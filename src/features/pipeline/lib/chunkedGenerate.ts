import {
  MAX_OUTPUT_TOKENS,
  ensureProvidersInitialized,
  getActiveProvider,
  getCloudProvider,
  type GeminiTier,
  isTransientServerError,
  estimateTokensFromChars,
  isLocalProvider,
} from '@/features/providers'
import { resolveChosenRestoreTarget } from './restoreTarget'
import { getFailsafeTarget, getClaudeFailsafeEnabled } from '@/features/guardrails'
import type {
  LLMProvider,
  ProviderEvent,
  CloudProvider,
  GenerateRequest,
} from '@/features/providers'
import type { PhaseTarget } from '@/features/routing'
import {
  detectRefusal,
  buildRefusalMarker,
  parseRefusalMarkers,
  genRefusalId,
} from './refusalDetection'
import { isPersistingBlockedChunks, vlog } from '@/features/maintenance'
import { announceTierFallback, paceBeforeRerun, rerunOnProvider } from './refusalRerun'
import { sleepWithCountdown } from './countdown'
import type { PhaseId } from '@/features/pipeline/lib/types'
import { resolvePhaseModel, resolvePhaseProvider } from './phaseModel'
import type { PipelineEvent } from './pipelineEvents'

type ChunkRequest = Pick<GenerateRequest, 'systemPrompt' | 'userPrompt'> &
  Partial<Pick<GenerateRequest, 'cacheablePrefix' | 'maxOutputTokens' | 'temperature' | 'responseFormat' | 'safetyMode'>>

/** What a phase hands chunkedGenerate. */
interface ChunkedGenerateArgs {
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
  /** Per-phase: the JSON value this phase answers with. Refusal detection
   *  then accepts any output that parses as it, however short — see
   *  RefusalCheckOptions. Unset for prose phases, which keep the length check. */
  expectJson?: '[' | '{'
  /** Per-phase: the grounded source span to record for a refused chunk so a
   *  later repair can re-process it. Defaults to `chunks[chunkIndex]`. Phases
   *  that pass placeholder chunks (Phase 2/4, which read content by index from
   *  separate raw/grounded arrays) override this to return the real span. */
  refusalSourceSpan?: (chunkIndex: number) => string
  /** Per-phase: the chunk-size target used to split this phase's input.
   *  Recorded on a refusal so a repair can deterministically re-derive sibling
   *  spans (e.g. Phase 2 re-chunks the raw transcript to pair with grounded). */
  chunkSizeChars?: number
}

/** The provider and model this phase's chunks go to: a local instance the
 *  phase routes to, the run's cloud provider (moving a paid-only Gemini model
 *  from the Free key to the Paid one), or the legacy active provider. */
function resolveChunkProvider(args: ChunkedGenerateArgs): {
  provider: LLMProvider
  model: string
  isLocalTarget: boolean
} {
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
  return { provider, model, isLocalTarget: !!phaseTarget?.isLocal }
}

/**
 * Per-chunk generation driver shared by every phase. Each phase builds a
 * GenerateRequest for the chunk; we call the active provider once per chunk,
 * pace between calls (cloud only; local servers aren't rate-limited), and
 * forward partial output via onChunkDone.
 */
export async function chunkedGenerate(args: ChunkedGenerateArgs): Promise<void> {
  await ensureProvidersInitialized()
  const total = args.chunks.length
  const startIdx = args.startChunkIndex ?? 0
  const { provider, model, isLocalTarget } = resolveChunkProvider(args)
  const usingLocal = isLocalTarget || (!args.cloudProvider && isLocalProvider())

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
          const check = detectRefusal(text, req.userPrompt?.length, { expectJson: args.expectJson })
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
              const target = resolveChosenRestoreTarget(getFailsafeTarget())
              const gem = target
                ? getCloudProvider(target.provider, { geminiTier: args.geminiTier ?? 'auto' })
                : null
              if (target && gem) {
                const gemModel = target.model
                try {
                  await paceBeforeRerun(args, gem, req)
                  const gemRes = await rerunOnProvider(
                    args,
                    gem,
                    { ...req, model: gemModel, safetyMode: 'permissive' },
                    args.contextLabel(i, total) + ` [${target.label} — claude refusal]`,
                  )
                  if (gemRes.text.trim() && !detectRefusal(gemRes.text, req.userPrompt?.length, { expectJson: args.expectJson }).refused) {
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
            // A listener that throws is reported to the diagnose ring, so it is
            // visible after the browser tab is closed.
            announceTierFallback(
              args.onPipelineEvent,
              { phase: args.phaseId!, reason: 'free_prohibited_content', chunkIndex: i, model },
              {
                site: 'free_prohibited_content_fallback',
                warning: '[chunkedGenerate] onPipelineEvent (prohibited fallback) listener threw:',
              },
            )
            // K.2.1 / B3 — pace BEFORE the paid retry so the escalated
            // call honours Paid's RateLimitState. Without this, we
            // synchronously burst Paid right after the Free failure;
            // when the user just exhausted a daily quota mid-loop, the
            // back-to-back Paid call can trip Paid's per-minute cap.
            const paidPaceDelay = await paceBeforeRerun(args, paidProvider, req)
            const retryStartTs = Date.now()
            try {
              const result = await rerunOnProvider(
                args,
                paidProvider,
                req,
                args.contextLabel(i, total) + ' [paid fallback — free blocked]',
              )
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
            announceTierFallback(
              args.onPipelineEvent,
              { phase: args.phaseId!, reason: 'free_transient_5xx', chunkIndex: i, model },
              {
                site: 'free_transient_5xx_auto_fallback',
                warning: '[chunkedGenerate] onPipelineEvent (auto_fallback) listener threw:',
              },
            )
            // K.2.1 / B3 — pace BEFORE the paid retry so Paid's
            // RateLimitState is respected on the transient-5xx
            // escalation path (same fix as the prohibited_content
            // branch above; both used to bypass paidProvider's
            // getNextDelayMs).
            const paidPaceDelay = await paceBeforeRerun(args, paidProvider, req)
            const retryStartTs = Date.now()
            // Reissue with the same req object — caches keyed to the Free
            // singleton don't carry over to Paid, but the prefix is small
            // enough on Phase 1+2 (compact KB) that one uncached call costs
            // pennies. Don't pass cachedContentHandle for the paid retry.
            try {
              const result = await rerunOnProvider(
                args,
                paidProvider,
                req,
                args.contextLabel(i, total) + ' [paid fallback]',
              )
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
