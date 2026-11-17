import { describe, expect, it } from 'vitest'
import { formatAbsolute, formatAgo, isStale } from './relativeTime'

const NOW = Date.parse('2026-06-15T12:00:00Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

describe('formatAgo', () => {
  it('says never for missing, invalid and epoch values', () => {
    expect(formatAgo(null, NOW)).toBe('never')
    expect(formatAgo(undefined, NOW)).toBe('never')
    expect(formatAgo('', NOW)).toBe('never')
    expect(formatAgo('not a date', NOW)).toBe('never')
    expect(formatAgo(new Date(0).toISOString(), NOW)).toBe('never')
  })
  it('says just now under a minute and for future times', () => {
    expect(formatAgo(ago(30_000), NOW)).toBe('just now')
    expect(formatAgo(ago(-5 * HOUR), NOW)).toBe('just now')
  })
  it('counts minutes, hours and days', () => {
    expect(formatAgo(ago(5 * MIN), NOW)).toBe('5 min ago')
    expect(formatAgo(ago(3 * HOUR + 10 * MIN), NOW)).toBe('3 h ago')
    expect(formatAgo(ago(26 * DAY), NOW)).toBe('26 days ago')
  })
  it('uses the singular for one day', () => {
    expect(formatAgo(ago(DAY + HOUR), NOW)).toBe('1 day ago')
  })
})

describe('isStale', () => {
  it('flags only times older than the limit', () => {
    expect(isStale(ago(8 * DAY), NOW)).toBe(true)
    expect(isStale(ago(6 * DAY), NOW)).toBe(false)
    expect(isStale(ago(2 * DAY), NOW, DAY)).toBe(true)
  })
  it('does not call a missing time stale', () => {
    expect(isStale(null, NOW)).toBe(false)
    expect(isStale(new Date(0).toISOString(), NOW)).toBe(false)
  })
})

describe('formatAbsolute', () => {
  it('is empty without a real time', () => {
    expect(formatAbsolute(null)).toBe('')
    expect(formatAbsolute(new Date(0).toISOString())).toBe('')
    expect(formatAbsolute(ago(DAY))).not.toBe('')
  })
})
