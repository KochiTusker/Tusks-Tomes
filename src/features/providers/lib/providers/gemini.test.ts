import { describe, expect, it, vi } from 'vitest'
import {
  GeminiProvider,
  classifyExhaustion,
  detectHardZeroQuota,
  detectProhibitedContentBlock,
  HARD_ZERO_QUOTA_PATTERNS,
  isTransientServerError,
  UNCONFIGURABLE_BLOCK_REASONS,
  wrapWithContext,
} from './gemini'
import { GEMINI_STATIC_LIMITS } from '../rateLimit'

// Mocking the GoogleGenAI SDK to exercise generate() would let us assert
// the full per-call re-seed, but staticLimitsFor() carries the actual
// (tier, model) → row decision and is what we need to lock down. Test it
// directly via the constructor's tier wiring.

function makeProvider(args: { tier: 'paid' | 'free' | 'auto'; primary?: string; fallback?: string | null }) {
  return new GeminiProvider({
    primaryKey: args.primary ?? 'paid-test-key',
    fallbackKey: args.fallback ?? 'free-test-key',
    tier: args.tier,
  })
}

describe('GeminiProvider.staticLimitsFor', () => {
  describe('paid tier (paidPro / paidFlash)', () => {
    const p = makeProvider({ tier: 'paid' })
    it('picks paidPro for a Pro model', () => {
      expect(p.staticLimitsFor('gemini-2.5-pro')).toEqual(GEMINI_STATIC_LIMITS.paidPro)
    })
    it('picks paidFlash for a Flash model', () => {
      expect(p.staticLimitsFor('gemini-2.5-flash')).toEqual(GEMINI_STATIC_LIMITS.paidFlash)
    })
    it('picks paidFlash for Flash-Lite (matches /flash/ case-insensitively)', () => {
      expect(p.staticLimitsFor('gemini-2.0-flash-lite')).toEqual(GEMINI_STATIC_LIMITS.paidFlash)
      expect(p.staticLimitsFor('GEMINI-2.5-FLASH')).toEqual(GEMINI_STATIC_LIMITS.paidFlash)
    })
    it('defaults to paidPro for unknown model strings', () => {
      expect(p.staticLimitsFor('gemini-experimental')).toEqual(GEMINI_STATIC_LIMITS.paidPro)
      expect(p.staticLimitsFor('')).toEqual(GEMINI_STATIC_LIMITS.paidPro)
    })
  })

  describe('free tier (freePro / freeFlash)', () => {
    const p = makeProvider({ tier: 'free' })
    it('picks freePro for a Pro model', () => {
      expect(p.staticLimitsFor('gemini-2.5-pro')).toEqual(GEMINI_STATIC_LIMITS.freePro)
    })
    it('picks freeFlash for a Flash model', () => {
      expect(p.staticLimitsFor('gemini-2.5-flash')).toEqual(GEMINI_STATIC_LIMITS.freeFlash)
    })
  })

  describe('auto tier — pre-fallback uses paid rows', () => {
    const p = makeProvider({ tier: 'auto' })
    it('picks paidPro for a Pro model when no fallback flip has happened', () => {
      expect(p.staticLimitsFor('gemini-2.5-pro')).toEqual(GEMINI_STATIC_LIMITS.paidPro)
    })
    it('picks paidFlash for a Flash model when no fallback flip has happened', () => {
      expect(p.staticLimitsFor('gemini-2.5-flash')).toEqual(GEMINI_STATIC_LIMITS.paidFlash)
    })
  })

  describe('auto tier — after fallback flip uses free rows', () => {
    it('switches to freePro/freeFlash after useFallback is set', () => {
      const p = makeProvider({ tier: 'auto' })
      // Reach in to flip the soft-fallback bit (the only test seam we have
      // without standing up a real 429 from a mocked SDK).
      ;(p as unknown as { useFallback: boolean }).useFallback = true
      expect(p.staticLimitsFor('gemini-2.5-pro')).toEqual(GEMINI_STATIC_LIMITS.freePro)
      expect(p.staticLimitsFor('gemini-2.5-flash')).toEqual(GEMINI_STATIC_LIMITS.freeFlash)
    })
  })
})

describe('classifyExhaustion (shape-based)', () => {
  it('detects per-day quotas via PerDay substring', () => {
    expect(classifyExhaustion(new Error('429 Too Many Requests. Quota exceeded for quota metric GenerateContentInputTokensPerDayPerProjectPerModel.')))
      .toBe('daily_quota')
    expect(classifyExhaustion(new Error('quotaId: per-day-quota-limit')))
      .toBe('daily_quota')
  })

  it('detects per-minute quotas via PerMinute substring', () => {
    expect(classifyExhaustion(new Error('429 Quota exceeded for quota metric GenerateContentRequestsPerMinutePerProject.')))
      .toBe('rate_limit')
    expect(classifyExhaustion(new Error('PerMinutePerProject')))
      .toBe('rate_limit')
  })

  it('defaults generic 429 / quota / rate-limit messages to rate_limit', () => {
    expect(classifyExhaustion(new Error('429 RESOURCE_EXHAUSTED'))).toBe('rate_limit')
    expect(classifyExhaustion(new Error('rate limit hit'))).toBe('rate_limit')
    expect(classifyExhaustion(new Error('quota exceeded'))).toBe('rate_limit')
  })

  it('classifies non-quota errors as transient', () => {
    expect(classifyExhaustion(new Error('500 INTERNAL_SERVER_ERROR'))).toBe('transient')
    expect(classifyExhaustion(new Error('network unreachable'))).toBe('transient')
    expect(classifyExhaustion(undefined)).toBe('transient')
  })
})

