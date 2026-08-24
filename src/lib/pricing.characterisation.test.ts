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
    // Pinned 2026-08-19 against the static tables. If a deliberate rate
    // change moves these, update the expectation in the same commit and
    // say which rates moved.
    expect(byPhase).toMatchInlineSnapshot(`
      {
        "phase1_ground": "0.2186",
        "phase2_audit": "0.0000",
        "phase3_chronicle": "3.2081",
        "phase4_extras": "0.1700",
        "phase6_condense": "0.0267",
      }
    `)
    expect(est.totalDollars.toFixed(4)).toMatchInlineSnapshot(`"3.6234"`)
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
