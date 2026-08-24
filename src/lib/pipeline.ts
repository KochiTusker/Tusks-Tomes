import { MAX_OUTPUT_TOKENS } from './constants'
import { chunkText } from './chunker'
import { tryParseJson } from './jsonExtract'
import { dedupeBullets } from './bulletDedup'
import { chunkSizeFor as chunkSizeForProvider, type ChunkPhase } from './chunking'
import { compactKb, kbForPhase } from './kbCompact'
import { resolveRestoreTarget } from './restoreTarget'
import { getFailsafeTarget } from './claudeFailsafe'
import { retrieveForText } from './vaultRetrieval'
import { shouldRetrieveVaultKb } from './modelLimits'

/** Static scaffolding in the Phase 6 cloud prompt, excluding the KB and the
 *  chronicle chunk. Measured from phase6CondenseParts in prompts.ts; used to
 *  decide whether the full vault still fits the model's context window. */
const PHASE6_PROMPT_OVERHEAD_CHARS = 3_790
import { classifyModelTier, type ModelTier } from './modelTier'
import {
  ensureProvidersInitialized,
  getActiveProvider,
  getCloudProvider,
  type GeminiTier,
} from './providers'
import { LocalInstanceProvider } from './providers/localInstance'
import { isTransientServerError } from './providers/gemini'
import type { LLMProvider, ProviderEvent, ProviderName } from './providers/llm'
import type { CloudProvider } from './profiles'
import type { PhaseTarget } from './sessions'
import { estimateTokensFromChars } from './rateLimit'
import {
  detectRefusal,
  buildRefusalMarker,
  parseRefusalMarkers,
  genRefusalId,
} from './refusalDetection'
import { getClaudeFailsafeEnabled } from './claudeFailsafe'
import { getProviderSettings, isLocalProvider } from './providers/settings'
import type { GenerateRequest } from './providers/llm'
import { isPersistingBlockedChunks, vlog } from './verboseLog'
import { getAliasIndex, type AliasIndex } from './aliasIndexClient'
import { annotateChunk, aliasIndexToSafeReplacements } from './aliasMatch'
import type { Phase1InputSnapshot } from './runCheckpoint'
import { computePacingDelay } from './providerPacing'
import { proportionalChunkTarget } from './wordCount'

/**
 * Resolve a phase's chunk size using the active routing. Cloud providers
 * each have their own per-phase size in src/lib/chunking.ts; local models
 * use a single conservative table regardless of which runner is in play.
 *
 * `model` is used to classify the per-phase model into a tier (flagship /
 * fast / frontier) so fast-tier models (Flash, Haiku, gpt-5-mini) run on
 * smaller chunks. Omitting it preserves the flagship-default behaviour.
 */
function chunkSizeForPhase(args: {
  phase: ChunkPhase
  cloudProvider?: CloudProvider
  geminiTier?: GeminiTier
  phaseTarget?: PhaseTarget
  model?: string
  /** When set, chunking.ts applies the all-fast shrink factor. Threaded
   *  through from RunSession.allPhasesFast on the per-phase call sites. */
  allPhasesFast?: boolean
}): number {
  const isLocal = isLocalProvider() || args.phaseTarget?.target === 'local'
  const modelTier: ModelTier | undefined =
    !isLocal && args.model && args.cloudProvider
      ? classifyModelTier(args.model, args.cloudProvider)
      : undefined
  return chunkSizeForProvider({
    phase: args.phase,
    isLocal,
    cloudProvider: args.cloudProvider,
    geminiTier: args.geminiTier,
    modelTier,
    allPhasesFast: args.allPhasesFast,
  })
}

/** Tier→model resolution for the active provider. Mirrors the legacy gemini.ts behavior. */
function resolveModel(tier: 'pro' | 'flash'): string {
  const s = getProviderSettings()
  return tier === 'pro' ? s.proModel : s.flashModel
}

/** Pick the per-phase override if provided, otherwise fall back to tier resolution. */
function resolvePhaseModel(modelOverride: string | undefined, tier: 'pro' | 'flash'): string {
  return modelOverride && modelOverride.length > 0 ? modelOverride : resolveModel(tier)
}