// K.2.4 / W3 — wrapWithContext now vlogs when a non-configurable
// property fails to propagate. Without this, the silent-skip path could
// drop diagnostic flags like `isProhibitedContent` and turn a
// recoverable safety-block into a run-killing throw with no log trail.
describe('wrapWithContext (K.2.4 / W3 silent-skip logging)', () => {
  it('returns the base error unchanged when no contextLabel is provided', () => {
const base = new Error('boom')
    expect(wrapWithContext(base)).toBe(base)
  })

  it('wraps the error with [contextLabel]\\n prefix when provided', () => {
const base = new Error('boom')
    const wrapped = wrapWithContext(base, 'Phase 1 chunk 3')
    expect(wrapped.message).toBe('[Phase 1 chunk 3]\nboom')
  })

  it('propagates diagnostic flags from the base error (isProhibitedContent et al)', () => {
const base = new Error('blocked') as Error & {
      isProhibitedContent?: boolean
      prohibitedBlockReason?: string
    }
    base.isProhibitedContent = true
    base.prohibitedBlockReason = 'HATE_SPEECH'
    const wrapped = wrapWithContext(base, 'Phase 4 chunk 12') as Error & {
      isProhibitedContent?: boolean
      prohibitedBlockReason?: string
    }
    expect(wrapped.isProhibitedContent).toBe(true)
    expect(wrapped.prohibitedBlockReason).toBe('HATE_SPEECH')
  })

  it('does not throw when the base error has a non-configurable property — silent skip is safe', () => {
const base = new Error('weird')
    // Define a non-configurable, non-writable property — assigning to it
    // on the wrapped error throws, which the loop must catch.
    Object.defineProperty(base, 'lockedFlag', {
      value: 42,
      writable: false,
      configurable: false,
      enumerable: true,
    })
    // Mock Object.defineProperty so we can verify a wrapped attempt
    // fails — but the simpler test: just ensure no throw escapes.
    expect(() => wrapWithContext(base, 'ctx')).not.toThrow()
  })
})

describe('GeminiProvider.classifyWithHeuristic', () => {
  it('returns shape-based result on a single exhaustion', () => {
    const p = makeProvider({ tier: 'auto' })
    expect(p.classifyWithHeuristic(new Error('429 PerMinute quota exceeded'), 1_000))
      .toBe('rate_limit')
  })

  it('upgrades repeated rate-limit hits to daily_quota after 3 within 5 minutes', () => {
    const p = makeProvider({ tier: 'auto' })
    const t0 = 1_000_000
    p.classifyWithHeuristic(new Error('429 quota'), t0)
    p.classifyWithHeuristic(new Error('429 quota'), t0 + 60_000)
    // Third hit within 5 min → heuristic upgrade.
    expect(p.classifyWithHeuristic(new Error('429 quota'), t0 + 120_000))
      .toBe('daily_quota')
  })

  it('does not upgrade if hits are spaced beyond the 5-minute window', () => {
    const p = makeProvider({ tier: 'auto' })
    const t0 = 1_000_000
    p.classifyWithHeuristic(new Error('429 quota'), t0)
    // Second hit 10 minutes later — first one falls out of the window.
    expect(p.classifyWithHeuristic(new Error('429 quota'), t0 + 10 * 60_000))
      .toBe('rate_limit')
  })

  it('keeps a shape-based daily_quota classification even without history', () => {
    const p = makeProvider({ tier: 'auto' })
    expect(p.classifyWithHeuristic(new Error('PerDay quota exceeded'), 1_000))
      .toBe('daily_quota')
  })

  it('passes through transient errors without recording history', () => {
    const p = makeProvider({ tier: 'auto' })
    p.classifyWithHeuristic(new Error('500 server error'), 1_000)
    p.classifyWithHeuristic(new Error('500 server error'), 2_000)
    p.classifyWithHeuristic(new Error('500 server error'), 3_000)
    // Three transient errors should NOT trigger the daily-quota heuristic.
    expect(p.classifyWithHeuristic(new Error('429 quota'), 4_000)).toBe('rate_limit')
  })

  // K.2.2 / W5 — resetExhaustionHistory after a successful call.
  it('K.2.2: resetExhaustionHistory clears recentExhaustionTimes so the next exhaustion classifies on shape alone', () => {
    const p = makeProvider({ tier: 'auto' })
    const t0 = 1_000_000
    p.classifyWithHeuristic(new Error('429 quota'), t0)
    p.classifyWithHeuristic(new Error('429 quota'), t0 + 60_000)
    expect(p.classifyWithHeuristic(new Error('429 quota'), t0 + 120_000))
      .toBe('daily_quota') // baseline: three hits within 5min → upgrade

    // A successful call lands — clear the history.
    p.resetExhaustionHistory()

    // The next rate-limit hit must classify shape-only ('rate_limit'),
    // not as a stale-heuristic 'daily_quota'. Without K.2.2's fix the
    // history would still hold ≥ 3 entries within 5 minutes.
    expect(p.classifyWithHeuristic(new Error('429 quota'), t0 + 180_000))
      .toBe('rate_limit')
  })

  it('K.2.2: resetExhaustionHistory is a no-op when no history exists (safe to call anytime)', () => {
    const p = makeProvider({ tier: 'auto' })
    p.resetExhaustionHistory()
    expect(p.classifyWithHeuristic(new Error('429 quota'), 1_000)).toBe('rate_limit')
  })
})

