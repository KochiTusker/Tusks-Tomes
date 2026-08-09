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
})
