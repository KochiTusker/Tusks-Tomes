import { describe, expect, it } from 'vitest'
import {
  detectRefusal,
  looksLikeRefusal,
  buildRefusalMarker,
  parseRefusalMarkers,
  genRefusalId,
} from './refusalDetection'

describe('detectRefusal', () => {
  it('flags empty / whitespace output', () => {
    expect(detectRefusal('')).toEqual({ refused: true, reason: 'empty' })
    expect(detectRefusal('   \n\t ')).toEqual({ refused: true, reason: 'empty' })
  })

  it('flags a short output that leads with a refusal phrase', () => {
    expect(detectRefusal("I can't help with that request.").reason).toBe('refusal_phrase')
    expect(detectRefusal("I'm sorry, but I can't continue this.").refused).toBe(true)
    expect(detectRefusal('I cannot create this content as it violates policy.').refused).toBe(true)
  })

  it('does NOT flag a long chronicle that merely quotes "I can\'t" in dialogue', () => {
    const prose =
      'The hall fell silent. ' .repeat(60) +
      '"I can\'t believe you did that," Anwen muttered, wiping blood from the blade. ' +
      'The chronicle continued for many more paragraphs. '.repeat(60)
    expect(looksLikeRefusal(prose)).toBe(false)
  })

  it('does NOT flag normal grounded output', () => {
    expect(looksLikeRefusal('Anwen: We march at dawn, you bastards.')).toBe(false)
  })

  it('flags near-empty output for a large input', () => {
    expect(detectRefusal('ok', 20_000).reason).toBe('suspiciously_short')
  })

  it('does NOT flag a proportionate output for a large input', () => {
    const out = 'Substantial grounded text. '.repeat(100) // ~2.7k chars
    expect(looksLikeRefusal(out, 20_000)).toBe(false)
  })
})

describe('refusal markers', () => {
  it('builds a marker carrying a visible banner + hidden tag with the id', () => {
    const marker = buildRefusalMarker('phase3_chronicle', 4, 13, 'abc-123')
    expect(marker).toContain('Chronicle, chunk 5/13') // 1-based, human label
    expect(marker).toContain('<!--TUSKS-REFUSAL:abc-123-->')
    expect(marker).toContain('Review & Repair Refusals')
  })

  it('round-trips the id through parseRefusalMarkers', () => {
    const id = 'r-xyz-001'
    const doc =
      'Some prose before.\n\n' +
      buildRefusalMarker('phase1_ground', 0, 3, id) +
      '\nMore prose after.'
    expect(parseRefusalMarkers(doc)).toEqual([id])
  })

  it('collects every marker id in order, and returns [] when none present', () => {
    const doc =
      buildRefusalMarker('phase3_chronicle', 1, 9, 'id-A') +
      buildRefusalMarker('phase3_chronicle', 5, 9, 'id-B')
    expect(parseRefusalMarkers(doc)).toEqual(['id-A', 'id-B'])
    expect(parseRefusalMarkers('a perfectly normal chronicle with no refusals')).toEqual([])
  })

  it('falls back to the raw phase id when the label is unknown', () => {
    expect(buildRefusalMarker('phase9_unknown', 0, 1, 'z')).toContain('phase9_unknown, chunk 1/1')
  })

  it('genRefusalId returns distinct non-empty ids', () => {
    const a = genRefusalId()
    const b = genRefusalId()
    expect(a).toBeTruthy()
    expect(b).toBeTruthy()
    expect(a).not.toBe(b)
  })
})
