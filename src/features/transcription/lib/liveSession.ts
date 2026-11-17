// Client for /api/sessions/:id/live. The Upload panel polls this while
// Whisper drains a freshly-uploaded multitrack session to render the
// running transcript + speaker list.

import { apiJson } from '@/platform/apiClient'

export type LiveParticipant = {
  discordUserId: string
  discordDisplayName?: string
}

/**
 * Where the transcription run is, as the server sees it. `idle` means no
 * run has been started for this session; `interrupted` means the server
 * was restarted while a run was in flight, so its in-memory queue is
 * gone and the snapshot in the manifest is all that remains.
 */
export type LiveRunState =
  | 'idle'
  | 'loading_model'
  | 'transcribing'
  | 'finalising'
  | 'done'
  | 'failed'
  | 'interrupted'

/** The utterance (one per-speaker track file) Whisper is working on now. */
export type LiveCurrentUtterance = {
  utteranceId: string
  speakerDisplay: string
  /** Length of this track's audio. */
  audioMs: number
  /** Epoch ms on the server clock. */
  startedAt: number
  /** 1-based; climbs when the engine retries the same track. */
  attempt: number
  /** How far into the track the engine has got, when it reports progress. */
  progressMs: number
}

export type LiveEngine = {
  name: string
  model: string
  /** e.g. `cuda`, `cpu`. */
  device: string
  computeType: string
  /** True when the engine dropped to the CPU after the GPU path failed. */
  fallback: boolean
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

  // ---- Liveness fields ------------------------------------------------
  // Every field below is optional: a server that predates them answers
  // with the shape above and the client falls back to active/finalized.
  // Timestamps are epoch ms on the SERVER clock; compare them against
  // `serverNow`, never against the client's Date.now(), because the two
  // clocks can disagree by minutes on a LAN install.

  runState?: LiveRunState
  startedAt?: number | null
  /**
   * Bumps on enqueue, utterance start, every progress tick, utterance
   * done or fail, and finalise — so "how long since this moved" is a
   * real signal rather than a guess.
   */
  lastActivityAt?: number | null
  /** Server clock at response time, for skew correction. */
  serverNow?: number
  /** Σ utterance audio length for the session. */
  totalAudioMs?: number
  /** Σ audio of completed utterances + the in-flight utterance's progress. */
  processedAudioMs?: number
  /** True per-utterance count — one per speaker track, not per cue. */
  utterancesTotal?: number
  utterancesDone?: number
  current?: LiveCurrentUtterance | null
  engine?: LiveEngine | null
  /** Σ audioMs / Σ elapsedMs over completed utterances ("× realtime"); null until one completes. */
  throughput?: number | null
  /** Run-level failure message when `runState` is `failed`. */
  failure?: string | null
}

export async function getLiveSession(sessionId: string): Promise<LiveSessionResponse> {
  return apiJson<LiveSessionResponse>(`/api/sessions/${sessionId}/live`, { errorMode: 'status' })
}

/** Re-emit the on-disk SBV with the current speakers.json mapping. */
export async function refreshLiveLabels(sessionId: string): Promise<void> {
  await apiJson<void>(`/api/sessions/${sessionId}/live/refresh`, {
    method: 'POST',
    errorMode: 'status',
    errorPrefix: 'POST live/refresh',
    parse: 'none',
  })
}
