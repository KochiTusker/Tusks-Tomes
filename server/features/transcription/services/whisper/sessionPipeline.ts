// "Process session" path. The transcription queue in `liveQueue.ts` is
// the single source of truth — this module replays every utterance from
// an already-extracted session manifest onto that queue and lets it
// finalise normally. Used both for fresh uploads and for re-processing a
// session whose Whisper run errored or was interrupted.

import {
  deriveRunState,
  readManifest,
  type EngineSnapshot,
  type LiveRunState,
} from '../sessions/sessionManifest.js'
import {
  failLiveSession,
  forgetLiveSession,
  getLiveSessionState,
  isLiveSessionRunning,
  transcribeExistingSession,
} from './liveQueue.js'

export type SessionProgress = {
  state: 'pending' | 'running' | 'done' | 'error'
  /** Utterances, not cues: one Whisper invocation each. */
  utterancesTotal: number
  utterancesDone: number
  errors: string[]
  startedAt: number
  finishedAt?: number
  sbvPath?: string
  runState?: LiveRunState
  /** Completed audio plus the in-flight utterance's progress. */
  processedAudioMs?: number
  totalAudioMs?: number
  lastActivityAt?: number | null
  engine?: EngineSnapshot | null
}

const progressBySession = new Map<string, SessionProgress>()

/** True while a run for the session is under way. */
export function isSessionRunning(sessionId: string): boolean {
  return isLiveSessionRunning(sessionId)
}

export function getSessionProgress(sessionId: string): SessionProgress | undefined {
  // Bridge to the live queue state so the Sessions tab's status polling
  // reflects whatever the live worker is doing right now. Counts are per
  // utterance: one utterance yields one to several cues, so a cue count
  // as the numerator reads complete with utterances still queued.
  const live = getLiveSessionState(sessionId)
  if (live) {
    const running = isLiveSessionRunning(sessionId)
    return {
      state: running ? 'running' : live.runState === 'failed' ? 'error' : 'done',
      utterancesTotal: live.utterancesTotal,
      utterancesDone: live.utterancesDone,
      errors: live.failure ? [...live.errors, live.failure] : live.errors,
      startedAt: live.startedAt,
      sbvPath: 'session.sbv',
      runState: live.runState,
      processedAudioMs: live.processedAudioMs + (live.current?.progressMs ?? 0),
      totalAudioMs: live.totalAudioMs,
      lastActivityAt: live.lastActivityAt,
      engine: live.engine,
    }
  }
  return progressBySession.get(sessionId)
}

/**
 * Progress for a session, including one no process is running any more.
 *
 * The in-memory answer above is the whole truth while a run is live. Once
 * the server has forgotten a run — or never knew it, because the process
 * that started it is gone — the snapshot the queue writes into the manifest
 * after every utterance is all that is left. Without this the sessions list
 * called an interrupted run "recorded", while opening the same session
 * called it interrupted, which is the disagreement between two readouts
 * that the run state exists to settle.
 *
 * A session that never ran still answers undefined, so a never-transcribed
 * upload stays a 204 rather than becoming a job that was never a job.
 */
export async function readSessionProgress(sessionId: string): Promise<SessionProgress | undefined> {
  const live = getSessionProgress(sessionId)
  if (live) return live

  const manifest = await readManifest(sessionId)
  if (!manifest) return undefined
  const runState = deriveRunState(manifest)
  if (runState === 'idle') return undefined

  const snap = manifest.processing.progress
  const totals = manifest.participants.reduce(
    (acc, p) => {
      for (const u of p.utterances) {
        acc.utterances += 1
        acc.audioMs += u.durationMs ?? 0
      }
      return acc
    },
    { utterances: 0, audioMs: 0 },
  )
  const done = runState === 'done'
  return {
    // An interrupted run is not a failure: the Process button has to stay
    // available, because pressing it is how the run is picked back up.
    state: runState === 'failed' ? 'error' : done ? 'done' : 'pending',
    utterancesTotal: snap?.utterancesTotal ?? totals.utterances,
    utterancesDone: snap?.utterancesDone ?? (done ? totals.utterances : 0),
    errors: snap?.failure
      ? [...(manifest.processing.errors ?? []), snap.failure]
      : (manifest.processing.errors ?? []),
    startedAt: snap?.startedAt ?? 0,
    sbvPath: manifest.processing.sbvPath ?? undefined,
    runState,
    processedAudioMs: snap?.processedAudioMs ?? (done ? totals.audioMs : 0),
    totalAudioMs: snap?.totalAudioMs ?? totals.audioMs,
    lastActivityAt: snap?.lastActivityAt ?? null,
    engine: snap?.engine ?? null,
  }
}

/**
 * Start a run. Rejects while one is under way for the session: a second
 * run on top of a live one would transcribe every utterance twice and
 * write every cue into the SBV twice. The check and the claim happen
 * before the first await, so two callers in the same tick cannot both
 * pass.
 */
export async function processSession(sessionId: string): Promise<SessionProgress> {
  if (isLiveSessionRunning(sessionId)) {
    throw new Error('already running')
  }
  const startedAt = Date.now()
  const placeholder: SessionProgress = {
    state: 'running',
    utterancesTotal: 0,
    utterancesDone: 0,
    errors: [],
    startedAt,
    runState: 'transcribing',
  }
  progressBySession.set(sessionId, placeholder)
  void (async () => {
    try {
      // transcribeExistingSession finalises the run itself, writing the
      // SBV path and the progress snapshot into the manifest before it
      // returns, so the in-memory state can be dropped straight after.
      const state = await transcribeExistingSession(sessionId)
      progressBySession.set(sessionId, {
        state: 'done',
        utterancesTotal: state.utterancesTotal,
        utterancesDone: state.utterancesDone,
        errors: state.errors,
        startedAt,
        finishedAt: Date.now(),
        sbvPath: 'session.sbv',
        runState: 'done',
        processedAudioMs: state.processedAudioMs,
        totalAudioMs: state.totalAudioMs,
        lastActivityAt: state.lastActivityAt,
        engine: state.engine,
      })
      forgetLiveSession(sessionId)
    } catch (err) {
      const message = (err as Error).message
      progressBySession.set(sessionId, {
        ...placeholder,
        state: 'error',
        errors: [message],
        finishedAt: Date.now(),
        runState: 'failed',
      })
      await failLiveSession(sessionId, message)
    }
  })()
  return placeholder
}
