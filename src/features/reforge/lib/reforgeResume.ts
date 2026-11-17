// A stopped Reforge, kept so it can be resumed instead of run again.
//
// A reforge runs for minutes to the better part of an hour, and the phases it
// re-runs are paid per chunk. When one stops late — a provider out of credits
// on the last chunk, a cancel — everything before that point is already paid
// for. This holds what finished, and what is needed to carry on from there.
//
// Two tiers. In memory the full record is kept, so a stopped run survives
// switching tabs (the panel unmounts; this module does not). In browser
// storage it is kept only when the source is a Saved Chronicle: the source
// text is then re-read from the library on resume rather than copied into
// storage, where a transcript plus a chronicle would crowd the quota other
// state depends on. A pasted source is resumable until the page reloads.

import type { CloudProvider } from '@/features/providers'
import { midPhaseResume, type ReforgeConfig, type ReforgeInput, type ReforgePhase, type ReforgeProgress } from './reforge'
import { safeGet, safeRemove, safeSet } from '../../../platform/lib/storage'
import type { CondenseOutput, ExtrasOutput } from '@/features/pipeline'

export const LS_REFORGE_RESUME = 'reforge_resume'

export type ReforgeResumeRecord = {
  version: 1
  savedAt: string
  /** Saved Chronicle the run was reforging, when it came from the library. */
  sourceId?: string
  campaign: string
  sessionNumber: number
  /** The full run config, provider and per-phase models included. A resume
   *  runs exactly this, so the kept chunks and the new ones match. */
  config: ReforgeConfig
  provider: CloudProvider
  modelLabel: string
  /** The outputs the run was told to keep rather than redo — merged into the
   *  saved result, and the baseline for the old-vs-new comparison. */
  priorOutputs: { extras: ExtrasOutput | null; condensed: CondenseOutput | null }
  progress: ReforgeProgress
  /** Why it stopped, as shown to the user. */
  stopReason: string
}

export type StoppedReforge = {
  record: ReforgeResumeRecord
  /** The run's input, when still in memory. Null after a page reload, when
   *  it is rebuilt from the library via `record.sourceId`. */
  input: ReforgeInput | null
}

let inMemory: StoppedReforge | null = null

export function saveStoppedReforge(record: ReforgeResumeRecord, input: ReforgeInput): void {
  inMemory = { record, input }
  if (record.sourceId) safeSet(LS_REFORGE_RESUME, record)
  else safeRemove(LS_REFORGE_RESUME)
}

export function loadStoppedReforge(): StoppedReforge | null {
  if (inMemory) return inMemory
  const stored = safeGet<ReforgeResumeRecord | null>(LS_REFORGE_RESUME, null)
  if (!stored || stored.version !== 1 || !stored.sourceId || !stored.progress || !stored.config) return null
  return { record: stored, input: null }
}

export function clearStoppedReforge(): void {
  inMemory = null
  safeRemove(LS_REFORGE_RESUME)
}

const PHASE_NAME: Record<ReforgePhase, string> = {
  phase3: 'Chronicle rewrite',
  phase4: 'Extras',
  phase6: 'Condense',
}

/** One line on what a resume keeps and what it will still run. */
export function describeKeptWork(config: ReforgeConfig, progress: ReforgeProgress): string {
  const selected: ReforgePhase[] = [
    ...(config.regenerateChronicle ? (['phase3'] as const) : []),
    ...(config.doExtras ? (['phase4'] as const) : []),
    ...(config.doCondense ? (['phase6'] as const) : []),
  ]
  const kept: string[] = []
  const todo: string[] = []
  for (const phase of selected) {
    const done = phase === 'phase3' ? progress.chronicle !== undefined : phase === 'phase4' && !!progress.extras
    if (done) {
      kept.push(phase === 'phase3' ? 'the rewritten chronicle' : 'the extras')
      continue
    }
    const at = phase === 'phase6' ? null : midPhaseResume(progress, phase)
    if (at) {
      kept.push(`${PHASE_NAME[phase]} chunks 1–${at.startChunkIndex} of ${progress.inFlight?.totalChunks}`)
      todo.push(`${PHASE_NAME[phase]} from chunk ${at.startChunkIndex + 1}`)
    } else {
      todo.push(PHASE_NAME[phase])
    }
  }
  const keptText = kept.length ? `Kept: ${joinList(kept)}.` : 'Nothing finished yet.'
  return todo.length ? `${keptText} Resume runs ${joinList(todo)}.` : keptText
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}
