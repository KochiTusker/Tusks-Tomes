// Client for /api/sessions/:id/live. The Upload panel polls this while
// Whisper drains a freshly-uploaded multitrack session to render the
// running transcript + speaker list.

export type LiveParticipant = {
  discordUserId: string
  discordDisplayName?: string
}

export type LiveSessionResponse = {
  sessionId: string
  /** True while utterances are still being enqueued from the upload. */
  active: boolean
  /** Utterances still queued or being transcribed. */
  pending: number
  /** Utterances completed (per Whisper invocation). */
  processed: number
  /** Total utterances seen for this session — denominator for the progress bar. */
  enqueued: number
  /** SBV cue count (one Whisper segment per cue). */
  cueCount: number
  errors: string[]
  participants: LiveParticipant[]
  sbv: string
  /** True once the manifest's processing.sbvPath has been written. */
  finalized: boolean
}

export async function getLiveSession(sessionId: string): Promise<LiveSessionResponse> {
  const res = await fetch(`/api/sessions/${sessionId}/live`)
  if (!res.ok) throw new Error(`GET /api/sessions/${sessionId}/live failed: HTTP ${res.status}`)
  return (await res.json()) as LiveSessionResponse
}

/** Re-emit the on-disk SBV with the current speakers.json mapping. */
export async function refreshLiveLabels(sessionId: string): Promise<void> {
  const res = await fetch(`/api/sessions/${sessionId}/live/refresh`, { method: 'POST' })
  if (!res.ok) throw new Error(`POST live/refresh failed: HTTP ${res.status}`)
}
