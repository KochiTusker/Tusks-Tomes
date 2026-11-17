// Characterisation tests — these pin the CURRENT cost-estimation behaviour
// so that the live-rates change (OpenRouter catalogue pricing for both
// OpenRouter AND Gemini) shows up as a visible, deliberate test diff rather
// than silent drift in someone's cost estimate.
//
// They are not "correctness" tests: they assert what estimateRunCost does
// today. The no-catalogue path must keep producing exactly these numbers
// after the change — that is the offline fallback contract.

import { describe, expect, it } from 'vitest'
import { estimateRunCost } from './pricing'

const FIXTURE = {
  transcriptChars: 240_000, // ~3-hour session
  kbChars: 100_000,
  routing: {
    phase1_ground: { provider: 'gemini' as const, tier: 'paid' as const, model: 'gemini-flash-latest' },
    phase2_audit: { provider: 'claudeCode' as const, model: 'haiku' },
    phase3_chronicle: { provider: 'gemini' as const, tier: 'paid' as const, model: 'gemini-pro-latest' },
    phase4_extras: { provider: 'openrouter' as const, model: 'deepseek/deepseek-v4-flash' },
    phase6_condense: { provider: 'gemini' as const, tier: 'paid' as const, model: 'gemini-flash-lite-latest' },
  },
}

describe('estimateRunCost — static-table path (no catalogue)', () => {
  it('pins the per-phase and total dollars', () => {
    const est = estimateRunCost(FIXTURE)
    const byPhase = Object.fromEntries(est.perPhase.map((p) => [p.phase, p.dollars.toFixed(4)]))
    // Pinned against the static tables. If a deliberate rate change moves
    // these, update the expectation in the same commit and say which rates
    // moved.
    //
    // Repinned 2026-09-16 for the cost-model refit. No provider rate changed;
    // three modelling terms did. What moved, and why:
    //   phase1, phase4   exactly 2x — their ratios are untouched, so this is
    //                    BILLED_TOKENS_PER_PLANNED_TOKEN alone.
    //   phase3           3.2081 -> 2.3794. The corpus ratio dropped 2.8x to
    //                    the measured value, then the overhead put 2x back.
    //   phase6           also down: its corpus is the chronicle, which is now
    //                    modelled at its real size.
    // A phase moving by something other than 2x is the signal worth reading
    // here — it means a ratio moved, not just the overhead.
    expect(byPhase).toMatchInlineSnapshot(`
      {
        "phase1_ground": "0.4373",
        "phase2_audit": "0.0000",
        "phase3_chronicle": "2.4884",
        "phase4_extras": "0.3900",
        "phase6_condense": "0.0187",
      }
    `)
    expect(est.totalDollars.toFixed(4)).toMatchInlineSnapshot(`"3.3343"`)
  })

  it('free-tier Gemini and both subscription CLIs price at zero', () => {
    const est = estimateRunCost({
      transcriptChars: 100_000,
      kbChars: 0,
      routing: {
        phase1_ground: { provider: 'gemini', tier: 'free', model: 'gemini-flash-latest' },
        phase2_audit: { provider: 'claudeCode', model: 'sonnet' },
        phase3_chronicle: { provider: 'codex', model: 'default' },
      },
    })
    expect(est.totalDollars).toBe(0)
  })
})
