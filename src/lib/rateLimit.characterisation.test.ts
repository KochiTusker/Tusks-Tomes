// Characterisation tests — these pin the CURRENT pacing behaviour so the
// per-model rate-limit work can prove it changed nothing for single-model runs,
// and changed exactly the intended thing for mixed-model runs.
//
// Like the chunking characterisation suite, these record what the code does
// today rather than what it ought to do. Two of them deliberately pin a KNOWN
// BUG (see 'shared-state bleed' below); when that bug is fixed the expectation
// changes in the same commit, which is the point.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GEMINI_STATIC_LIMITS, RateLimitState, estimateTokensFromChars } from './rateLimit'

/** Drive a state through a chunk sequence, collecting the delay before each
 *  call. Mirrors chunkedGenerate's loop: pace, then call, then note. */
function runSequence(
  rl: RateLimitState,
  calls: Array<{ tokens: number; mult?: number; seedRpm?: number; seedTpm?: number }>,
): number[] {
  const delays: number[] = []
  for (const call of calls) {
    // Gemini re-seeds from the model's row inside generate(); other providers
    // learn from response headers. Both happen AFTER the pacing decision.
    if (call.seedRpm !== undefined && call.seedTpm !== undefined) {
      rl.setStatic(call.seedRpm, call.seedTpm)
    }
    const delay = rl.delayBeforeNextCall(call.tokens, call.mult ?? 1)
    delays.push(delay)
    vi.advanceTimersByTime(delay)
    rl.noteCall()
  }
  return delays
}

describe('pacing characterisation', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('single-model run: 8 chunks on Gemini paid Pro', () => {
    // The common case. A per-model registry must leave this byte-identical —
    // with only one model in play there is nothing to key apart.
    const rl = new RateLimitState()
    const { rpm, tpm } = GEMINI_STATIC_LIMITS.paidPro
    rl.setStatic(rpm, tpm)
    const delays = runSequence(
      rl,
      Array.from({ length: 8 }, () => ({ tokens: estimateTokensFromChars(30_000) })),
    )
    expect(delays).toMatchSnapshot()
  })

  it('single-model run: 8 chunks on Gemini FREE Pro (2 RPM — the slow path)', () => {
    const rl = new RateLimitState()
    const { rpm, tpm } = GEMINI_STATIC_LIMITS.freePro
    rl.setStatic(rpm, tpm)
    const delays = runSequence(
      rl,
      Array.from({ length: 8 }, () => ({ tokens: estimateTokensFromChars(15_000) })),
    )
    expect(delays).toMatchSnapshot()
  })

  it('the 3x slowdown dial multiplies spacing', () => {
    const rl = new RateLimitState()
    rl.setStatic(GEMINI_STATIC_LIMITS.freeFlash.rpm, GEMINI_STATIC_LIMITS.freeFlash.tpm)
    const normal = runSequence(rl, Array.from({ length: 4 }, () => ({ tokens: 4_000 })))

    const slowed = new RateLimitState()
    slowed.setStatic(GEMINI_STATIC_LIMITS.freeFlash.rpm, GEMINI_STATIC_LIMITS.freeFlash.tpm)
    const slow = runSequence(slowed, Array.from({ length: 4 }, () => ({ tokens: 4_000, mult: 3 })))

    expect({ normal, slow }).toMatchSnapshot()
  })

  it('Retry-After overrides the computed spacing', () => {
    const rl = new RateLimitState()
    rl.setStatic(1000, 4_000_000) // fast row: spacing would be ~66ms
    rl.noteCall()
    rl.noteRetryAfter(30)
    expect(rl.delayBeforeNextCall(1000)).toBe(30_000)
  })

  it('KNOWN BUG 1 — shared lastCallAt anchor bleeds across models', () => {
    // One RateLimitState is shared by every model on a provider
    // (gemini.ts:489, openai.ts:95, claude.ts:120). Under a mixed preset
    // (GEMINI_HYBRID_RECOMMENDED runs Pro on Phase 3 and Flash-Lite on Phase 6)
    // a Pro call sets lastCallAt, and the next Flash call is spaced against
    // that anchor even though Flash has its own, far larger budget.
    //
    // This seeds the correct row before each call, so it isolates the shared
    // ANCHOR specifically. Bug 2 below covers the stale-row half.
    //
    // Recorded on purpose. When per-model state lands this expectation must
    // change, and the diff is the evidence the bug is fixed.
    const shared = new RateLimitState()
    const pro = GEMINI_STATIC_LIMITS.paidPro
    const flash = GEMINI_STATIC_LIMITS.paidFlash
    const delays = runSequence(shared, [
      { tokens: 8_000, seedRpm: pro.rpm, seedTpm: pro.tpm },
      { tokens: 8_000, seedRpm: flash.rpm, seedTpm: flash.tpm },
      { tokens: 8_000, seedRpm: pro.rpm, seedTpm: pro.tpm },
      { tokens: 8_000, seedRpm: flash.rpm, seedTpm: flash.tpm },
    ])
    expect(delays).toMatchSnapshot()
  })

  it('KNOWN BUG 2 — seeding after pacing prices a call on the previous row', () => {
    // gemini.ts:695 re-seeds from staticLimitsFor(req.model) INSIDE generate(),
    // but getNextDelayMs() was already consulted at pipeline.ts:445. So every
    // pacing decision uses the row belonging to the PREVIOUS chunk's model.
    // Here: a Free-Pro call (2 RPM) is paced as if it were Paid-Flash, because
    // Flash seeded the row on the call before.
    const rl = new RateLimitState()
    const delays: number[] = []
    const order = [GEMINI_STATIC_LIMITS.paidFlash, GEMINI_STATIC_LIMITS.freePro]
    for (const row of order) {
      // pace FIRST (pipeline.ts:445), using whatever row the last call left
      const d = rl.delayBeforeNextCall(8_000)
      delays.push(d)
      vi.advanceTimersByTime(d)
      // ...then generate() seeds this call's real row (gemini.ts:695)
      rl.setStatic(row.rpm, row.tpm)
      rl.noteCall()
    }
    // Second delay is Flash-priced despite the second call being Free Pro.
    expect(delays).toMatchSnapshot()
  })

  it('an independent state per model gives different (correct) spacing', () => {
    // The same four calls, but each model keeping its own state. This is the
    // target behaviour for the registry work; today nothing produces it.
    const proState = new RateLimitState()
    proState.setStatic(GEMINI_STATIC_LIMITS.paidPro.rpm, GEMINI_STATIC_LIMITS.paidPro.tpm)
    const flashState = new RateLimitState()
    flashState.setStatic(GEMINI_STATIC_LIMITS.paidFlash.rpm, GEMINI_STATIC_LIMITS.paidFlash.tpm)

    const delays: number[] = []
    for (const state of [proState, flashState, proState, flashState]) {
      const d = state.delayBeforeNextCall(8_000)
      delays.push(d)
      vi.advanceTimersByTime(d)
      state.noteCall()
    }
    expect(delays).toMatchSnapshot()
  })

  it('estimateTokensFromChars is the divisor the pipeline actually uses', () => {
    // pricing.ts uses 4 chars/token while rateLimit.ts uses 3.5. Pinning the
    // pacing side so the reconciliation is a deliberate, visible change.
    expect(estimateTokensFromChars(35_000)).toBe(10_000)
    expect(estimateTokensFromChars(1)).toBe(1)
    expect(estimateTokensFromChars(0)).toBe(0)
  })
})
