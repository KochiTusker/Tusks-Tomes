/** @vitest-environment jsdom */
// v1.1.0 — PROVIDERS_CHANGED_EVENT lock-down test.
//
// Pre-fix bug: refreshProviders() updated the cached singletons but
// emitted no signal. Components downstream (e.g. RefinementTool) cached
// references to the active provider at run-start time; a mid-run key
// swap by the user dispatched subsequent chunks to the stale singleton,
// producing unexpected bill on the wrong account.
//
// Fix: refreshProviders() now dispatches a window-level CustomEvent.
// Listeners decide what to do (the RefinementTool warns the user that
// the next chunk will use the new singleton; tests can simply assert
// the event fires).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PROVIDERS_CHANGED_EVENT, refreshProviders } from './index'
import type { ProvidersChangedDetail } from './index'

function stubKeysResponse(payload: object) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      ({
        ok: true,
        status: 200,
        json: async () => payload,
      }) as unknown as Response,
    ),
  )
}

describe('PROVIDERS_CHANGED_EVENT', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fires on refreshProviders()', async () => {
    stubKeysResponse({ gemini: 'paid-key' })
    const fired: CustomEvent[] = []
    const handler = (e: Event) => fired.push(e as CustomEvent)
    window.addEventListener(PROVIDERS_CHANGED_EVENT, handler)

    await refreshProviders()

    expect(fired.length).toBeGreaterThanOrEqual(1)
    window.removeEventListener(PROVIDERS_CHANGED_EVENT, handler)
  })

  it('detail.changedKeys lists slots that flipped between configured states', async () => {
    // Round 1: only paid configured.
    stubKeysResponse({ gemini: 'paid-key' })
    await refreshProviders()

    // Round 2: user adds claude + free fallback. Both new keys should
    // show up as changedKeys; gemini stayed the same so it should NOT.
    stubKeysResponse({ gemini: 'paid-key', claude: 'new-claude', geminiFallback: 'new-free' })
    const fired: CustomEvent[] = []
    const handler = (e: Event) => fired.push(e as CustomEvent)
    window.addEventListener(PROVIDERS_CHANGED_EVENT, handler)

    await refreshProviders()

    expect(fired.length).toBe(1)
    const detail = fired[0].detail as ProvidersChangedDetail
    expect(detail.changedKeys.sort()).toEqual(['claude', 'geminiFallback'])
    window.removeEventListener(PROVIDERS_CHANGED_EVENT, handler)
  })

  it('detail.changedKeys is empty when the same key set is re-supplied', async () => {
    stubKeysResponse({ gemini: 'k1', claude: 'k2' })
    await refreshProviders()

    // Same payload — no change.
    stubKeysResponse({ gemini: 'k1', claude: 'k2' })
    const fired: CustomEvent[] = []
    const handler = (e: Event) => fired.push(e as CustomEvent)
    window.addEventListener(PROVIDERS_CHANGED_EVENT, handler)

    await refreshProviders()

    expect(fired.length).toBe(1)
    const detail = fired[0].detail as ProvidersChangedDetail
    expect(detail.changedKeys).toEqual([])
    window.removeEventListener(PROVIDERS_CHANGED_EVENT, handler)
  })

  it('detail.changedKeys catches a key VALUE change for the same slot (rotation)', async () => {
    stubKeysResponse({ gemini: 'old-key' })
    await refreshProviders()

    stubKeysResponse({ gemini: 'rotated-key' })
    const fired: CustomEvent[] = []
    const handler = (e: Event) => fired.push(e as CustomEvent)
    window.addEventListener(PROVIDERS_CHANGED_EVENT, handler)

    await refreshProviders()

    const detail = fired[0].detail as ProvidersChangedDetail
    expect(detail.changedKeys).toContain('gemini')
    window.removeEventListener(PROVIDERS_CHANGED_EVENT, handler)
  })
})
