// React-side client for /api/chronicle-library — the Saved Chronicles store.
//
// Finished runs are auto-saved here on completion (see RefinementTool) so a
// chronicle survives reloads/restarts/browser-clears. Separate from the
// grounding Knowledge Base and from the singular /api/chronicle markdown
// export.

import { apiJson } from '@/platform/apiClient'
import type { CondenseOutput, DMAnswers, DMQuestion, ExtrasOutput, RefusalRecord } from '@/features/pipeline'

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
  /** Phase 1 output present — the richer 'transcript' extras source is
   *  available for a reforge. See the server-side type for why the list
   *  carries this rather than discovering it on open. */
  hasGroundedTranscript: boolean
  hasChronicle: boolean
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
  const { chronicles } = await apiJson<{ chronicles: ChronicleSummary[] }>('/api/chronicle-library', {
    errorMode: 'status',
  })
  return chronicles
}

export async function getChronicle(id: string): Promise<SavedChronicle> {
  return apiJson<SavedChronicle>(`/api/chronicle-library/${encodeURIComponent(id)}`, {
    errorMode: 'status',
    errorPrefix: `GET /api/chronicle-library/${id}`,
  })
}

export async function saveChronicle(input: SaveChronicleInput): Promise<SavedChronicle> {
  const saved = await apiJson<SavedChronicle>('/api/chronicle-library', {
    method: 'POST',
    body: input,
    errorMode: 'text',
    bodySlice: 300,
  })
  emitChange()
  return saved
}

export async function updateChronicle(
  id: string,
  patch: UpdateChronicleInput,
): Promise<SavedChronicle> {
  const updated = await apiJson<SavedChronicle>(`/api/chronicle-library/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: patch,
    errorMode: 'text',
    bodySlice: 300,
    errorPrefix: `PUT /api/chronicle-library/${id}`,
  })
  emitChange()
  return updated
}

export async function deleteChronicle(id: string): Promise<void> {
  await apiJson<void>(`/api/chronicle-library/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    errorMode: 'status',
    errorPrefix: `DELETE /api/chronicle-library/${id}`,
    parse: 'none',
  })
  emitChange()
}
