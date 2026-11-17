// getSessionProgress reports utterances, not cues. One utterance yields one
// to several cues, so a cue count as the numerator overshoots and the bar
// reads complete with utterances still queued.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LiveSessionState } from './liveQueue.js'

function fakeState(over: Partial<LiveSessionState> = {}): LiveSessionState {
  return {
    sessionId: 's',
    active: true,
    initialPrompt: '',
    participants: new Map(),
    segments: [],
    processedUtterances: 0,
    pending: 0,
    enqueued: 0,
    errors: [],
    startedAt: 1000,
    runState: 'transcribing',
    lastActivityAt: 2000,
    totalAudioMs: 0,
    processedAudioMs: 0,
    utterancesTotal: 0,
    utterancesDone: 0,
    current: null,
    engine: null,
    completed: [],
    failure: null,
    devices: {},
    ...over,
  }
}

let live: LiveSessionState | undefined
let running = false

beforeEach(() => {
  live = undefined
  running = false
  vi.resetModules()
  vi.doMock('./liveQueue.js', () => ({
    getLiveSessionState: () => live,
    isLiveSessionRunning: () => running,
    transcribeExistingSession: vi.fn(),
    forgetLiveSession: vi.fn(),
    failLiveSession: vi.fn(),
  }))
})

afterEach(() => {
  vi.doUnmock('./liveQueue.js')
  vi.resetModules()
})

describe('getSessionProgress', () => {
  it('counts utterances, not cues, and carries the progress fields', async () => {
    // Five cues from one finished utterance; one utterance still queued.
    const segments = new Array(5).fill({}) as LiveSessionState['segments']
    live = fakeState({
      segments,
      pending: 1,
      processedUtterances: 1,
      enqueued: 2,
      utterancesTotal: 2,
      utterancesDone: 1,
      totalAudioMs: 90_000,
      processedAudioMs: 60_000,
      current: {
        utteranceId: 'u_1',
        speakerDisplay: 'B',
        audioMs: 30_000,
        startedAt: 1500,
        attempt: 1,
        progressMs: 12_000,
      },
      engine: { name: 'faster-whisper', model: 'large-v3', device: 'cuda', computeType: 'int8_float16', fallback: false },
    })
    running = true
    const { getSessionProgress, isSessionRunning } = await import('./sessionPipeline.js')

    const progress = getSessionProgress('s')!
    expect(isSessionRunning('s')).toBe(true)
    expect(progress.state).toBe('running')
    expect(progress.utterancesTotal).toBe(2)
    expect(progress.utterancesDone).toBe(1)
    expect(progress.runState).toBe('transcribing')
    expect(progress.processedAudioMs).toBe(72_000)
    expect(progress.totalAudioMs).toBe(90_000)
    expect(progress.lastActivityAt).toBe(2000)
    expect(progress.startedAt).toBe(1000)
    expect(progress.engine).toMatchObject({ device: 'cuda', fallback: false })
  })

  it('maps a finished run to done and a failed run to error, with the failure listed', async () => {
    const { getSessionProgress } = await import('./sessionPipeline.js')

    live = fakeState({ runState: 'done', utterancesTotal: 3, utterancesDone: 3 })
    expect(getSessionProgress('s')).toMatchObject({ state: 'done', runState: 'done', utterancesDone: 3 })

    live = fakeState({ runState: 'failed', failure: 'disk full', errors: ['a/u_0: boom'] })
    expect(getSessionProgress('s')).toMatchObject({
      state: 'error',
      runState: 'failed',
      errors: ['a/u_0: boom', 'disk full'],
    })
  })

  it('returns undefined when nothing is known about the session', async () => {
    const { getSessionProgress } = await import('./sessionPipeline.js')
    expect(getSessionProgress('never-seen')).toBeUndefined()
  })
})

describe('processSession', () => {
  it('refuses to start a second run while one is under way', async () => {
    live = fakeState()
    running = true
    const { processSession } = await import('./sessionPipeline.js')
    await expect(processSession('s')).rejects.toThrow(/already running/)
  })
})
