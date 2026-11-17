import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('liveSessionBridge', () => {
  beforeEach(() => {
    vi.resetModules()
  })
  afterEach(() => {
    vi.resetModules()
  })

  it('returns undefined from getLiveSessionState before registration', async () => {
    const bridge = await import('./liveSessionBridge')
    expect(bridge.getLiveSessionState('any-id')).toBeUndefined()
  })

  it('refreshLiveSbv resolves without throwing before registration', async () => {
    const bridge = await import('./liveSessionBridge')
    await expect(bridge.refreshLiveSbv('any-id')).resolves.toBeUndefined()
  })

  it('delegates to registered getLiveState after registerLiveImpl', async () => {
    const bridge = await import('./liveSessionBridge')
    const fakeState = {
      active: true,
      pending: 1,
      processedUtterances: 0,
      enqueued: 2,
      segments: [],
      errors: [],
      participants: new Map(),
    }
    const fakeGet = vi.fn(() => fakeState)
    const fakeRefresh = vi.fn(async () => {})

    bridge.registerLiveImpl(fakeGet, fakeRefresh)

    expect(bridge.getLiveSessionState('abc')).toBe(fakeState)
    expect(fakeGet).toHaveBeenCalledWith('abc')
  })

  it('delegates to registered refreshLiveSbv after registerLiveImpl', async () => {
    const bridge = await import('./liveSessionBridge')
    const fakeGet = vi.fn(() => undefined)
    const fakeRefresh = vi.fn(async () => {})

    bridge.registerLiveImpl(fakeGet, fakeRefresh)

    await bridge.refreshLiveSbv('xyz')
    expect(fakeRefresh).toHaveBeenCalledWith('xyz')
  })

  it('passes the progress fields through untouched', async () => {
    const bridge = await import('./liveSessionBridge')
    const fakeState: import('./liveSessionBridge').LiveState = {
      active: true,
      pending: 1,
      processedUtterances: 1,
      enqueued: 2,
      segments: [],
      errors: [],
      participants: new Map(),
      startedAt: 1000,
      runState: 'transcribing',
      lastActivityAt: 2000,
      totalAudioMs: 90_000,
      processedAudioMs: 60_000,
      utterancesTotal: 2,
      utterancesDone: 1,
      current: {
        utteranceId: 'u_1',
        speakerDisplay: 'B',
        audioMs: 30_000,
        startedAt: 1500,
        attempt: 1,
        progressMs: 12_000,
      },
      engine: { name: 'faster-whisper', model: 'large-v3', device: 'cuda', computeType: 'int8_float16', fallback: false },
      completed: [{ audioMs: 60_000, elapsedMs: 30 }],
      failure: null,
      devices: { cuda: 1 },
    }
    bridge.registerLiveImpl(() => fakeState, async () => {})

    const got = bridge.getLiveSessionState('abc')
    expect(got?.runState).toBe('transcribing')
    expect(got?.current?.progressMs).toBe(12_000)
    expect(got?.engine?.device).toBe('cuda')
  })

  it('throughputOf is a ratio of sums, and null until an utterance has completed', async () => {
    const { throughputOf } = await import('./liveSessionBridge')
    expect(throughputOf([])).toBeNull()
    expect(throughputOf([{ audioMs: 1000, elapsedMs: 0 }])).toBeNull()
    // 90 s of audio in 45 ms of engine time: 2000× realtime, not the mean
    // of the two per-utterance ratios.
    expect(
      throughputOf([
        { audioMs: 60_000, elapsedMs: 30 },
        { audioMs: 30_000, elapsedMs: 15 },
      ]),
    ).toBe(2000)
  })
})