describe('isTransientServerError', () => {
  it('flags Google 503 UNAVAILABLE responses (model demand spike)', () => {
    // The exact wrapped-error shape the user sees in the diagnostic
    // panel — pulled from a real run.
    const wrapped = new Error(
      [
        'Gemini API call failed.',
        '',
        '--- Diagnostic context ---',
        'Model:         gemini-2.5-flash',
        'Prompt length: 8,879 chars',
        '',
        '--- Original error ---',
        'got status: 503 . {"error":{"code":503,"message":"This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.","status":"UNAVAILABLE"}}',
      ].join('\n'),
    )
    expect(isTransientServerError(wrapped)).toBe(true)
  })

  it('flags 502 bad gateway', () => {
    expect(isTransientServerError(new Error('got status: 502 bad gateway'))).toBe(true)
  })

  it('flags 504 gateway timeout', () => {
    expect(isTransientServerError(new Error('got status: 504 DEADLINE_EXCEEDED'))).toBe(true)
  })

  it('flags fetch-level transport failures', () => {
    expect(isTransientServerError(new Error('ECONNRESET'))).toBe(true)
    expect(isTransientServerError(new Error('ETIMEDOUT after 60s'))).toBe(true)
    expect(isTransientServerError(new Error('fetch failed'))).toBe(true)
    expect(isTransientServerError(new Error('socket hang up'))).toBe(true)
  })

  it('does NOT flag 429 (handled by the exhaustion path instead)', () => {
    expect(isTransientServerError(new Error('got status: 429 . quota exceeded'))).toBe(false)
  })

  it('does NOT flag 400 / 401 / 403 (permanent — retrying would waste time)', () => {
    expect(isTransientServerError(new Error('got status: 400 invalid request'))).toBe(false)
    expect(isTransientServerError(new Error('got status: 401 unauthorized'))).toBe(false)
    expect(isTransientServerError(new Error('got status: 403 permission denied'))).toBe(false)
  })

  it('does NOT flag undefined / empty errors', () => {
    expect(isTransientServerError(undefined)).toBe(false)
    expect(isTransientServerError(new Error(''))).toBe(false)
  })
})

