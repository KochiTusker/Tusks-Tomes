import { describe, expect, it } from 'vitest'
import { buildSeedDocument } from './seed.js'
import { validatePersona } from './validate.js'

describe('validatePersona', () => {
  it('accepts every seeded preset', () => {
    const doc = buildSeedDocument()
    for (const p of doc.personas) {
      const errors = validatePersona(p)
      expect(errors, `preset "${p.name}" should validate`).toEqual([])
    }
  })

  it('rejects a missing name', () => {
    const doc = buildSeedDocument()
    const errors = validatePersona({ ...doc.personas[0], name: '' })
    expect(errors.some((e) => e.field === 'name')).toBe(true)
  })

  it('rejects a slot stripped of its required placeholder', () => {
    const doc = buildSeedDocument()
    const broken = {
      ...doc.personas[0],
      prompts: {
        ...doc.personas[0].prompts,
        phase3Cloud: 'Just some narrative voice with no chunk variable at all, way past the eighty character minimum length though so the short-prompt check does not fire.',
      },
    }
    const errors = validatePersona(broken)
    expect(errors.some((e) => e.slot === 'phase3Cloud' && /groundedChunk/.test(e.message))).toBe(true)
  })

  it('rejects an empty prompt slot', () => {
    const doc = buildSeedDocument()
    const broken = {
      ...doc.personas[0],
      prompts: { ...doc.personas[0].prompts, phase5Local: '' },
    }
    const errors = validatePersona(broken)
    expect(errors.some((e) => e.slot === 'phase5Local')).toBe(true)
  })
})