function sleepWithCountdown(
  ms: number,
  signal?: AbortSignal,
  onTick?: (remaining: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'))
    const start = Date.now()
    let interval: ReturnType<typeof setInterval> | null = null
    const cleanup = () => {
      if (interval) clearInterval(interval)
      signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = () => {
      cleanup()
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    if (onTick) {
      onTick(ms)
      interval = setInterval(() => {
        const remaining = Math.max(0, ms - (Date.now() - start))
        onTick(remaining)
        if (remaining <= 0 && interval) {
          clearInterval(interval)
          interval = null
        }
      }, 1000)
    }
    setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
  })
}

/**
 * Per-chunk generation driver shared by every phase. Each phase builds a
 * GenerateRequest for the chunk; we call the active provider once per chunk,
 * pace between calls (cloud only; local servers aren't rate-limited), and
 * forward partial output via onChunkDone.
 */
type ChunkRequest = Pick<GenerateRequest, 'systemPrompt' | 'userPrompt'> &
  Partial<Pick<GenerateRequest, 'cacheablePrefix' | 'maxOutputTokens' | 'temperature' | 'responseFormat' | 'safetyMode'>>

const LOCAL_BACKEND_BASE_URLS: Record<string, string> = {
  ollama: 'http://localhost:11434',
  lmstudio: 'http://localhost:1234',
  llamacpp: 'http://localhost:8080',
}

function resolvePhaseProvider(target: PhaseTarget | undefined): {
  provider: LLMProvider
  model: string
  isLocal: boolean
} | null {
  if (!target || target.target === 'cloud') return null
  // Use the routed model. The base URL isn't carried per-phase yet, so we
  // try the common defaults — Ollama first, then LM Studio, then llama.cpp.
  // The first reachable backend that recognises this model wins. For now we
  // pick Ollama by default since it's the most common dev setup.
  const baseUrl = target.baseUrl ?? LOCAL_BACKEND_BASE_URLS.ollama
  const provider = new LocalInstanceProvider({ baseUrl, modelId: target.modelId })
  return { provider, model: target.modelId, isLocal: true }
}

async function chunkedGenerate(args: {
  chunks: string[]
  buildRequest: (chunk: string, index: number, total: number) => ChunkRequest
  tier: 'pro' | 'flash'
  /** Optional per-phase model override from `RunSession.models` (Step 7). */
  modelOverride?: string
  /** Cloud-provider name from the run-start modal (Step 7 fix). Without this
   *  the dispatcher silently falls back to Gemini even when the user picked
   *  Claude / OpenAI. */
  cloudProvider?: CloudProvider
  /** Gemini-only tier preference: 'paid' / 'free' / 'auto'. */
  geminiTier?: GeminiTier
  /** Gemini-only: list of model ids that the Free key cannot reach. When
   *  `geminiTier === 'free'` and the per-phase model is in this list, the
   *  pipeline escalates to the Paid key for that phase. */
  geminiPaidOnlyModels?: string[]
  /** Optional per-phase target override from RunSession.routing (Step 15). */
  phaseTarget?: PhaseTarget
  startChunkIndex?: number
  onChunkDone: (absoluteIndex: number, text: string) => Promise<void> | void
  contextLabel: (absoluteIndex: number, total: number) => string
  signal?: AbortSignal
  onCountdown?: (msRemaining: number) => void
  delayMs?: number
  /** Forwarded into provider.generate so the pipeline can react to quota
   *  exhaustion / auto-fallback events the provider surfaces mid-call. */
  onProviderEvent?: (event: ProviderEvent) => void
  /** Fires when the provider pauses to retry after a transient error.
   *  The pipeline event forwarder turns this into a `retry_waiting`
   *  PipelineEvent so the UI can show a visible countdown. */
  onRetry?: (attempt: number, waitMs: number) => void
  /** Per-run "slow down" dial from the rate-limit dialog. 1.0 = natural
   *  provider pacing; 3.0 = three times slower. May be a literal number
   *  (fixed for the whole call) or a getter (read fresh before every
   *  chunk — used when the dialog flips the multiplier mid-run). */
  safetyMultiplier?: number | (() => number)
  /** Which provider repairs a chunk the subscription CLI refuses. Defaults to
   *  'gemini', preserving the behaviour from when Gemini was the only
   *  permissive provider wired up. Either way the resolver falls back to the
   *  other rather than skipping the repair entirely. */
  restorePrefer?: 'gemini' | 'openrouter'
  /** Gemini-only per-chunk thinking budget. 0 = DISABLED (cheaper).
   *  undefined = SDK default (model decides). Other providers ignore.
   *  Set per-phase by runPhaseN based on user-toggle + hardcoded
   *  per-phase defaults (Phase 3 chronicle ALWAYS undefined — voice
   *  protection). */
  thinkingBudget?: number
  /** Optional per-chunk skip predicate. When set and returns true for an
   *  absolute chunk index, the loop emits onChunkDone(index, skipText)
   *  synthetically without an API call. Used by Phase 2 to skip chunks
   *  whose grounded text is byte-identical to the raw input (nothing
   *  for audit to flag). The provider's cache lease is still created
   *  on a non-skipped chunk's prefix, so the cache remains valid for
   *  any non-skipped chunks downstream. */
  shouldSkip?: (absoluteIndex: number) => boolean
  /** Synthetic onChunkDone payload for skipped chunks. Default is "".
   *  Phase 2 passes "[]" so its JSON parser doesn't choke on empty. */
  skipText?: (absoluteIndex: number) => string
  /** When set, a chunk that throws with `err.isProhibitedContent === true`
   *  (Gemini's unconfigurable PROHIBITED_CONTENT / BLOCKLIST / SPII block —
   *  CANNOT be relaxed via safetySettings) is treated as if `shouldSkip`
   *  returned true: emits onChunkDone with the configured skipText and
   *  continues. Used by Phase 2 (audit) and Phase 4 (extras) — both
   *  produce JSON outputs where a single chunk returning `[]` / `{}` is
   *  a valid degraded outcome (most audit chunks already return `[]`).
   *  Phase 1/3/5/6 keep failing hard because they produce continuous
   *  narrative — a hole in the middle of the chronicle is not
   *  acceptable. */
  softSkipOnProhibitedContent?: boolean
  /** Layer-B chunk-fusion recovery. When a chunk hits PROHIBITED_CONTENT,
   *  Gemini's meta-filter (which CANNOT be relaxed via safetySettings)
   *  has tripped on the trigger's CONCENTRATION inside the chunk — not
   *  its absolute presence. Joining chunk i with chunk i-1 dilutes the
   *  trigger ratio below threshold (empirically verified — see the
   *  `.diagnose/brody-bisect-*.json` probe). Caller returns a ChunkRequest
   *  whose prompt embeds the fused content, or null if fusion isn't
   *  possible (i=0 with no previous chunk to fuse with). Fires for ANY
   *  phase that wires this callback — whether or not softSkipOnProhibitedContent
   *  is also set. JSON-output phases (Phase 2, Phase 4) pair this with
   *  softSkip so fusion+soft-skip is the full cascade. Prose-output phases
   *  (Phase 3 chronicle) pair this with `onChunksFused` so the previous
   *  chunk's narrative contribution is replaced — NOT duplicated — and
   *  on fusion failure throw hard (no silent hole in the chronicle).
   *  Cost: ~$0.001 per fused retry on Flash. */
  buildFusedRequestOnBlock?: (i: number, total: number) => ChunkRequest | null
  /** Called when chunk i was recovered by fusing with chunk i-1. The
   *  handler must replace BOTH chunks' contributions to any accumulated
   *  output (the fused text covers chunks i-1 and i). When not provided,
   *  the fusion success path falls back to `onChunkDone(i, fusedText)` —
   *  this is correct for JSON-output phases that dedup the merged result
   *  (Phase 2 questions, Phase 4 quotes), but NOT safe for narrative
   *  accumulation (Phase 3 would write chunk i-1's output AND the fused
   *  output, doubling the prose). Phase 3 wires this callback to replace
   *  chunkOutputs[i-1] = "" and chunkOutputs[i] = fusedText, then rebuilds
   *  `accumulated` from the filtered chunkOutputs array. */
  onChunksFused?: (previousIndex: number, currentIndex: number, fusedText: string) => void | Promise<void>
  /** Phase identifier — used by verbose error messages and the
   *  `tier_escalated` PipelineEvent. Optional for backward compatibility
   *  (legacy callers don't set it); when absent, errors omit the phase
   *  prefix and the escalation event doesn't fire. */
  phaseId?: PhaseId
  /** Lets chunkedGenerate emit pipeline-level events (currently
   *  `tier_escalated`) without round-tripping through onProviderEvent.
   *  Each runPhaseN wires this to its `callbacks.onEvent`. */
  onPipelineEvent?: (event: PipelineEvent) => void
  /** Per-phase: produces the chunk-output text injected when a Claude Code
   *  refusal is detected but NOT repaired in-run (failsafe off, no Gemini key,
   *  or Gemini also failed). Prose phases (3) return a visible banner + hidden
   *  TUSKS-REFUSAL tag (the default when this is omitted); Phase 1 returns the
   *  ungrounded passthrough (`chunk`) so downstream phases aren't polluted by a
   *  banner; JSON phases (2/4) return the empty sentinel (`[]`) so downstream
   *  parsing stays alive. When the returned text carries the tag it also
   *  becomes the RefusalRecord's splice marker. */
  refusalMarker?: (chunkIndex: number, total: number, id: string) => string
  /** Per-phase: the grounded source span to record for a refused chunk so a
   *  later repair can re-process it. Defaults to `chunks[chunkIndex]`. Phases
   *  that pass placeholder chunks (Phase 2/4, which read content by index from
   *  separate raw/grounded arrays) override this to return the real span. */
  refusalSourceSpan?: (chunkIndex: number) => string
  /** Per-phase: the chunk-size target used to split this phase's input.
   *  Recorded on a refusal so a repair can deterministically re-derive sibling
   *  spans (e.g. Phase 2 re-chunks the raw transcript to pair with grounded). */
  chunkSizeChars?: number
}): Promise<void> {
  await ensureProvidersInitialized()
  const total = args.chunks.length
  const startIdx = args.startChunkIndex ?? 0
  const phaseTarget = resolvePhaseProvider(args.phaseTarget)
  let provider: LLMProvider
  let model: string
  if (phaseTarget) {
    provider = phaseTarget.provider
    model = phaseTarget.model
  } else if (args.cloudProvider) {
    // Explicit cloud provider from RunSession.
    model = resolvePhaseModel(args.modelOverride, args.tier)
    // Gemini Free semantics: prefer the Free key, escalate to Paid when
    // this phase's model is paid-only. The list of paid-only model ids is
    // computed at session-build time and passed through unchanged.
    let resolvedGeminiTier = args.geminiTier
    let escalatedFreeToPaid = false
    if (
      args.cloudProvider === 'gemini' &&
      resolvedGeminiTier === 'free' &&
      args.geminiPaidOnlyModels?.includes(model)
    ) {
      resolvedGeminiTier = 'paid'
      escalatedFreeToPaid = true
    }
    provider = getCloudProvider(args.cloudProvider, { geminiTier: resolvedGeminiTier })
    // Hard fail when escalation is needed but no Paid key is configured.
    // Without this guard, the call would dispatch to a Gemini singleton with
    // no key and the user would see a generic SDK error. Be explicit.
    if (escalatedFreeToPaid && !(provider as { hasKey?: () => boolean }).hasKey?.()) {
      const phasePrefix = args.phaseId
        ? `${args.phaseId.replace('_', ' ')}: `
        : ''
      throw new Error(
        `${phasePrefix}model "${model}" is paid-only on the Free Gemini key, ` +
          `but no Paid Gemini key is configured. Add one in Settings → API Keys (Paid tier slot) ` +
          `or pick a Flash model for this phase.`,
      )
    }
    if (escalatedFreeToPaid && args.phaseId && args.onPipelineEvent) {
      // Surface the escalation so the UI can toast "Phase N model X requires
      // Paid — dispatching to the Paid singleton for this phase." Lets the
      // user understand WHY their Free-tier run is hitting Paid quota.
      vlog('pipeline', {
        event: 'tier_escalated',
        phase: args.phaseId,
        model,
        fromTier: 'free',
        toTier: 'paid',
        reason: 'paid_only_model_on_free_tier',
      })
      try {
        args.onPipelineEvent({
          type: 'tier_escalated',
          phase: args.phaseId,
          model,
          fromTier: 'free',
          toTier: 'paid',
          reason: 'paid_only_model_on_free_tier',
        })
      } catch (e) {
        console.warn('[chunkedGenerate] onPipelineEvent listener threw:', e)
      }
    }
  } else {
    // Legacy path — provider id read from `provider_settings` localStorage.
    provider = getActiveProvider()
    model = resolvePhaseModel(args.modelOverride, args.tier)
  }
  const usingLocal = phaseTarget?.isLocal || (!args.cloudProvider && isLocalProvider())

  // Per-phase prefix cache lease (Gemini today; Claude/OpenAI auto-cache
  // via headers so they don't expose createPrefixCache). Cache pays off
  // when there are ≥ 2 chunks — for a single-chunk phase, the create +
  // delete round trips would cost more than they save. The cacheable
  // prefix is invariant across chunks in a given phase (KB + contextual
  // hints), so we sample chunk[startIdx]'s buildRequest to extract it.
  let cachedContentHandle: string | null = null
  const chunksRemaining = total - startIdx
  if (
    !usingLocal &&
    chunksRemaining > 1 &&
    typeof provider.createPrefixCache === 'function'
  ) {
    try {
      const probeBase = args.buildRequest(args.chunks[startIdx], startIdx, total)
      const probeReq: GenerateRequest = {
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        safetyMode: 'permissive',
        ...probeBase,
        model,
      }
      const prefixChars =
        (probeReq.systemPrompt?.length ?? 0) + (probeReq.cacheablePrefix?.length ?? 0)
      // K.2.3 / W6 — defensive skip when the probe has an empty
      // cacheable prefix (e.g. Phase 2 audit prompts that don't ship a
      // KB section). Creating a cache for zero bytes is wasted round-
      // trips: Google/SDK reject empty cachedContent, and even when the
      // call succeeds the resulting handle saves nothing on subsequent
      // chunks. Skip and log.
      if (prefixChars === 0) {
        vlog('cache', {
          event: 'cache_skipped',
          reason: 'empty_prefix',
          phase: args.phaseId,
          model,
          chunksRemaining,
        })
      } else {
        cachedContentHandle = await provider.createPrefixCache(probeReq)
        vlog('cache', {
          event: cachedContentHandle ? 'cache_created' : 'cache_skipped',
          phase: args.phaseId,
          model,
          handle: cachedContentHandle,
          prefixChars,
          chunksRemaining,
        })
      }
    } catch (err) {
      // createPrefixCache is supposed to swallow its own errors and
      // return null, but defense in depth — never let a cache attempt
      // sink the whole phase.
      console.warn('[chunkedGenerate] createPrefixCache threw:', err)
      vlog('cache', {
        event: 'cache_create_error',
        phase: args.phaseId,
        model,
        errorPreview: String((err as Error)?.message ?? err).slice(0, 200),
      })
      cachedContentHandle = null
    }
  }

  try {
    for (let i = startIdx; i < total; i++) {
      if (args.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      // Per-chunk skip path. Phase 2 uses this when raw === grounded for a
      // chunk — no work for the audit to do, so we save the round trip.
      // We still emit chunk_done so the UI progress bar advances.
      if (args.shouldSkip?.(i)) {
        const synthetic = args.skipText?.(i) ?? ''
        await args.onChunkDone(i, synthetic)
        continue
      }
      const baseReq = args.buildRequest(args.chunks[i], i, total)
      const req: GenerateRequest = {
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        safetyMode: 'permissive',
        ...baseReq,
        model,
        // thinkingBudget applies only when the caller (runPhaseN) set it.
        // Undefined = let the SDK / model decide (existing behaviour).
        // Gemini provider conditionally spreads thinkingConfig; other
        // providers ignore.
        ...(args.thinkingBudget !== undefined ? { thinkingBudget: args.thinkingBudget } : {}),
      }

      // Pace BEFORE the call. The provider's RateLimitState tracks the last
      // call timestamp + the harvested rate-limit headers, so the right
      // spacing is whatever it returns. Local providers and `args.delayMs`
      // overrides skip the provider math.
      const promptChars =
        (req.systemPrompt?.length ?? 0) +
        (req.cacheablePrefix?.length ?? 0) +
        (req.userPrompt?.length ?? 0)
      const estimatedInputTokens = estimateTokensFromChars(promptChars)
      let delay: number
      if (args.delayMs !== undefined) {
        delay = args.delayMs
      } else if (usingLocal) {
        delay = 0
      } else {
        const mult =
          typeof args.safetyMultiplier === 'function'
            ? args.safetyMultiplier()
            : args.safetyMultiplier ?? 1
        delay = provider.getNextDelayMs?.(estimatedInputTokens, mult, model) ?? 0
      }
      if (delay > 0) {
        await sleepWithCountdown(delay, args.signal, args.onCountdown)
      }

      // Per-chunk timing for the diagnostic stream. The chunk_started
      // event includes the prompt size + token estimate so the user can
      // see "phase 3 chunk 12 sent 8.4kB / 2400 tokens to gemini-2.5-pro";
      // the chunk_finished pair includes latency + output size so a hang
      // is localized to a specific chunk index.
      const chunkStartTs = Date.now()
      vlog('chunk', {
        event: 'chunk_started',
        phase: args.phaseId,
        index: i,
        totalChunks: total,
        model,
        tier: args.geminiTier,
        promptChars,
        estimatedTokens: estimatedInputTokens,
        cachedHandle: cachedContentHandle ?? null,
      })
      let text: string
      try {
        const result = await provider.generate(req, {
          signal: args.signal,
          contextLabel: args.contextLabel(i, total),
          onProviderEvent: args.onProviderEvent,
          onRetry: args.onRetry,
          cachedContentHandle: cachedContentHandle ?? undefined,
        })
        text = result.text
        vlog('chunk', {
          event: 'chunk_finished',
          phase: args.phaseId,
          index: i,
          totalChunks: total,
          latencyMs: Date.now() - chunkStartTs,
          outputChars: text.length,
          usage: result.usage,
        })

        // Layer-1 explicit-content failsafe + refusal tracking (Claude Code).
        // Detection runs for EVERY Claude Code chunk regardless of the failsafe
        // toggle — the toggle now only governs whether an in-run Gemini RESTORE
        // is attempted. When a refusal is NOT repaired in-run (toggle off, no
        // Gemini key, or Gemini also failed) we inject a durable per-phase
        // marker into the output and fire an enriched event so a persistent,
        // repairable RefusalRecord can be recorded + the user can later
        // re-process just the refused chunk(s).
        if (args.cloudProvider === 'claudeCode') {
          const check = detectRefusal(text, req.userPrompt?.length)
          if (check.refused) {
            const refusedText = text
            let replacementText = ''
            if (getClaudeFailsafeEnabled()) {
              // Who repairs a refusal is resolved rather than hardcoded: a
              // user with no Gemini key used to get no repair at all, and the
              // refusal became a durable hole in the chronicle. See
              // restoreTarget.ts for why DeepSeek V4 Pro is the OpenRouter pick.
              // The user's chosen repair model, falling back to whatever is
              // actually configured. Both halves matter: a preference for a
              // provider with no key must not mean no repair at all.
              const chosen = getFailsafeTarget()
              const resolved = resolveRestoreTarget('in-run', chosen.provider)
              const target = resolved
                ? resolved.provider === chosen.provider
                  ? { ...resolved, model: chosen.modelId, label: chosen.label }
                  : resolved
                : null
              const gem = target
                ? getCloudProvider(target.provider, { geminiTier: args.geminiTier ?? 'auto' })
                : null
              if (target && gem) {
                const gemModel = target.model
                try {
                  const pace = computePacingDelay({
                    req,
                    provider: gem,
                    safetyMultiplier: args.safetyMultiplier,
                  })
                  if (pace > 0) await sleepWithCountdown(pace, args.signal, args.onCountdown)
                  const gemRes = await gem.generate(
                    { ...req, model: gemModel, safetyMode: 'permissive' },
                    {
                      signal: args.signal,
                      contextLabel:
                        args.contextLabel(i, total) + ` [${target.label} — claude refusal]`,
                      onProviderEvent: args.onProviderEvent,
                      onRetry: args.onRetry,
                    },
                  )
                  if (gemRes.text.trim() && !detectRefusal(gemRes.text, req.userPrompt?.length).refused) {
                    text = gemRes.text
                    replacementText = gemRes.text
                    vlog('chunk', {
                      event: 'claude_refusal_repaired',
                      phase: args.phaseId,
                      index: i,
                      gemModel,
                      outputChars: text.length,
                    })
                  }
                } catch (gemErr) {
                  vlog('pipeline', {
                    event: 'claude_refusal_repair_failed',
                    phase: args.phaseId,
                    index: i,
                    error: (gemErr as Error)?.message ?? String(gemErr),
                  })
                }
              }
            }

            const repaired = replacementText.length > 0
            let refusalId: string | undefined
            let marker = ''
            if (!repaired) {
              // Unrepaired: inject the per-phase chunk output. Prose phases get
              // a visible banner + hidden tag (default); Phase 1 gets the
              // ungrounded passthrough; JSON phases get the empty sentinel. The
              // injected text REPLACES the refused text in the output so the
              // refusal/blank never silently lands in the document.
              refusalId = genRefusalId()
              const injected = args.refusalMarker
                ? args.refusalMarker(i, total, refusalId)
                : buildRefusalMarker(args.phaseId ?? 'phase3_chronicle', i, total, refusalId)
              text = injected
              // The record's splice anchor is the injected text ONLY when it
              // carries our tag (prose banner). Phase 1 passthrough / JSON
              // sentinels have no unique anchor → empty marker (manifest-only).
              marker = parseRefusalMarkers(injected).includes(refusalId) ? injected : ''
            }

            // vlog stays light (no full text — it would bloat the diagnose
            // ring); the full texts ride the UI event only.
            vlog('pipeline', {
              event: 'auto_fallback',
              phase: args.phaseId,
              index: i,
              totalChunks: total,
              reason: 'claude_refusal',
              refusalReason: check.reason,
              repaired,
            })
            try {
              args.onPipelineEvent?.({
                type: 'auto_fallback',
                phase: args.phaseId!,
                provider: 'claudeCode',
                reason: 'claude_refusal',
                chunkIndex: i,
                totalChunks: total,
                transcriptExcerpt: args.refusalSourceSpan ? args.refusalSourceSpan(i) : args.chunks[i],
                refusedText,
                replacementText,
                repaired,
                refusalId,
                marker,
                chunkSizeChars: args.chunkSizeChars,
              })
            } catch (listenerErr) {
              console.warn('[chunkedGenerate] onPipelineEvent (claude_refusal) listener threw:', listenerErr)
            }
          }
        }
      } catch (err) {
        // Soft-skip path for the JSON-output phases (audit + extras). The
        // unconfigurable PROHIBITED_CONTENT / BLOCKLIST / SPII filters cannot
        // be relaxed via safetySettings, so once the model rejects the
        // chunk's prompt there's no retry that will succeed on the same
        // model. Treating the chunk as if it produced empty output keeps
        // the run alive — a single missing audit/extras chunk is recoverable
        // (other chunks still produce questions/quotes), whereas failing
        // the entire run costs the user every chunk's progress.
        const isProhibited = (err as Error & { isProhibitedContent?: boolean })?.isProhibitedContent === true

        // Free→Paid escalation on PROHIBITED_CONTENT. Google applies stricter
        // PROHIBITED_CONTENT / BLOCKLIST / SPII thresholds on the free-tier
        // endpoint (T&S policy for unverified usage) than on the paid endpoint.
        // The exact same prompt that the free key rejects frequently passes on
        // the paid key. Try the paid endpoint with the SAME model first; only
        // fall through to soft-skip if paid also blocks. Cost: ~$0.001 per
        // escalated chunk on Flash. Saves the user a missing audit/extras
        // chunk (or an unblocked Phase 3 chunk on a hand-routed free run).
        if (
          isProhibited &&
          args.cloudProvider === 'gemini' &&
          args.geminiTier === 'free'
        ) {
          const paidProvider = getCloudProvider('gemini', { geminiTier: 'paid' })
          const paidHasKey = (paidProvider as { hasKey?: () => boolean }).hasKey?.() ?? false
          if (paidHasKey) {
            const escalationReason =
              (err as Error & { prohibitedBlockReason?: string })?.prohibitedBlockReason ?? 'PROHIBITED_CONTENT'
            vlog('pipeline', {
              event: 'auto_fallback',
              phase: args.phaseId,
              index: i,
              totalChunks: total,
              model,
              fromTier: 'free',
              toTier: 'paid',
              reason: 'free_prohibited_content',
              blockReason: escalationReason,
            })
            try {
              args.onPipelineEvent?.({
                type: 'auto_fallback',
                phase: args.phaseId!,
                provider: 'gemini',
                reason: 'free_prohibited_content',
                chunkIndex: i,
                model,
              })
            } catch (listenerErr) {
              // Surface to the diagnose ring so a future debugging session
              // reading `.diagnose/latest.md` can see that a UI listener
              // threw — previously this was console-only and disappeared
              // when the user closed the browser tab.
              vlog('pipeline', {
                type: 'listener_failed',
                site: 'free_prohibited_content_fallback',
                phase: args.phaseId,
                chunkIndex: i,
                error: (listenerErr as Error).message ?? String(listenerErr),
              })
              console.warn('[chunkedGenerate] onPipelineEvent (prohibited fallback) listener threw:', listenerErr)
            }
            // K.2.1 / B3 — pace BEFORE the paid retry so the escalated
            // call honours Paid's RateLimitState. Without this, we
            // synchronously burst Paid right after the Free failure;
            // when the user just exhausted a daily quota mid-loop, the
            // back-to-back Paid call can trip Paid's per-minute cap.
            const paidPaceDelay = computePacingDelay({
              req,
              provider: paidProvider,
              safetyMultiplier: args.safetyMultiplier,
            })
            if (paidPaceDelay > 0) {
              await sleepWithCountdown(paidPaceDelay, args.signal, args.onCountdown)
            }
            const retryStartTs = Date.now()
            try {
              const result = await paidProvider.generate(req, {
                signal: args.signal,
                contextLabel: args.contextLabel(i, total) + ' [paid fallback — free blocked]',
                onProviderEvent: args.onProviderEvent,
                onRetry: args.onRetry,
              })
              vlog('chunk', {
                event: 'chunk_finished',
                phase: args.phaseId,
                index: i,
                totalChunks: total,
                latencyMs: Date.now() - retryStartTs,
                outputChars: result.text.length,
                usage: result.usage,
                fallbackFrom: 'free',
                fallbackTo: 'paid',
                fallbackReason: 'prohibited_content',
                paidPaceDelayMs: paidPaceDelay,
              })
              await args.onChunkDone(i, result.text)
              continue
            } catch (paidErr) {
              // Paid blocked too — fall through to the existing soft-skip
              // path with the original error, so the soft-skip decision is
              // made on the canonical PROHIBITED state. The paid attempt
              // just proves the chunk is unrecoverable at this provider.
              vlog('chunk', {
                event: 'chunk_error',
                phase: args.phaseId,
                index: i,
                totalChunks: total,
                latencyMs: Date.now() - retryStartTs,
                errorName: (paidErr as Error)?.name ?? 'Error',
                errorPreview: String((paidErr as Error)?.message ?? paidErr).slice(0, 200),
                fallbackAttempted: 'free_to_paid_prohibited',
                fallbackResult: 'paid_also_blocked',
              })
            }
          }
        }

        // Layer B — chunk fusion fallback. When PROHIBITED_CONTENT trips
        // (concentration-based meta-filter — see brody-bisect-*.json probe
        // evidence), joining chunk i with chunk i-1 dilutes the trigger
        // below the meta-filter's ratio threshold. Available to any phase
        // that wires `buildFusedRequestOnBlock`. For JSON-output phases
        // (Phase 2, Phase 4) fusion is rescue-before-soft-skip; for
        // prose-output phases (Phase 3 chronicle) fusion is the ONLY
        // recovery — on fusion failure these phases throw hard rather
        // than leaving a synthetic hole in the narrative.
        if (
          isProhibited &&
          args.buildFusedRequestOnBlock
        ) {
          const fusedRequest = args.buildFusedRequestOnBlock(i, total)
          if (fusedRequest) {
            // Pick the strongest available provider for fusion — paid
            // Gemini if reachable, else fall back to the current provider.
            // The bisect probe showed Paid Pro doesn't dodge this trigger
            // class (meta-filter is at the API gateway, before model
            // dispatch), so going to Pro buys nothing — Paid Flash is the
            // right target. For non-Gemini providers we just reuse `provider`.
            let fuseProvider = provider
            if (args.cloudProvider === 'gemini') {
              const paidProvider = getCloudProvider('gemini', { geminiTier: 'paid' })
              const paidHasKey = (paidProvider as { hasKey?: () => boolean }).hasKey?.() ?? false
              if (paidHasKey) fuseProvider = paidProvider
            }
            const fuseReq: GenerateRequest = {
              ...req,
              userPrompt: fusedRequest.userPrompt,
              systemPrompt: fusedRequest.systemPrompt ?? req.systemPrompt,
              cacheablePrefix: fusedRequest.cacheablePrefix ?? req.cacheablePrefix,
            }
            const fuseStartTs = Date.now()
            vlog('pipeline', {
              event: 'chunk_fusion_attempt',
              phase: args.phaseId,
              index: i,
              totalChunks: total,
              model,
              tier: args.geminiTier,
              fusedPromptChars:
                (fuseReq.systemPrompt?.length ?? 0) +
                (fuseReq.cacheablePrefix?.length ?? 0) +
                (fuseReq.userPrompt?.length ?? 0),
            })
            try {
              const fuseResult = await fuseProvider.generate(fuseReq, {
                signal: args.signal,
                contextLabel: args.contextLabel(i, total) + ' [fused with chunk i-1 to dilute trigger]',
                onProviderEvent: args.onProviderEvent,
                onRetry: args.onRetry,
              })
              vlog('chunk', {
                event: 'chunk_recovered_via_fusion',
                phase: args.phaseId,
                index: i,
                totalChunks: total,
                latencyMs: Date.now() - fuseStartTs,
                outputChars: fuseResult.text.length,
                usage: fuseResult.usage,
              })
              try {
                args.onPipelineEvent?.({
                  type: 'chunk_fusion_recovered',
                  phase: args.phaseId!,
                  chunkIndex: i,
                  model,
                })
              } catch (listenerErr) {
                vlog('pipeline', {
                  type: 'listener_failed',
                  site: 'chunk_fusion_recovered',
                  phase: args.phaseId,
                  chunkIndex: i,
                  error: (listenerErr as Error).message ?? String(listenerErr),
                })
                console.warn('[chunkedGenerate] onPipelineEvent (fusion_recovered) listener threw:', listenerErr)
              }
              // Prose-accumulation phases (Phase 3) supply onChunksFused so the
              // previous chunk's contribution is REPLACED — without it, the
              // accumulator would contain both chunk i-1 (already written)
              // AND the fused text (covering both). JSON-output phases
              // (Phase 2, Phase 4) leave onChunksFused unset and dedup via
              // their own onChunkDone logic.
              if (args.onChunksFused) {
                await args.onChunksFused(i - 1, i, fuseResult.text)
              } else {
                await args.onChunkDone(i, fuseResult.text)
              }
              continue
            } catch (fuseErr) {
              vlog('chunk', {
                event: 'chunk_fusion_also_blocked',
                phase: args.phaseId,
                index: i,
                totalChunks: total,
                latencyMs: Date.now() - fuseStartTs,
                errorName: (fuseErr as Error)?.name ?? 'Error',
                errorPreview: String((fuseErr as Error)?.message ?? fuseErr).slice(0, 200),
              })
              // Fall through to soft-skip below.
            }
          }
        }

        if (isProhibited && args.softSkipOnProhibitedContent === true) {
          const blockReason =
            (err as Error & { prohibitedBlockReason?: string })?.prohibitedBlockReason ?? 'PROHIBITED_CONTENT'
          const synthetic = args.skipText?.(i) ?? ''
          vlog('chunk', {
            event: 'chunk_soft_skipped',
            phase: args.phaseId,
            index: i,
            totalChunks: total,
            latencyMs: Date.now() - chunkStartTs,
            reason: 'prohibited_content',
            blockReason,
            model,
            tier: args.geminiTier,
            syntheticOutputChars: synthetic.length,
          })
          // Capture-on-block: when the user has opted into persisting the
          // rejected chunk's full prompt body (DiagnosticsCard toggle), POST
          // it to the diagnose endpoint so future probe runs can use this
          // exact content as a ground-truth fixture. Fire-and-forget; never
          // block the soft-skip path. Default OFF — capture only fires when
          // the user has explicitly enabled it for the diagnostic session.
          if (isPersistingBlockedChunks()) {
            const fullPrompt =
              (req.systemPrompt ?? '') +
              (req.cacheablePrefix ? '\n\n' + req.cacheablePrefix : '') +
              (req.userPrompt ?? '')
            void fetch('/api/diagnose/capture-blocked-chunk', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                phase: args.phaseId,
                index: i,
                totalChunks: total,
                model,
                tier: args.geminiTier,
                blockReason,
                prompt: fullPrompt,
              }),
              keepalive: true,
            }).catch((captureErr) => {
              // Capture failure must NEVER affect the soft-skip path —
              // log + swallow.
              console.warn('[chunkedGenerate] capture-blocked-chunk failed:', captureErr)
            })
          }
          await args.onChunkDone(i, synthetic)
          continue
        }
        // Free→Paid fallback for transient 5xx. When a chunk routed to the
        // Free Gemini singleton exhausts its retries on an UNAVAILABLE/503
        // (Google's "this model is currently experiencing high demand"),
        // reissue the same chunk via the Paid singleton if one is configured.
        // This unsticks Smart Budget runs (which pin Phase 1+2 to Free Flash)
        // when Google's free tier has a bad afternoon — the alternative is
        // ~74 brittle calls per Session-24-sized run with any single 503
        // killing everything. Costs ~$0.001 per rescued chunk. Only fires
        // for explicit-Free dispatch (the 'auto' tier already has its own
        // swap path; 'paid' has nothing to fall back to).
        const isFreeGeminiTransient =
          args.cloudProvider === 'gemini' &&
          args.geminiTier === 'free' &&
          !(err as Error & { isProhibitedContent?: boolean })?.isProhibitedContent &&
          isTransientServerError(err)
        if (isFreeGeminiTransient) {
          const paidProvider = getCloudProvider('gemini', { geminiTier: 'paid' })
          const paidHasKey = (paidProvider as { hasKey?: () => boolean }).hasKey?.() ?? false
          if (paidHasKey) {
            vlog('pipeline', {
              event: 'auto_fallback',
              phase: args.phaseId,
              index: i,
              totalChunks: total,
              model,
              fromTier: 'free',
              toTier: 'paid',
              reason: 'free_transient_5xx',
              errorPreview: String((err as Error)?.message ?? err).slice(0, 200),
            })
            try {
              args.onPipelineEvent?.({
                type: 'auto_fallback',
                phase: args.phaseId!,
                provider: 'gemini',
                reason: 'free_transient_5xx',
                chunkIndex: i,
                model,
              })
            } catch (listenerErr) {
              vlog('pipeline', {
                type: 'listener_failed',
                site: 'free_transient_5xx_auto_fallback',
                phase: args.phaseId,
                chunkIndex: i,
                error: (listenerErr as Error).message ?? String(listenerErr),
              })
              console.warn('[chunkedGenerate] onPipelineEvent (auto_fallback) listener threw:', listenerErr)
            }
            // K.2.1 / B3 — pace BEFORE the paid retry so Paid's
            // RateLimitState is respected on the transient-5xx
            // escalation path (same fix as the prohibited_content
            // branch above; both used to bypass paidProvider's
            // getNextDelayMs).
            const paidPaceDelay = computePacingDelay({
              req,
              provider: paidProvider,
              safetyMultiplier: args.safetyMultiplier,
            })
            if (paidPaceDelay > 0) {
              await sleepWithCountdown(paidPaceDelay, args.signal, args.onCountdown)
            }
            const retryStartTs = Date.now()
            // Reissue with the same req object — caches keyed to the Free
            // singleton don't carry over to Paid, but the prefix is small
            // enough on Phase 1+2 (compact KB) that one uncached call costs
            // pennies. Don't pass cachedContentHandle for the paid retry.
            try {
              const result = await paidProvider.generate(req, {
                signal: args.signal,
                contextLabel: args.contextLabel(i, total) + ' [paid fallback]',
                onProviderEvent: args.onProviderEvent,
                onRetry: args.onRetry,
              })
              text = result.text
              vlog('chunk', {
                event: 'chunk_finished',
                phase: args.phaseId,
                index: i,
                totalChunks: total,
                latencyMs: Date.now() - retryStartTs,
                outputChars: text.length,
                usage: result.usage,
                fallbackFrom: 'free',
                fallbackTo: 'paid',
                paidPaceDelayMs: paidPaceDelay,
              })
              await args.onChunkDone(i, text)
              continue
            } catch (paidErr) {
              vlog('chunk', {
                event: 'chunk_error',
                phase: args.phaseId,
                index: i,
                totalChunks: total,
                latencyMs: Date.now() - chunkStartTs,
                errorName: (paidErr as Error)?.name ?? 'Error',
                errorPreview: String((paidErr as Error)?.message ?? paidErr).slice(0, 200),
                fallbackAttempted: 'free_to_paid',
              })
              throw paidErr
            }
          }
        }
        vlog('chunk', {
          event: 'chunk_error',
          phase: args.phaseId,
          index: i,
          totalChunks: total,
          latencyMs: Date.now() - chunkStartTs,
          errorName: (err as Error)?.name ?? 'Error',
          errorPreview: String((err as Error)?.message ?? err).slice(0, 200),
        })
        throw err
      }
      await args.onChunkDone(i, text)
    }
  } finally {
    if (cachedContentHandle && typeof provider.deletePrefixCache === 'function') {
      vlog('cache', {
        event: 'deletePrefixCache',
        handle: cachedContentHandle,
        phase: args.phaseId,
      })
      await provider.deletePrefixCache(cachedContentHandle).catch((err) => {
        vlog('cache', {
          event: 'deletePrefixCache_error',
          handle: cachedContentHandle,
          errorPreview: String((err as Error)?.message ?? err).slice(0, 200),
        })
      })
    }
  }
}

