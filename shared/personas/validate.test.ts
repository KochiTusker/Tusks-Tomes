import { describe, expect, it } from 'vitest'
import { extractPlaceholders, validatePersona } from './validate'

const LONG = 'x'.repeat(100)
const good = {
  name: 'Name',
  description: '',
  prompts: {
    phase3Cloud: `${LONG} {groundedChunk}`,
    phase3Local: `${LONG} {groundedChunk}`,
    phase5Local: `${LONG} {chronicleChunk}`,
    phase6Cloud: `${LONG} {chronicle}`,
    phase6Local: `${LONG} {chronicle}`,
  },
}

describe('validatePersona messages', () => {
  it('accepts a complete persona', () => {
    expect(validatePersona(good)).toEqual([])
  })

  it('words every rejection exactly', () => {
    const errors = validatePersona({
      name: ' ',
      description: 'd'.repeat(241),
      prompts: { ...good.prompts, phase3Cloud: '', phase3Local: 'short {groundedChunk}', phase5Local: LONG },
    })
    expect(errors).toEqual([
      { field: 'name', message: 'Name is required.' },
      { field: 'description', message: 'Description must be 240 characters or fewer.' },
      { slot: 'phase3Cloud', message: 'phase3Cloud prompt is required.' },
      { slot: 'phase3Local', message: 'phase3Local prompt is too short to be a working prompt.' },
      {
        slot: 'phase5Local',
        message: 'phase5Local prompt must include the {chronicleChunk} placeholder so the pipeline can feed in the chunk text.',
      },
    ])
    expect(validatePersona({ ...good, name: 'n'.repeat(61) })).toEqual([
      { field: 'name', message: 'Name must be 60 characters or fewer.' },
    ])
  })
})

describe('extractPlaceholders', () => {
  it('collects word-character tokens only', () => {
    expect([...extractPlaceholders('{a} {b_1} { c } {} {a}')].sort()).toEqual(['a', 'b_1'])
  })
})
