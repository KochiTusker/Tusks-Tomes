import { describe, expect, it } from 'vitest'
import {
  BILLED_TOKENS_PER_PLANNED_TOKEN,
  estimateRunCost,
  rateFor,
  type PhaseRouting,
} from './pricing'
import { MAX_OUTPUT_TOKENS } from './constants'
import { DEFAULT_RETRIEVAL_MAX_CHARS } from '@/features/lore'

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
  // A 3-hour session SBV is ~285 KB on disk; sbvToText() (src/features/caption-repair/lib/sbv.ts:38-42)
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

  it('charges phases 2, 3 and 4 for the lore they now carry', () => {
    // The audit and extras prompts take the compact lore and the chronicle
    // prefix takes it in full. An estimate that priced them at zero lore
    // under-reported every run with a Knowledge Base.
    const without = estimateRunCost({ routing: allPro, transcriptChars: THREE_HOUR_SESSION, kbChars: 0 })
    const withLore = estimateRunCost({ routing: allPro, transcriptChars: THREE_HOUR_SESSION, kbChars: 58_000 })
    const tokens = (r: typeof without, phase: string) => r.perPhase.find((p) => p.phase === phase)!.inputTokens
    for (const phase of ['phase2_audit', 'phase3_chronicle', 'phase4_extras']) {
      expect(tokens(withLore, phase)).toBeGreaterThan(tokens(without, phase))
    }
  })

  it('caps the Phase 3 lore at the retrieval budget', () => {
    // Phase 3 retrieves rather than overflow, so past the budget a bigger
    // vault costs Phase 3 nothing more. Phase 6 has no such cap here: its
    // caller passes the retrieved size instead.
    const atBudget = estimateRunCost({
      routing: allPro, transcriptChars: THREE_HOUR_SESSION, kbChars: DEFAULT_RETRIEVAL_MAX_CHARS,
    })
    const farPast = estimateRunCost({
      routing: allPro, transcriptChars: THREE_HOUR_SESSION, kbChars: REFERENCE_VAULT,
    })
    const tokens = (r: typeof atBudget, phase: string) => r.perPhase.find((p) => p.phase === phase)!.inputTokens
    expect(tokens(farPast, 'phase3_chronicle')).toBe(tokens(atBudget, 'phase3_chronicle'))
    expect(tokens(farPast, 'phase6_condense')).toBeGreaterThan(tokens(atBudget, 'phase6_condense'))
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
    expect(by.phase1_ground).toBeGreaterThan(0)
    expect(by.phase2_audit).toBe(0)
    expect(by.phase4_extras).toBe(0)
  })

  it('does not model a Phase 6 cache on a chronicle that fits one call', () => {
    // A cache lease needs a second call to pay off, and pipeline.ts only takes
    // one when chunksRemaining > 1. A real chronicle off a 3-hour session is
    // ~70k chars, which fits inside the 100k flagship Phase 6 chunk, so there
    // is no second call and no cache.
    //
    // This looked different until 2026-09-16 only because the model had the
    // chronicle at 2.8x its real size: it invented a multi-chunk Phase 6 and
    // then credited the run with cache savings it never received. Asserting
    // the absence is the point — an over-sized corpus shows up here first.
    const r = estimateRunCost({
      routing: allPro, transcriptChars: THREE_HOUR_SESSION, kbChars: REFERENCE_VAULT,
    })
    const p6 = r.perPhase.find((p) => p.phase === 'phase6_condense')!
    expect(p6.chunks).toBe(1)
    expect(p6.cachedInputTokens).toBe(0)
  })

  it('does model a Phase 6 cache once the chronicle needs a second call', () => {
    // Same routing, a session long enough that the chronicle passes 100k chars.
    const r = estimateRunCost({
      routing: allPro, transcriptChars: 700_000, kbChars: REFERENCE_VAULT,
    })
    const p6 = r.perPhase.find((p) => p.phase === 'phase6_condense')!
    expect(p6.chunks).toBeGreaterThan(1)
    expect(p6.cachedInputTokens).toBeGreaterThan(0)
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
  // What the model is built from, after the 2026-09-16 refit:
  //
  //   measured   chronicle ÷ transcript, and condense ÷ chronicle, taken from
  //              completed runs on disk rather than from what the prompt asks
  //              the model to do.
  //   bounded    per-call output cannot exceed the maxOutputTokens the
  //              pipeline sends. This is what makes the fit falsifiable: it
  //              is why a single pass over the planned chunks provably cannot
  //              reach the bill, and therefore why the overhead term exists.
  //   fitted     BILLED_TOKENS_PER_PLANNED_TOKEN, the one free parameter.
  //
  // The transcript size below is a choice, not a record — the billed
  // sessions' lengths were never captured, and size and the overhead term
  // trade off directly against each other (roughly 1.8x on a long session,
  // 4.2x on a short one). 280,000 chars sits in the upper third of the real
  // observed range, which is where a session billing GBP 2.28-2.56 most
  // plausibly sat. Read the pair as one hypothesis, not two measurements.
  const T = 280_000
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
    expect(gbp).toBeGreaterThan(2.0)
    expect(gbp).toBeLessThan(2.9)
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
    // Every phase on the most expensive model, on a long session — the top
    // corner of the README's "roughly $0-$5 per session", and slightly past
    // it. The overhead term is applied to all five phases although the
    // billing evidence only covers three, because retries are not phase-
    // specific and assuming they spare the mechanical phases would bias the
    // estimate low. Low is the dangerous direction for a cost estimate.
    expect(gbp).toBeGreaterThan(3.5)
    expect(gbp).toBeLessThan(6.0)
  })

  it('never models a call billing more output than the pipeline permits', () => {
    // The invariant that would have caught the 2.8x corpus error on the day
    // it landed. Before the clamp, a chronicle call modelled 71,775 output
    // tokens against the 32,768 the pipeline sends as maxOutputTokens, and
    // the total still matched billing because the thinking residual had
    // absorbed the difference. A total that matches is not evidence when the
    // parts are impossible.
    const allPro: Record<string, PhaseRouting> = {
      phase1_ground: pro,
      phase2_audit: pro,
      phase3_chronicle: pro,
      phase4_extras: pro,
      phase6_condense: pro,
    }
    for (const chars of [50_000, 240_000, 500_000, 1_200_000]) {
      const r = estimateRunCost({ routing: allPro, transcriptChars: chars, kbChars: KB })
      for (const p of r.perPhase) {
        const perCall = p.outputTokens / (p.chunks * BILLED_TOKENS_PER_PLANNED_TOKEN)
        expect(perCall).toBeLessThanOrEqual(MAX_OUTPUT_TOKENS)
      }
    }
  })

  it('keeps chunks as the planned count, not the billed one', () => {
    // callsForRun (runPreflight.ts) sums these against a daily request cap and
    // the picker shows them as "chunks per phase". The overhead term belongs
    // on tokens; folding it into chunks would quietly double both.
    const r = estimateRunCost({ routing: balanced, transcriptChars: 120_000, kbChars: 0 })
    const p3 = r.perPhase.find((p) => p.phase === 'phase3_chronicle')!
    expect(p3.chunks).toBe(2) // 120,000 chars / 60,000 flagship p3 chunk
  })
})
