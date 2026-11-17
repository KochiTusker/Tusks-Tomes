import { shouldRetrieveVaultKb, type GeminiTier, isLocalProvider } from '@/features/providers'
import { chunkText } from '../chunker'
import { compactKb, kbForPhase, retrieveForText, type AliasIndex } from '@/features/lore'
import type { CloudProvider } from '@/features/providers'
import type { PhaseTarget } from '@/features/routing'
import { vlog } from '@/features/maintenance'
import { phase3ChronicleLocal, phase3ChronicleParts } from '../prompts'
import type { DMAnswers, DMQuestion, KBDocument, PhaseId } from '@/features/pipeline/lib/types'
import { buildKbConcat } from '../buildKbConcat'
import { chunkedGenerate } from '../chunkedGenerate'
import { chunkSizeForPhase, resolveModelContextTokens, resolvePhaseModel } from '../phaseModel'
import { providerEventForwarder, retryWaitingForwarder } from '../pipelineEvents'
import type { PipelineCallbacks } from '../pipelineEvents'

/** Static scaffolding in the Phase 3 cloud prompt, excluding the KB, the
 *  grounded chunk and the prior tail. Measured from phase3ChronicleParts in
 *  prompts.ts; feeds the same fit decision as its Phase 6 counterpart. */
const PHASE3_PROMPT_OVERHEAD_CHARS = 7_335

/** How much of the chronicle written so far rides along as continuity context
 *  in each Phase 3 chunk prompt. */
const PHASE3_PRIOR_TAIL_CHARS = 2_000

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
  /** Lore alias index, for vault-agnostic KB retrieval. Optional: retrieval
   *  falls back to note-title matching when absent. */
  aliasIndex?: AliasIndex | null
  /** settings.retrieveVaultKb (default false). When on, the cloud chronicle
   *  prompt receives only the lore this session actually references rather
   *  than the whole vault.
   *
   *  Phase 3 needs this more than Phase 6 does. The KB rides in the cacheable
   *  prefix, and a prefix is amortised in COST but not in FOOTPRINT: cached
   *  tokens still occupy their full share of the context window on every
   *  call. So a vault that does not fit is not a slow run, it is a run that
   *  cannot happen — and Phase 3 is per-chunk, so it asks the question once
   *  per chunk of the transcript. */
  retrieveVaultKb?: boolean
  /** Context window of the Phase 3 model, in tokens. Omit it and it is looked
   *  up from the model catalogue (contextWindow.ts); pass null to declare it
   *  unknown. When the full vault cannot fit this window, retrieval turns
   *  itself on. */
  modelContextTokens?: number | null
  safetyMultiplier?: number | (() => number)
}): Promise<string> {
  const { groundedTranscript, dmQuestions, dmAnswers, kb, callbacks } = args
  const phase: PhaseId = 'phase3_chronicle'
  const local = isLocalProvider()
  const personaTemplate = local ? args.personaTemplates?.local : args.personaTemplates?.cloud
  const phase3ChunkChars =
    args.chunkSizeChars ??
    chunkSizeForPhase({
      phase: 'p3',
      cloudProvider: args.cloudProvider,
      geminiTier: args.geminiTier,
      phaseTarget: args.phaseTarget,
      model: resolvePhaseModel(args.model, 'pro'),
      allPhasesFast: args.allPhasesFast,
    })
  const chunks = chunkText(groundedTranscript, phase3ChunkChars)

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
    chunkSizeChars: phase3ChunkChars,
  })

  // Phase 3 gets the lore too, not only Phase 1. Grounding corrects spelling
  // but is deliberately a near-1:1 transform, so whatever the table said
  // wrongly about a character — pronouns above all — arrives here intact, and
  // the narrator is the only pass that can put it right. Local models take the
  // compact form (full lore would crowd a small context window); cloud takes
  // the full text kbForPhase specifies for this phase — unless the vault is
  // large enough that "full" stops describing the lore and starts describing
  // the failure. Retrieval then narrows it to the notes this session actually
  // references. That decision is made ONCE, against the whole grounded
  // transcript rather than per chunk: a prefix that differs between chunks is
  // a prefix no provider can cache, which would trade the context problem for
  // a cost one.
  const fullKbConcat = buildKbConcat(kb)
  const localKbConcat = local ? compactKb(fullKbConcat).text : ''

  const fullKbChars = kb.reduce((sum, d) => sum + (d.text?.length ?? 0), 0)
  const modelContextTokens = local
    ? null
    : await resolveModelContextTokens(args.modelContextTokens, args.phaseTarget, args.cloudProvider, args.model)
  const retrievalDecision = local
    ? { retrieve: false, reason: 'fits' as const }
    : shouldRetrieveVaultKb({
        userEnabled: args.retrieveVaultKb === true,
        kbChars: fullKbChars,
        chunkChars: chunks.reduce((max, c) => Math.max(max, c.length), 0),
        overheadChars: PHASE3_PROMPT_OVERHEAD_CHARS + PHASE3_PRIOR_TAIL_CHARS,
        contextLength: modelContextTokens,
      })

  // Retrieval stays opt-in, and turns itself on only where the fit can be
  // shown to fail. An unknown context window is not evidence of a bad fit, so
  // it does not override a setting the user left off — see
  // pipeline.phase3Retrieval.test.ts, which pins that.
  const retrieve = retrievalDecision.retrieve && !local

  const retrieval = retrieve
    ? retrieveForText(groundedTranscript, kb, { index: args.aliasIndex ?? null })
    : null

  const cloudKbConcat = local
    ? ''
    : retrieval
      ? buildKbConcat(retrieval.docs)
      : kbForPhase('phase3_chronicle', fullKbConcat).text

  vlog('pipeline', {
    event: 'phase3_kb_retrieval',
    decision: retrievalDecision.reason,
    applied: retrieve,
    modelContextTokens,
    fullKbChars,
    sentKbChars: cloudKbConcat.length,
    ...(retrieval
      ? {
          selectedDocs: retrieval.stats.selectedDocs,
          totalDocs: retrieval.stats.totalDocs,
          literalMatches: retrieval.stats.literalMatches,
          droppedForBudget: retrieval.stats.droppedForBudget,
          matchedEntityCount: retrieval.matchedEntities.length,
        }
      : {}),
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
    buildRequest: (chunk, index, total) => {
      const priorTail = rebuildAccumulated().slice(-PHASE3_PRIOR_TAIL_CHARS)
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
        kbConcat: cloudKbConcat,
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
      const priorTail = priorContext.slice(-PHASE3_PRIOR_TAIL_CHARS)
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
        kbConcat: cloudKbConcat,
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
