// React-side client for /api/sessions (uploaded multitrack session list
// + transcribe). Kept separate from src/features/routing/lib/sessions.ts (pipeline
// session resolution) to avoid name collisions — these are persisted
// on-disk recordings (typically Craig multitrack zips).

import { apiJson } from '@/platform/apiClient'

export type Utterance = {
  utteranceId: string
  startedAtMs: number
  endedAtMs: number
  filename: string
  durationMs: number
}

export type Participant = {
  discordUserId: string
  discordDisplayName?: string
  utterances: Utterance[]
}

export type SessionManifest = {
  version: 1
  sessionId: string
  guildId: string
  voiceChannelId: string
  voiceChannelName: string
  startedAt: string
  endedAt: string | null
  participants: Participant[]
  processing: {
    transcribedAt: string | null
    sbvPath: string | null
  }
}

/** Where a transcription run is in its life, finer than `state`. A run
 *  that was mid-flight when the server stopped comes back as
 *  'interrupted' rather than silently 'running' forever. */
export type TranscribeRunState =
  | 'idle'
  | 'loading_model'
  | 'transcribing'
  | 'finalising'
  | 'done'
  | 'failed'
  | 'interrupted'

/** Which speech engine a run is actually using — the model and device it
 *  settled on, and whether that was a fallback from what was configured. */
export type TranscribeEngine = {
  name: string
  model: string
  device: string
  computeType: string
  fallback: boolean
}

export type TranscribeProgress = {
  state: 'pending' | 'running' | 'done' | 'error'
  /** Per-utterance counts (one utterance = one speaker track segment on
   *  disk), NOT SBV cue counts — a single utterance yields many cues. */
  utterancesTotal: number
  utterancesDone: number
  errors: string[]
  sbvPath?: string
  startedAt: number
  finishedAt?: number
  // Optional: older servers omit these, and the list falls back to a
  // percentage of utterances. Audio figures are the honest measure of
  // progress — utterances vary from a second to twenty minutes long.
  runState?: TranscribeRunState
  /** Sum of completed utterances' durations plus the in-flight one's progress. */
  processedAudioMs?: number
  /** Sum of every utterance's duration for the session. */
  totalAudioMs?: number
  /** Epoch ms of the last enqueue / progress tick / completion. */
  lastActivityAt?: number | null
  engine?: TranscribeEngine | null
}

export async function listSessions(): Promise<SessionManifest[]> {
  const json = await apiJson<{ sessions: SessionManifest[] }>('/api/sessions', { errorMode: 'status' })
  return json.sessions
}

export async function deleteSession(id: string): Promise<void> {
  await apiJson<void>(`/api/sessions/${id}`, { method: 'DELETE', errorMode: 'status', parse: 'none' })
}

export async function startTranscribe(id: string): Promise<TranscribeProgress> {
  const res = await fetch(`/api/sessions/${id}/transcribe`, { method: 'POST' })
  if (!res.ok && res.status !== 202) {
    throw new Error(`POST /api/sessions/${id}/transcribe failed: HTTP ${res.status}`)
  }
  return (await res.json()) as TranscribeProgress
}

export async function getTranscribeStatus(id: string): Promise<TranscribeProgress | null> {
  const res = await fetch(`/api/sessions/${id}/transcribe/status`)
  // 204 (idle — no active job) is the current contract; 404 stays
  // recognised for older servers / legacy clients during rollouts.
  if (res.status === 204 || res.status === 404) return null
  if (!res.ok) throw new Error(`GET status failed: HTTP ${res.status}`)
  return (await res.json()) as TranscribeProgress
}

export function sbvDownloadUrl(id: string): string {
  return `/api/sessions/${id}/sbv`
}

export async function downloadSbv(id: string): Promise<string> {
  const res = await fetch(sbvDownloadUrl(id))
  if (!res.ok) throw new Error(`SBV not available (HTTP ${res.status})`)
  return await res.text()
}
