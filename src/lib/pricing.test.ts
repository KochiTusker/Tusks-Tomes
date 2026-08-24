import { describe, expect, it } from 'vitest'
import { estimateRunCost, rateFor, type PhaseRouting } from './pricing'

describe('rateFor — multi-provider pricing lookup', () => {
  it('returns Gemini Paid Pro rate', () => {
    expect(rateFor('gemini', 'paid', 'gemini-2.5-pro')).toEqual({
      input: 1.25, output: 10.0, cachedInput: 0.31,
    })
  })

  it('returns Gemini Free rate as zero', () => {
    expect(rateFor('gemini', 'free', 'gemini-2.5-flash')).toEqual({
      input: 0, output: 0, cachedInput: 0,
    })
  })

  it('prices the subscription CLIs at zero rather than guessing a rate', () => {
    // They bill against a subscription, not per-token credit. A guessed rate
    // would be the only wrong number in the estimator.
    expect(rateFor('claudeCode', undefined, 'sonnet')).toEqual({
      input: 0, output: 0, cachedInput: 0,
    })
    expect(rateFor('codex', undefined, 'gpt-5-mini')).toEqual({
      input: 0, output: 0, cachedInput: 0,
    })
  })

  it('falls back to a sane rate for unknown Gemini model (heuristic by name)', () => {
    const r = rateFor('gemini', 'paid', 'gemini-3-flash-experimental')
    expect(r.input).toBeGreaterThan(0)
    expect(r.output).toBeGreaterThan(0)
  })
})

describe('estimateRunCost — parity across all 3 providers', () => {
  // Realistic Session-24-sized inputs
  const SIZES = { transcriptChars: 292_000, kbChars: 381_000 }

  it('produces non-zero positive cost for Gemini Smart Budget', () => {
    const routing: Record<string, PhaseRouting> = {
      phase1_ground:    { provider: 'gemini', tier: 'free', model: 'gemini-2.5-flash' },
      phase2_audit:     { provider: 'gemini', tier: 'paid', model: 'gemini-2.5-flash' },
      phase3_chronicle: { provider: 'gemini', tier: 'paid', model: 'gemini-2.5-pro' },
      phase4_extras:    { provider: 'gemini', tier: 'paid', model: 'gemini-2.5-flash-lite' },
      phase6_condense:  { provider: 'gemini', tier: 'paid', model: 'gemini-2.5-flash-lite' },
    }
    const r = estimateRunCost({ routing, ...SIZES })
    expect(r.totalDollars).toBeGreaterThan(0.1)
    // Raised from 2.0 on 2026-08-18 when thinking tokens were added to the
    // model. They bill as output and had been omitted entirely, which
    // understated real spend by ~4.5x — see the calibration test below.
    expect(r.totalDollars).toBeLessThan(6.0)
    expect(r.perPhase).toHaveLength(5)
  })

  it('produces non-zero positive cost for an OpenRouter routing', () => {
    const routing: Record<string, PhaseRouting> = {
      phase1_ground:    { provider: 'openrouter', model: 'qwen/qwen3-30b-a3b-instruct-2507' },
      phase2_audit:     { provider: 'openrouter', model: 'qwen/qwen3-30b-a3b-instruct-2507' },
      phase3_chronicle: { provider: 'openrouter', model: 'deepseek/deepseek-v4-pro' },
      phase4_extras:    { provider: 'openrouter', model: 'z-ai/glm-5.2' },
      phase6_condense:  { provider: 'openrouter', model: 'deepseek/deepseek-v4-pro' },
    }
    const r = estimateRunCost({ routing, ...SIZES })
    expect(r.totalDollars).toBeGreaterThan(0.1)
    expect(r.perPhase).toHaveLength(5)
  })



  it('a dearer chronicle model costs more than a cheaper one', () => {
    // The ordering property the retired per-provider rate tables used to
    // assert. Gemini is the provider that still carries a rate table, so the
    // check lives there now.
    const flash: Record<string, PhaseRouting> = {
      phase3_chronicle: { provider: 'gemini', model: 'gemini-2.5-flash' },
    }
    const pro: Record<string, PhaseRouting> = {
      phase3_chronicle: { provider: 'gemini', model: 'gemini-2.5-pro' },
    }
    expect(estimateRunCost({ routing: pro, ...SIZES }).totalDollars).toBeGreaterThan(
      estimateRunCost({ routing: flash, ...SIZES }).totalDollars,
    )
  })
})