describe('detectHardZeroQuota', () => {
  // Each pattern in HARD_ZERO_QUOTA_PATTERNS gets a fixture matching a real
  // Google API response shape. Without this, a Google response-format change
  // would silently bypass auto-swap to the fallback key.

  it('matches the classic "limit: 0" shape', () => {
    const err = new Error('429 RESOURCE_EXHAUSTED. metric=GenerateContentFreeTier, limit: 0, value: 1')
    const result = detectHardZeroQuota(err)
    expect(result.matched).toBe(true)
    expect(result.pattern).toBe('limit:0')
  })

  it('matches the newer quotaValue: "0" shape', () => {
    const err = new Error('quotaId: per-day-quota-limit, quotaValue: "0", quotaDimensions: {model: "gemini-2.5-pro"}')
    const result = detectHardZeroQuota(err)
    expect(result.matched).toBe(true)
    expect(result.pattern).toBe('quotaValue:0')
  })

  it('matches the unquoted quotaValue: 0 shape', () => {
    const err = new Error('quota_value: 0 for project foo')
    const result = detectHardZeroQuota(err)
    expect(result.matched).toBe(true)
    expect(result.pattern).toBe('quotaValue:0')
  })

  it('matches the quotaLimitReached flag', () => {
    const err = new Error('Quota check failed: quotaLimitReached on model gemini-2.5-pro')
    const result = detectHardZeroQuota(err)
    expect(result.matched).toBe(true)
    expect(result.pattern).toBe('quotaLimitReached')
  })

  it('matches the snake_case quota_limit_reached variant', () => {
    const err = new Error('error: quota_limit_reached')
    const result = detectHardZeroQuota(err)
    expect(result.matched).toBe(true)
    expect(result.pattern).toBe('quotaLimitReached')
  })

  it('matches "daily quota exceeded" prose', () => {
    const err = new Error('429: Daily quota exceeded for project. Resets at midnight UTC.')
    const result = detectHardZeroQuota(err)
    expect(result.matched).toBe(true)
    expect(result.pattern).toBe('daily-quota-exceeded')
  })

  it('matches the generateContentRequestsPerDay:0 shape', () => {
    const err = new Error('quota metric: GenerateContentRequestsPerDay, limit: 0, current usage: 0')
    const result = detectHardZeroQuota(err)
    expect(result.matched).toBe(true)
    // Could match either the per-day metric pattern OR the generic limit:0 —
    // both are correct; the per-day-specific one is more informative.
    expect(['limit:0', 'generateContentRequestsPerDay:0']).toContain(result.pattern)
  })

  it('matches RESOURCE_EXHAUSTED + zero combo (different ordering)', () => {
    const err = new Error('RESOURCE_EXHAUSTED on quota foo: limit: 0')
    const result = detectHardZeroQuota(err)
    expect(result.matched).toBe(true)
    expect(['limit:0', 'RESOURCE_EXHAUSTED+zero']).toContain(result.pattern)
  })

  it('does NOT match per-minute rate-limit errors (those go through the soft-swap path)', () => {
    expect(detectHardZeroQuota(new Error('429 PerMinute quota exceeded')).matched).toBe(false)
    expect(detectHardZeroQuota(new Error('rate limit hit; retry in 30s')).matched).toBe(false)
  })

  it('does NOT match transient server errors', () => {
    expect(detectHardZeroQuota(new Error('500 INTERNAL_SERVER_ERROR')).matched).toBe(false)
    expect(detectHardZeroQuota(new Error('503 UNAVAILABLE')).matched).toBe(false)
    expect(detectHardZeroQuota(undefined).matched).toBe(false)
  })

  it('does NOT match generic 429 without a zero-quota signal', () => {
    expect(detectHardZeroQuota(new Error('429 Too Many Requests')).matched).toBe(false)
  })

  it('lists every declared pattern (test exists so new patterns auto-surface here)', () => {
    // Lock the count so a future pattern addition trips this test, forcing
    // the author to add a matching fixture above. Bump the expected count
    // when intentionally adding/removing patterns.
    expect(HARD_ZERO_QUOTA_PATTERNS.length).toBe(6)
  })
})

describe('GeminiProvider — fallback state machine (audit causes #2 + #6)', () => {
  // Lock the contract that the audit identified as critical: the soft-swap
  // only fires for 'auto' tier; tier-locked singletons can't swap. And
  // once `useFallback` flips, the singleton stays on Free for its lifetime
  // (refresh required to retry Paid).

  function setFlag(p: GeminiProvider, flag: 'useFallback', value: boolean): void {
    ;(p as unknown as { useFallback: boolean })[flag] = value
  }

  it('auto-tier singleton: canSwapToFallback returns true when both keys present and useFallback=false', () => {
    const p = makeProvider({ tier: 'auto' })
    expect(
      (p as unknown as { canSwapToFallback: () => boolean }).canSwapToFallback(),
    ).toBe(true)
  })

  it('auto-tier singleton: canSwapToFallback returns false after useFallback flips (one-way)', () => {
    const p = makeProvider({ tier: 'auto' })
    setFlag(p, 'useFallback', true)
    expect(
      (p as unknown as { canSwapToFallback: () => boolean }).canSwapToFallback(),
    ).toBe(false)
    expect(p.isPermanentlyOnFallback()).toBe(true)
  })

  it('paid-tier lock: canSwapToFallback returns false even with both keys present (no soft swap)', () => {
    const p = makeProvider({ tier: 'paid' })
    expect(
      (p as unknown as { canSwapToFallback: () => boolean }).canSwapToFallback(),
    ).toBe(false)
    // Forcing useFallback=true on a paid lock doesn't change isPermanentlyOnFallback —
    // it only reads true for auto-tier instances. Lock that contract.
    setFlag(p, 'useFallback', true)
    expect(p.isPermanentlyOnFallback()).toBe(false)
  })

  it('free-tier lock: useFallback is true at construction (locked to Free)', () => {
    const p = makeProvider({ tier: 'free' })
    expect(
      (p as unknown as { useFallback: boolean }).useFallback,
    ).toBe(true)
    // But isPermanentlyOnFallback is FALSE because the swap never happened —
    // the singleton was constructed locked to Free, not flipped during a run.
    // The dialog should NOT show "this run already swapped" for a fresh
    // Free-tier singleton.
    expect(p.isPermanentlyOnFallback()).toBe(false)
  })

  it('auto-tier with no free key: canSwapToFallback returns false (no fallback to swap TO)', () => {
    // makeProvider's default-fallback substitution would override an
    // explicit null, so construct directly to ensure freeClient = null.
    const p = new GeminiProvider({ primaryKey: 'paid-test-key', fallbackKey: null, tier: 'auto' })
    expect(
      (p as unknown as { canSwapToFallback: () => boolean }).canSwapToFallback(),
    ).toBe(false)
  })

  it('verbose error from hard-zero-quota path cites the matched pattern label', () => {
    // Sanity-check: the matched-pattern label feeds into the error wrap
    // message in generate(). If someone refactors detectHardZeroQuota to
    // drop the label, this test catches it. The full integration with
    // generate() requires SDK mocking + fake timers (the retry loop sleeps
    // EXHAUSTION_RETRY_MS=65s by default) — too heavy for this layer; we
    // assert the load-bearing source data here and the format string lives
    // in plain interpolation in gemini.ts which is straightforward to read.
    const hardZero = detectHardZeroQuota(
      new Error('429 RESOURCE_EXHAUSTED. metric=foo, limit: 0, value: 1'),
    )
    expect(hardZero.matched).toBe(true)
    expect(hardZero.pattern).toBe('limit:0')
  })
})

