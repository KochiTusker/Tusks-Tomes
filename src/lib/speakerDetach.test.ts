import { describe, expect, it } from 'vitest'
import { detachSpeakers, reattachSpeakers } from './speakerDetach'

describe('detachSpeakers', () => {
  it('replaces every bracketed speaker line with a numbered marker', () => {
    const input = [
      '[Dungeon Master (DM)] So the orc charges at you.',
      '[Lakshmi (Olamide)] I dodge and counter.',
      '[Dungeon Master (DM)] Roll d20.',
    ].join('\n')
    const result = detachSpeakers(input)
    expect(result.attached).toBe(true)
    expect(result.stripped.split('\n')).toEqual([
      '«1» So the orc charges at you.',
      '«2» I dodge and counter.',
      '«3» Roll d20.',
    ])
    expect(result.speakersByMarker.get(1)).toBe('[Dungeon Master (DM)]')
    expect(result.speakersByMarker.get(2)).toBe('[Lakshmi (Olamide)]')
    expect(result.speakersByMarker.get(3)).toBe('[Dungeon Master (DM)]')
  })

  it('passes mixed bracketed / plain lines through with markers only on the bracketed ones', () => {
    const input = [
      '[Dungeon Master (DM)] You enter the cave.',
      '(scene break — the party rests)',
      '[Lakshmi (Olamide)] How long until dawn?',
    ].join('\n')
    const result = detachSpeakers(input)
    expect(result.attached).toBe(true)
    expect(result.stripped.split('\n')).toEqual([
      '«1» You enter the cave.',
      '(scene break — the party rests)',
      '«3» How long until dawn?',
    ])
    // Line 2 had no bracket → no entry in the map.
    expect(result.speakersByMarker.has(2)).toBe(false)
    expect(result.speakersByMarker.get(1)).toBe('[Dungeon Master (DM)]')
    expect(result.speakersByMarker.get(3)).toBe('[Lakshmi (Olamide)]')
  })

  it('returns attached=false and the input verbatim when no line has a bracket', () => {
    const input = 'A plain-text transcript pasted into Refinement.\nNo brackets here.'
    const result = detachSpeakers(input)
    expect(result.attached).toBe(false)
    expect(result.stripped).toBe(input)
    expect(result.speakersByMarker.size).toBe(0)
  })

  it('handles the empty-input edge case', () => {
    const result = detachSpeakers('')
    expect(result.attached).toBe(false)
    expect(result.stripped).toBe('')
  })

  it('tolerates content brackets in dialogue body (only the leading bracket is the speaker)', () => {
    const input = '[Lakshmi (Olamide)] I cast [Fireball] at the dragon.'
    const result = detachSpeakers(input)
    expect(result.attached).toBe(true)
    expect(result.stripped).toBe('«1» I cast [Fireball] at the dragon.')
    expect(result.speakersByMarker.get(1)).toBe('[Lakshmi (Olamide)]')
  })

  it('does not match a bracketed line that has no body after the bracket', () => {
    // Brackets without subsequent text (e.g. a [Music] marker line that
    // somehow survived cleanup) don't match because the regex requires
    // whitespace + at least one body character.
    const input = '[Music]'
    const result = detachSpeakers(input)
    expect(result.attached).toBe(false)
  })
})

describe('reattachSpeakers', () => {
  it('round-trips a clean detach (model preserved every marker exactly)', () => {
    const input = [
      '[Dungeon Master (DM)] So the orc charges at you.',
      '[Lakshmi (Olamide)] I dodge and counter.',
    ].join('\n')
    const detached = detachSpeakers(input)
    // Simulate a grounding pass that left markers + bodies as-is.
    const grounded = detached.stripped
    const result = reattachSpeakers(grounded, detached)
    expect(result.transcript).toBe(input)
    expect(result.dropoutRate).toBe(0)
  })

  it('round-trips when the grounder corrected the body text but kept the markers', () => {
    const input = [
      '[Dungeon Master (DM)] So the ork chargess at you.',
      '[Lakshmi (Olamide)] I dogde and conter.',
    ].join('\n')
    const detached = detachSpeakers(input)
    // Pretend the grounder fixed the typos in the bodies.
    const grounded = [
      '«1» So the orc charges at you.',
      '«2» I dodge and counter.',
    ].join('\n')
    const result = reattachSpeakers(grounded, detached)
    expect(result.transcript).toBe(
      '[Dungeon Master (DM)] So the orc charges at you.\n' +
        '[Lakshmi (Olamide)] I dodge and counter.',
    )
    expect(result.dropoutRate).toBe(0)
  })

  it('reports dropout when the model dropped a marker (line passes through unbracketed)', () => {
    const input = [
      '[Dungeon Master (DM)] Line one.',
      '[Lakshmi (Olamide)] Line two.',
      '[Dungeon Master (DM)] Line three.',
    ].join('\n')
    const detached = detachSpeakers(input)
    // Model dropped the marker on line 2.
    const grounded = [
      '«1» Line one.',
      'Line two.',
      '«3» Line three.',
    ].join('\n')
    const result = reattachSpeakers(grounded, detached)
    const lines = result.transcript.split('\n')
    expect(lines[0]).toBe('[Dungeon Master (DM)] Line one.')
    expect(lines[1]).toBe('Line two.') // dropped marker → no bracket
    expect(lines[2]).toBe('[Dungeon Master (DM)] Line three.')
    // 1 of 3 source lines dropped → 1/3.
    expect(result.dropoutRate).toBeCloseTo(1 / 3, 5)
  })

  it('handles a model that split a line (extra unbracketed lines pass through, original marker still found)', () => {
    const input = [
      '[Dungeon Master (DM)] The dragon roars and breathes fire.',
    ].join('\n')
    const detached = detachSpeakers(input)
    // Model split into two lines, keeping marker on the first half.
    const grounded = [
      '«1» The dragon roars',
      'and breathes fire.',
    ].join('\n')
    const result = reattachSpeakers(grounded, detached)
    expect(result.transcript).toBe(
      '[Dungeon Master (DM)] The dragon roars\nand breathes fire.',
    )
    // The one source line was matched (marker preserved) → 0 dropout.
    expect(result.dropoutRate).toBe(0)
  })

  it('discards markers that reference unknown indices (model invented one)', () => {
    const input = ['[Dungeon Master (DM)] Original line.'].join('\n')
    const detached = detachSpeakers(input)
    // Model emitted «42» — there's no entry for 42 in the map.
    const grounded = ['«1» Original line.', '«42» Hallucinated line.'].join('\n')
    const result = reattachSpeakers(grounded, detached)
    expect(result.transcript.split('\n')).toEqual([
      '[Dungeon Master (DM)] Original line.',
      'Hallucinated line.', // marker stripped, body kept
    ])
  })

  it('attached=false is a complete pass-through (no marker parsing)', () => {
    const detached = detachSpeakers('plain text with «1» literal marker glyphs')
    expect(detached.attached).toBe(false)
    const result = reattachSpeakers('grounded plain text', detached)
    expect(result.transcript).toBe('grounded plain text')
    expect(result.dropoutRate).toBe(0)
  })

  it('zero dropout on an empty source map (numerator and denominator both 0)', () => {
    const detached = { stripped: '', speakersByMarker: new Map(), attached: true }
    const result = reattachSpeakers('', detached)
    expect(result.dropoutRate).toBe(0)
  })
})
