import { describe, expect, it } from 'vitest'
import { extractPlaceholders, renderPersonaPrompt } from './render'
import { buildSeedPersonas } from './presets'
import { validatePersona } from './validate'
import { PROMPT_SLOTS, REQUIRED_PLACEHOLDER } from './types'

describe('renderPersonaPrompt', () => {
  it('substitutes string and number placeholders', () => {
    const out = renderPersonaPrompt('Chunk {chunkIndex}/{chunkTotal}: {groundedChunk}', {
      groundedChunk: 'hello',
      chunkIndex: 2,
      chunkTotal: 5,
    })
    expect(out).toBe('Chunk 2/5: hello')
  })

  it('leaves unknown tokens intact for visibility', () => {
    const out = renderPersonaPrompt('Hello {nope}', { groundedChunk: 'x' })
    expect(out).toBe('Hello {nope}')
  })

  it('treats missing vars as empty strings', () => {
    const out = renderPersonaPrompt('A {priorTail} B', { groundedChunk: 'x' })
    expect(out).toBe('A  B')
  })
})

describe('client preset templates', () => {
  it('every preset renders the required placeholder for each slot', () => {
    const presets = buildSeedPersonas()
    for (const p of presets) {
      for (const slot of PROMPT_SLOTS) {
        const placeholders = extractPlaceholders(p.prompts[slot])
        expect(placeholders.has(REQUIRED_PLACEHOLDER[slot]), `${p.name} → ${slot} missing required {${REQUIRED_PLACEHOLDER[slot]}}`).toBe(true)
      }
    }
  })

  it('every preset passes client-side validation', () => {
    const presets = buildSeedPersonas()
    for (const p of presets) {
      expect(validatePersona(p), `preset "${p.name}" should validate client-side`).toEqual([])
    }
  })
})
