import { describe, expect, it } from 'vitest'
import { parseExtras } from './restorePass'

describe('parseExtras', () => {
  it('parses a well-formed extras object embedded in surrounding text', () => {
    const raw =
      'Here is the JSON:\n{"jests":["a joke"],"gore":["a beheading"],"quotes":[{"speaker":"Anwen","line":"die"}]}\nDone.'
    expect(parseExtras(raw)).toEqual({
      jests: ['a joke'],
      gore: ['a beheading'],
      quotes: [{ speaker: 'Anwen', line: 'die', kind: 'funny' }],
    })
  })

  it('defaults missing arrays and drops malformed quotes', () => {
    const raw = '{"gore":["blood"],"quotes":[{"speaker":"X"},{"speaker":"Y","line":"ok"}]}'
    expect(parseExtras(raw)).toEqual({
      jests: [],
      gore: ['blood'],
      quotes: [{ speaker: 'Y', line: 'ok', kind: 'funny' }],
    })
  })

  it('returns null when there is no JSON object', () => {
    expect(parseExtras('no json here')).toBeNull()
    expect(parseExtras('{ not valid json')).toBeNull()
  })
})
