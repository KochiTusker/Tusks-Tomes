// React-side client for /api/chronicle-library — the Saved Chronicles store.
//
// Finished runs are auto-saved here on completion (see RefinementTool) so a
// chronicle survives reloads/restarts/browser-clears. Separate from the
// grounding Knowledge Base and from the singular /api/chronicle markdown
// export.

import type { CondenseOutput, DMAnswers, DMQuestion, ExtrasOutput, RefusalRecord } from '@/types'

export type SavedChronicle = {
  id: string
  createdAt: string
  campaign: string
  sessionNumber: number
  provider?: string
  chronicle: string
  extras?: ExtrasOutput
  condensed?: CondenseOutput
  groundedTranscript?: string
  /** Unrepaired Claude Code refusals carried with the saved run so the Review
   *  & Repair panel works even after a reload or from the library. */
  refusals?: RefusalRecord[]
  /** DM audit questions + answers snapshotted so a Phase 2/3 repair launched
   *  from the library (fresh session, no live run state) has the context the
   *  per-chunk prompt needs. */
  dmQuestions?: DMQuestion[]
  dmAnswers?: DMAnswers
}

export type ChronicleSummary = {
  id: string
  createdAt: string
  campaign: string
  sessionNumber: number
  provider?: string
  wordCount: number
  hasExtras: boolean
  hasCondensed: boolean
}

/** Input for saving a finished run. id/createdAt are assigned server-side. */
export type SaveChronicleInput = {
  campaign: string
  sessionNumber: number
  provider?: string
  chronicle: string
  extras?: ExtrasOutput
  condensed?: CondenseOutput
  groundedTranscript?: string
  refusals?: RefusalRecord[]
  dmQuestions?: DMQuestion[]
  dmAnswers?: DMAnswers
}

/** Fields that may change after the initial save (extras/condensed generated
 *  from the ChronicleView after the run first completes; refusals flip to
 *  repaired and the chronicle is re-spliced via the repair panel). */
export type UpdateChronicleInput = Partial<
  Pick<
    SavedChronicle,
    'chronicle' | 'extras' | 'condensed' | 'groundedTranscript' | 'refusals' | 'dmQuestions' | 'dmAnswers'
  >
>

export const CHRONICLE_LIBRARY_EVENT = 'sbts:chronicle-library-changed'

function emitChange(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(CHRONICLE_LIBRARY_EVENT))
  }
}

export async function listChronicles(): Promise<ChronicleSummary[]> {
  const res = await fetch('/api/chronicle-library')
  if (!res.ok) throw new Error(`GET /api/chronicle-library failed: HTTP ${res.status}`)
  const { chronicles } = (await res.json()) as { chronicles: ChronicleSummary[] }
  return chronicles
}

export async function getChronicle(id: string): Promise<SavedChronicle> {
  const res = await fetch(`/api/chronicle-library/${encodeURIComponent(id)}`)
  if (!res.ok) throw new Error(`GET /api/chronicle-library/${id} failed: HTTP ${res.status}`)
  return (await res.json()) as SavedChronicle
}

export async function saveChronicle(input: SaveChronicleInput): Promise<SavedChronicle> {
  const res = await fetch('/api/chronicle-library', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`POST /api/chronicle-library failed: HTTP ${res.status}. ${body.slice(0, 300)}`)
  }
  const saved = (await res.json()) as SavedChronicle
  emitChange()
  return saved
}

export async function updateChronicle(
  id: string,
  patch: UpdateChronicleInput,
): Promise<SavedChronicle> {
  const res = await fetch(`/api/chronicle-library/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`PUT /api/chronicle-library/${id} failed: HTTP ${res.status}. ${body.slice(0, 300)}`)
  }
  const updated = (await res.json()) as SavedChronicle
  emitChange()
  return updated
}

export async function deleteChronicle(id: string): Promise<void> {
  const res = await fetch(`/api/chronicle-library/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`DELETE /api/chronicle-library/${id} failed: HTTP ${res.status}`)
  emitChange()
}
