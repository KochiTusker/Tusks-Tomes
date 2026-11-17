import { type GeminiTier, isLocalProvider } from '@/features/providers'
import { chunkText } from '../chunker'
import {
  kbForPhase,
  getAliasIndex,
  type AliasIndex,
  annotateChunk,
  aliasIndexToSafeReplacements,
} from '@/features/lore'
import type { CloudProvider } from '@/features/providers'
import type { PhaseTarget } from '@/features/routing'
import { vlog } from '@/features/maintenance'
import type { Phase1InputSnapshot } from '../runCheckpoint'
import { combineRules, pickHintsFor, preGround, getGlossary } from '@/features/corrections'
import { detachSpeakers, reattachSpeakers, type DetachResult } from '../speakerDetach'
import { phase1GroundLocal, phase1GroundParts } from '../prompts'
import { cleanupTranscript } from '../transcriptCleanup'
import type { KBDocument, PhaseId } from '@/features/pipeline/lib/types'
import { buildKbConcat } from '../buildKbConcat'
import { chunkedGenerate } from '../chunkedGenerate'
import { chunkSizeForPhase, resolvePhaseModel } from '../phaseModel'
import { providerEventForwarder, retryWaitingForwarder } from '../pipelineEvents'
import type { PipelineCallbacks } from '../pipelineEvents'
import { resolveThinkingBudget } from '../thinkingBudget'

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
