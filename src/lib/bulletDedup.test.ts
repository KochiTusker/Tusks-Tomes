import { describe, expect, it } from 'vitest'
import { BULLET_DEDUP_SIMILARITY, dedupeBullets } from './bulletDedup'

describe('dedupeBullets', () => {
  it('returns a copy of the input when no duplicates are present', () => {
    const input = [
      'The party reached Thornholt at dusk.',
      'A guard in silver-and-grey livery challenged them at the gate.',
      'Bilal rolled Insight and learned the guard had been on duty since dawn.',
    ]
    expect(dedupeBullets(input)).toEqual(input)
  })

  it('drops exact duplicates after whitespace normalisation', () => {
    const input = [
      'The party reached Thornholt at dusk.',
      'The party  reached  Thornholt  at dusk.',
      'A guard challenged them at the gate.',
    ]
    expect(dedupeBullets(input)).toEqual([
      'The party reached Thornholt at dusk.',
      'A guard challenged them at the gate.',
    ])
  })

  it('drops case-different duplicates', () => {
    const input = [
      'The party reached Thornholt at dusk.',
      'the party reached thornholt at dusk.',
    ]
    expect(dedupeBullets(input)).toHaveLength(1)
  })

  it('drops trailing-punctuation-only differences', () => {
    const input = [
      'The party reached Thornholt at dusk',
      'The party reached Thornholt at dusk.',
      'The party reached Thornholt at dusk!',
    ]
    expect(dedupeBullets(input)).toHaveLength(1)
  })

  it('drops paraphrase duplicates (Levenshtein >= 80% similarity)', () => {
    const input = [
      'The party reached Thornholt at dusk as the sun bled out.',
      'The party reached Thornholt at dusk as the sun set red.',
    ]
    expect(dedupeBullets(input)).toHaveLength(1)
  })

  it('keeps semantically-different bullets that share a few words', () => {
    const input = [
      'The party reached Thornholt at dusk.',
      'The party left Thornholt at dawn the following day.',
    ]
    // ~50% similar — different events, even though both name Thornholt + party.
    expect(dedupeBullets(input)).toHaveLength(2)
  })

  it('preserves the FIRST occurrence in a duplicate cluster (chronological order)', () => {
    const input = [
      'A: The party reached Thornholt at dusk.',
      'B: The party reached Thornholt at dusk.',
    ]
    const out = dedupeBullets(input)
    expect(out).toEqual(['A: The party reached Thornholt at dusk.'])
  })

  it('handles empty + whitespace-only entries gracefully', () => {
    const input = ['', '   ', 'real bullet', '\t\n']
    expect(dedupeBullets(input)).toEqual(['real bullet'])
  })

  it('handles a single-element input', () => {
    expect(dedupeBullets(['only one'])).toEqual(['only one'])
  })

  it('handles empty input', () => {
    expect(dedupeBullets([])).toEqual([])
  })

  it('similarity threshold is publicly exported for downstream tuning', () => {
    expect(BULLET_DEDUP_SIMILARITY).toBe(0.8)
  })

  it('dedupes a realistic boundary-event cluster from two adjacent chunks', () => {
    // Simulates what runPhase6 produces when chunk N+1 starts with the same
    // event chunk N ended on. The phrasing is close enough that 80%
    // similarity catches it. Hard paraphrases (50% similar) are not the
    // dedup target — those need semantic-embedding deduplication which is
    // out of scope; we accept that the rare deep paraphrase slips through.
    const input = [
      // Chunk 1 bullets
      'The party met Chidi at the Silver Lantern.',
      'Niamh recognised the cadence of the captive as a Pact of Mor ritual.',
      // Chunk 2 boundary repeat — small phrasing drift, same event
      'Niamh recognised the cadence of the captive as a Pact of Mor rite.',
      'Mira agreed to help interrogate the surviving thug.',
    ]
    const out = dedupeBullets(input)
    expect(out).toHaveLength(3)
    expect(out[0]).toMatch(/Chidi/)
    expect(out[1]).toMatch(/recognised the cadence/)
    expect(out[2]).toMatch(/Mira/)
  })
})
