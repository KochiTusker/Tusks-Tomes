import { shouldRetrieveVaultKb, type GeminiTier, isLocalProvider } from '@/features/providers'
import { chunkText } from '../chunker'
import { dedupeBullets } from '../bulletDedup'
import { parseCondenseChunk } from '../condenseParse'
import { compactKb, retrieveForText, type AliasIndex } from '@/features/lore'
import type { CloudProvider } from '@/features/providers'
import type { PhaseTarget } from '@/features/routing'
import { vlog } from '@/features/maintenance'
import { proportionalChunkTarget } from '../../../../platform/lib/wordCount'
import { phase6CondenseLocal, phase6CondenseParts } from '../prompts'
import type {
  CondenseOutput,
  DMAnswers,
  KBDocument,
  PhaseId,
} from '@/features/pipeline/lib/types'
import { buildKbConcat } from '../buildKbConcat'
import { chunkedGenerate } from '../chunkedGenerate'
import { chunkSizeForPhase, resolveModelContextTokens, resolvePhaseModel } from '../phaseModel'
import { providerEventForwarder, retryWaitingForwarder } from '../pipelineEvents'
import type { PipelineCallbacks } from '../pipelineEvents'
import { resolveThinkingBudget } from '../thinkingBudget'

/** Static scaffolding in the Phase 6 cloud prompt, excluding the KB and the
 *  chronicle chunk. Measured from phase6CondenseParts in prompts.ts; used to
 *  decide whether the full vault still fits the model's context window. */
const PHASE6_PROMPT_OVERHEAD_CHARS = 3_790

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
  /** Context window of the Phase 6 model, in tokens. Omit it and it is looked
   *  up from the model catalogue (contextWindow.ts); pass null to declare it
   *  unknown. When the full vault cannot fit this window,
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
  // Phases 3 and 6 are the cloud phases handed the FULL vault (1/2/4 send
  // compactKb). On the reference vault that is ~557k tokens per call to
  // condense an already-written chronicle. Retrieval narrows it to the notes
  // the chronicle actually references — see vaultRetrieval.ts for the safety
  // invariant that keeps this from dropping grounding.
  const fullKbChars = kb.reduce((sum, d) => sum + (d.text?.length ?? 0), 0)
  const modelContextTokens = local
    ? null
    : await resolveModelContextTokens(args.modelContextTokens, args.phaseTarget, args.cloudProvider, args.model)
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
        contextLength: modelContextTokens,
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
    modelContextTokens,
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

  // Held per chunk and assembled in chunk order, so a chunk re-run after the
  // first pass still lands in its place in the session.
  const chunkResults: (CondenseOutput | null)[] = chunks.map(() => null)
  const assemble = (): CondenseOutput => ({
    narrative: chunkResults
      .map((r) => r?.narrative ?? '')
      .filter(Boolean)
      .join('\n\n'),
    bulletPoints: chunkResults.flatMap((r) => r?.bulletPoints ?? []),
  })

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

  // A chunk whose output cannot be read is re-run once rather than skipped.
  // Skipping it used to drop that stretch of the session from both the
  // condensed narrative and the recap with no sign anything was missing —
  // when it was the first chunk, both simply began partway through.
  const unreadable = new Set<number>()
  const recordChunk = (index: number, text: string, attempt: 'first' | 'retry'): void => {
    const parsed = parseCondenseChunk(text)
    if (parsed) {
      chunkResults[index] = parsed
      unreadable.delete(index)
      return
    }
    unreadable.add(index)
    console.warn(`[phase6] chunk ${index} output could not be read (${attempt} attempt). Raw:`, text.slice(0, 200))
    vlog('pipeline', {
      event: 'phase6_chunk_unreadable',
      index,
      totalChunks: chunks.length,
      attempt,
      outputChars: text.length,
      head: text.slice(0, 200),
      tail: text.slice(-200),
    })
  }

  const condenseChunks = (retryOnly: Set<number> | null) => chunkedGenerate({
    chunks,
    // The retry pass keeps absolute chunk indices (so labels and any refusal
    // record point at the right span) and skips every chunk that was read.
    startChunkIndex: retryOnly ? Math.min(...retryOnly) : 0,
    shouldSkip: retryOnly ? (i) => !retryOnly.has(i) : undefined,
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
    expectJson: '{',
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
      if (retryOnly) {
        // Skipped chunks arrive here too, with no output; ignore them. The
        // progress counter already reached the end in the first pass, so the
        // retry does not emit chunk_done and walk it backwards.
        if (retryOnly.has(absoluteIndex)) recordChunk(absoluteIndex, text, 'retry')
        return
      }
      recordChunk(absoluteIndex, text, 'first')
      callbacks.onEvent({
        type: 'chunk_done',
        phase,
        index: absoluteIndex,
        totalChunks: chunks.length,
        partial: JSON.stringify(assemble(), null, 2),
      })
    },
    signal: callbacks.signal,
    onCountdown: (ms) => callbacks.onEvent({ type: 'countdown', phase, msRemaining: ms }),
    onProviderEvent: providerEventForwarder(phase, callbacks),
    onRetry: retryWaitingForwarder(phase, callbacks),
    safetyMultiplier: args.safetyMultiplier,
    contextLabel: (absoluteIndex) =>
      `Phase 6 (Condense) — chunk ${absoluteIndex + 1}/${chunks.length}` +
      (retryOnly ? ' (retry: previous output unreadable)' : ''),
    phaseId: phase,
    onPipelineEvent: callbacks.onEvent,
    thinkingBudget: resolveThinkingBudget(phase, {
      disableThinkingOnGrounding: false,
      perPhaseThinking: { phase6: args.thinkingOn },
    }),
  })

  await condenseChunks(null)
  if (unreadable.size > 0) await condenseChunks(new Set(unreadable))
  if (unreadable.size > 0) {
    const which = [...unreadable].sort((a, b) => a - b).map((i) => `${i + 1}/${chunks.length}`).join(', ')
    throw new Error(
      `Phase 6 (Condense): the model's output for chunk ${which} could not be read, twice. ` +
        `Stopped rather than save a condensed chronicle and recap with that part of the session missing — run Condense again.`,
    )
  }

  const accumulated = assemble()

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