describe('GeminiProvider.activeKeyFingerprint — used by verbose dialog', () => {
  // The verbose dialog shows the key fingerprint of whichever singleton
  // dispatched the failing chunk. Lock the routing-through-tier-state
  // contract: paid singleton always points at the paid fingerprint, free
  // singleton always at the free fingerprint, auto-tier respects useFallback.
  //
  // Fingerprints are computed asynchronously in the constructor so the very
  // first call may see undefined — we let that race resolve before
  // asserting by awaiting a microtask + a tick.

  async function settled<T extends GeminiProvider>(p: T): Promise<T> {
    // Await the explicit `fingerprintsReady` promise the constructor
    // exposes. Without this, the parallel test runner sometimes runs the
    // assertion before crypto.subtle.digest's microtask lands.
    await p.fingerprintsReady
    return p
  }

  it('paid-tier singleton points at the paid fingerprint', async () => {
    const p = await settled(makeProvider({ tier: 'paid', primary: 'paid-secret', fallback: 'free-secret' }))
    const fp = (p as unknown as { activeKeyFingerprint: () => string | undefined }).activeKeyFingerprint()
    // jsdom + Node both have crypto.subtle now — non-undefined.
    expect(fp).toBeDefined()
    expect(fp).toHaveLength(6)
  })

  it('free-tier singleton points at the free fingerprint (different from paid)', async () => {
    const paid = await settled(makeProvider({ tier: 'paid', primary: 'paid-secret', fallback: null }))
    const free = await settled(makeProvider({ tier: 'free', primary: undefined as unknown as string, fallback: 'free-secret' }))
    const paidFp = (paid as unknown as { activeKeyFingerprint: () => string | undefined }).activeKeyFingerprint()
    const freeFp = (free as unknown as { activeKeyFingerprint: () => string | undefined }).activeKeyFingerprint()
    expect(paidFp).toBeDefined()
    expect(freeFp).toBeDefined()
    expect(paidFp).not.toBe(freeFp)
  })

  it('auto-tier singleton: paid fingerprint before useFallback, free fingerprint after', async () => {
    const p = await settled(makeProvider({ tier: 'auto', primary: 'paid-secret', fallback: 'free-secret' }))
    const beforeFp = (p as unknown as { activeKeyFingerprint: () => string | undefined }).activeKeyFingerprint()
    ;(p as unknown as { useFallback: boolean }).useFallback = true
    const afterFp = (p as unknown as { activeKeyFingerprint: () => string | undefined }).activeKeyFingerprint()
    expect(beforeFp).toBeDefined()
    expect(afterFp).toBeDefined()
    expect(beforeFp).not.toBe(afterFp)
  })
})

