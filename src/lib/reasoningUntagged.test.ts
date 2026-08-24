// Untagged reasoning stripping.
//
// The tag-based stripper only removes <think>-style blocks. Two models probed
// on 2026-08-18 wrote their deliberation as ordinary prose with no tag at all
// and returned ~12x the expected length. Nothing downstream caught it, so it
// would have landed in the chronicle.
//
// The bias throughout is toward NOT cutting: a visible preamble is a bug
// someone reports, a wrongly-truncated chronicle is one nobody notices.

import { describe, expect, it } from 'vitest'
import { stripAllReasoning, stripUntaggedReasoning } from './reasoning'

const GROUNDED = '[Kaziel] He pushed the door open.\n[Brugo] Blood everywhere.'

describe('stripUntaggedReasoning', () => {
  it('leaves ordinary output completely alone', () => {
    const r = stripUntaggedReasoning(GROUNDED, { expectedShape: 'speaker-tagged' })
    expect(r.stripped).toBe(false)
    expect(r.text).toBe(GROUNDED)
  })

  it('cuts a "Here\'s a thinking process" preamble at the speaker tag', () => {
    // The exact opener one probed model produced.
    const input = `Here's a thinking process:\n\n1. Analyse the request.\n2. Apply the glossary.\n\n${GROUNDED}`
    const r = stripUntaggedReasoning(input, { expectedShape: 'speaker-tagged' })
    expect(r.stripped).toBe(true)
    expect(r.text).toBe(GROUNDED)
  })

  it('cuts a "We need to correct..." preamble', () => {
    // The other probed model's opener.
    const input = `We need to correct misheard proper nouns using canonical names.\n\n${GROUNDED}`
    const r = stripUntaggedReasoning(input, { expectedShape: 'speaker-tagged' })
    expect(r.stripped).toBe(true)
    expect(r.text).toBe(GROUNDED)
  })

  it('prefers an explicit answer marker over shape-matching', () => {
    const input = `Let me think through this carefully.\n\nFinal answer:\n${GROUNDED}`
    const r = stripUntaggedReasoning(input, { expectedShape: 'speaker-tagged' })
    expect(r.stripped).toBe(true)
    expect(r.text).toBe(GROUNDED)
  })

  it('cuts to the opening bracket for JSON phases', () => {
    const input = 'We need to find clarification questions.\n\n[{"question":"a","why":"b"}]'
    const r = stripUntaggedReasoning(input, { expectedShape: 'json' })
    expect(r.stripped).toBe(true)
    expect(JSON.parse(r.text)).toHaveLength(1)
  })

  it('does NOT cut when a preamble is recognised but no safe boundary exists', () => {
    // Nothing here looks like the real output, so cutting would be guessing.
    // Returning it whole surfaces the problem instead of hiding it.
    const input = 'We need to think about this. There is no actual output here.'
    const r = stripUntaggedReasoning(input, { expectedShape: 'speaker-tagged' })
    expect(r.stripped).toBe(false)
    expect(r.text).toBe(input)
  })

  it('does not mistake prose that merely starts with a similar phrase', () => {
    // A chronicle could legitimately open this way. It is not a preamble.
    const prose = 'Let me tell you of the night the Crimson Cathedral opened its doors.'
    expect(stripUntaggedReasoning(prose).stripped).toBe(false)
  })

  it('never cuts when the text already looks like the answer', () => {
    const r = stripUntaggedReasoning(`${GROUNDED}\n[Rey] And then we left.`, {
      expectedShape: 'speaker-tagged',
    })
    expect(r.stripped).toBe(false)
  })

  it('handles empty and whitespace-only input', () => {
    expect(stripUntaggedReasoning('').text).toBe('')
    expect(stripUntaggedReasoning('   \n  ').text).toBe('')
  })
})

describe('stripAllReasoning', () => {
  it('removes a tagged block and an untagged preamble together', () => {
    const input = `<think>internal</think>\nHere's a thinking process:\n1. do it\n\n${GROUNDED}`
    const r = stripAllReasoning(input, { expectedShape: 'speaker-tagged' })
    expect(r.text).toBe(GROUNDED)
    expect(r.stripped).toBe(true)
  })

  it('removes a tagged block alone without reporting an untagged strip', () => {
    const r = stripAllReasoning(`<think>internal</think>\n${GROUNDED}`, {
      expectedShape: 'speaker-tagged',
    })
    expect(r.text).toBe(GROUNDED)
    expect(r.stripped).toBe(false)
  })

  it('leaves clean output untouched', () => {
    const r = stripAllReasoning(GROUNDED, { expectedShape: 'speaker-tagged' })
    expect(r.text).toBe(GROUNDED)
    expect(r.stripped).toBe(false)
  })
})
