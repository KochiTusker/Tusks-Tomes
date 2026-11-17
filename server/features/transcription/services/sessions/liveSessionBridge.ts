// Bridge between sessions.ts and the audio add-on's liveQueue.
// sessions.ts imports from here instead of whisper/liveQueue directly so
// the sessions router compiles and runs correctly even when the audio
// add-on is not loaded. The audio add-on calls registerLiveImpl() inside
// its registerRoutes() to wire in the real implementations.

import type { EngineSnapshot, LiveRunState } from './sessionManifest.js'

/** The utterance the engine is working on right now. */
export type LiveCurrent = {
  utteranceId: string
  speakerDisplay: string
  audioMs: number
  /** Epoch ms. */
  startedAt: number
  /** 1 for the first GPU attempt, 2 for the GPU retry, 3 for the CPU fallback. */
  attempt: number
  /** How far through the audio the engine has reported getting. */
  progressMs: number
}

export type LiveState = {
  active: boolean
  pending: number
  processedUtterances: number
  enqueued: number
  segments: unknown[]
  errors: string[]
  participants: Map<string, { discordDisplayName?: string }>
  // The progress fields are optional so an implementation that predates
  // them still registers; the sessions router fills each gap from the
  // manifest instead.
  startedAt?: number
  runState?: LiveRunState
  lastActivityAt?: number | null
  totalAudioMs?: number
  /** Audio in completed utterances only; add `current.progressMs` for the live figure. */
  processedAudioMs?: number
  utterancesTotal?: number
  utterancesDone?: number
  current?: LiveCurrent | null
  engine?: EngineSnapshot | null
  /** One sample per completed utterance, for `throughputOf`. */
  completed?: Array<{ audioMs: number; elapsedMs: number }>
  failure?: string | null
  devices?: Record<string, number>
}

/**
 * Audio seconds per engine second over the completed utterances, or null
 * until one has completed. A ratio of sums rather than a mean of ratios,
 * so a run of short utterances does not let a few fast ones dominate.
 */
export function throughputOf(completed: ReadonlyArray<{ audioMs: number; elapsedMs: number }>): number | null {
  let audioMs = 0
  let elapsedMs = 0
  for (const sample of completed) {
    audioMs += sample.audioMs
    elapsedMs += sample.elapsedMs
  }
  if (completed.length === 0 || elapsedMs <= 0) return null
  return audioMs / elapsedMs
}

type GetLiveStateFn = (sessionId: string) => LiveState | undefined
type RefreshLiveSbvFn = (sessionId: string) => Promise<void>

let _getLiveState: GetLiveStateFn = () => undefined
let _refreshLiveSbv: RefreshLiveSbvFn = async () => {}

export function registerLiveImpl(
  getLiveState: GetLiveStateFn,
  refreshLiveSbv: RefreshLiveSbvFn,
): void {
  _getLiveState = getLiveState
  _refreshLiveSbv = refreshLiveSbv
}

export function getLiveSessionState(sessionId: string): LiveState | undefined {
  return _getLiveState(sessionId)
}

export async function refreshLiveSbv(sessionId: string): Promise<void> {
  return _refreshLiveSbv(sessionId)
}
