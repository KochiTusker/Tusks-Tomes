import { describe, expect, it } from 'vitest'
import { truncateAtLineBoundary } from './devTruncate'

describe('truncateAtLineBoundary', () => {
  it('returns input unchanged when shorter than maxChars', () => {
    const r = truncateAtLineBoundary('short text', 100)
    expect(r.truncated).toBe(false)
    expect(r.text).toBe('short text')
    expect(r.outputChars).toBe(r.originalChars)
  })

  it('returns input unchanged when exactly equal to maxChars', () => {
    const txt = 'a'.repeat(50)
    const r = truncateAtLineBoundary(txt, 50)
    expect(r.truncated).toBe(false)
    expect(r.outputChars).toBe(50)
  })

  it('cuts at the nearest newline within the backtrack window', () => {
    // Hardcut at 50 chars lands mid-"line three is much longer". Newline
    // after "line two" is at index 17 — outside the 70% backtrack window
    // (35–50). Newline after "line three is much..." is the next one.
    // Use a fixture where the backtrack actually fires: short final-line
    // sits inside the backtrack zone.
    const txt = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\nBBBBBBBB\nCCCCC mid-cut here'
    //          ^ 38 chars of A, newline at idx 38                      ^
    //          ^                                  ^ 47, newline at idx 47
    // maxChars=55 → hardSlice = 55 chars, minLineCut = 38, lastNewline = 47
    const r = truncateAtLineBoundary(txt, 55)
    expect(r.truncated).toBe(true)
    expect(r.text.endsWith('BBBBBBBB')).toBe(true)
    expect(r.text.includes('\n')).toBe(true)
  })

  it('falls back to hard cut when no newline lands inside the backtrack window', () => {
    // 100 chars, all one line, no newlines. Cap = 50 → no backtrack target → hard slice.
    const txt = 'x'.repeat(100)
    const r = truncateAtLineBoundary(txt, 50)
    expect(r.truncated).toBe(true)
    expect(r.text.length).toBe(50)
  })

  it('handles transcripts with line-per-utterance shape (Tomes default)', () => {
    const lines: string[] = []
    for (let i = 0; i < 50; i++) {
      lines.push(`[Speaker ${i}] line ${i} of the session transcript with enough chars to matter`)
    }
    const txt = lines.join('\n')
    const r = truncateAtLineBoundary(txt, 500)
    expect(r.truncated).toBe(true)
    // Output ends on a complete line (no mid-utterance cut).
    expect(r.text.endsWith(']') || /\]\s.*$/.test(r.text)).toBe(true)
    // The cut happens at a newline boundary.
    const cutEndsAtCompleteLine = !r.text.match(/\[Speaker \d+\]$/) // no half-bracket
    expect(cutEndsAtCompleteLine).toBe(true)
  })

  it('treats invalid maxChars as no-op', () => {
    const txt = 'some text'
    expect(truncateAtLineBoundary(txt, 0).truncated).toBe(false)
    expect(truncateAtLineBoundary(txt, -1).truncated).toBe(false)
  })

  it('reports correct originalChars and outputChars', () => {
    const txt = 'a'.repeat(1000) + '\n' + 'b'.repeat(1000)
    const r = truncateAtLineBoundary(txt, 1500)
    expect(r.originalChars).toBe(2001)
    expect(r.outputChars).toBeLessThanOrEqual(1500)
    expect(r.outputChars).toBeGreaterThan(0)
  })
})
