import { describe, expect, it } from 'vitest'
import { compactKb, kbForPhase } from './kbCompact'

describe('compactKb', () => {
  it('returns a fallback string for empty input', () => {
    const result = compactKb('')
    expect(result.text).toBe('(no Knowledge Base provided)')
    expect(result.termCount).toBe(0)
  })

  it('extracts Title Case proper nouns from prose', () => {
    const kb = `
      Tiamat is a five-headed dragon goddess of evil.
      Sam the Cleric serves Pelor faithfully.
      Tiamat appears again in the next paragraph.
      The party landed in the city of Krome and met Lord Helmsworth.
    `
    const result = compactKb(kb)
    // Frequent terms outrank one-offs.
    expect(result.text).toContain('Tiamat')
    expect(result.text).toContain('Krome')
    expect(result.text).toContain('Lord Helmsworth')
    expect(result.termCount).toBeGreaterThan(0)
  })

  it('excludes single-word stopwords (The, A, etc.) at sentence starts', () => {
    const kb = 'The dragon roared. A villager screamed. The dragon left.'
    const result = compactKb(kb)
    // Pure stopwords like "The" and "A" should NOT count as terms even
    // though they appear in Title Case at sentence starts.
    expect(result.text).not.toContain('- **The** ')
    expect(result.text).not.toContain('- **A** ')
  })
})

describe('kbForPhase', () => {
  const fullKb = `
    Tiamat the five-headed dragon goddess of evil rules in the Nine Hells.
    Sam the Cleric serves Pelor in the city of Krome.
    Lord Helmsworth is the mayor.
  `.repeat(50) // make it large enough that compact is clearly smaller

  it('returns compact form for Phase 1 (grounding)', () => {
    const result = kbForPhase('phase1_ground', fullKb)
    expect(result.format).toBe('compact')
    expect(result.text.length).toBeLessThan(fullKb.length)
  })

  it('returns compact form for Phase 2 (audit)', () => {
    const result = kbForPhase('phase2_audit', fullKb)
    expect(result.format).toBe('compact')
  })

  it('returns compact form for Phase 4 (extras)', () => {
    const result = kbForPhase('phase4_extras', fullKb)
    expect(result.format).toBe('compact')
  })

  it('returns the full prose KB for Phase 3 (chronicle)', () => {
    const result = kbForPhase('phase3_chronicle', fullKb)
    expect(result.format).toBe('full')
    expect(result.text).toBe(fullKb)
  })

  it('returns the full prose KB for Phase 6 (condense)', () => {
    const result = kbForPhase('phase6_condense', fullKb)
    expect(result.format).toBe('full')
    expect(result.text).toBe(fullKb)
  })

  it('handles empty input with a sentinel string for full-form phases', () => {
    const result = kbForPhase('phase3_chronicle', '')
    expect(result.format).toBe('full')
    expect(result.text).toMatch(/no Knowledge Base/i)
  })

  it('handles empty input via compactKb for compact-form phases', () => {
    const result = kbForPhase('phase1_ground', '')
    expect(result.format).toBe('compact')
    expect(result.text).toMatch(/no Knowledge Base/i)
  })
})