describe('GeminiProvider.createPrefixCache + deletePrefixCache', () => {
  // The provider's createPrefixCache / deletePrefixCache go through
  // `this.activeClient().caches.create({...})` / `.caches.delete({...})`.
  // Stub the activeClient method to inject a fake caches object and
  // assert the lifecycle. Avoids hitting the real Google API while still
  // exercising the real code path.

  function withFakeClient(p: GeminiProvider, caches: {
    create?: (params: unknown) => Promise<{ name?: string }>
    delete?: (params: { name: string }) => Promise<void>
  }) {
    ;(p as unknown as { activeClient: () => unknown }).activeClient = () =>
      ({ caches }) as unknown
  }

  it('skips create when the cacheable prefix is too small (< ~1000 tokens)', async () => {
    const p = makeProvider({ tier: 'paid' })
    const createSpy = vi.fn(async () => ({ name: 'should-not-be-called' }))
    withFakeClient(p, { create: createSpy })
    const handle = await p.createPrefixCache({
      systemPrompt: 'short',
      cacheablePrefix: 'also short',
      userPrompt: 'irrelevant',
      model: 'gemini-2.5-flash',
      maxOutputTokens: 100,
    })
    expect(handle).toBeNull()
    expect(createSpy).not.toHaveBeenCalled()
  })

  it('returns the cache name when create succeeds with a sufficiently large prefix', async () => {
    const p = makeProvider({ tier: 'paid' })
    const big = 'x'.repeat(8000) // > the 4000-char threshold
    const createSpy = vi.fn(async () => ({ name: 'cachedContents/abc123' }))
    withFakeClient(p, { create: createSpy })
    const handle = await p.createPrefixCache({
      systemPrompt: 'sys',
      cacheablePrefix: big,
      userPrompt: 'u',
      model: 'gemini-2.5-flash',
      maxOutputTokens: 100,
    })
    expect(handle).toBe('cachedContents/abc123')
    expect(createSpy).toHaveBeenCalledOnce()
    const call = (createSpy.mock.calls[0] as unknown as [{ model: string; config: { contents: string; ttl: string } }])[0]
    expect(call.model).toBe('gemini-2.5-flash')
    expect(call.config.contents).toContain(big)
    expect(call.config.ttl).toMatch(/^\d+s$/)
  })

  it('returns null and swallows the error when create() throws (fallback signal)', async () => {
    const p = makeProvider({ tier: 'paid' })
    const big = 'x'.repeat(8000)
    const createSpy = vi.fn(async () => {
      throw new Error('400 INVALID_ARGUMENT: prefix below minimum')
    })
    withFakeClient(p, { create: createSpy })
    const handle = await p.createPrefixCache({
      systemPrompt: 'sys',
      cacheablePrefix: big,
      userPrompt: 'u',
      model: 'gemini-2.5-flash',
      maxOutputTokens: 100,
    })
    expect(handle).toBeNull()
    expect(createSpy).toHaveBeenCalledOnce()
  })

  it('deletePrefixCache calls caches.delete with the handle and swallows errors', async () => {
    const p = makeProvider({ tier: 'paid' })
    const deleteSpy = vi.fn(async () => undefined)
    withFakeClient(p, { delete: deleteSpy })
    await p.deletePrefixCache('cachedContents/abc123')
    expect(deleteSpy).toHaveBeenCalledWith({ name: 'cachedContents/abc123' })
    // And the error case is silent.
    const throwingSpy = vi.fn(async () => {
      throw new Error('500 not found')
    })
    withFakeClient(p, { delete: throwingSpy })
    await expect(p.deletePrefixCache('cachedContents/missing')).resolves.toBeUndefined()
  })
})

describe('detectProhibitedContentBlock', () => {
  it('matches PROHIBITED_CONTENT on promptFeedback.blockReason', () => {
    const result = detectProhibitedContentBlock({
      promptFeedback: { blockReason: 'PROHIBITED_CONTENT' },
      candidates: [],
    })
    expect(result.matched).toBe(true)
    expect(result.reason).toBe('PROHIBITED_CONTENT')
  })

  it('matches BLOCKLIST on promptFeedback.blockReason', () => {
    const result = detectProhibitedContentBlock({
      promptFeedback: { blockReason: 'BLOCKLIST' },
    })
    expect(result.matched).toBe(true)
    expect(result.reason).toBe('BLOCKLIST')
  })

  it('matches SPII on promptFeedback.blockReason', () => {
    const result = detectProhibitedContentBlock({
      promptFeedback: { blockReason: 'SPII' },
    })
    expect(result.matched).toBe(true)
    expect(result.reason).toBe('SPII')
  })

  it('matches PROHIBITED_CONTENT on candidate.finishReason when promptFeedback is absent', () => {
    // The unconfigurable filter can fire at the candidate level too — when
    // the model started generating but then was cut off by the safety net.
    const result = detectProhibitedContentBlock({
      candidates: [{ finishReason: 'PROHIBITED_CONTENT' }],
    })
    expect(result.matched).toBe(true)
    expect(result.reason).toBe('PROHIBITED_CONTENT')
  })

  it('returns matched:false for SAFETY (configurable category)', () => {
    // SAFETY means one of the four HARM_CATEGORY_* thresholds tripped —
    // recoverable via safetySettings BLOCK_NONE. NOT what we soft-skip on.
    const result = detectProhibitedContentBlock({
      promptFeedback: { blockReason: 'SAFETY' },
    })
    expect(result.matched).toBe(false)
  })

  it('returns matched:false for RECITATION (different recovery shape)', () => {
    const result = detectProhibitedContentBlock({
      candidates: [{ finishReason: 'RECITATION' }],
    })
    expect(result.matched).toBe(false)
  })

  it('returns matched:false for MAX_TOKENS / STOP (normal completion)', () => {
    expect(
      detectProhibitedContentBlock({
        candidates: [{ finishReason: 'MAX_TOKENS' }],
      }).matched,
    ).toBe(false)
    expect(
      detectProhibitedContentBlock({
        candidates: [{ finishReason: 'STOP' }],
      }).matched,
    ).toBe(false)
  })

  it('returns matched:false when nothing block-like is present', () => {
    expect(detectProhibitedContentBlock({}).matched).toBe(false)
    expect(detectProhibitedContentBlock({ promptFeedback: null }).matched).toBe(false)
    expect(detectProhibitedContentBlock({ candidates: [] }).matched).toBe(false)
    expect(detectProhibitedContentBlock({ candidates: [null] }).matched).toBe(false)
  })

  it('promptFeedback takes precedence over candidate.finishReason', () => {
    // If BOTH paths report a block, the promptFeedback one is the canonical
    // signal (it fired earlier in the pipeline — before any candidate even
    // started). Order matters because the reason string surfaces in logs.
    const result = detectProhibitedContentBlock({
      promptFeedback: { blockReason: 'BLOCKLIST' },
      candidates: [{ finishReason: 'PROHIBITED_CONTENT' }],
    })
    expect(result.matched).toBe(true)
    expect(result.reason).toBe('BLOCKLIST')
  })
})

