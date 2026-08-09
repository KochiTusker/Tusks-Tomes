// Lock down the fixture set + variant transforms. Catches the case where
// a future edit accidentally drops a fixture, breaks the severity ladder,
// or introduces a variant that doesn't apply the right framing.

import { describe, expect, it } from 'vitest'
import { FIXTURES, VARIANTS, applyVariant, V1_TTRPG_FRAMING, V2_META_FRAMING } from './fixtures.mjs'

describe('FIXTURES', () => {
  it('exports exactly 10 graded fixtures', () => {
    // The probe matrix size depends on this count. If you add an 11th,
    // bump this test and the probe documentation in the plan.
    expect(FIXTURES).toHaveLength(10)
  })

  it('every fixture has a unique id', () => {
    const ids = FIXTURES.map((f) => f.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('every fixture has a chunk ≥ 200 chars (real-prompt size)', () => {
    for (const f of FIXTURES) {
      expect(f.chunk.length, `${f.id} chunk too small`).toBeGreaterThanOrEqual(200)
    }
  })

  it('every fixture uses the [Speaker (Player)] format we audit', () => {
    // The probe sends the fixture as `${rawChunk}` to phase2Audit. The
    // prompts are written for this format; a fixture without it would
    // test something other than realistic D&D content.
    for (const f of FIXTURES) {
      expect(f.chunk, `${f.id} missing speaker-format lines`).toMatch(/\[[^\]]+\([^)]+\)\]/)
    }
  })

  it('covers the expected category set', () => {
    const categories = new Set(FIXTURES.map((f) => f.category))
    expect(categories).toContain('baseline')
    expect(categories).toContain('combat')
    expect(categories).toContain('mental')
    expect(categories).toContain('character')
    expect(categories).toContain('dialogue')
    expect(categories).toContain('plot')
    expect(categories).toContain('sexual')
  })

  it('covers the expected severity ladder', () => {
    const severities = new Set(FIXTURES.map((f) => f.severity))
    expect(severities).toContain('baseline')
    expect(severities).toContain('mild')
    expect(severities).toContain('moderate')
    expect(severities).toContain('severe')
    expect(severities).toContain('extreme')
  })

  it('the explicit_sexual fixture (control) is the only extreme', () => {
    const extreme = FIXTURES.filter((f) => f.severity === 'extreme')
    expect(extreme).toHaveLength(1)
    expect(extreme[0].id).toBe('f10_explicit_sexual')
  })
})

describe('applyVariant', () => {
  it('V0 returns the prompt unchanged (no framing)', () => {
    const out = applyVariant('V0', 'transcript chunk body')
    expect(out.systemPrompt).toBe('')
    expect(out.userPrompt).toBe('transcript chunk body')
  })

  it('V1 prepends the TTRPG framing as systemPrompt', () => {
    const out = applyVariant('V1', 'transcript chunk body')
    expect(out.systemPrompt).toBe(V1_TTRPG_FRAMING)
    expect(out.userPrompt).toBe('transcript chunk body')
  })

  it('V2 prepends V1 framing + V2 meta-framing as systemPrompt', () => {
    const out = applyVariant('V2', 'transcript chunk body')
    expect(out.systemPrompt).toContain(V1_TTRPG_FRAMING)
    expect(out.systemPrompt).toContain(V2_META_FRAMING)
    // V1 comes first in the concatenation.
    expect(out.systemPrompt.indexOf(V1_TTRPG_FRAMING)).toBeLessThan(
      out.systemPrompt.indexOf(V2_META_FRAMING),
    )
    expect(out.userPrompt).toBe('transcript chunk body')
  })

  it('throws on unknown variant', () => {
    // @ts-expect-error — intentional bad input
    expect(() => applyVariant('V99', 'x')).toThrow(/Unknown variant/)
  })

  it('V1 framing matches the verbatim Claude + OpenAI provider text', () => {
    // This locks down the contract that V1 == the existing TTRPG framing.
    // If Claude/OpenAI change their framing, this test fails until the
    // probe is also updated — preventing silent drift between providers.
    expect(V1_TTRPG_FRAMING).toContain('tabletop role-playing game')
    expect(V1_TTRPG_FRAMING).toContain('Mature themes are expected')
    expect(V1_TTRPG_FRAMING).toContain('Preserve them verbatim')
  })

  it('V2 meta-framing emphasises meta-analysis, not generation', () => {
    expect(V2_META_FRAMING).toContain('meta-analysis')
    expect(V2_META_FRAMING).toContain('NOT generating')
    expect(V2_META_FRAMING).toContain('documentary text')
  })
})

describe('VARIANTS', () => {
  it('exports the canonical three-variant set', () => {
    expect(VARIANTS).toEqual(['V0', 'V1', 'V2'])
  })
})
