// React-side client for /api/sessions (uploaded multitrack session list
// + transcribe). Kept separate from src/lib/sessions.ts (pipeline
// session resolution) to avoid name collisions — these are persisted
// on-disk recordings (typically Craig multitrack zips).

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

export type TranscribeProgress = {
  state: 'pending' | 'running' | 'done' | 'error'
  utterancesTotal: number
  utterancesDone: number
  errors: string[]
  sbvPath?: string
  startedAt: number
  finishedAt?: number
}

export async function listSessions(): Promise<SessionManifest[]> {
  const res = await fetch('/api/sessions')
  if (!res.ok) throw new Error(`GET /api/sessions failed: HTTP ${res.status}`)
  const json = (await res.json()) as { sessions: SessionManifest[] }
  return json.sessions
}

export async function getSession(id: string): Promise<SessionManifest> {
  const res = await fetch(`/api/sessions/${id}`)
  if (!res.ok) throw new Error(`GET /api/sessions/${id} failed: HTTP ${res.status}`)
  return (await res.json()) as SessionManifest
}

export async function deleteSession(id: string): Promise<void> {
  const res = await fetch(`/api/sessions/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`DELETE /api/sessions/${id} failed: HTTP ${res.status}`)
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
