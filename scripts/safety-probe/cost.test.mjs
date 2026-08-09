// T1.2 — cost meter sanity. Verifies the per-chunk → per-phase aggregator
// produces correct totals for the matrix of (tier, model) combinations
// and that Free counts as $0.

import { describe, expect, it } from 'vitest'
import {
  GEMINI_PRICING,
  aggregate,
  cellsFromRing,
  costForCell,
  formatDollars,
} from './cost.mjs'

describe('GEMINI_PRICING table', () => {
  it('has Paid Pro at $1.25 input / $10 output per MTok', () => {
    expect(GEMINI_PRICING.paid['gemini-2.5-pro'].input).toBe(1.25)
    expect(GEMINI_PRICING.paid['gemini-2.5-pro'].output).toBe(10.0)
  })

  it('has Paid Flash at $0.30 / $2.50', () => {
    expect(GEMINI_PRICING.paid['gemini-2.5-flash'].input).toBe(0.30)
    expect(GEMINI_PRICING.paid['gemini-2.5-flash'].output).toBe(2.50)
  })

  it('has Paid Flash-Lite at $0.10 / $0.40', () => {
    expect(GEMINI_PRICING.paid['gemini-2.5-flash-lite'].input).toBe(0.10)
    expect(GEMINI_PRICING.paid['gemini-2.5-flash-lite'].output).toBe(0.40)
  })

  it('Free table is empty / falls back to $0', () => {
    // The Free table is intentionally empty — costForCell returns 0 for tier=free.
    expect(GEMINI_PRICING.free).toBeDefined()
    expect(Object.keys(GEMINI_PRICING.free)).toHaveLength(0)
  })

  it('lists cached input rate at ~25% of uncached for Pro + Flash', () => {
    // Google's cached-token discount is ~75% off list. Lock that down.
    const pro = GEMINI_PRICING.paid['gemini-2.5-pro']
    expect(pro.cachedInput).toBeLessThan(pro.input * 0.5)
    const flash = GEMINI_PRICING.paid['gemini-2.5-flash']
    expect(flash.cachedInput).toBeLessThan(flash.input * 0.5)
  })
})

describe('costForCell', () => {
  it('returns 0 for Free tier regardless of token count', () => {
    expect(
      costForCell({
        tier: 'free',
        model: 'gemini-2.5-flash',
        usage: { inputTokens: 100_000, outputTokens: 50_000 },
      }),
    ).toBe(0)
  })

  it('computes Pro: 1M input + 1M output = $11.25', () => {
    const dollars = costForCell({
      tier: 'paid',
      model: 'gemini-2.5-pro',
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
    })
    expect(dollars).toBeCloseTo(1.25 + 10.0, 4)
  })

  it('computes Flash: 10K input + 5K output = ~$0.0155', () => {
    // 10K * 0.30/1M + 5K * 2.50/1M = 0.003 + 0.0125 = 0.0155
    const dollars = costForCell({
      tier: 'paid',
      model: 'gemini-2.5-flash',
      usage: { inputTokens: 10_000, outputTokens: 5_000 },
    })
    expect(dollars).toBeCloseTo(0.0155, 5)
  })

  it('applies cachedInput rate to the cached portion', () => {
    // 100K total input, 80K cached, 20K uncached, on Pro.
    // uncached: 20K * 1.25/1M = 0.025
    // cached:   80K * 0.31/1M = 0.0248
    // output:   1K * 10/1M    = 0.01
    // total: ~0.0598
    const dollars = costForCell({
      tier: 'paid',
      model: 'gemini-2.5-pro',
      usage: { inputTokens: 100_000, cachedInputTokens: 80_000, outputTokens: 1_000 },
    })
    expect(dollars).toBeCloseTo(0.025 + 0.0248 + 0.01, 4)
  })

  it('treats tier=auto as paid for cost purposes', () => {
    // Auto mode dispatches to paid by default; cost should match.
    const auto = costForCell({
      tier: 'auto',
      model: 'gemini-2.5-pro',
      usage: { inputTokens: 1_000_000, outputTokens: 0 },
    })
    const paid = costForCell({
      tier: 'paid',
      model: 'gemini-2.5-pro',
      usage: { inputTokens: 1_000_000, outputTokens: 0 },
    })
    expect(auto).toBe(paid)
  })

  it('returns 0 for a missing usage object', () => {
    expect(costForCell({ tier: 'paid', model: 'x' })).toBe(0)
  })

  it('falls back to Pro rates for unknown model names', () => {
    // An unknown model gets the FALLBACK_RATE (Pro). Test that a Pro-shaped
    // model name still maps to Pro pricing via the heuristic.
    const dollars = costForCell({
      tier: 'paid',
      model: 'gemini-2.5-pro-experimental-12345',
      usage: { inputTokens: 1_000_000, outputTokens: 0 },
    })
    expect(dollars).toBeCloseTo(1.25, 4)
  })

  it('heuristic maps "flash-lite" model names to Flash-Lite rates', () => {
    const dollars = costForCell({
      tier: 'paid',
      model: 'gemini-3.0-flash-lite-preview',
      usage: { inputTokens: 1_000_000, outputTokens: 0 },
    })
    expect(dollars).toBeCloseTo(0.10, 4)
  })
})

