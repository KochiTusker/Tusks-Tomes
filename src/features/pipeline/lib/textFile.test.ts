// The wrong-file guard. Each case is a file someone could plausibly pick
// by accident, and the two directions matter equally: binary must never
// load, and a real transcript must never be refused.

import { describe, expect, it } from 'vitest'
import { looksLikeText } from './textFile'

/** A PDF/zip/image renamed .txt, as the browser decodes it. */
function binaryish(): string {
  let s = ''
  for (let i = 0; i < 2000; i++) s += String.fromCharCode(i % 256)
  return s
}

describe('looksLikeText — refuses what is not a transcript', () => {
  it('rejects an empty file, and says so', () => {
    const v = looksLikeText('')
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toMatch(/empty/)
  })

  it('rejects binary content on a single NUL', () => {
    const v = looksLikeText('some text\u0000more text')
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toMatch(/binary/)
  })

  it('rejects the decoded-binary case that reached the transcript box in QA', () => {
    expect(looksLikeText(binaryish()).ok).toBe(false)
  })

  it('rejects a wall of replacement characters from a bad decode', () => {
    expect(looksLikeText('\uFFFD'.repeat(500)).ok).toBe(false)
  })
})

describe('looksLikeText — accepts real transcripts', () => {
  it('accepts plain dialogue with tabs and newlines', () => {
    expect(looksLikeText('KAZIEL: We ride at dawn.\n\tDM: Roll for it.\r\n').ok).toBe(true)
  })

  it('accepts an SBV with timestamps', () => {
    expect(looksLikeText('0:00:01.000,0:00:03.500\nKAZIEL: We ride at dawn.\n').ok).toBe(true)
  })

  it('accepts accented and non-Latin text', () => {
    expect(looksLikeText('Zürich — 大丈夫 — Ωμέγα, said the bard.').ok).toBe(true)
  })

  it('tolerates a stray mangled character in an otherwise real file', () => {
    // One bad character in a long real transcript must not block the load.
    expect(looksLikeText('KAZIEL: We ride at dawn. '.repeat(80) + '\uFFFD').ok).toBe(true)
  })
})