describe('estimateRunCost — calibration against the documented per-session figure', () => {
  // The anchor is a real bill: a 3-hour session on Gemini Pro. The figure
  // quoted in the docs is generated from this same estimator, so the
  // independent check is the billing reconciliation of 2026-08-18 rather
  // than any number written on a page.
  //
  // A 3-hour session SBV is ~285 KB on disk; sbvToText() (src/lib/sbv.ts:38-42)
  // strips the 24-char timestamp line per cue, leaving ~220 KB of dialogue.
  const THREE_HOUR_SESSION = 220_000
  const REFERENCE_VAULT = 2_130_000 // pipeline.ts:2255

  const allPro: Record<string, PhaseRouting> = {
    phase1_ground:    { provider: 'gemini', tier: 'paid', model: 'gemini-2.5-pro' },
    phase2_audit:     { provider: 'gemini', tier: 'paid', model: 'gemini-2.5-pro' },
    phase3_chronicle: { provider: 'gemini', tier: 'paid', model: 'gemini-2.5-pro' },
    phase4_extras:    { provider: 'gemini', tier: 'paid', model: 'gemini-2.5-pro' },
    phase6_condense:  { provider: 'gemini', tier: 'paid', model: 'gemini-2.5-pro' },
  }

  it('lands in the right range for an all-Pro run on the reference vault', () => {
    const r = estimateRunCost({
      routing: allPro,
      transcriptChars: THREE_HOUR_SESSION,
      kbChars: REFERENCE_VAULT,
    })
    // Generous bracket — a heuristic with ~10-20% stated error, checked for
    // order of magnitude rather than to the cent. Before the 2026-08-18
    // thinking-token correction this produced under a dollar, which is the
    // failure this guards against.
    expect(r.totalDollars).toBeGreaterThan(2)
    expect(r.totalDollars).toBeLessThan(7)
  })

  it('prices Phase 1 and Phase 3 as the dominant phases', () => {
    // Both emit output at ~1:1 with their input, and output is priced 8x input
    // on Pro. Any future ratio edit that stops these two dominating is a signal
    // the edit is wrong.
    const r = estimateRunCost({
      routing: allPro,
      transcriptChars: THREE_HOUR_SESSION,
      kbChars: 50_000,
    })
    const by = Object.fromEntries(r.perPhase.map((p) => [p.phase, p.dollars]))
    expect(by.phase1_ground).toBeGreaterThan(by.phase2_audit)
    expect(by.phase1_ground).toBeGreaterThan(by.phase4_extras)
    expect(by.phase3_chronicle).toBeGreaterThan(by.phase2_audit)
    expect(by.phase3_chronicle).toBeGreaterThan(by.phase4_extras)
  })

  it('charges Phase 6 for the vault it actually ships', () => {
    // pipeline.ts:2257 — Phase 6 is the only cloud phase handed the FULL vault.
    // Before the correction its KB ratio was 0.00, so vault size had no effect
    // on the estimate at all.
    const small = estimateRunCost({
      routing: allPro, transcriptChars: THREE_HOUR_SESSION, kbChars: 50_000,
    })
    const large = estimateRunCost({
      routing: allPro, transcriptChars: THREE_HOUR_SESSION, kbChars: REFERENCE_VAULT,
    })
    const p6small = small.perPhase.find((p) => p.phase === 'phase6_condense')!.dollars
    const p6large = large.perPhase.find((p) => p.phase === 'phase6_condense')!.dollars
    expect(p6large).toBeGreaterThan(p6small * 2)
  })

  it('charges Phase 2 for both the raw and the grounded chunk', () => {
    // prompts.ts:412-421 ships both in one prompt. Phase 2 and Phase 1 use the
    // same chunk size, so with no KB on either, Phase 2's input must exceed
    // Phase 1's corpus-only input.
    const r = estimateRunCost({
      routing: allPro, transcriptChars: THREE_HOUR_SESSION, kbChars: 0,
    })
    const p1 = r.perPhase.find((p) => p.phase === 'phase1_ground')!
    const p2 = r.perPhase.find((p) => p.phase === 'phase2_audit')!
    expect(p1.chunks).toBe(p2.chunks)
    expect(p2.inputTokens).toBeGreaterThan(p1.inputTokens * 1.8)
  })

  it('models prompt caching on the phases that actually carry a prefix', () => {
    // Phases 1, 3 and 6 ship a cacheablePrefix; 2 and 4 send none and hit the
    // empty_prefix skip. Before the correction cachedInputTokens was 0 for
    // every phase, so caching was unmodelled everywhere.
    const r = estimateRunCost({
      routing: allPro, transcriptChars: THREE_HOUR_SESSION, kbChars: REFERENCE_VAULT,
    })
    const by = Object.fromEntries(r.perPhase.map((p) => [p.phase, p.cachedInputTokens]))
    expect(by.phase6_condense).toBeGreaterThan(0)
    expect(by.phase2_audit).toBe(0)
    expect(by.phase4_extras).toBe(0)
  })

  it('a zero cache-hit ratio costs more than the default', () => {
    const cached = estimateRunCost({
      routing: allPro, transcriptChars: THREE_HOUR_SESSION, kbChars: REFERENCE_VAULT,
    })
    const uncached = estimateRunCost({
      routing: allPro, transcriptChars: THREE_HOUR_SESSION, kbChars: REFERENCE_VAULT,
      cacheHitRatio: 0,
    })
    expect(uncached.totalDollars).toBeGreaterThan(cached.totalDollars)
  })
})