describe('UNCONFIGURABLE_BLOCK_REASONS', () => {
  it('exports the three known unconfigurable block reasons', () => {
    // Locked down so a future Google API addition is caught by a failing
    // test rather than silently slipping through the soft-skip path.
    expect(UNCONFIGURABLE_BLOCK_REASONS.has('PROHIBITED_CONTENT')).toBe(true)
    expect(UNCONFIGURABLE_BLOCK_REASONS.has('BLOCKLIST')).toBe(true)
    expect(UNCONFIGURABLE_BLOCK_REASONS.has('SPII')).toBe(true)
    expect(UNCONFIGURABLE_BLOCK_REASONS.size).toBe(3)
  })

  it('explicitly excludes SAFETY (which is configurable)', () => {
    expect(UNCONFIGURABLE_BLOCK_REASONS.has('SAFETY')).toBe(false)
  })
})

// ────────────────────────────────────────────────────────────────────────
// T3.1 + T3.2 (Phase 8) — auto-tier flip path verification.
//
// `detectHardZeroQuota()` and `HARD_ZERO_QUOTA_PATTERNS` are unit-tested
// elsewhere in this file at the regex level. What's NOT yet tested at
// gemini.test.ts is the END-TO-END flip behaviour: when a real SDK call
// throws an error matching one of the patterns, does the provider
// actually flip `useFallback` and route the retry through the Free key?
//
// We stub both `paidClient.models.generateContent` and
// `freeClient.models.generateContent` separately, then call generate()
// once. The first SDK call (on Paid) throws; the catch block detects
// hard-zero, sets useFallback=true, and the retry loop calls
// activeClient() again — which now returns freeClient. We assert the
// Free stub was called and the return value came from it.
// ────────────────────────────────────────────────────────────────────────

describe('T3.1 — auto-tier flip via HARD_ZERO_QUOTA_PATTERNS', () => {
  /** Stub both client paths separately so we can observe the flip.
   *  paidClient throws with the supplied error; freeClient returns text. */
  function stubBothClients(
    p: GeminiProvider,
    paidBehavior: () => Promise<never>,
    freeText = 'fallback success',
  ) {
    const paidGenerate = vi.fn(paidBehavior)
    const freeGenerate = vi.fn(async () => ({
      text: freeText,
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    }))
    ;(p as unknown as { paidClient: unknown }).paidClient = {
      models: { generateContent: paidGenerate },
    }
    ;(p as unknown as { freeClient: unknown }).freeClient = {
      models: { generateContent: freeGenerate },
    }
    return { paidGenerate, freeGenerate }
  }

  // Build a provider that has BOTH a paid + free key configured and is in
  // 'auto' mode (the only tier that can flip).
  function makeAutoProvider() {
    return new GeminiProvider({
      primaryKey: 'paid-test-key',
      fallbackKey: 'free-test-key',
      tier: 'auto',
    })
  }

  it.each([
    ['limit:0',                          '429 quota: { limit: 0, value: 100 }'],
    ['quotaValue:0',                     '429 RESOURCE_EXHAUSTED quotaValue: "0"'],
    ['quotaLimitReached',                '429 quota_limit_reached for model'],
    ['daily-quota-exceeded',             '429 daily quota exceeded'],
    // Pattern 5's fixture needs a `429` or `quota`/`rate limit`/
    // `resource_exhausted` keyword to clear isExhaustion()'s gate
    // BEFORE the pattern-matcher gets a look. The real Google error
    // shape always includes 429 + the metric name together.
    ['generateContentRequestsPerDay:0',  '429 quota metric generateContentRequestsPerDay limit: 0'],
    ['RESOURCE_EXHAUSTED+zero',          'RESOURCE_EXHAUSTED — quota value: 0 for the day'],
  ])('flips useFallback when paid throws an error matching pattern %s', async (_label, errMsg) => {
    const p = makeAutoProvider()
    const { paidGenerate, freeGenerate } = stubBothClients(p, async () => {
      throw new Error(errMsg)
    })
    // Sanity: starts on paid (useFallback=false)
    expect((p as unknown as { useFallback: boolean }).useFallback).toBe(false)
    const result = await p.generate(
      { model: 'gemini-2.5-pro', systemPrompt: '', userPrompt: 'hello', maxOutputTokens: 100, safetyMode: 'permissive' },
      {},
    )
    // After the flip + retry, the result text came from the Free stub.
    expect(result.text).toBe('fallback success')
    expect(paidGenerate).toHaveBeenCalledOnce() // first try, threw
    expect(freeGenerate).toHaveBeenCalledOnce() // retry after flip
    expect((p as unknown as { useFallback: boolean }).useFallback).toBe(true)
  })

  it('does NOT flip when a single isolated generic 429 hits but then succeeds', { timeout: 120_000 }, async () => {
    // Isolate T3.1's pattern-match behaviour from T3.2's repeated-exhaustion
    // behaviour: a SINGLE generic 429 (no hard-zero pattern) followed by a
    // success should NOT flip useFallback. The provider retries internally
    // via consecutiveExhaustions; the success resets the counter.
    const p = makeAutoProvider()
    const paidGenerate = vi.fn()
    paidGenerate.mockImplementationOnce(async () => {
      throw new Error('429 Too Many Requests — retry after 30 seconds')
    })
    paidGenerate.mockImplementationOnce(async () => ({
      text: 'paid success after retry',
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    }))
    const freeGenerate = vi.fn(async () => ({
      text: 'free success — should NOT have been reached',
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    }))
    ;(p as unknown as { paidClient: unknown }).paidClient = {
      models: { generateContent: paidGenerate },
    }
    ;(p as unknown as { freeClient: unknown }).freeClient = {
      models: { generateContent: freeGenerate },
    }
    const result = await p.generate(
      { model: 'gemini-2.5-pro', systemPrompt: '', userPrompt: 'hello', maxOutputTokens: 100, safetyMode: 'permissive' },
      {},
    )
    // Result came from PAID's second attempt — the flip did NOT fire.
    expect(result.text).toBe('paid success after retry')
    expect((p as unknown as { useFallback: boolean }).useFallback).toBe(false)
    expect(freeGenerate).not.toHaveBeenCalled()
  })

  it('locks down the pattern set — every export in HARD_ZERO_QUOTA_PATTERNS has a flip-test fixture', () => {
    // If someone adds a new pattern to HARD_ZERO_QUOTA_PATTERNS, this
    // test fails until they add a corresponding flip-test fixture in
    // the it.each above. Forces deliberate test coverage on every
    // pattern that could fire the flip.
    expect(HARD_ZERO_QUOTA_PATTERNS).toHaveLength(6)
  })
})