describe('aggregate', () => {
  it('returns empty buckets for an empty input', () => {
    const result = aggregate([])
    expect(result.perPhase).toEqual([])
    expect(result.totals.dollars).toBe(0)
  })

  it('groups cells by phase and sums tokens + dollars per bucket', () => {
    const cells = [
      { phase: 'phase1_ground', tier: 'paid', model: 'gemini-2.5-pro',
        usage: { inputTokens: 10_000, outputTokens: 1_000 } },
      { phase: 'phase1_ground', tier: 'paid', model: 'gemini-2.5-pro',
        usage: { inputTokens: 12_000, outputTokens: 1_500 } },
      { phase: 'phase3_chronicle', tier: 'paid', model: 'gemini-2.5-pro',
        usage: { inputTokens: 30_000, outputTokens: 5_000 } },
    ]
    const result = aggregate(cells)
    expect(result.perPhase).toHaveLength(2)
    const p1 = result.perPhase.find((b) => b.phase === 'phase1_ground')
    expect(p1.chunks).toBe(2)
    expect(p1.inputTokens).toBe(22_000)
    expect(p1.outputTokens).toBe(2_500)
    const p3 = result.perPhase.find((b) => b.phase === 'phase3_chronicle')
    expect(p3.chunks).toBe(1)
    expect(p3.inputTokens).toBe(30_000)
  })

  it('produces a Free + Paid split for a hybrid run', () => {
    // The headline scenario: Phase 1 + 2 on Free, Phase 3 on Paid.
    const cells = [
      { phase: 'phase1_ground', tier: 'free', model: 'gemini-2.5-flash',
        usage: { inputTokens: 50_000, outputTokens: 5_000 } },
      { phase: 'phase2_audit', tier: 'free', model: 'gemini-2.5-flash',
        usage: { inputTokens: 80_000, outputTokens: 1_000 } },
      { phase: 'phase3_chronicle', tier: 'paid', model: 'gemini-2.5-pro',
        usage: { inputTokens: 60_000, outputTokens: 15_000 } },
    ]
    const result = aggregate(cells)
    const p1 = result.perPhase.find((b) => b.phase === 'phase1_ground')
    expect(p1.dollars).toBe(0) // Free
    const p2 = result.perPhase.find((b) => b.phase === 'phase2_audit')
    expect(p2.dollars).toBe(0) // Free
    const p3 = result.perPhase.find((b) => b.phase === 'phase3_chronicle')
    // Pro: 60K * 1.25/1M + 15K * 10/1M = 0.075 + 0.150 = 0.225
    expect(p3.dollars).toBeCloseTo(0.225, 4)
    expect(result.totals.dollars).toBeCloseTo(0.225, 4)
  })

  it('reports the set of tiers + models seen per phase', () => {
    // Edge case — escalation: a phase that has both free and paid cells.
    const cells = [
      { phase: 'phase1_ground', tier: 'free', model: 'gemini-2.5-flash',
        usage: { inputTokens: 1_000, outputTokens: 100 } },
      { phase: 'phase1_ground', tier: 'paid', model: 'gemini-2.5-pro',
        usage: { inputTokens: 1_000, outputTokens: 100 } },
    ]
    const result = aggregate(cells)
    const p1 = result.perPhase[0]
    expect(p1.tiers).toEqual(expect.arrayContaining(['free', 'paid']))
    expect(p1.models).toEqual(expect.arrayContaining(['gemini-2.5-flash', 'gemini-2.5-pro']))
  })

  it('skips cells without a usage object (defensive)', () => {
    const result = aggregate([
      { phase: 'phase1_ground', tier: 'paid', model: 'gemini-2.5-pro' }, // no usage
      { phase: 'phase1_ground', tier: 'paid', model: 'gemini-2.5-pro',
        usage: { inputTokens: 1_000, outputTokens: 100 } },
    ])
    expect(result.perPhase[0].chunks).toBe(1)
    expect(result.totals.chunks).toBe(1)
  })
})

describe('cellsFromRing', () => {
  it('extracts chunk_finished entries from a mixed vlog ring', () => {
    const ring = [
      { ts: 1, cat: 'pipeline', payload: { type: 'phase_start' } }, // ignored
      { ts: 2, cat: 'chunk', payload: { event: 'chunk_started' } }, // ignored
      { ts: 3, cat: 'chunk', payload: {
        event: 'chunk_finished',
        phase: 'phase1_ground',
        tier: 'paid',
        model: 'gemini-2.5-pro',
        index: 0,
        latencyMs: 1234,
        usage: { inputTokens: 5_000, outputTokens: 500 },
      } },
      { ts: 4, cat: 'gemini', payload: { event: 'useFallback_flipped' } }, // ignored
    ]
    const cells = cellsFromRing(ring)
    expect(cells).toHaveLength(1)
    expect(cells[0].phase).toBe('phase1_ground')
    expect(cells[0].usage.inputTokens).toBe(5_000)
    expect(cells[0].latencyMs).toBe(1234)
  })

  it('returns empty array for a ring with no chunk_finished events', () => {
    expect(cellsFromRing([])).toEqual([])
    expect(cellsFromRing([{ cat: 'pipeline', payload: {} }])).toEqual([])
  })
})

describe('formatDollars', () => {
  it('uses 4 decimals for sub-cent', () => {
    expect(formatDollars(0.0001)).toBe('$0.0001')
    expect(formatDollars(0.0099)).toBe('$0.0099')
  })

  it('uses 3 decimals for sub-dollar', () => {
    expect(formatDollars(0.01)).toBe('$0.010')
    expect(formatDollars(0.99)).toBe('$0.990')
  })

  it('uses 2 decimals for dollars and up', () => {
    expect(formatDollars(1.234)).toBe('$1.23')
    expect(formatDollars(123.456)).toBe('$123.46')
  })

  it('handles non-finite gracefully', () => {
    expect(formatDollars(NaN)).toBe('$?')
    expect(formatDollars(Infinity)).toBe('$?')
  })
})
