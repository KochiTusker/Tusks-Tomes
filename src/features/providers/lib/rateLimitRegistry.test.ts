import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DailyBudget,
  GEMINI_STATIC_LIMITS,
  OPENROUTER_FREE_LIMITS,
  RateLimitRegistry,
} from './rateLimit'

describe('RateLimitRegistry — per-model buckets', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('gives each model its own bucket', () => {
    const reg = new RateLimitRegistry()
    reg.setStatic('pro', GEMINI_STATIC_LIMITS.paidPro.rpm, GEMINI_STATIC_LIMITS.paidPro.tpm)
    reg.setStatic('flash', GEMINI_STATIC_LIMITS.paidFlash.rpm, GEMINI_STATIC_LIMITS.paidFlash.tpm)
    expect(reg.knownModels().sort()).toEqual(['flash', 'pro'])
  })

  it('does not let one model set the pacing anchor for another', () => {
    // The shared-state bug: a 150 RPM Pro call used to make the next 1000 RPM
    // Flash call wait, because lastCallAt was a single shared field.
    const reg = new RateLimitRegistry()
    reg.setStatic('pro', GEMINI_STATIC_LIMITS.paidPro.rpm, GEMINI_STATIC_LIMITS.paidPro.tpm)
    reg.setStatic('flash', GEMINI_STATIC_LIMITS.paidFlash.rpm, GEMINI_STATIC_LIMITS.paidFlash.tpm)

    expect(reg.delayBeforeNextCall('pro', 8_000)).toBe(0)
    reg.noteCall('pro')
    // Flash has not been called yet, so it owes nothing.
    expect(reg.delayBeforeNextCall('flash', 8_000)).toBe(0)
  })

  it('still paces a model against its own previous call', () => {
    const reg = new RateLimitRegistry()
    reg.setStatic('pro', GEMINI_STATIC_LIMITS.paidPro.rpm, GEMINI_STATIC_LIMITS.paidPro.tpm)
    reg.delayBeforeNextCall('pro', 8_000)
    reg.noteCall('pro')
    // 150 RPM -> 400ms, x1.1 safety = 440ms.
    expect(reg.delayBeforeNextCall('pro', 8_000)).toBeCloseTo(440, 0)
  })

  it('prices a free-tier model on its own row, not the last model used', () => {
    // The seed-ordering bug: a Free Pro call (2 RPM) was paced at 132ms because
    // Paid Flash had seeded the shared row on the call before.
    const reg = new RateLimitRegistry()
    reg.setStatic('flash', GEMINI_STATIC_LIMITS.paidFlash.rpm, GEMINI_STATIC_LIMITS.paidFlash.tpm)
    reg.setStatic('freePro', GEMINI_STATIC_LIMITS.freePro.rpm, GEMINI_STATIC_LIMITS.freePro.tpm)

    reg.noteCall('flash')
    reg.noteCall('freePro')
    // 2 RPM -> 30_000ms, x1.1 = 33_000ms. Nowhere near Flash's 132ms.
    expect(reg.delayBeforeNextCall('freePro', 8_000)).toBeCloseTo(33_000, 0)
  })

  it('applies a 429 Retry-After account-wide, not just to the offending model', () => {
    // A 429 is normally a statement about the key. Letting a switch of model
    // escape it would turn one 429 into several.
    const reg = new RateLimitRegistry()
    reg.setStatic('a', 1000, 4_000_000)
    reg.setStatic('b', 1000, 4_000_000)
    reg.noteRetryAfter(30)
    expect(reg.delayBeforeNextCall('a', 100)).toBe(30_000)
    expect(reg.delayBeforeNextCall('b', 100)).toBe(30_000)
  })

  it('takes the larger of the account gate and the model requirement', () => {
    const reg = new RateLimitRegistry()
    reg.setStatic('slow', GEMINI_STATIC_LIMITS.freePro.rpm, GEMINI_STATIC_LIMITS.freePro.tpm)
    reg.noteCall('slow') // owes 33_000ms on its own
    reg.noteRetryAfter(5) // account gate is only 5_000ms
    expect(reg.delayBeforeNextCall('slow', 100)).toBeCloseTo(33_000, 0)
  })

  it('keeps a longer Retry-After when a shorter one arrives after it', () => {
    const reg = new RateLimitRegistry()
    reg.noteRetryAfter(60)
    reg.noteRetryAfter(5)
    expect(reg.delayBeforeNextCall('x', 100)).toBe(60_000)
  })

  it('reports per-model recent call counts for the rate-limit dialog', () => {
    const reg = new RateLimitRegistry()
    reg.noteCall('a')
    reg.noteCall('a')
    reg.noteCall('b')
    expect(reg.recentCallCount('a')).toBe(2)
    expect(reg.recentCallCount('b')).toBe(1)
  })
})

