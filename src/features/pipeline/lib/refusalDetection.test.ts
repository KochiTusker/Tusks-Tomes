import { describe, expect, it } from 'vitest'
import {
  detectRefusal,
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

  it('flags near-empty output for a large input', () => {
    expect(detectRefusal('ok', 20_000).reason).toBe('suspiciously_short')
  })
})

describe('detectRefusal — JSON-output phases', () => {
  // An audit chunk's prompt carries raw + grounded transcript (~40k chars);
  // its answer is a handful of questions, or none.
  const AUDIT_INPUT = 40_000
  const QUESTIONS = JSON.stringify([
    { id: 'q-1-1', question: 'What came up on the reward wheel at the start of the session?' },
  ])

  it('accepts a short valid question array from a large prompt', () => {
    expect(QUESTIONS.length).toBeLessThan(AUDIT_INPUT * 0.02) // the length rule alone would flag it
    expect(detectRefusal(QUESTIONS, AUDIT_INPUT, { expectJson: '[' })).toEqual({ refused: false })
  })

  it('accepts an empty array — nothing to ask is a valid answer', () => {
    expect(detectRefusal('[]', AUDIT_INPUT, { expectJson: '[' })).toEqual({ refused: false })
    expect(detectRefusal('```json\n[]\n```', AUDIT_INPUT, { expectJson: '[' }).refused).toBe(false)
  })

  it('still flags a refusal written in front of the JSON', () => {
    expect(detectRefusal("I can't help with that. []", AUDIT_INPUT, { expectJson: '[' })).toEqual({
      refused: true,
      reason: 'refusal_phrase',
    })
  })

  it('still flags prose refusals and empty output', () => {
    expect(detectRefusal("I'm unable to assist with this.", AUDIT_INPUT, { expectJson: '[' }).reason).toBe('refusal_phrase')
    expect(detectRefusal('  ', AUDIT_INPUT, { expectJson: '[' }).reason).toBe('empty')
  })

  it('keeps the length rule for output that is not the requested JSON', () => {
    expect(detectRefusal('ok', AUDIT_INPUT, { expectJson: '[' }).reason).toBe('suspiciously_short')
    expect(detectRefusal('{"a":1}', AUDIT_INPUT, { expectJson: '[' }).reason).toBe('suspiciously_short')
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