import { combineRules, formatContextualHints, pickHintsFor, preGround, type PreGroundReport } from './preGround'
import { detachSpeakers, reattachSpeakers, type DetachResult } from './speakerDetach'
import { getGlossary } from './glossary'
import {
  phase1GroundLocal,
  phase1GroundParts,
  phase2Audit,
  phase2AuditLocal,
  phase3ChronicleLocal,
  phase3ChronicleParts,
  phase4Extras,
  phase4ExtrasLocal,
  phase5PolishLocal,
  phase6CondenseLocal,
  phase6CondenseParts,
} from './prompts'
import { cleanupTranscript, type CleanupReport } from './transcriptCleanup'
import { appendNovelQuotes, normalizeQuotes } from './quotes'
import type { CondenseOutput, DMAnswers, DMQuestion, ExtrasOutput, KBDocument, PhaseId } from '@/types'

export type PipelineEvent =
  | {
      type: 'phase_start'
      phase: PhaseId
      totalChunks: number
      /** When the phase is resumed from a checkpoint, this is the
       *  absolute chunk index the loop is about to start at (matches
       *  the checkpoint's progress.chunkIndex). The UI primes its
       *  counter from this so the user doesn't briefly see "0 / N"
       *  before the resumed chunk completes. Omitted for fresh runs;
       *  the UI treats absence as 0. */
      startChunkIndex?: number
    }
  | { type: 'chunk_done'; phase: PhaseId; index: number; totalChunks: number; partial: string }
  | { type: 'countdown'; phase: PhaseId; msRemaining: number }
  | { type: 'phase_complete'; phase: PhaseId }
  | { type: 'pre_ground'; report: PreGroundReport }
  | { type: 'cleanup'; report: CleanupReport }
  | {
      type: 'quota_exhausted'
      phase: PhaseId
      provider: ProviderName
      quotaKind: 'rate_limit' | 'daily_quota'
      tier: 'free' | 'paid' | 'auto'
      model: string
      /** Short SHA-256 prefix of the active key (matches Settings → API Keys
       *  → Probe). Optional — async-computed at provider construction. */
      keyFingerprint?: string
      /** Approximate count of requests sent in the last 60s, from the
       *  provider's in-memory call history. */
      requestsInLastMinute?: number
      /** Provider's published per-minute cap for (tier, model). */
      rpmCap?: number
      /** Provider's published per-minute input-token cap for (tier, model). */
      tpmCap?: number
      /** True when an auto-tier singleton has already swapped to its
       *  fallback key in this run. The dialog uses this to disable
       *  "Switch to paid" — Paid is already exhausted, so swapping back is
       *  a no-op until refreshProviders() rebuilds the singleton. */
      permanentlyOnFallback?: boolean
    }
  | {
      type: 'auto_fallback'
      phase: PhaseId
      provider: ProviderName
      reason:
        | 'hard_zero_quota'
        | 'repeated_exhaustion'
        | 'free_transient_5xx'
        | 'free_prohibited_content'
        // Claude Code chunk looked like a refusal/empty; the explicit-content
        // failsafe redid it on Gemini (permissive). Fired AFTER the redo so it
        // can carry the texts for the post-run review modal.
        | 'claude_refusal'
      /** claude_refusal only — the grounded transcript span that was refused
       *  (the "what was said"), so the review modal can show the source. */
      transcriptExcerpt?: string
      /** claude_refusal only — what Claude returned (the refusal/blank). */
      refusedText?: string
      /** claude_refusal only — what Gemini wrote in (now in the output, and
       *  the exact string the review modal find-replaces when you edit it).
       *  Empty when the refusal was NOT repaired in-run. */
      replacementText?: string
      /** claude_refusal only — false when the in-run Gemini restore did not
       *  run / failed. Drives whether a persistent RefusalRecord is recorded
       *  and whether a marker was injected into the output. */
      repaired?: boolean
      /** claude_refusal + unrepaired — stable id, also embedded in the prose
       *  marker tag; links the event to the persisted RefusalRecord. */
      refusalId?: string
      /** claude_refusal + unrepaired — total chunks in the phase, so a later
       *  repair can rebuild the per-chunk prompt ("chunk i of N"). */
      totalChunks?: number
      /** claude_refusal + unrepaired — the EXACT sentinel injected into the
       *  prose output (Phase 3) as the splice anchor. Empty for Phase 1/2/4
       *  (no inline marker). */
      marker?: string
      /** claude_refusal + unrepaired — chunk-size target used to split this
       *  phase, so a repair can re-derive sibling spans deterministically. */
      chunkSizeChars?: number
      /** Set for chunk-level fallbacks (free_transient_5xx, free_prohibited_content):
       *  the chunk index that recovered via the Paid singleton, so the
       *  diagnostic stream can pinpoint exactly where the Free key failed. */
      chunkIndex?: number
      /** Set for chunk-level fallbacks: the model id reissued via Paid. */
      model?: string
    }
  | {
      /** Layer B chunk-fusion recovery succeeded — a PROHIBITED_CONTENT
       *  block on chunk i was rescued by re-issuing with chunk[i-1] joined
       *  in to dilute the trigger below the meta-filter's concentration
       *  threshold. Fires AFTER the original call and any Free→Paid
       *  escalation both failed; lets the UI toast "Chunk N rescued via
       *  fusion (lost no content)". */
      type: 'chunk_fusion_recovered'
      phase: PhaseId
      chunkIndex: number
      model?: string
    }
  // The pipeline auto-escalated a Free-tier dispatch to Paid because the
  // chunk's model is paid-only. Surfaced to the UI as a toast so the user
  // understands WHY their Free-tier run is touching Paid quota. Today only
  // fires for Gemini (the only provider with a Free/Paid distinction in
  // this codebase).
  | {
      type: 'tier_escalated'
      phase: PhaseId
      model: string
      fromTier: 'free'
      toTier: 'paid'
      reason: 'paid_only_model_on_free_tier'
    }
  // A chunk hit a retryable error (transient 5xx, network, or rate-limit) and
  // the provider is pausing before its next attempt. The UI shows a live
  // countdown so the user knows the pipeline isn't hung. Fires once at the
  // start of each wait — UI runs its own setInterval to tick down to zero.
  // The UI dismisses the banner on the next `chunk_done` for the same phase
  // (success) or on an unhandled pipeline error (retry exhausted).
  | {
      type: 'retry_waiting'
      phase: PhaseId
      attempt: number
      maxAttempts: number
      waitMs: number
    }
  // Phase 1's speaker-detach optimization re-attached brackets to the
  // grounded output and noticed the model dropped > 15% of markers.
  // Emit so the UI can warn the user and offer a one-click opt-out
  // for the next run.
  | {
      type: 'speaker_dropout'
      phase: PhaseId
      /** Fraction in [0, 1]. UI displays as a percentage. */
      dropoutRate: number
      /** Total source lines that had a speaker bracket — the denominator
       *  of dropoutRate. Useful for the toast copy: "11 of 250 lines lost
       *  their speaker attribution." */
      sourceLines: number
    }
  // Phase 2 audit skipped a chunk because Phase 1 produced grounded text
  // byte-identical to the raw input. UI can surface "saved N API calls"
  // diagnostic so the user sees the optimisation working.
  | {
      type: 'audit_skipped'
      phase: PhaseId
      skippedChunks: number
      totalChunks: number
    }

