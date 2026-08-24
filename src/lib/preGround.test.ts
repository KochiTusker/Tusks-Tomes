import { describe, expect, it } from 'vitest'
import { formatContextualHints, pickHintsFor } from './preGround'
import type { ContextualHint } from '@/data/corrections'

const HINTS: ContextualHint[] = [
  {
    canonical: 'Az',
    commonMishears: ['as', 'Aza', 'Ass'],
    notes: 'Lord Az is a player character; sentence-initial "As" is the trap.',
  },
  {
    canonical: 'Tiamat',
    commonMishears: ['Tia mat', 'Tia-mat', 'Tiomat'],
    notes: 'Five-headed dragon goddess.',
  },
  {
    canonical: 'Helmsworth',
    notes: 'Lord of the city of Krome.',
  },
]

describe('pickHintsFor', () => {
  it('returns empty string when no hint matches the chunk', () => {
    const chunk = 'The party walked through a forest, encountered a bear, and won initiative.'
    expect(pickHintsFor(chunk, HINTS)).toBe('')
  })

  it('matches a canonical name in the chunk text', () => {
    const chunk = 'Helmsworth waved them inside the keep.'
    const result = pickHintsFor(chunk, HINTS)
    expect(result).toContain('Helmsworth')
    expect(result).not.toContain('Az')
    expect(result).not.toContain('Tiamat')
  })

  it('matches when a mis-heard form (not the canonical) appears in the chunk', () => {
    // The hint exists to fix this mis-hearing — filtering it out because
    // only the misspelling appears in the raw text would defeat the
    // hint's purpose.
    const chunk = 'And as he raised his sword, the dragon roared.'
    const result = pickHintsFor(chunk, HINTS)
    expect(result).toContain('Az')
  })

  it('matches multiple hints when multiple triggers appear', () => {
    const chunk = 'Helmsworth stood his ground as Tiamat descended upon Krome.'
    const result = pickHintsFor(chunk, HINTS)
    expect(result).toContain('Helmsworth')
    expect(result).toContain('Tiamat')
    expect(result).toContain('Az') // "as" mishear triggers
  })

  it('is case-insensitive', () => {
    const chunk = 'HELMSWORTH waited at the gate.'
    expect(pickHintsFor(chunk, HINTS)).toContain('Helmsworth')
  })

  it('returns "" when the hints array is empty', () => {
    expect(pickHintsFor('any text', [])).toBe('')
  })

  it('returns "" when the chunk is empty', () => {
    expect(pickHintsFor('', HINTS)).toBe('')
  })

  it('output format matches formatContextualHints for the filtered subset', () => {
    const chunk = 'Helmsworth waved them inside.'
    const filtered = pickHintsFor(chunk, HINTS)
    const manual = formatContextualHints(HINTS.filter((h) => h.canonical === 'Helmsworth'))
    expect(filtered).toBe(manual)
  })
})
