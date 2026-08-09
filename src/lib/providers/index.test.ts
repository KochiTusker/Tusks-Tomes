import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getActiveProvider, getCloudProvider, getProvider, refreshProviders } from './index'
import type { GeminiProvider } from './gemini'
import { setProviderSettings } from './settings'
import { MODEL_FLASH, MODEL_PRO } from '../constants'

// Regression coverage for the keystore-to-singleton wiring in rebuild().
// The constructor itself was always correct — the bug was that rebuild()
// passed the free key into the primaryKey slot, which populates paidClient,
// while activeClient()/hasKey() for tier 'free' only reads freeClient.

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

describe('provider registry — geminiFree wiring', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reports hasKey() === true after refreshProviders() when keystore has geminiFallback', async () => {
    stubKeysResponse({ geminiFallback: 'test-free-key' })
    await refreshProviders()
    const free = getCloudProvider('gemini', { geminiTier: 'free' }) as GeminiProvider
    expect(free.hasKey()).toBe(true)
  })

  it('reports hasKey() === false when keystore has only a paid key (no free fallback)', async () => {
    stubKeysResponse({ gemini: 'paid-key-only' })
    await refreshProviders()
    const free = getCloudProvider('gemini', { geminiTier: 'free' }) as GeminiProvider
    expect(free.hasKey()).toBe(false)
  })

  it('paid singleton remains independently keyed when both keys are configured', async () => {
    stubKeysResponse({ gemini: 'paid-k', geminiFallback: 'free-k' })
    await refreshProviders()
    const paid = getCloudProvider('gemini', { geminiTier: 'paid' }) as GeminiProvider
    const free = getCloudProvider('gemini', { geminiTier: 'free' }) as GeminiProvider
    expect(paid.hasKey()).toBe(true)
    expect(free.hasKey()).toBe(true)
  })

  it('refreshProviders() builds a fresh auto-tier singleton with useFallback=false', async () => {
    // The audit flagged that `useFallback` is non-reversible inside a single
    // singleton's lifetime. The user fix path is: click "Switch to paid" →
    // refreshProviders() rebuilds the singletons → next call retries Paid
    // fresh. Lock that contract: a refresh ALWAYS resets useFallback for the
    // auto-tier instance even if the previous instance had it flipped.
    stubKeysResponse({ gemini: 'paid-k', geminiFallback: 'free-k' })
    await refreshProviders()
    const before = getCloudProvider('gemini') as GeminiProvider
    // Force the previous singleton into the flipped state.
    ;(before as unknown as { useFallback: boolean }).useFallback = true
    expect(before.isPermanentlyOnFallback()).toBe(true)
    // Now refresh — the user's "Switch to paid" handler does this after
    // putRouting. The audit found that without this, the user would stay
    // on Free until a full server restart.
    await refreshProviders()
    const after = getCloudProvider('gemini') as GeminiProvider
    expect(after).not.toBe(before)
    expect(after.isPermanentlyOnFallback()).toBe(false)
  })

  it('refreshProviders() resets recent-call history (no stale "47 requests in last minute")', async () => {
    // Verbose dialog cites requestsInLastMinute. After a refresh that count
    // should be zero (fresh RateLimitState in the new singleton). Without
    // this guarantee, a user would switch to Paid and the post-switch
    // dialog could falsely claim "you've made 47 requests" carrying over
    // from the previous singleton.
    stubKeysResponse({ gemini: 'paid-k', geminiFallback: 'free-k' })
    await refreshProviders()
    const before = getCloudProvider('gemini') as GeminiProvider
    // Pump 5 noteCall()s into the rate-limit history.
    for (let i = 0; i < 5; i++) before.rateLimit.noteCall()
    expect(before.rateLimit.recentCallCount(60_000)).toBe(5)
    await refreshProviders()
    const after = getCloudProvider('gemini') as GeminiProvider
    expect(after.rateLimit.recentCallCount(60_000)).toBe(0)
  })
})

describe('getProvider — explicit routing contract', () => {
  // The Phase H audit caught that getActiveProvider() previously hard-coded
  // a fork over isLocalProvider() and silently fell through to Gemini for
  // any non-local selection — meaning Claude / OpenAI selections (if ever
  // wired into ProviderSettings) would have been silently routed to Gemini.
  // The pipeline's per-phase routing path uses getCloudProvider() instead,
  // which IS correct, but Caption Repair, persona generation, and the
  // legacy single-provider pipeline path all go through getActiveProvider.
  // These tests lock in the explicit-name routing so a future expansion of
  // ProviderId to include claude/openai is structurally safe.

  beforeEach(() => {
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('routes "gemini" to the GeminiProvider singleton', () => {
    const p = getProvider('gemini')
    expect(p.name).toBe('gemini')
  })

  it('routes "claude" to the ClaudeProvider singleton (NOT Gemini)', () => {
    const p = getProvider('claude')
    expect(p.name).toBe('claude')
  })

  it('routes "openai" to the OpenAIProvider singleton (NOT Gemini)', () => {
    const p = getProvider('openai')
    expect(p.name).toBe('openai')
  })

  it('routes "local" to the LocalProviderAdapter singleton', () => {
    const p = getProvider('local')
    expect(p.name).toBe('local')
  })

  it('routes "claudeCode" to the ClaudeCodeProvider singleton', () => {
    const p = getProvider('claudeCode')
    expect(p.name).toBe('claudeCode')
  })

  it('getCloudProvider("claudeCode") resolves the ClaudeCodeProvider', () => {
    const p = getCloudProvider('claudeCode')
    expect(p.name).toBe('claudeCode')
  })
})

describe('getActiveProvider — honors current selection', () => {
  // In-memory localStorage shim — the Node test environment doesn't ship a
  // DOM, so setProviderSettings() (which writes to localStorage) would
  // otherwise crash. This is the same pattern the dev server uses to
  // pre-render React in production builds.
  function stubLocalStorage(): void {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v) },
      removeItem: (k: string) => { store.delete(k) },
      clear: () => { store.clear() },
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      get length() { return store.size },
    })
  }

  beforeEach(() => {
    vi.unstubAllGlobals()
    stubLocalStorage()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns the Gemini singleton when current selection is gemini', () => {
    setProviderSettings({ providerId: 'gemini', proModel: MODEL_PRO, flashModel: MODEL_FLASH })
    const p = getActiveProvider()
    expect(p.name).toBe('gemini')
  })

  it('returns the local adapter when current selection is ollama', () => {
    setProviderSettings({ providerId: 'ollama', proModel: MODEL_PRO, flashModel: MODEL_FLASH })
    const p = getActiveProvider()
    expect(p.name).toBe('local')
  })

  it('returns the local adapter when current selection is lmstudio', () => {
    setProviderSettings({ providerId: 'lmstudio', proModel: MODEL_PRO, flashModel: MODEL_FLASH })
    const p = getActiveProvider()
    expect(p.name).toBe('local')
  })

  it('returns the local adapter when current selection is unsloth', () => {
    setProviderSettings({ providerId: 'unsloth', proModel: MODEL_PRO, flashModel: MODEL_FLASH })
    const p = getActiveProvider()
    expect(p.name).toBe('local')
  })
})