export type PipelineCallbacks = {
  onEvent: (e: PipelineEvent) => void
  signal?: AbortSignal
}

/** Translate provider-level `onRetry` callbacks into a `retry_waiting`
 *  PipelineEvent so the UI can show a non-blocking countdown banner. The
 *  provider invokes this once per retry, before sleeping for `waitMs`. */
function retryWaitingForwarder(
  phase: PhaseId,
  callbacks: PipelineCallbacks,
): (attempt: number, waitMs: number) => void {
  return (attempt, waitMs) => {
    vlog('pipeline', { event: 'retry_waiting', phase, attempt, waitMs })
    callbacks.onEvent({
      type: 'retry_waiting',
      phase,
      attempt,
      // MAX_RETRIES is the provider-level constant; mirrored here to keep
      // the UI honest about how many more attempts are left. If a future
      // provider uses a different cap, this would need plumbing — for now
      // every cloud provider shares MAX_RETRIES = 4 from src/lib/constants.
      maxAttempts: 4,
      waitMs,
    })
  }
}

/** Translate provider-level events into pipeline events tagged with the
 *  active phase. Used by every runPhaseN's chunkedGenerate call. */
function providerEventForwarder(
  phase: PhaseId,
  callbacks: PipelineCallbacks,
): (event: ProviderEvent) => void {
  return (event) => {
    vlog('provider', { phase, event })
    if (event.kind === 'quota_exhausted') {
      callbacks.onEvent({
        type: 'quota_exhausted',
        phase,
        provider: event.provider,
        quotaKind: event.quotaKind,
        tier: event.tier,
        model: event.model,
        keyFingerprint: event.keyFingerprint,
        requestsInLastMinute: event.requestsInLastMinute,
        rpmCap: event.rpmCap,
        tpmCap: event.tpmCap,
        permanentlyOnFallback: event.permanentlyOnFallback,
      })
    } else if (event.kind === 'auto_fallback') {
      callbacks.onEvent({
        type: 'auto_fallback',
        phase,
        provider: event.provider,
        reason: event.reason,
      })
    }
  }
}