describe('estimateRunCost — reconciled against real billing', () => {
  // Two sessions of the balanced preset on 2026-08-18 billed GBP 2.562 and
  // GBP 2.279 of Gemini API usage. Balanced runs the mechanical phases on a
  // subscription (no API cost), Gemini Pro on the chronicle, and Flash on
  // extras and condense — so the whole bill is those three phases.
  //
  // Before thinking tokens were modelled this predicted GBP 0.54. That gap is
  // the reason the ratios exist, and this test is what stops it reopening.
  const T = 220_000
  const KB = 58_000
  const USD_TO_GBP = 0.79
  const pro = { provider: 'gemini' as const, tier: 'paid' as const, model: 'gemini-2.5-pro' }
  const flash = { provider: 'gemini' as const, tier: 'paid' as const, model: 'gemini-2.5-flash' }

  const balanced: Record<string, PhaseRouting> = {
    phase3_chronicle: pro,
    phase4_extras: flash,
    phase6_condense: flash,
  }

  it('lands inside the observed billing range for the balanced preset', () => {
    const gbp =
      estimateRunCost({ routing: balanced, transcriptChars: T, kbChars: KB }).totalDollars *
      USD_TO_GBP
    expect(gbp).toBeGreaterThan(1.8)
    expect(gbp).toBeLessThan(3.2)
  })

  it('attributes most of the balanced bill to the chronicle', () => {
    // Chronicle is the only phase where thinking cannot be switched off.
    const r = estimateRunCost({ routing: balanced, transcriptChars: T, kbChars: KB })
    const p3 = r.perPhase.find((p) => p.phase === 'phase3_chronicle')!
    expect(p3.dollars / r.totalDollars).toBeGreaterThan(0.75)
  })

  it('shows thinking as the dominant cost, not the prose', () => {
    // Turning thinking off should cut the estimate by more than half. If it
    // ever stops doing so, the ratios have drifted away from the measurement.
    const on = estimateRunCost({ routing: balanced, transcriptChars: T, kbChars: KB }).totalDollars
    const off = estimateRunCost({
      routing: balanced,
      transcriptChars: T,
      kbChars: KB,
      thinkingEnabled: false,
    }).totalDollars
    expect(off).toBeLessThan(on * 0.5)
  })

  it('still reproduces the documented all-Pro figure', () => {
    const allPro: Record<string, PhaseRouting> = {
      phase1_ground: pro,
      phase2_audit: pro,
      phase3_chronicle: pro,
      phase4_extras: pro,
      phase6_condense: pro,
    }
    const gbp =
      estimateRunCost({ routing: allPro, transcriptChars: T, kbChars: KB }).totalDollars *
      USD_TO_GBP
    // README quotes ~GBP 3 for a 3-hour session on Pro.
    expect(gbp).toBeGreaterThan(2.5)
    expect(gbp).toBeLessThan(5)
  })
})
