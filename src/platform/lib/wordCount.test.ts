import { describe, expect, it } from 'vitest'
import {
  CHRONICLE_TO_TRANSCRIPT_WORD_RATIO,
  computeCondenseTarget,
  countWords,
  estimateChronicleWords,
  proportionalChunkTarget,
} from './wordCount'

describe('countWords', () => {
  it('returns 0 for empty input', () => {
    expect(countWords('')).toBe(0)
  })

  it('returns 0 for whitespace-only input', () => {
    expect(countWords('   \n\t  ')).toBe(0)
  })

  it('counts simple words', () => {
    expect(countWords('hello world')).toBe(2)
  })

  it('collapses multiple whitespace', () => {
    expect(countWords('hello   world')).toBe(2)
    expect(countWords('hello\n\nworld')).toBe(2)
    expect(countWords('hello\tworld')).toBe(2)
  })

  it('treats punctuation as part of a word', () => {
    // "Hello, world!" is two whitespace-separated tokens — punctuation
    // doesn't split. This matches the rough-prose-counter contract the
    // Phase 6 prompt operates on (so the model's word count matches ours).
    expect(countWords('Hello, world!')).toBe(2)
    expect(countWords("don't go")).toBe(2)
  })

  it('counts a representative chronicle paragraph', () => {
    // "silver-and-grey" is hyphenated and counts as one whitespace-
    // separated token. Same as how the LLM's word-count check will see it.
    const para =
      'The party reached Thornholt at dusk. A guard in silver-and-grey livery stepped forward, spear held more out of habit than vigilance.'
    expect(countWords(para)).toBe(21)
  })
})

describe('computeCondenseTarget', () => {
  it('returns 0 for empty chronicle', () => {
    expect(computeCondenseTarget(0, 25)).toBe(0)
  })

  it('returns 0 for 0% slider', () => {
    expect(computeCondenseTarget(10000, 0)).toBe(0)
  })

  it('returns the chronicle word count at 100%', () => {
    expect(computeCondenseTarget(12345, 100)).toBe(12345)
  })

  it('rounds 25% of 12000 to 3000', () => {
    expect(computeCondenseTarget(12000, 25)).toBe(3000)
  })

  it('rounds 20% of 8000 to 1600 (the new default for typical sessions)', () => {
    expect(computeCondenseTarget(8000, 20)).toBe(1600)
  })

  it('rounds 5% of 8000 to 400 (the cheapest setting)', () => {
    expect(computeCondenseTarget(8000, 5)).toBe(400)
  })

  it('handles 5% increment steps cleanly across a realistic chronicle size', () => {
    // 14,000 words is a typical 3-hour Craig session.
    expect(computeCondenseTarget(14000, 5)).toBe(700)
    expect(computeCondenseTarget(14000, 10)).toBe(1400)
    expect(computeCondenseTarget(14000, 15)).toBe(2100)
    expect(computeCondenseTarget(14000, 20)).toBe(2800)
    expect(computeCondenseTarget(14000, 25)).toBe(3500)
    expect(computeCondenseTarget(14000, 50)).toBe(7000)
    expect(computeCondenseTarget(14000, 75)).toBe(10500)
  })

  it('rounds half values away from zero (Math.round) to keep target integral', () => {
    // 25% of 11 = 2.75; Math.round rounds to 3. Doc-anchored: any future
    // change from Math.round to Math.floor changes the cap behaviour for
    // boundary cases and should fail this test deliberately.
    expect(computeCondenseTarget(11, 25)).toBe(3)
  })
})

describe('proportionalChunkTarget', () => {
  it('passes the target through unchanged for a single full-size chunk', () => {
    expect(proportionalChunkTarget(2000, 10000, 10000)).toBe(2000)
  })

  it('splits the target by each chunk\'s share of the total', () => {
    // Two equal chunks of a 2000-word target → ~1000 each; the sum lands on
    // the whole target regardless of how many chunks it took.
    expect(proportionalChunkTarget(2000, 5000, 10000)).toBe(1000)
    // A 30% chunk gets 30% of the target.
    expect(proportionalChunkTarget(2000, 3000, 10000)).toBe(600)
  })

  it('three uneven chunks sum back to (approximately) the whole target', () => {
    const total = 12000
    const chunks = [6000, 4000, 2000]
    const sum = chunks.reduce((s, c) => s + (proportionalChunkTarget(2000, c, total) ?? 0), 0)
    expect(sum).toBe(2000)
  })

  it('returns the target unchanged when there is no target or zero total', () => {
    expect(proportionalChunkTarget(undefined, 5000, 10000)).toBeUndefined()
    expect(proportionalChunkTarget(0, 5000, 10000)).toBe(0)
    expect(proportionalChunkTarget(2000, 5000, 0)).toBe(2000)
  })

  it('never returns 0 for a non-empty target on a tiny chunk', () => {
    expect(proportionalChunkTarget(2000, 1, 1_000_000)).toBe(1)
  })
})

describe('estimateChronicleWords', () => {
  it('returns 0 for an empty or negative transcript', () => {
    expect(estimateChronicleWords(0)).toBe(0)
    expect(estimateChronicleWords(-100)).toBe(0)
  })

  it('scales by the calibrated ratio and rounds', () => {
    expect(estimateChronicleWords(10_000)).toBe(4_000)
    expect(estimateChronicleWords(28_657)).toBe(Math.round(28_657 * CHRONICLE_TO_TRANSCRIPT_WORD_RATIO))
  })

  it('estimates well under the transcript it came from', () => {
    // The bug this replaces assumed 1:1, which overstated the Condense
    // Slider's preview by roughly 2.5x. Guard the direction, not just the
    // arithmetic — a future recalibration may move the constant, but a
    // chronicle is never as long as the transcript behind it.
    expect(CHRONICLE_TO_TRANSCRIPT_WORD_RATIO).toBeGreaterThan(0)
    expect(CHRONICLE_TO_TRANSCRIPT_WORD_RATIO).toBeLessThan(1)
    expect(estimateChronicleWords(30_000)).toBeLessThan(30_000)
  })

  it('lands inside the range measured across real completed runs', () => {
    // Observed chronicle:transcript word ratios spanned 0.22-0.78 over
    // sixteen finished sessions. A constant outside that band would be
    // calibrated against something other than real output.
    expect(CHRONICLE_TO_TRANSCRIPT_WORD_RATIO).toBeGreaterThanOrEqual(0.22)
    expect(CHRONICLE_TO_TRANSCRIPT_WORD_RATIO).toBeLessThanOrEqual(0.78)
  })

  it('feeds computeCondenseTarget to give a plausible slider preview', () => {
    // A ~29k-word grounded transcript at the default 20% slider position.
    // Real runs of that size produced condensed narratives around 1,000-1,600
    // words; the old 1:1 basis previewed ~5,800.
    const preview = computeCondenseTarget(estimateChronicleWords(29_000), 20)
    expect(preview).toBeGreaterThan(1_000)
    expect(preview).toBeLessThan(3_000)
  })
})