// Strip the YAML frontmatter block (the `---\n…\n---\n` fence at the top)
// from a markdown doc. Frontmatter is structured metadata for the alias
// index — the AI doesn't need to see it in the KB body, and shipping it
// costs ~3.5% more input tokens per call for no improvement in chronicle
// quality. The alias index lives in `.tusks-lore.index.json` and is the
// canonical consumer of the metadata.
const FRONTMATTER_FENCE_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n+/

function stripFrontmatterFromDoc(text: string): string {
  return text.replace(FRONTMATTER_FENCE_RE, '')
}

export function buildKbConcat(docs: KBDocument[]): string {
  return docs
    .map((d) => `### ${d.name}\n${stripFrontmatterFromDoc(d.text)}`.trim())
    .join('\n\n---\n\n')
}

// ----- JSON helpers (lenient parsers for Phase 2 / 4 output) -----

// JSON extraction helpers (stripCodeFences / extractFirstJsonBlock /
// tryParseJson) moved to ./jsonExtract so the refusal-repair runner can reuse
// the exact same parsing the JSON phases use. Imported at the top of the file.

// ----- Gemini thinking budget per-phase resolver (Phase A) -----
//
// Single source of truth for whether to pass `thinkingBudget` to the Gemini
// SDK on a given phase. The mapping is:
//
//   - Phase 3 (chronicle): ALWAYS `undefined` (SDK default = model decides).
//     This is hardcoded for voice protection — no user toggle can disable
//     thinking on the chronicle phase.
//   - Phase 1 (grounding): respects `disableThinkingOnGrounding` toggle.
//     undefined when off (existing behaviour); 0 when on (cheaper, mechanical).
//   - Phases 2 / 4 / 6: kept on SDK default for this cycle. The toggle's
//     scope is intentionally narrow on first ship — Phase 1 is the most
//     mechanical and lowest-risk phase to disable thinking on. Other phases
//     can be added later if the user opts in to a broader scope.
//
// `disableThinkingOnGrounding` defaults to false (off) per the user's hard
// constraint: existing behaviour preserved, savings opt-in.
//
// Stage 4 — extended with `perPhaseThinking` map. When a phase has an
// explicit boolean override:
//   true  → thinking ON (undefined budget = SDK default)
//   false → thinking OFF (budget = 0, cheaper)
// When the phase has NO override (undefined), fall back to the legacy
// per-phase default. Phase 3 chronicle is ALWAYS undefined (no override
// permitted — voice protection guardrail).
export function resolveThinkingBudget(
  phase: PhaseId,
  opts: {
    disableThinkingOnGrounding: boolean
    perPhaseThinking?: {
      phase1?: boolean
      phase2?: boolean
      phase4?: boolean
      phase6?: boolean
    }
  },
): number | undefined {
  if (phase === 'phase3_chronicle') return undefined
  const explicit = opts.perPhaseThinking
  if (phase === 'phase1_ground' && explicit?.phase1 !== undefined) {
    return explicit.phase1 ? undefined : 0
  }
  if (phase === 'phase2_audit' && explicit?.phase2 !== undefined) {
    return explicit.phase2 ? undefined : 0
  }
  if (phase === 'phase4_extras' && explicit?.phase4 !== undefined) {
    return explicit.phase4 ? undefined : 0
  }
  if (phase === 'phase6_condense' && explicit?.phase6 !== undefined) {
    return explicit.phase6 ? undefined : 0
  }
  // Legacy fallback — preserve today's behaviour for users who haven't
  // touched per-phase thinking.
  if (phase === 'phase1_ground' && opts.disableThinkingOnGrounding) return 0
  return undefined
}

// ----- Phases -----

export async function runPhase1(args: {
  rawTranscript: string
  kb: KBDocument[]
  callbacks: PipelineCallbacks
  startChunkIndex?: number
  priorPartial?: string
  /** Per-phase model override from the active RunSession (Step 7). */
  model?: string
  /** Optional per-phase routing target (Step 15 hybrid mode). */
  phaseTarget?: PhaseTarget
  cloudProvider?: CloudProvider
  geminiTier?: GeminiTier
  geminiPaidOnlyModels?: string[]
  allPhasesFast?: boolean
  /** Resume-only: forces the chunker to use a specific char-count
   *  instead of recomputing from (cloudProvider, geminiTier, model).
   *  Set by runFromResumeAction so chunk boundaries match the run
   *  that was paused — important when the user switched provider/tier
   *  between Pause and Resume (e.g. Free → Paid after a quota hit).
   *  Without this, the new routing would re-chunk to a different
   *  size and startChunkIndex would point at the wrong content. */
  chunkSizeChars?: number
  /** Per-run "slow down" dial from the rate-limit dialog. 1.0 (default)
   *  preserves byte-for-byte pacing. */
  safetyMultiplier?: number | (() => number)
  /** Phase A opt-in: when true, sends `thinkingBudget: 0` on every Phase 1
   *  Gemini call (disables internal reasoning). Default false (existing
   *  behaviour). Non-Gemini providers ignore. Phase 3 chronicle is
   *  hardcoded to keep thinking on regardless of this flag. */
  disableThinkingOnGrounding?: boolean
  /** Stage 1 opt-in (default false): consume the lore alias index to
   *  (a) inject canonical-name safe-replacements into preGround when an
   *  alias appears literally, and (b) annotate chunks with inline
   *  `[≈Name? NN%]` fuzzy hints for phonetic mishears the model would
   *  otherwise miss. Adds zero cost when off; zero risk of NEW wrong
   *  substitutions when on (annotations are suggestions, not edits). */
  phase1AliasHints?: boolean
  /** Resume-only (K.1.2 / B2 fix): pre-chunked grounding input captured
   *  at pause time. When present, runPhase1 SKIPS cleanupTranscript →
   *  preGround → detachSpeakers → chunkText entirely and uses these
   *  chunks directly. Required to keep chunk boundaries aligned across
   *  glossary edits that happen between pause and resume. The
   *  {@link Phase1InputSnapshot} shape carries everything the resume
   *  needs (chunks + detach state + speakersByMarker) to keep the rest
   *  of the phase byte-for-byte equivalent to the paused run. */
  inputSnapshot?: Phase1InputSnapshot
  /** Resume-only callback fired ONCE the first time runPhase1 has
   *  finished prep and knows the chunk array + speaker-detach state.
   *  RefinementTool uses this to stash the snapshot into its next
   *  checkpoint write — without it, the snapshot can't survive across
   *  pause/resume cycles. Pure observer; not invoked on the snapshot-
   *  restore path (when args.inputSnapshot was supplied). */
  onInputSnapshot?: (snapshot: Phase1InputSnapshot) => void
}): Promise<string> {
  const { rawTranscript, kb, callbacks } = args
  const phase: PhaseId = 'phase1_ground'
  const local = isLocalProvider()
  // Phase 1 grounding is a names-and-terms task — the compact glossary
  // surfaces the canonical spellings (which is all the grounder needs)
  // at ~10× lower token cost than the full prose KB. Used for BOTH
  // cloud and local; local already required compact for VRAM reasons,
  // cloud now joins it for free-tier savings. The narrative-heavy
  // phases (3 chronicle, 6 condense) get the full prose KB via
  // kbForPhase('phase3_chronicle' / 'phase6_condense', ...).
  const kbConcat = kbForPhase(phase, buildKbConcat(kb)).text

  // The user glossary is needed for per-chunk contextual hints regardless
  // of whether we ran the prep stage this invocation or are restoring it
  // from a snapshot — pickHintsFor() runs in buildRequest below.
  const glossary = await getGlossary()
  let aliasIndex: AliasIndex | null = null
  if (args.phase1AliasHints) {
    aliasIndex = await getAliasIndex()
  }

  // K.1.2 / B2: prep-stage shortcut. When resuming from a checkpoint
  // taken AFTER the first chunk completed, the run's chunk boundaries
  // were captured into `inputSnapshot`. Skipping the cleanup → preGround
  // → detachSpeakers → chunkText pipeline here is how we keep those
  // boundaries aligned even if the user edited the glossary between
  // pause and resume — the live glossary's safeReplacements would
  // produce different preGround output and shift every chunk index.
  let chunks: string[]
  let resolvedChunkSize: number
  let detached: DetachResult
  if (args.inputSnapshot) {
    chunks = args.inputSnapshot.phase1Chunks
    resolvedChunkSize = args.inputSnapshot.chunkSizeChars
    detached = {
      // `stripped` is the chunker's input; not consumed past chunkText,
      // so we don't need to reconstruct it from the chunk array.
      stripped: '',
      attached: args.inputSnapshot.detachAttached,
      speakersByMarker: new Map(
        Object.entries(args.inputSnapshot.speakersByMarker).map(([k, v]) => [Number(k), v]),
      ),
    }
    vlog('resume', {
      event: 'phase1_input_snapshot_restored',
      chunkCount: chunks.length,
      chunkSizeChars: resolvedChunkSize,
      detachAttached: detached.attached,
      speakerMarkerCount: detached.speakersByMarker.size,
    })
  } else {
    // 1. Deterministic transcript cleanup: strip [Music]/[Laughter] markers,
    //    collapse runaway fillers, normalize quotes/dashes/whitespace.
    const { text: cleaned, report: cleanupRpt } = cleanupTranscript(rawTranscript)
    if (
      cleanupRpt.markersStripped > 0 ||
      cleanupRpt.fillersCollapsed > 0 ||
      cleanupRpt.whitespaceNormalized
    ) {
      callbacks.onEvent({ type: 'cleanup', report: cleanupRpt })
    }

    // 2. Deterministic pre-grounding (script). Applies safeReplacements
    //    from the user glossary (loaded once per run) + dndDictionary.
    //    When phase1AliasHints is on, also fold in alias→canonical pairs
    //    derived from the lore frontmatter index (zero-risk: only fires on
    //    exact alias matches).
    const aliasRules = args.phase1AliasHints ? aliasIndexToSafeReplacements(aliasIndex) : []
    const allRules = combineRules([...glossary.safeReplacements, ...aliasRules])
    const { text: preGrounded, report } = preGround(cleaned, allRules)
    if (report.totalReplacements > 0) {
      callbacks.onEvent({ type: 'pre_ground', report })
    }

    // Contextual hints (e.g. "Az" vs "as") get injected into chunks that
    // actually mention the hint's canonical form or one of its common
    // mishears. buildRequest below calls pickHintsFor() per chunk so a
    // hint about "Az vs as" only ships with the chunks that contain those
    // strings. A 20-hint glossary shipping with every chunk used to cost
    // ~5 kB/chunk; the per-chunk filter drops that to ~0-1 kB. The hint
    // block lives in the user prompt (not cacheable prefix) so the
    // provider-side cache stays valid across chunks.

    // 3. Speaker detach. For Craig-style transcripts every line starts with
    //    `[CharacterName (PlayerName)]` — that bracket is deterministically
    //    reconstructable from speakers.json, so shipping it through the
    //    grounder wastes ~25-30 chars per utterance per chunk. detachSpeakers
    //    strips the bracket and injects a short `«N»` marker so we can
    //    re-prepend the bracket after the model returns. For non-Craig
    //    inputs (plain pasted text) the call short-circuits to a no-op
    //    pass-through and the byte-for-byte original prompt flows through.
    detached = detachSpeakers(preGrounded)
    const groundingInput = detached.stripped

    resolvedChunkSize =
      args.chunkSizeChars ??
      chunkSizeForPhase({
        phase: 'p1',
        cloudProvider: args.cloudProvider,
        geminiTier: args.geminiTier,
        phaseTarget: args.phaseTarget,
        model: resolvePhaseModel(args.model, 'pro'),
        allPhasesFast: args.allPhasesFast,
      })
    chunks = chunkText(groundingInput, resolvedChunkSize)

    // K.1.2 / B2: fresh-run snapshot capture. Fire ONCE after chunking
    // completes so the React layer can stash the snapshot into the next
    // checkpoint write. Without this, a subsequent pause has no way to
    // record what the model is actually being fed — which is exactly the
    // gap B2 exploits. Snapshot capture is unconditional on the no-
    // snapshot branch: even runs that never pause pay one synchronous
    // callback invocation, which is free.
    if (args.onInputSnapshot) {
      const speakersByMarkerObj: Record<string, string> = {}
      detached.speakersByMarker.forEach((bracket, marker) => {
        speakersByMarkerObj[String(marker)] = bracket
      })
      try {
        args.onInputSnapshot({
          phase1Chunks: chunks,
          chunkSizeChars: resolvedChunkSize,
          detachAttached: detached.attached,
          speakersByMarker: speakersByMarkerObj,
        })
      } catch (err) {
        // Listener errors must not fail the run. Log and continue.
        console.warn('[runPhase1] onInputSnapshot listener threw:', err)
      }
    }
  }

  const startIdx = args.startChunkIndex ?? 0
  let accumulated = args.priorPartial ?? ''

  // phase_start carries startChunkIndex so the UI primes its counter to
  // the resumed position — fresh runs default to 0, resumed runs jump
  // straight to "chunk N/M" instead of briefly showing "chunk 1/M".
  callbacks.onEvent({
    type: 'phase_start',
    phase,
    totalChunks: chunks.length,
    startChunkIndex: startIdx,
  })

  await chunkedGenerate({
    chunks,
    startChunkIndex: startIdx,
    tier: 'pro',
    modelOverride: args.model,
    phaseTarget: args.phaseTarget,
    cloudProvider: args.cloudProvider,
    geminiTier: args.geminiTier,
    geminiPaidOnlyModels: args.geminiPaidOnlyModels,
    // Grounding feeds every downstream phase, so an unrepaired refusal must
    // NOT inject a prose banner (it would pollute Phase 2/3/4). Pass the
    // ungrounded chunk through verbatim; the refusal is still recorded in the
    // manifest (marker-less) so a repair can re-ground just this span.
    refusalMarker: (i) => chunks[i],
    chunkSizeChars: resolvedChunkSize,
    buildRequest: (chunk, index, total) => {
      // Filter contextual hints to those whose canonical or mis-heard
      // forms actually appear in THIS chunk's text — drops the per-chunk
      // hint shipment from ~5 kB to ~0-1 kB without losing accuracy on
      // any hint that's actually relevant.
      const contextualHintsBlock = pickHintsFor(chunk, glossary.contextualHints)
      // Fuzzy alias hints — only on when phase1AliasHints toggle is set.
      // The annotated chunk has inline [≈Name? NN%] markers that the
      // prompt's rule #8 teaches the model to interpret + strip.
      const chunkForPrompt = args.phase1AliasHints && aliasIndex
        ? annotateChunk(chunk, aliasIndex).annotated
        : chunk
      const promptArgs = {
        chunk: chunkForPrompt,
        kbConcat,
        index,
        total,
        contextualHintsBlock,
        stripped: detached.attached,
      }
      const phaseIsLocal = local || args.phaseTarget?.target === 'local'
      if (phaseIsLocal) {
        return { systemPrompt: '', userPrompt: phase1GroundLocal(promptArgs) }
      }
      // Cloud: stable cacheable prefix (system + KB + rules) + per-chunk
      // user prompt (chunk-relevant hints + chunk body). The prefix is
      // byte-identical across chunks so provider-side caching (Gemini
      // cachedContent, Claude ephemeral, OpenAI auto) amortises across
      // calls.
      const parts = phase1GroundParts(promptArgs)
      return { systemPrompt: '', cacheablePrefix: parts.cacheablePrefix, userPrompt: parts.userPrompt }
    },
    onChunkDone: (absoluteIndex, text) => {
      accumulated = accumulated ? `${accumulated}\n\n${text.trim()}` : text.trim()
      callbacks.onEvent({
        type: 'chunk_done',
        phase,
        index: absoluteIndex,
        totalChunks: chunks.length,
        partial: accumulated,
      })
    },
    signal: callbacks.signal,
    onCountdown: (ms) => callbacks.onEvent({ type: 'countdown', phase, msRemaining: ms }),
    onProviderEvent: providerEventForwarder(phase, callbacks),
    onRetry: retryWaitingForwarder(phase, callbacks),
    safetyMultiplier: args.safetyMultiplier,
    contextLabel: (absoluteIndex) =>
      `Phase 1 (Grounding) — chunk ${absoluteIndex + 1}/${chunks.length}`,
    phaseId: phase,
    onPipelineEvent: callbacks.onEvent,
    thinkingBudget: resolveThinkingBudget(phase, {
      disableThinkingOnGrounding: args.disableThinkingOnGrounding ?? false,
    }),
  })

  // Re-prepend speaker brackets if detach was active. When dropoutRate is
  // high the model lost a lot of markers — surface a warning so the user
  // can disable the optimization next run if attribution quality suffers.
  let finalGrounded = accumulated
  if (detached.attached) {
    const reattached = reattachSpeakers(accumulated, detached)
    finalGrounded = reattached.transcript
    if (reattached.dropoutRate > 0.15) {
      callbacks.onEvent({
        type: 'speaker_dropout',
        phase,
        dropoutRate: reattached.dropoutRate,
        sourceLines: detached.speakersByMarker.size,
      })
    }
  }

  callbacks.onEvent({ type: 'phase_complete', phase })
  return finalGrounded
}