describe('DailyBudget', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('reports no cap when none is known — the paid-model case', () => {
    // OpenRouter applies no platform request cap to paid models, only a credit
    // balance, so "unknown cap" must read as "unlimited", not as "zero".
    const b = new DailyBudget(null)
    expect(b.remaining()).toBeNull()
    expect(b.planFits(10_000).fits).toBe(true)
  })

  it('counts down as calls are made', () => {
    const b = new DailyBudget(OPENROUTER_FREE_LIMITS.rpdNoCredits)
    expect(b.remaining()).toBe(50)
    b.noteCall()
    b.noteCall()
    expect(b.remaining()).toBe(48)
  })

  it('answers whether a whole run fits BEFORE it starts', () => {
    // A 3-hour session is ~26 calls. On the 50/day tier that is one session;
    // the point of planFits is to say so up front rather than failing midway.
    const b = new DailyBudget(OPENROUTER_FREE_LIMITS.rpdNoCredits)
    b.setUsed(38)
    const plan = b.planFits(26)
    expect(plan.fits).toBe(false)
    expect(plan.remaining).toBe(12)
    expect(plan.shortfall).toBe(14)
  })

  it('fits the same run comfortably on the post-top-up tier', () => {
    const b = new DailyBudget(OPENROUTER_FREE_LIMITS.rpdWithCredits)
    expect(b.planFits(26).fits).toBe(true)
    expect(b.planFits(26).remaining).toBe(1000)
  })

  it('reports when the budget resets', () => {
    vi.setSystemTime(new Date('2026-08-18T14:30:00Z'))
    const b = new DailyBudget(50)
    expect(b.planFits(1).resetsAt).toBe('2026-08-19T00:00:00.000Z')
  })

  it('rolls over at UTC midnight', () => {
    vi.setSystemTime(new Date('2026-08-18T23:59:00Z'))
    const b = new DailyBudget(50)
    b.setUsed(50)
    expect(b.remaining()).toBe(0)
    vi.setSystemTime(new Date('2026-08-19T00:01:00Z'))
    expect(b.remaining()).toBe(50)
  })

  it('never reports a negative remainder', () => {
    const b = new DailyBudget(5)
    b.setUsed(9)
    expect(b.remaining()).toBe(0)
  })

  it('exposes the real OpenRouter caps', () => {
    expect(OPENROUTER_FREE_LIMITS.rpm).toBe(20)
    expect(OPENROUTER_FREE_LIMITS.rpdNoCredits).toBe(50)
    expect(OPENROUTER_FREE_LIMITS.rpdWithCredits).toBe(1000)
  })
})

describe('RateLimitRegistry — daily budget integration', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('decrements the shared daily budget regardless of which model was called', () => {
    // The cap is per-account, so spreading a run across models does not buy
    // more of it.
    const reg = new RateLimitRegistry({ dailyCap: 50 })
    reg.noteCall('a')
    reg.noteCall('b')
    reg.noteCall('c')
    expect(reg.daily.remaining()).toBe(47)
  })

  it('does NOT slow pacing as the daily budget runs low', () => {
    // Worth pinning explicitly: a daily cap is a count, not a rate. Spacing
    // calls further apart cannot make a 26-call run fit in 12 requests, so the
    // budget deliberately has no influence on the delay. The pre-flight check
    // is what handles it.
    const reg = new RateLimitRegistry({ dailyCap: 50 })
    reg.daily.setUsed(49)
    expect(reg.delayBeforeNextCall('a', 100)).toBe(0)
  })
})
