import { type GeminiTier, isLocalProvider } from '@/features/providers'
import { chunkText } from '../chunker'
import { tryParseJson } from '../jsonExtract'
import { kbForPhase } from '@/features/lore'
import type { CloudProvider } from '@/features/providers'
import type { PhaseTarget } from '@/features/routing'
import { phase4Extras, phase4ExtrasLocal } from '../prompts'
import { appendNovelQuotes, normalizeQuotes } from '../quotes'
import type { DMAnswers, ExtrasOutput, KBDocument, PhaseId } from '@/features/pipeline/lib/types'
import { buildKbConcat } from '../buildKbConcat'
import { chunkedGenerate } from '../chunkedGenerate'
import { chunkSizeForPhase, resolvePhaseModel } from '../phaseModel'
import { providerEventForwarder, retryWaitingForwarder } from '../pipelineEvents'
import type { PipelineCallbacks } from '../pipelineEvents'
import { resolveThinkingBudget } from '../thinkingBudget'

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
  kb: KBDocument[]
}): Promise<ExtrasOutput> {
  const { groundedTranscript, dmAnswers, kb, callbacks } = args
  const phase: PhaseId = 'phase4_extras'
  // Extras attributes each quote/jest/gore beat to a character by name, so it
  // needs the same canonical spellings the rest of the run is held to.
  const kbConcat = kbForPhase(phase, buildKbConcat(kb)).text
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
    chunkSizeChars: phase4ChunkSize,
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
    expectJson: '{',
    chunkSizeChars: phase4ChunkSize,
    buildRequest: (chunk, index, total) => {
      const promptArgs = {
        groundedChunk: chunk,
        dmAnswers,
        kbConcat,
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
        kbConcat,
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