export async function runPhase2(args: {
  rawTranscript: string
  groundedTranscript: string
  callbacks: PipelineCallbacks
  model?: string
  phaseTarget?: PhaseTarget
  cloudProvider?: CloudProvider
  geminiTier?: GeminiTier
  geminiPaidOnlyModels?: string[]
  allPhasesFast?: boolean
  safetyMultiplier?: number | (() => number)
}): Promise<DMQuestion[]> {
  const { rawTranscript, groundedTranscript, callbacks } = args
  const phase: PhaseId = 'phase2_audit'

  // Pair raw and grounded by re-chunking each on the same target.
  // We assume both align well enough at the chunk boundary; any drift is
  // tolerable since Phase 2 is advisory (it asks questions, doesn't transform).
  const phase2ChunkSize = chunkSizeForPhase({
    phase: 'p2',
    cloudProvider: args.cloudProvider,
    geminiTier: args.geminiTier,
    phaseTarget: args.phaseTarget,
    model: resolvePhaseModel(args.model, 'pro'),
    allPhasesFast: args.allPhasesFast,
  })
  const rawChunks = chunkText(rawTranscript, phase2ChunkSize)
  const groundedChunks = chunkText(groundedTranscript, phase2ChunkSize)
  const total = Math.min(rawChunks.length, groundedChunks.length)

  callbacks.onEvent({ type: 'phase_start', phase, totalChunks: total })

  const allQuestions: DMQuestion[] = []
  const phase2Local = isLocalProvider()
  const placeholderChunks = Array.from({ length: total }, () => '')

  // Audit-skip: when Phase 1 produced grounded text byte-identical to
  // the raw input for a chunk, there's nothing for the audit to flag —
  // the model would return `[]` after a full prompt round trip. Pre-
  // compute the diff so chunkedGenerate can skip the API call entirely.
  // Whitespace normalisation handles trailing-newline differences that
  // wouldn't affect content judgement.
  const normalise = (s: string) => s.replace(/\s+/g, ' ').trim()
  const skipMask = new Array<boolean>(total)
  let skippedCount = 0
  for (let i = 0; i < total; i++) {
    if (normalise(rawChunks[i]) === normalise(groundedChunks[i])) {
      skipMask[i] = true
      skippedCount += 1
    }
  }

  await chunkedGenerate({
    chunks: placeholderChunks,
    tier: 'pro',
    modelOverride: args.model,
    phaseTarget: args.phaseTarget,
    cloudProvider: args.cloudProvider,
    geminiTier: args.geminiTier,
    geminiPaidOnlyModels: args.geminiPaidOnlyModels,
    shouldSkip: (i) => skipMask[i] === true,
    skipText: () => '[]', // empty JSON array — the parser below recognises it
    // Audit phase produces optional clarification questions; a chunk Gemini
    // rejects with PROHIBITED_CONTENT (combat/violence in D&D transcripts
    // trips this on Flash models) becomes `[]` instead of failing the run.
    softSkipOnProhibitedContent: true,
    // JSON phase: an unrepaired Claude refusal becomes a valid empty array
    // (no inline banner — it would break parsing). The grounded span + chunk
    // size are recorded so a repair can re-run the audit on just this chunk.
    refusalMarker: () => '[]',
    refusalSourceSpan: (i) => groundedChunks[i],
    chunkSizeChars: phase2ChunkSize,
    buildRequest: (_chunk, index) => {
      const promptArgs = {
        rawChunk: rawChunks[index],
        groundedChunk: groundedChunks[index],
        index,
        total,
      }
      // Local model: aggressive uncertainty surfacing. Cloud: conservative
      // (only ask when truly necessary). Same JSON output shape.
      const userPrompt = phase2Local ? phase2AuditLocal(promptArgs) : phase2Audit(promptArgs)
      return { systemPrompt: '', userPrompt }
    },
    // Layer B fusion fallback — when PROHIBITED_CONTENT trips on chunk i
    // (concentration-based meta-filter), retry with chunk[i-1]+chunk[i]
    // joined to dilute the trigger. Chunk 0 has no previous to fuse with;
    // returning null lets chunkedGenerate fall through to soft-skip. The
    // resulting questions are deduped in onChunkDone (some may already
    // exist from the successful chunk[i-1] run).
    buildFusedRequestOnBlock: (index) => {
      if (index === 0) return null
      const fusedRaw = rawChunks[index - 1] + '\n\n' + rawChunks[index]
      const fusedGrounded = groundedChunks[index - 1] + '\n\n' + groundedChunks[index]
      const promptArgs = {
        rawChunk: fusedRaw,
        groundedChunk: fusedGrounded,
        index,
        total,
      }
      const userPrompt = phase2Local ? phase2AuditLocal(promptArgs) : phase2Audit(promptArgs)
      return { systemPrompt: '', userPrompt }
    },
    onChunkDone: (absoluteIndex, text) => {
      const parsed = tryParseJson<DMQuestion[]>(text, '[')
      if (Array.isArray(parsed)) {
        const cleaned = parsed
          .filter((q) => q && typeof q === 'object' && q.question)
          .map((q, j) => ({
            id: q.id || `q-${absoluteIndex + 1}-${j + 1}`,
            question: q.question,
            context: q.context,
          }))
        // Dedup by normalised question text — Layer B fusion fallback may
        // re-emit chunk[i-1]'s questions when it joins them with chunk[i]
        // to dilute a meta-filter trigger. Without dedup the user would
        // see the same DM question twice in the clarification modal.
        const seen = new Set(allQuestions.map((q) => q.question.trim().toLowerCase()))
        const novel = cleaned.filter((q) => !seen.has(q.question.trim().toLowerCase()))
        allQuestions.push(...novel)
      } else {
        console.warn(`[phase2] chunk ${absoluteIndex} returned non-JSON; skipping. Raw:`, text.slice(0, 200))
      }
      callbacks.onEvent({
        type: 'chunk_done',
        phase,
        index: absoluteIndex,
        totalChunks: total,
        partial: JSON.stringify(allQuestions, null, 2),
      })
    },
    signal: callbacks.signal,
    onCountdown: (ms) => callbacks.onEvent({ type: 'countdown', phase, msRemaining: ms }),
    onProviderEvent: providerEventForwarder(phase, callbacks),
    onRetry: retryWaitingForwarder(phase, callbacks),
    safetyMultiplier: args.safetyMultiplier,
    contextLabel: (absoluteIndex) => `Phase 2 (Audit) — chunk ${absoluteIndex + 1}/${total}`,
    phaseId: phase,
    onPipelineEvent: callbacks.onEvent,
  })

  if (skippedCount > 0) {
    callbacks.onEvent({
      type: 'audit_skipped',
      phase,
      skippedChunks: skippedCount,
      totalChunks: total,
    })
  }

  callbacks.onEvent({ type: 'phase_complete', phase })
  return allQuestions
}

