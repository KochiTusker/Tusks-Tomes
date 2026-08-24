import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CONSERVATIVE_FLOOR_MS,
  estimateTokensFromChars,
  GEMINI_STATIC_LIMITS,
  RateLimitState,
} from './rateLimit'

describe('RateLimitState', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns 0 on the very first call before any limits are seen', () => {
    const rl = new RateLimitState()
    expect(rl.delayBeforeNextCall(1000)).toBe(0)
  })

  it('falls back to CONSERVATIVE_FLOOR_MS spacing after the first call when no limits seen', () => {
    const rl = new RateLimitState()
    rl.noteCall()
    expect(rl.delayBeforeNextCall(1000)).toBe(CONSERVATIVE_FLOOR_MS)
    // After waiting half the floor, delay shrinks to the remainder
    vi.advanceTimersByTime(CONSERVATIVE_FLOOR_MS / 2)
    expect(rl.delayBeforeNextCall(1000)).toBeCloseTo(CONSERVATIVE_FLOOR_MS / 2, -2)
  })

  it('uses RPM-based spacing when TPM not binding', () => {
    const rl = new RateLimitState()
    // 1000 RPM ⇒ 60ms/req. With 1.1 safety = 66ms.
    rl.setStatic(1000, 999_999_999_999)
    rl.noteCall()
    const delay = rl.delayBeforeNextCall(100)
    // First call just happened, so the required spacing IS the wait
    expect(delay).toBeGreaterThanOrEqual(60)
    expect(delay).toBeLessThanOrEqual(70)
  })

  it('uses TPM-based spacing when it dominates', () => {
    const rl = new RateLimitState()
    // 100K TPM, 1000 RPM. Chunk of 10K tokens => 10K/100K * 60_000 = 6_000ms.
    // RPM math gives 60ms. TPM dominates.
    rl.setStatic(1000, 100_000)
    rl.noteCall()
    const delay = rl.delayBeforeNextCall(10_000)
    expect(delay).toBeGreaterThan(5_900) // 6000 * 1.1 = 6600, minus some clock drift tolerance
    expect(delay).toBeLessThan(7_000)
  })

  it('returns 0 once enough time has elapsed since the last call', () => {
    const rl = new RateLimitState()
    rl.setStatic(60, 1_000_000) // 1 req/sec => 1100ms spacing with safety
    rl.noteCall()
    vi.advanceTimersByTime(2_000)
    expect(rl.delayBeforeNextCall(100)).toBe(0)
  })

  it('multiplies the spacing by extraMultiplier (slow-down mode)', () => {
    const rl = new RateLimitState()
    rl.setStatic(1000, 999_999_999_999) // 60ms base, 66ms with safety
    rl.noteCall()
    const baseDelay = rl.delayBeforeNextCall(100, 1)
    rl.noteCall() // re-anchor so 3× test starts fresh
    const slowDelay = rl.delayBeforeNextCall(100, 3)
    expect(slowDelay).toBeGreaterThanOrEqual(baseDelay * 2.8)
    expect(slowDelay).toBeLessThanOrEqual(baseDelay * 3.2)
  })

  it('passes byte-for-byte when extraMultiplier omitted (back-compat lock)', () => {
    const rl = new RateLimitState()
    rl.setStatic(1000, 999_999_999_999)
    rl.noteCall()
    const a = rl.delayBeforeNextCall(100)
    rl.noteCall()
    const b = rl.delayBeforeNextCall(100, 1)
    expect(a).toBe(b)
  })

  it('honours Retry-After window override', () => {
    const rl = new RateLimitState()
    rl.setStatic(1000, 1_000_000)
    rl.noteCall()
    vi.advanceTimersByTime(100_000) // would normally clear any spacing
    rl.noteRetryAfter(30) // 30 seconds
    expect(rl.delayBeforeNextCall(100)).toBeGreaterThan(29_000)
    expect(rl.delayBeforeNextCall(100)).toBeLessThanOrEqual(30_000)
    vi.advanceTimersByTime(31_000)
    expect(rl.delayBeforeNextCall(100)).toBe(0)
  })

  it('parses Anthropic rate-limit headers', () => {
    const rl = new RateLimitState()
    const headers = new Headers({
      'anthropic-ratelimit-requests-limit': '50',
      'anthropic-ratelimit-tokens-limit': '40000',
      'anthropic-ratelimit-requests-remaining': '12',
      'anthropic-ratelimit-tokens-remaining': '9500',
      'anthropic-ratelimit-tokens-reset': new Date(Date.now() + 60_000).toISOString(),
    })
    rl.updateFromClaudeHeaders(headers)
    const snap = rl.snapshotForDebug()
    expect(snap.rpm).toBe(50)
    expect(snap.tpm).toBe(40_000)
    expect(snap.requestsRemaining).toBe(12)
    expect(snap.tokensRemaining).toBe(9_500)
    expect(snap.resetMs).toBeGreaterThan(0)
  })

  it('parses Anthropic input-tokens-* fallback header names', () => {
    const rl = new RateLimitState()
    const headers = new Headers({
      'anthropic-ratelimit-input-tokens-limit': '20000',
      'anthropic-ratelimit-input-tokens-remaining': '5000',
    })
    rl.updateFromClaudeHeaders(headers)
    const snap = rl.snapshotForDebug()
    expect(snap.tpm).toBe(20_000)
    expect(snap.tokensRemaining).toBe(5_000)
  })

  it('parses OpenAI rate-limit headers with reset durations', () => {
    const rl = new RateLimitState()
    const headers = new Headers({
      'x-ratelimit-limit-requests': '500',
      'x-ratelimit-limit-tokens': '30000',
      'x-ratelimit-remaining-requests': '480',
      'x-ratelimit-remaining-tokens': '25000',
      'x-ratelimit-reset-requests': '6m0s',
      'x-ratelimit-reset-tokens': '30s',
    })
    rl.updateFromOpenAIHeaders(headers)
    const snap = rl.snapshotForDebug()
    expect(snap.rpm).toBe(500)
    expect(snap.tpm).toBe(30_000)
    expect(snap.requestsRemaining).toBe(480)
    expect(snap.tokensRemaining).toBe(25_000)
    expect(snap.resetMs).toBe(360_000) // 6m0s wins over 30s
  })

  it('matches the documented Gemini paid/free Pro static limits', () => {
    // Smoke-check the numbers we keyed the design off of so they don't
    // silently drift later.
    expect(GEMINI_STATIC_LIMITS.paidPro.rpm).toBeGreaterThanOrEqual(100)
    expect(GEMINI_STATIC_LIMITS.paidPro.tpm).toBeGreaterThan(1_000_000)
    expect(GEMINI_STATIC_LIMITS.freePro.rpm).toBe(2)
    expect(GEMINI_STATIC_LIMITS.freePro.tpm).toBe(32_000)
  })
})

describe('estimateTokensFromChars', () => {
  it('rounds up at 3.5 chars/token', () => {
    expect(estimateTokensFromChars(0)).toBe(0)
    expect(estimateTokensFromChars(7)).toBe(2)
    expect(estimateTokensFromChars(35)).toBe(10)
    expect(estimateTokensFromChars(36)).toBe(11)
  })
})
