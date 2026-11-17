import { isLocalProvider } from '@/features/providers'
import { chunkText } from '../chunker'
import { compactKb } from '@/features/lore'
import { phase5PolishLocal } from '../prompts'
import type { KBDocument, PhaseId } from '@/features/pipeline/lib/types'
import { buildKbConcat } from '../buildKbConcat'
import { chunkedGenerate } from '../chunkedGenerate'
import { chunkSizeForPhase } from '../phaseModel'
import { providerEventForwarder, retryWaitingForwarder } from '../pipelineEvents'
import type { PipelineCallbacks } from '../pipelineEvents'

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
