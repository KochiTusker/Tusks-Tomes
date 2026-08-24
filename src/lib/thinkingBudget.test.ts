import { describe, expect, it } from 'vitest'
import { resolveThinkingBudget } from './pipeline'

describe('resolveThinkingBudget — Phase A toggle', () => {
  it('returns undefined for Phase 3 (chronicle) regardless of toggle state', () => {
    // Phase 3 is hardcoded to keep thinking on — voice protection.
    expect(
      resolveThinkingBudget('phase3_chronicle', { disableThinkingOnGrounding: true }),
    ).toBeUndefined()
    expect(
      resolveThinkingBudget('phase3_chronicle', { disableThinkingOnGrounding: false }),
    ).toBeUndefined()
  })

  it('returns 0 for Phase 1 when the toggle is ON', () => {
    expect(
      resolveThinkingBudget('phase1_ground', { disableThinkingOnGrounding: true }),
    ).toBe(0)
  })

  it('returns undefined for Phase 1 when the toggle is OFF (existing behaviour)', () => {
    expect(
      resolveThinkingBudget('phase1_ground', { disableThinkingOnGrounding: false }),
    ).toBeUndefined()
  })

  it('returns undefined for Phase 2 / 4 / 6 regardless of toggle state (out of scope this cycle)', () => {
    for (const phase of [
      'phase2_audit',
      'phase4_extras',
      'phase5_polish',
      'phase6_condense',
    ] as const) {
      expect(
        resolveThinkingBudget(phase, { disableThinkingOnGrounding: true }),
      ).toBeUndefined()
      expect(
        resolveThinkingBudget(phase, { disableThinkingOnGrounding: false }),
      ).toBeUndefined()
    }
  })

  it('regression: default behaviour (toggle OFF) returns undefined for EVERY phase', () => {
    // The user's hard constraint: default OFF = byte-for-byte identical
    // pipeline behaviour. If this test ever turns red, an opt-in setting
    // has leaked into the default path.
    const phases = [
      'phase1_ground',
      'phase2_audit',
      'phase3_chronicle',
      'phase4_extras',
      'phase5_polish',
      'phase6_condense',
    ] as const
    for (const phase of phases) {
      expect(
        resolveThinkingBudget(phase, { disableThinkingOnGrounding: false }),
      ).toBeUndefined()
    }
  })
})
