// Zip Slip defence regression. extractMultitrack.ts iterates the zip
// entries before extraction and rejects any whose resolved target
// escapes the workdir.
//
// adm-zip itself sanitises `../` segments away on addFile() — so a
// proper hostile zip can't be constructed through its public API.
// The runtime defence still matters because the .zip on disk could
// have been crafted by another library (or by hand) with traversal
// entries intact; that's the actual attack scenario.
//
// This test exercises the predicate directly on a synthesised entry
// list rather than crafting a real malicious archive (which would
// require building a zip header by hand).

import { describe, expect, it } from 'vitest'
import path from 'node:path'

// Import the REAL predicate from the production module. Phase 6.3
// closed the copy-paste regression that previously had a stale copy
// here. A future change to extractMultitrack.ts's predicate trips this
// test the same day, not weeks later in a /ship.
import { isEntrySafe } from './extractMultitrack.js'

describe('Zip Slip predicate (workdir containment)', () => {
  const workdir = path.resolve('/tmp/zipslip-fixture')

  // Hostile entry names — must all be rejected.
  const hostile = [
    '../escape.flac',
    '../../escape.flac',
    '../../../etc/passwd',
    '/etc/passwd',
    '/C:/Windows/System32/foo',
    'sub/../../escape.flac',
    'a/../../../../../escape.flac',
  ]
  for (const name of hostile) {
    it(`rejects hostile entry ${JSON.stringify(name)}`, () => {
      expect(isEntrySafe(workdir, name)).toBe(false)
    })
  }

  // Benign entries — must all pass.
  const benign = [
    'a.flac',
    'sub/b.flac',
    'deep/nested/path/c.flac',
    './d.flac',
  ]
  for (const name of benign) {
    it(`accepts benign entry ${JSON.stringify(name)}`, () => {
      expect(isEntrySafe(workdir, name)).toBe(true)
    })
  }
})

// ── Duration probing ────────────────────────────────────────────────────
//
// A chunk's length is max(track durations), and the NEXT batch's start
// offset is the running total of chunk lengths. So a mis-read duration
// doesn't just mislabel one track — it shifts every following part of a
// staged upload down the timeline.
//
// ffmpeg's `Duration:` header is a bitrate estimate for raw streams with
// no container index. The strings below are real ffmpeg output for a
// Craig ADTS .aac track whose measured length is 1h41m23s: the header
// claims 8h19m14s, a 4.9x overshoot.

import { parseHeaderDurationMs, parseLastProgressTimeMs } from './extractMultitrack.js'

const CRAIG_AAC_STDERR = `[aac @ 0000021a664c1980] Estimating duration from bitrate, this may be inaccurate
  Duration: 08:19:14.94, bitrate: 5 kb/s
  Stream #0:0: Audio: aac (LC), 48000 Hz, stereo, fltp, 5 kb/s
size=       0kB time=00:00:00.00 bitrate=N/A speed=N/A
size=N/A time=00:29:21.57 bitrate=N/A speed=3.52e+03x
size=N/A time=01:22:18.81 bitrate=N/A speed=3.29e+03x
size=N/A time=01:41:23.26 bitrate=N/A speed=3.3e+03x`

describe('duration probe parsing', () => {
  it('takes the measured end-of-stream, not the bitrate estimate', () => {
    // 1h41m23.26s — the real length.
    expect(parseLastProgressTimeMs(CRAIG_AAC_STDERR)).toBe(6083260)
  })

  it('would have produced the bogus 8h19m offset from the header alone', () => {
    // Pins the actual regression: this is the value that landed in a real
    // manifest as Part 2's startedAtMs.
    expect(parseHeaderDurationMs(CRAIG_AAC_STDERR)).toBe(29954940)
  })

  it('measured duration is far enough off the estimate to matter', () => {
    const measured = parseLastProgressTimeMs(CRAIG_AAC_STDERR)
    const estimated = parseHeaderDurationMs(CRAIG_AAC_STDERR)
    expect(estimated / measured).toBeGreaterThan(4)
  })

  it('takes the LAST progress line, not the first', () => {
    expect(parseLastProgressTimeMs('time=00:00:01.00\ntime=00:10:00.50')).toBe(600500)
  })

  it('returns 0 when ffmpeg produced no usable output', () => {
    expect(parseLastProgressTimeMs('')).toBe(0)
    expect(parseLastProgressTimeMs('time=N/A')).toBe(0)
    expect(parseHeaderDurationMs('')).toBe(0)
    expect(parseHeaderDurationMs('Duration: N/A, bitrate: N/A')).toBe(0)
  })

  it('handles a duration with no fractional part and multi-hour values', () => {
    expect(parseHeaderDurationMs('Duration: 100:00:00, bitrate: 1 kb/s')).toBe(360000000)
    expect(parseLastProgressTimeMs('time=01:02:03')).toBe(3723000)
  })
})