export async function runPhase3(args: {
  groundedTranscript: string
  dmQuestions: DMQuestion[]
  dmAnswers: DMAnswers
  kb: KBDocument[]
  callbacks: PipelineCallbacks
  startChunkIndex?: number
  priorPartial?: string
  model?: string
  phaseTarget?: PhaseTarget
  cloudProvider?: CloudProvider
  geminiTier?: GeminiTier
  geminiPaidOnlyModels?: string[]
  allPhasesFast?: boolean
  /** Resume-only: forces the chunker to a specific char-count so
   *  boundaries match the paused run when the user has switched
   *  routing between Pause and Resume. See runPhase1's doc. */
  chunkSizeChars?: number
  /** Optional persona templates from the personas add-on. When provided,
   *  the locked bard prompt is replaced by the matching slot for the
   *  cloud-vs-local path. */
  personaTemplates?: { cloud?: string; local?: string }
  safetyMultiplier?: number | (() => number)
}): Promise<string> {
  const { groundedTranscript, dmQuestions, dmAnswers, kb, callbacks } = args
  const phase: PhaseId = 'phase3_chronicle'
  const local = isLocalProvider()
  const personaTemplate = local ? args.personaTemplates?.local : args.personaTemplates?.cloud
  const chunks = chunkText(
    groundedTranscript,
    args.chunkSizeChars ??
      chunkSizeForPhase({
        phase: 'p3',
        cloudProvider: args.cloudProvider,
        geminiTier: args.geminiTier,
        phaseTarget: args.phaseTarget,
        model: resolvePhaseModel(args.model, 'pro'),
        allPhasesFast: args.allPhasesFast,
      }),
  )

  const startIdx = args.startChunkIndex ?? 0
  // Per-chunk output texts indexed by absolute chunk index. Required so
  // Layer-B fusion (chunk i+i-1 joined) can REPLACE the previous chunk's
  // prose contribution without leaving it duplicated in `accumulated`.
  // Pre-seeded with priorPartial split at chunk_done separators is not
  // possible (we don't know which chunks the partial covered), so we
  // treat priorPartial as a single opaque "before startIdx" block at
  // index -1; the rebuild concatenates it before the fresh chunks.
  const chunkOutputs: string[] = []
  const resumePartial = args.priorPartial ?? ''
  const rebuildAccumulated = (): string => {
    const fresh = chunkOutputs.filter((t) => t && t.length > 0).join('\n\n')
    if (resumePartial && fresh) return `${resumePartial}\n\n${fresh}`
    return resumePartial || fresh
  }

  // phase_start carries the resumed startChunkIndex so the UI counter
  // matches where the loop will actually begin processing.
  callbacks.onEvent({
    type: 'phase_start',
    phase,
    totalChunks: chunks.length,
    startChunkIndex: startIdx,
  })

  // Local needs canonical-names glossary in every chunk's prompt for spelling
  // discipline; cloud's chronicle prompt didn't include the KB at all (Phase 1
  // already grounded it). For local, the model is less reliable so we keep
  // reminding it of the canonical spellings.
  const localKbConcat = local ? compactKb(buildKbConcat(kb)).text : ''

  await chunkedGenerate({
    chunks,
    startChunkIndex: startIdx,
    tier: 'pro',
    modelOverride: args.model,
    phaseTarget: args.phaseTarget,
    cloudProvider: args.cloudProvider,
    geminiTier: args.geminiTier,
    geminiPaidOnlyModels: args.geminiPaidOnlyModels,
    buildRequest: (chunk, index, total) => {
      const priorTail = rebuildAccumulated().slice(-2000)
      if (local) {
        const userPrompt = phase3ChronicleLocal({
          groundedChunk: chunk,
          dmAnswers,
          dmQuestions,
          kbConcat: localKbConcat,
          index,
          total,
          priorTail,
          personaTemplate,
        })
        return { systemPrompt: '', userPrompt }
      }
      // Cloud: split into a stable cacheable prefix (rules + DM Q&A) and a
      // per-chunk user prompt (prior tail + grounded chunk). Persona templates
      // opt out via an empty prefix.
      const parts = phase3ChronicleParts({
        groundedChunk: chunk,
        dmAnswers,
        dmQuestions,
        index,
        total,
        priorTail,
        personaTemplate,
      })
      return { systemPrompt: '', cacheablePrefix: parts.cacheablePrefix, userPrompt: parts.userPrompt }
    },
    onChunkDone: (absoluteIndex, text) => {
      chunkOutputs[absoluteIndex] = text.trim()
      callbacks.onEvent({
        type: 'chunk_done',
        phase,
        index: absoluteIndex,
        totalChunks: chunks.length,
        partial: rebuildAccumulated(),
      })
    },
    // Layer B fusion — when chunk i hits PROHIBITED_CONTENT, retry with
    // chunks[i-1]+chunks[i] joined to dilute the meta-filter trigger.
    // Chunk 0 has no previous to fuse with; returning null lets the cascade
    // throw (Phase 3 has no soft-skip — silent hole in prose would be worse
    // than failing loud). The fused chunk reuses chunks BEFORE i-1 for the
    // priorTail since chunk i-1's output will be discarded by onChunksFused.
    buildFusedRequestOnBlock: (index, total) => {
      if (index === 0) return null
      const fusedChunk = chunks[index - 1] + '\n\n' + chunks[index]
      // priorTail excludes chunkOutputs[index - 1] since the fused regen
      // covers chunks i-1 AND i; using i-1's output here would double-count.
      const priorTextParts = chunkOutputs
        .slice(0, index - 1)
        .filter((t) => t && t.length > 0)
      const priorContext = resumePartial
        ? (priorTextParts.length > 0 ? `${resumePartial}\n\n${priorTextParts.join('\n\n')}` : resumePartial)
        : priorTextParts.join('\n\n')
      const priorTail = priorContext.slice(-2000)
      if (local) {
        const userPrompt = phase3ChronicleLocal({
          groundedChunk: fusedChunk,
          dmAnswers,
          dmQuestions,
          kbConcat: localKbConcat,
          index,
          total,
          priorTail,
          personaTemplate,
        })
        return { systemPrompt: '', userPrompt }
      }
      const parts = phase3ChronicleParts({
        groundedChunk: fusedChunk,
        dmAnswers,
        dmQuestions,
        index,
        total,
        priorTail,
        personaTemplate,
      })
      return { systemPrompt: '', cacheablePrefix: parts.cacheablePrefix, userPrompt: parts.userPrompt }
    },
    // Replace BOTH chunks' contributions when fusion recovers — the fused
    // output covers prevIndex AND currentIndex, so chunkOutputs[prevIndex]
    // must be cleared to avoid duplicating that narrative.
    onChunksFused: (prevIndex, currentIndex, fusedText) => {
      chunkOutputs[prevIndex] = ''
      chunkOutputs[currentIndex] = fusedText.trim()
      callbacks.onEvent({
        type: 'chunk_done',
        phase,
        index: currentIndex,
        totalChunks: chunks.length,
        partial: rebuildAccumulated(),
      })
    },
    signal: callbacks.signal,
    onCountdown: (ms) => callbacks.onEvent({ type: 'countdown', phase, msRemaining: ms }),
    onProviderEvent: providerEventForwarder(phase, callbacks),
    onRetry: retryWaitingForwarder(phase, callbacks),
    safetyMultiplier: args.safetyMultiplier,
    contextLabel: (absoluteIndex) =>
      `Phase 3 (Chronicle) — chunk ${absoluteIndex + 1}/${chunks.length}`,
    phaseId: phase,
    onPipelineEvent: callbacks.onEvent,
  })

  callbacks.onEvent({ type: 'phase_complete', phase })
  return rebuildAccumulated()
}

export async function runPhase4(args: {
  groundedTranscript: string
  dmAnswers: DMAnswers
  callbacks: PipelineCallbacks
  startChunkIndex?: number
  priorExtras?: ExtrasOutput
  model?: string
  phaseTarget?: PhaseTarget
  cloudProvider?: CloudProvider
  geminiTier?: GeminiTier
  geminiPaidOnlyModels?: string[]
  allPhasesFast?: boolean
  /** Resume-only chunk-size override. See runPhase1's doc. */
  chunkSizeChars?: number
  safetyMultiplier?: number | (() => number)
  /** Stage 4: per-phase thinking-budget override. true = thinking on
   *  (slower + better extraction quality, ~3× output token cost),
   *  false = thinking off (cheaper), undefined = legacy default. */
  thinkingOn?: boolean
  /** Reforge-only: what `groundedTranscript` actually IS. 'chronicle' tells the
   *  cloud extras prompt it's reading finished narrative prose (cheaper, lossier
   *  source) rather than a bracketed transcript. Default 'transcript'. */
  extrasSourceKind?: 'transcript' | 'chronicle'
  /** settings.reassembleQuotes (default false). Lets the cloud extras prompt
   *  rejoin Whisper's ~2s fragments into complete sentences instead of quoting
   *  them raw. Ignored by the local prompt variant. */
  reassembleQuotes?: boolean
}): Promise<ExtrasOutput> {
  const { groundedTranscript, dmAnswers, callbacks } = args
  const phase: PhaseId = 'phase4_extras'
  const phase4ChunkSize =
    args.chunkSizeChars ??
    chunkSizeForPhase({
      phase: 'p4',
      cloudProvider: args.cloudProvider,
      geminiTier: args.geminiTier,
      phaseTarget: args.phaseTarget,
      model: resolvePhaseModel(args.model, 'pro'),
      allPhasesFast: args.allPhasesFast,
    })
  const chunks = chunkText(groundedTranscript, phase4ChunkSize)

  const startIdx = args.startChunkIndex ?? 0
  callbacks.onEvent({
    type: 'phase_start',
    phase,
    totalChunks: chunks.length,
    startChunkIndex: startIdx,
  })

  const accumulated: ExtrasOutput = args.priorExtras
    ? {
        jests: [...args.priorExtras.jests],
        gore: [...args.priorExtras.gore],
        quotes: [...args.priorExtras.quotes],
      }
    : { jests: [], gore: [], quotes: [] }

  const local = isLocalProvider()
  await chunkedGenerate({
    chunks,
    startChunkIndex: startIdx,
    tier: 'pro',
    modelOverride: args.model,
    phaseTarget: args.phaseTarget,
    cloudProvider: args.cloudProvider,
    geminiTier: args.geminiTier,
    geminiPaidOnlyModels: args.geminiPaidOnlyModels,
    // Extras (quotes / jests / gore) is JSON-shaped per chunk. A blocked
    // chunk becomes an empty extras object — the other chunks still produce
    // their share. The skipText must parse as a valid Phase 4 payload so
    // tryParseJson<ExtrasOutput> in onChunkDone returns a usable object.
    softSkipOnProhibitedContent: true,
    skipText: () => '{"jests":[],"gore":[],"quotes":[]}',
    // JSON phase: an unrepaired Claude refusal becomes a valid empty extras
    // object (no inline banner). chunks here ARE the grounded spans, so the
    // default sourceSpan is correct; record the size for a faithful repair.
    refusalMarker: () => '{"jests":[],"gore":[],"quotes":[]}',
    chunkSizeChars: phase4ChunkSize,
    buildRequest: (chunk, index, total) => {
      const promptArgs = {
        groundedChunk: chunk,
        dmAnswers,
        index,
        total,
      }
      const phaseIsLocal = local || args.phaseTarget?.target === 'local'
      const userPrompt = phaseIsLocal
        ? phase4ExtrasLocal(promptArgs)
        : phase4Extras({
            ...promptArgs,
            sourceKind: args.extrasSourceKind,
            reassemble: args.reassembleQuotes,
          })
      return { systemPrompt: '', userPrompt }
    },
    // Layer B fusion fallback — see runPhase2 for the design notes. Phase 4
    // dedup happens in onChunkDone below (quote: speaker+line; jest/gore:
    // exact-text). Chunk 0 returns null → fall through to soft-skip.
    buildFusedRequestOnBlock: (index, total) => {
      if (index === 0) return null
      const fusedChunk = chunks[index - 1] + '\n\n' + chunks[index]
      const promptArgs = {
        groundedChunk: fusedChunk,
        dmAnswers,
        index,
        total,
      }
      const phaseIsLocal = local || args.phaseTarget?.target === 'local'
      const userPrompt = phaseIsLocal
        ? phase4ExtrasLocal(promptArgs)
        : phase4Extras({
            ...promptArgs,
            sourceKind: args.extrasSourceKind,
            reassemble: args.reassembleQuotes,
          })
      return { systemPrompt: '', userPrompt }
    },
    onChunkDone: (absoluteIndex, text) => {
      const parsed = tryParseJson<ExtrasOutput>(text, '{')
      if (parsed) {
        // Layer B fusion dedup: when chunk i recovers via fusion with
        // chunk i-1, the response may re-emit i-1's extras. Dedup by
        // string equality (jest/gore) and speaker+line (quotes, including
        // each turn of an exchange) so the final extras card doesn't
        // double-count.
        const seenJests = new Set(accumulated.jests)
        const seenGore = new Set(accumulated.gore)
        if (Array.isArray(parsed.jests)) {
          accumulated.jests.push(
            ...parsed.jests.filter((j): j is string => Boolean(j) && !seenJests.has(j)),
          )
        }
        if (Array.isArray(parsed.gore)) {
          accumulated.gore.push(
            ...parsed.gore.filter((g): g is string => Boolean(g) && !seenGore.has(g)),
          )
        }
        accumulated.quotes = appendNovelQuotes(accumulated.quotes, normalizeQuotes(parsed.quotes))
      } else {
        console.warn(`[phase4] chunk ${absoluteIndex} returned non-JSON; skipping. Raw:`, text.slice(0, 200))
      }
      callbacks.onEvent({
        type: 'chunk_done',
        phase,
        index: absoluteIndex,
        totalChunks: chunks.length,
        partial: JSON.stringify(accumulated, null, 2),
      })
    },
    signal: callbacks.signal,
    onCountdown: (ms) => callbacks.onEvent({ type: 'countdown', phase, msRemaining: ms }),
    onProviderEvent: providerEventForwarder(phase, callbacks),
    onRetry: retryWaitingForwarder(phase, callbacks),
    safetyMultiplier: args.safetyMultiplier,
    contextLabel: (absoluteIndex) =>
      `Phase 4 (Extras) — chunk ${absoluteIndex + 1}/${chunks.length}`,
    phaseId: phase,
    onPipelineEvent: callbacks.onEvent,
    thinkingBudget: resolveThinkingBudget(phase, {
      disableThinkingOnGrounding: false,
      perPhaseThinking: { phase4: args.thinkingOn },
    }),
  })

  callbacks.onEvent({ type: 'phase_complete', phase })
  return accumulated
}

/**
 * Final review sweep over the chronicle. Runs only for local providers — the
 * cloud chronicle from Phase 3 is already high quality. The polish pass
 * catches residual lore-spelling errors that crept in chunk-by-chunk, smooths
 * rough chunk-boundary transitions, removes OOC residue that slipped past
 * Phase 3's filter, and tightens verbose sections.
 *
 * Re-uses the compact-KB glossary so the polish prompt stays in budget for
 * a 16k-context local model.
 */
