import { type GeminiTier, isLocalProvider } from '@/features/providers'
import { chunkText } from '../chunker'
import { tryParseJson } from '../jsonExtract'
import { kbForPhase } from '@/features/lore'
import type { CloudProvider } from '@/features/providers'
import type { PhaseTarget } from '@/features/routing'
import { phase2Audit, phase2AuditLocal } from '../prompts'
import type { DMQuestion, KBDocument, PhaseId } from '@/features/pipeline/lib/types'
import { buildKbConcat } from '../buildKbConcat'
import { chunkedGenerate } from '../chunkedGenerate'
import { chunkSizeForPhase, resolvePhaseModel } from '../phaseModel'
import { providerEventForwarder, retryWaitingForwarder } from '../pipelineEvents'
import type { PipelineCallbacks } from '../pipelineEvents'

export async function runPhase2(args: {
  rawTranscript: string
  groundedTranscript: string
  kb: KBDocument[]
  callbacks: PipelineCallbacks
  model?: string
  phaseTarget?: PhaseTarget
  cloudProvider?: CloudProvider
  geminiTier?: GeminiTier
  geminiPaidOnlyModels?: string[]
  allPhasesFast?: boolean
  safetyMultiplier?: number | (() => number)
}): Promise<DMQuestion[]> {
  const { rawTranscript, groundedTranscript, kb, callbacks } = args
  const phase: PhaseId = 'phase2_audit'
  // The audit prompt has always told the model to weigh candidates against
  // the Knowledge Base and to flag contradictions with canon — but the lore
  // was never actually passed in, so it was judging against something it
  // could not see. kbForPhase gives this phase the compact form.
  const kbConcat = kbForPhase(phase, buildKbConcat(kb)).text

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
    expectJson: '[',
    refusalSourceSpan: (i) => groundedChunks[i],
    chunkSizeChars: phase2ChunkSize,
    buildRequest: (_chunk, index) => {
      const promptArgs = {
        rawChunk: rawChunks[index],
        groundedChunk: groundedChunks[index],
        kbConcat,
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
        kbConcat,
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