describe('T3.2 — auto-tier flip via repeated-exhaustion (2× consecutive 429s)', () => {
  // The repeated-exhaustion path: when hard-zero patterns don't match
  // but Paid keeps returning generic 429s, the provider flips on the
  // SECOND consecutive exhaustion. A successful call interleaved between
  // two 429s resets the counter.

  function stubBothClients(p: GeminiProvider) {
    const callLog: string[] = []
    const paidGenerate = vi.fn()
    const freeGenerate = vi.fn(async () => {
      callLog.push('free')
      return { text: 'free success', usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }
    })
    ;(p as unknown as { paidClient: unknown }).paidClient = {
      models: { generateContent: paidGenerate },
    }
    ;(p as unknown as { freeClient: unknown }).freeClient = {
      models: { generateContent: freeGenerate },
    }
    return { paidGenerate, freeGenerate, callLog }
  }

  function makeAutoProvider() {
    return new GeminiProvider({
      primaryKey: 'paid-test-key',
      fallbackKey: 'free-test-key',
      tier: 'auto',
    })
  }

  it('does NOT flip on a single isolated 429 (counter goes 0 → 1, threshold is 2)', { timeout: 120_000 }, async () => {
    const p = makeAutoProvider()
    const { paidGenerate } = stubBothClients(p)
    paidGenerate.mockImplementationOnce(async () => {
      throw new Error('429 rate-limited — try again')
    })
    paidGenerate.mockImplementationOnce(async () => ({
      text: 'paid success after retry',
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    }))
    const result = await p.generate(
      { model: 'gemini-2.5-pro', systemPrompt: '', userPrompt: 'hi', maxOutputTokens: 100, safetyMode: 'permissive' },
      {},
    )
    expect(result.text).toBe('paid success after retry')
    expect((p as unknown as { useFallback: boolean }).useFallback).toBe(false)
    // consecutiveExhaustions decremented on the successful retry.
    const counter = (p as unknown as { consecutiveExhaustions: number }).consecutiveExhaustions
    // Either 0 (reset on success) or unchanged from 1 — implementation
    // detail; what matters is the flip didn't fire.
    expect(counter).toBeLessThanOrEqual(1)
  })

  it('lock-down: GeminiProvider exposes consecutiveExhaustions as an internal counter', () => {
    // This counter is the load-bearing state for T3.2's flip. If it
    // ever gets renamed or removed, this test catches it.
    const p = makeAutoProvider()
    expect(
      (p as unknown as { consecutiveExhaustions: number }).consecutiveExhaustions,
    ).toBe(0)
  })
})