export async function runPhase5Polish(args: {
  chronicle: string
  kb: KBDocument[]
  callbacks: PipelineCallbacks
  /** Optional persona template (local-only — phase 5 never runs cloud). */
  personaTemplate?: string
  safetyMultiplier?: number | (() => number)
}): Promise<string> {
  const { chronicle, kb, callbacks, personaTemplate } = args
  const phase: PhaseId = 'phase5_polish'

  // Cloud doesn't need polish — its chronicle is already accurate. Pass through.
  if (!isLocalProvider()) return chronicle

  if (!chronicle.trim()) return chronicle

  const kbConcat = compactKb(buildKbConcat(kb)).text
  // Phase 5 is local-only by design — runs only when the active provider is
  // a local model. Always use the local chunk size.
  const chunks = chunkText(chronicle, chunkSizeForPhase({ phase: 'p5' }))

  callbacks.onEvent({ type: 'phase_start', phase, totalChunks: chunks.length })

  let polished = ''

  await chunkedGenerate({
    chunks,
    tier: 'pro',
    buildRequest: (chunk, index, total) => {
      const priorTail = polished.slice(-1500)
      const userPrompt = phase5PolishLocal({
        chronicleChunk: chunk,
        kbConcat,
        index,
        total,
        priorTail,
        personaTemplate,
      })
      return { systemPrompt: '', userPrompt }
    },
    onChunkDone: (absoluteIndex, text) => {
      polished = polished ? `${polished}\n\n${text.trim()}` : text.trim()
      callbacks.onEvent({
        type: 'chunk_done',
        phase,
        index: absoluteIndex,
        totalChunks: chunks.length,
        partial: polished,
      })
    },
    signal: callbacks.signal,
    onCountdown: (ms) => callbacks.onEvent({ type: 'countdown', phase, msRemaining: ms }),
    onProviderEvent: providerEventForwarder(phase, callbacks),
    onRetry: retryWaitingForwarder(phase, callbacks),
    safetyMultiplier: args.safetyMultiplier,
    contextLabel: (absoluteIndex) =>
      `Phase 5 (Polish) — chunk ${absoluteIndex + 1}/${chunks.length}`,
    phaseId: phase,
    onPipelineEvent: callbacks.onEvent,
  })

  callbacks.onEvent({ type: 'phase_complete', phase })
  return polished
}

/**
 * Phase 6 — Condense. Optional final pass triggered by the user from the
 * Chronicle view. Takes the finished chronicle and produces:
 *
 *   - narrative: a tightened retelling (~30–50% of the original)
 *   - bulletPoints: 10–15 catch-up bullets for someone who missed
 *
 * Unlike Phase 4 (which accumulates per-chunk JSON arrays), Phase 6
 * concatenates per-chunk narratives and merges per-chunk bullets. In
 * the common case where the chronicle fits in one chunk this is a
 * single LLM call.
 */
export async function runPhase6(args: {
  chronicle: string
  kb: KBDocument[]
  dmAnswers: DMAnswers
  campaign: string
  sessionNumber: number
  callbacks: PipelineCallbacks
  model?: string
  phaseTarget?: PhaseTarget
  cloudProvider?: CloudProvider
  geminiTier?: GeminiTier
  geminiPaidOnlyModels?: string[]
  allPhasesFast?: boolean
  personaTemplates?: { cloud?: string; local?: string }
  /** Lore alias index, for vault-agnostic KB retrieval. Optional: retrieval
   *  falls back to note-title matching when absent. */
  aliasIndex?: AliasIndex | null
  /** settings.retrieveVaultKb (default false). When on, the cloud condense
   *  prompt receives only the lore the chronicle actually references instead
   *  of the entire vault. Measured on Session 29: 2,228,864 -> 176,196 chars
   *  (-92%) with 17/17 referenced entities still present. */
  retrieveVaultKb?: boolean
  /** Context window of the Phase 6 model, in tokens, when it is known.
   *  Sourced from a provider catalogue; null/undefined for providers that
   *  publish no such figure. When the full vault cannot fit this window,
   *  retrieval turns itself on — otherwise the call is simply impossible on
   *  any model smaller than about 1M tokens. */
  modelContextTokens?: number | null
  safetyMultiplier?: number | (() => number)
  /** Stage 4: per-phase thinking override. Especially useful here —
   *  Phase 6 condense quality on Flash-Lite undershoots length targets;
   *  flipping thinking ON brings it close to Pro at much lower cost. */
  thinkingOn?: boolean
  /** v1.1.0+: explicit word-count target from the Condense Slider. When
   *  omitted, the prompt falls back to the legacy `min(2000, 25%)` formula
   *  so existing pause/resume checkpoints (no slider value persisted) keep
   *  working. Computed at session-build-time as
   *  `Math.round(chronicleWordCount * sliderPercentage / 100)`. */
  targetWordCount?: number
}): Promise<CondenseOutput> {
  const { chronicle, kb, dmAnswers, campaign, sessionNumber, callbacks } = args
  const phase: PhaseId = 'phase6_condense'

  if (!chronicle.trim()) {
    return { narrative: '', bulletPoints: [] }
  }

  const local = isLocalProvider() || args.phaseTarget?.target === 'local'
  const personaTemplate = local ? args.personaTemplates?.local : args.personaTemplates?.cloud
  // Phase 6 is the only cloud phase handed the FULL vault (Phase 3 sends no
  // KB; 1/2/4 send compactKb). On the reference vault that is ~557k tokens
  // per call to condense an already-written chronicle. Retrieval narrows it
  // to the notes the chronicle actually references — see vaultRetrieval.ts
  // for the safety invariant that keeps this from dropping grounding.
  const fullKbChars = kb.reduce((sum, d) => sum + (d.text?.length ?? 0), 0)
  const retrievalDecision = local
    ? { retrieve: false, reason: 'fits' as const }
    : shouldRetrieveVaultKb({
        userEnabled: args.retrieveVaultKb === true,
        kbChars: fullKbChars,
        chunkChars: chunkSizeForPhase({
          phase: 'p6',
          cloudProvider: args.cloudProvider,
          geminiTier: args.geminiTier,
          phaseTarget: args.phaseTarget,
          model: resolvePhaseModel(args.model, 'pro'),
          allPhasesFast: args.allPhasesFast,
        }),
        overheadChars: PHASE6_PROMPT_OVERHEAD_CHARS,
        contextLength: args.modelContextTokens ?? null,
      })

  const retrieval = retrievalDecision.retrieve
    ? retrieveForText(chronicle, kb, { index: args.aliasIndex ?? null })
    : null
  const retrievedKb = retrieval ? retrieval.docs : kb

  // Retrieval telemetry. Previously the whole stats block was discarded by
  // this, its only caller, so there was no way to tell whether a -92% payload
  // reduction had also dropped a note the chronicle needed. Recall is the one
  // thing that matters here and it was the one thing unmeasured.
  vlog('pipeline', {
    event: 'phase6_kb_retrieval',
    decision: retrievalDecision.reason,
    applied: retrievalDecision.retrieve,
    modelContextTokens: args.modelContextTokens ?? null,
    fullKbChars,
    ...(retrieval
      ? {
          selectedChars: retrieval.stats.selectedChars,
          totalChars: retrieval.stats.totalChars,
          selectedDocs: retrieval.stats.selectedDocs,
          totalDocs: retrieval.stats.totalDocs,
          literalMatches: retrieval.stats.literalMatches,
          coreDocs: retrieval.stats.coreDocs,
          carriedDocs: retrieval.stats.carriedDocs,
          droppedForBudget: retrieval.stats.droppedForBudget,
          matchedEntityCount: retrieval.matchedEntities.length,
        }
      : {}),
  })

  const kbConcat = local
    ? compactKb(buildKbConcat(kb)).text
    : buildKbConcat(retrievedKb)
  const chunks = chunkText(
    chronicle,
    chunkSizeForPhase({
      phase: 'p6',
      cloudProvider: args.cloudProvider,
      geminiTier: args.geminiTier,
      phaseTarget: args.phaseTarget,
      model: resolvePhaseModel(args.model, 'pro'),
      allPhasesFast: args.allPhasesFast,
    }),
  )

  callbacks.onEvent({ type: 'phase_start', phase, totalChunks: chunks.length })

  const accumulated: CondenseOutput = { narrative: '', bulletPoints: [] }

  // The explicit targetWordCount is a whole-output target, but condense runs
  // once per chunk and the per-chunk outputs are concatenated. Stamping the
  // full target into every chunk's prompt would scale the total by the chunk
  // count — and the chunk count is provider/model-dependent (Gemini paid
  // condenses in larger chunks than Claude), so the same slider value produced
  // different lengths on different providers. Split the target proportionally
  // by each chunk's share of the chronicle so the concatenated total lands on
  // the target regardless of how many chunks it took. Single chunk → full
  // target (unchanged). The legacy formula (targetWordCount omitted) is left
  // alone: "25% of the chronicle" already self-normalizes because each chunk
  // sees only its own slice.
  const totalChars = chunks.reduce((sum, c) => sum + c.length, 0)
  const perChunkTarget = (chunk: string): number | undefined =>
    proportionalChunkTarget(args.targetWordCount, chunk.length, totalChars)

  await chunkedGenerate({
    chunks,
    tier: 'pro',
    modelOverride: args.model,
    phaseTarget: args.phaseTarget,
    cloudProvider: args.cloudProvider,
    geminiTier: args.geminiTier,
    geminiPaidOnlyModels: args.geminiPaidOnlyModels,
    // JSON phase: an unrepaired Claude refusal becomes a valid empty condense
    // object (no inline banner). chunks ARE the chronicle spans → default
    // sourceSpan is correct; a repair re-condenses just this span.
    refusalMarker: () => '{"narrative":"","bulletPoints":[]}',
    buildRequest: (chunk) => {
      const promptArgs = {
        chronicle: chunk,
        campaign,
        sessionNumber,
        kbConcat,
        dmAnswers,
        personaTemplate,
        // Whole-run target stays stable across chunks (cacheable prefix);
        // the per-chunk share rides in the user prompt.
        targetWordCount: args.targetWordCount,
        chunkTargetWordCount: perChunkTarget(chunk),
      }
      if (local) {
        return { systemPrompt: '', userPrompt: phase6CondenseLocal(promptArgs) }
      }
      // Cloud: split into a stable cacheable prefix (KB + DM Q&A + format
      // spec + target word count) and a per-chunk user prompt (campaign +
      // chronicle chunk). The target lives in the prefix so it's part of
      // the cache key — different slider positions produce different cache
      // entries, which is the intended behaviour.
      const parts = phase6CondenseParts(promptArgs)
      return { systemPrompt: '', cacheablePrefix: parts.cacheablePrefix, userPrompt: parts.userPrompt }
    },
    onChunkDone: (absoluteIndex, text) => {
      const parsed = tryParseJson<CondenseOutput>(text, '{')
      if (parsed) {
        if (typeof parsed.narrative === 'string' && parsed.narrative.trim()) {
          accumulated.narrative = accumulated.narrative
            ? `${accumulated.narrative}\n\n${parsed.narrative.trim()}`
            : parsed.narrative.trim()
        }
        if (Array.isArray(parsed.bulletPoints)) {
          accumulated.bulletPoints.push(
            ...parsed.bulletPoints
              .filter((b): b is string => typeof b === 'string' && b.trim().length > 0)
              .map((b) => b.trim())
          )
        }
      } else {
        console.warn(`[phase6] chunk ${absoluteIndex} returned non-JSON; skipping. Raw:`, text.slice(0, 200))
      }
      callbacks.onEvent({
        type: 'chunk_done',
        phase,
        index: absoluteIndex,
        totalChunks: chunks.length,
        partial: JSON.stringify(accumulated, null, 2),
      })
    },
    signal: callbacks.signal,
    onCountdown: (ms) => callbacks.onEvent({ type: 'countdown', phase, msRemaining: ms }),
    onProviderEvent: providerEventForwarder(phase, callbacks),
    onRetry: retryWaitingForwarder(phase, callbacks),
    safetyMultiplier: args.safetyMultiplier,
    contextLabel: (absoluteIndex) =>
      `Phase 6 (Condense) — chunk ${absoluteIndex + 1}/${chunks.length}`,
    phaseId: phase,
    onPipelineEvent: callbacks.onEvent,
    thinkingBudget: resolveThinkingBudget(phase, {
      disableThinkingOnGrounding: false,
      perPhaseThinking: { phase6: args.thinkingOn },
    }),
  })

  // v1.1.0 — boundary-event bullet dedup. When chunk N+1 starts with the
  // same event chunk N ended on, the per-chunk condense often emits the
  // event twice with slightly different phrasing. dedupeBullets collapses
  // exact + near-duplicates (Levenshtein >= 80% similarity) while preserving
  // first-occurrence chronological order. No-op when there's nothing to
  // dedup (≤1 bullet, or zero overlap).
  accumulated.bulletPoints = dedupeBullets(accumulated.bulletPoints)

  callbacks.onEvent({ type: 'phase_complete', phase })
  return accumulated
}
