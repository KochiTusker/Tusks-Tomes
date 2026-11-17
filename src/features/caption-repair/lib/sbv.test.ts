import { describe, it, expect } from 'vitest'
import { parseSbv, formatSbv } from './sbv'

describe('formatSbv', () => {
  it('returns a single newline for an empty cues array', () => {
    expect(formatSbv([])).toBe('\n')
  })

  it('serializes a single cue with no blank-line separator', () => {
    const cues = [{ startStr: '0:00:01.000', endStr: '0:00:04.000', startMs: 1000, endMs: 4000, text: 'Hello world' }]
    expect(formatSbv(cues)).toBe('0:00:01.000,0:00:04.000\nHello world\n')
  })

  it('separates multiple cues with a single blank line', () => {
    const cues = [
      { startStr: '0:00:00.000', endStr: '0:00:02.000', startMs: 0, endMs: 2000, text: 'First' },
      { startStr: '0:00:02.500', endStr: '0:00:05.000', startMs: 2500, endMs: 5000, text: 'Second' },
    ]
    expect(formatSbv(cues)).toBe(
      '0:00:00.000,0:00:02.000\nFirst\n\n0:00:02.500,0:00:05.000\nSecond\n'
    )
  })

  it('preserves original timestamp strings verbatim', () => {
    const cues = [{ startStr: '1:23:45.678', endStr: '1:23:48.000', startMs: 0, endMs: 0, text: 'x' }]
    expect(formatSbv(cues)).toContain('1:23:45.678,1:23:48.000')
  })

  it('round-trips through parseSbv without data loss', () => {
    const raw = [
      '0:00:00.000,0:00:02.000',
      'First line',
      '',
      '0:00:02.500,0:00:05.000',
      'Second line',
      '',
    ].join('\n')

    const cues = parseSbv(raw)
    const serialized = formatSbv(cues)
    const reparsed = parseSbv(serialized)

    expect(reparsed).toHaveLength(cues.length)
    reparsed.forEach((c, i) => {
      expect(c.startMs).toBe(cues[i].startMs)
      expect(c.endMs).toBe(cues[i].endMs)
      expect(c.text).toBe(cues[i].text)
    })
  })
})
