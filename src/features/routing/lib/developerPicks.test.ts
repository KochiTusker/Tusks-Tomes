import { describe, expect, it } from 'vitest'
import {
  DEVELOPER_PICKS,
  hasPicks,
  pickFor,
  pickRank,
  vendorLabel,
  vendorOf,
} from './developerPicks'
import { MEASURED_GRADES, PHASE_ORDER, type Phase } from './phaseGrades'

describe('grouping models by vendor', () => {
  it('reads the vendor out of the id namespace', () => {
    expect(vendorOf('anthropic/claude-haiku-4.5')).toBe('anthropic')
    expect(vendorOf('z-ai/glm-5.2')).toBe('z-ai')
    expect(vendorOf('moonshotai/kimi-k3')).toBe('moonshotai')
  })

  it('strips the tilde that marks a floating latest alias', () => {
    // Otherwise "~google/gemini-pro-latest" would open its own one-model
    // folder next to the real Google one.
    expect(vendorOf('~google/gemini-pro-latest')).toBe('google')
  })

  it('files an unnamespaced id under "other" rather than inventing a vendor', () => {
    expect(vendorOf('gemini-pro-latest')).toBe('other')
  })

  it('labels a vendor it has never seen, so a new one still groups', () => {
    // The whole point of deriving folders from the namespace: nothing has to
    // be added by hand when a vendor appears in the catalogue.
    expect(vendorLabel('anthropic')).toBe('Anthropic')
    expect(vendorLabel('brand-new-lab')).toBe('Brand-New-Lab')
  })
})

describe("developer's picks", () => {
  it('is an ordered recommendation, not a set', () => {
    // Position carries the meaning — first entry is what would be routed by
    // default — so rank has to be stable and distinct.
    const ranks = DEVELOPER_PICKS.phase4!.map((p) => pickRank('phase4', p.modelId))
    expect(ranks).toEqual([0, 1, 2])
  })

  it('sorts an unpicked model last rather than first', () => {
    expect(pickRank('phase4', 'some/unknown-model')).toBeGreaterThan(pickRank('phase4', 'z-ai/glm-5.2'))
  })

  it('gives every pick a reason, since none of them are on reputation', () => {
    for (const [phase, picks] of Object.entries(DEVELOPER_PICKS)) {
      for (const p of picks ?? []) {
        expect(p.reason.length, `${phase} ${p.modelId}`).toBeGreaterThan(40)
      }
    }
  })

  it('states the configuration for any pick that needs one', () => {
    // A model that returns an empty body at its defaults must not be
    // recommended without saying so in the same breath.
    const kimi = pickFor('phase4', 'moonshotai/kimi-k3')
    expect(kimi?.requires).toMatch(/effort/i)
    expect(kimi?.requires).toMatch(/pin/i)
  })

  it('does not pick a model graded D or F on that phase', () => {
    // Picks and grades can disagree on ordering, but a pick must never
    // contradict a measurement outright.
    for (const phase of PHASE_ORDER) {
      for (const p of DEVELOPER_PICKS[phase] ?? []) {
        const measured = MEASURED_GRADES[`${p.modelId}::${phase}`]
        if (!measured) continue
        expect(['A', 'B', 'C'], `${p.modelId} on ${phase}`).toContain(measured.grade)
      }
    }
  })

  it('has no opinion on the phase with no measurements, and says so', () => {
    // Audit has never been graded. An empty pick list is the honest state;
    // the UI shows "not measured" rather than a guess.
    expect(hasPicks('phase2' as Phase)).toBe(false)
    expect(hasPicks('phase4' as Phase)).toBe(true)
  })
})
