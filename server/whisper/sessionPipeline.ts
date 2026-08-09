// "Process session" path. The transcription queue in `liveQueue.ts` is
// the single source of truth — this module replays every utterance from
// an already-extracted session manifest onto that queue and lets it
// finalise normally. Used both for fresh uploads and for re-processing a
// session whose Whisper run errored or was interrupted.

import {
  finalizeLiveSession,
  forgetLiveSession,
  getLiveSessionState,
  transcribeExistingSession,
} from './liveQueue.js'

export type SessionProgress = {
  state: 'pending' | 'running' | 'done' | 'error'
  utterancesTotal: number
  utterancesDone: number
  errors: string[]
  startedAt: number
  finishedAt?: number
  sbvPath?: string
}

const progressBySession = new Map<string, SessionProgress>()

export function getSessionProgress(sessionId: string): SessionProgress | undefined {
  // Bridge to the live queue state so the Sessions tab's status polling
  // reflects whatever the live worker is doing right now.
  const live = getLiveSessionState(sessionId)
  if (live) {
    return {
      state: live.active ? 'running' : 'done',
      utterancesTotal: live.segments.length + live.pending,
      utterancesDone: live.segments.length,
      errors: live.errors,
      startedAt: live.startedAt,
      sbvPath: 'session.sbv',
    }
  }
  return progressBySession.get(sessionId)
}

export async function processSession(sessionId: string): Promise<SessionProgress> {
  const startedAt = Date.now()
  const placeholder: SessionProgress = {
    state: 'running',
    utterancesTotal: 0,
    utterancesDone: 0,
    errors: [],
    startedAt,
  }
  progressBySession.set(sessionId, placeholder)
  void (async () => {
    try {
      const state = await transcribeExistingSession(sessionId)
      await finalizeLiveSession(sessionId)
      progressBySession.set(sessionId, {
        state: 'done',
        utterancesTotal: state.segments.length,
        utterancesDone: state.segments.length,
        errors: state.errors,
        startedAt,
        finishedAt: Date.now(),
        sbvPath: 'session.sbv',
      })
      forgetLiveSession(sessionId)
    } catch (err) {
      progressBySession.set(sessionId, {
        ...placeholder,
        state: 'error',
        errors: [(err as Error).message],
        finishedAt: Date.now(),
      })
    }
  })()
  return placeholder
}
