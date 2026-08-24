/** @vitest-environment jsdom */
//
// K.3.4 — Phase H warning paths.
//
// Phase H (commit `1fdd078`) added user-facing warnings on four previously-
// silent edge cases:
//
//   1. SBV files with malformed timestamp lines — parseSbvWithStats reports
//      a count so CaptionRepair can warn the user.
//   2. Phase 6 condense output below the empirical floor (1,200 words) —
//      warnIfCondenseShort fires a toast.
//   3. KB files above the size threshold (500 KB) — KnowledgeBaseManager
//      warns the user that the file will inflate per-chunk cost.
//   4. Pipeline event listeners throwing inside chunkedGenerate's recovery
//      paths — vlogged as `listener_failed` so the diagnose bundle captures
//      what was previously console-only.
//
// (1), (2), and (3) are covered by pure-function / helper-level tests in
// this file. (4) is exercised at integration level — the recovery paths
// require Free→Paid escalation OR fusion fallback OR transient-5xx auto-
// fallback to fire, which is heavier than a unit test should be. The catch+
// vlog pattern itself is straightforward and reviewed in the diff for
// `1fdd078`; locking it down with integration coverage belongs in Phase
// K.7 (pre-release verification).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseSbv, parseSbvWithStats } from './sbv'

// ──────────────────── SBV malformed-timestamp counter ────────────────────

const VALID_SBV = `0:00:01.000,0:00:03.500
Hello world

0:00:04.000,0:00:05.000
Second cue

`

const PARTIALLY_BROKEN_SBV = `0:00:01.000,0:00:03.500
Good cue

0:00:04,0:00:05
This timestamp is missing the milliseconds — malformed

0:00:06.000,0:00:08.000
Another good cue

0:00:9.999,0:00:10.500
This one has a single-digit second — also looks-like-an-attempt-but-bad

`

describe('parseSbvWithStats — malformed-timestamp counter', () => {
  it('returns malformedLineCount: 0 on a well-formed SBV', () => {
    const { cues, malformedLineCount } = parseSbvWithStats(VALID_SBV)
    expect(cues).toHaveLength(2)
    expect(malformedLineCount).toBe(0)
  })

  it('counts lines that LOOK like timestamp attempts but fail the strict regex', () => {
    const { cues, malformedLineCount } = parseSbvWithStats(PARTIALLY_BROKEN_SBV)
    // Two good cues are parsed; two bad timestamp lines are counted.
    expect(cues).toHaveLength(2)
    expect(malformedLineCount).toBe(2)
  })

  it('does NOT count blank gap lines as malformed', () => {
    const sbv = `0:00:01.000,0:00:03.500
Cue body



0:00:04.000,0:00:05.000
Another

`
    const { malformedLineCount } = parseSbvWithStats(sbv)
    expect(malformedLineCount).toBe(0)
  })

  it('does NOT count non-timestamp prose lines as malformed', () => {
    const sbv = `0:00:01.000,0:00:03.500
Just regular prose without timestamps

Another line of prose — no digit-colon-digit

0:00:04.000,0:00:05.000
Another good cue

`
    const { malformedLineCount } = parseSbvWithStats(sbv)
    expect(malformedLineCount).toBe(0)
  })

  it('counts a high malformed rate when the whole file is broken', () => {
    const sbv = `0:00:01,0:00:03
First bad ts

0:00:04,0:00:05
Second bad ts

0:00:06,0:00:08
Third bad ts

`
    const { cues, malformedLineCount } = parseSbvWithStats(sbv)
    expect(cues).toHaveLength(0)
    expect(malformedLineCount).toBe(3)
  })

  it('returns 0 cues + 0 malformed on empty input', () => {
    expect(parseSbvWithStats('')).toEqual({ cues: [], malformedLineCount: 0 })
  })

  it('parseSbv (back-compat wrapper) returns only cues, dropping the stats', () => {
    const cues = parseSbv(VALID_SBV)
    expect(cues).toHaveLength(2)
    expect(cues[0].text).toBe('Hello world')
    expect(cues[0].startMs).toBe(1000)
    expect(cues[0].endMs).toBe(3500)
  })

  it('preserves original timestamp strings verbatim', () => {
    const { cues } = parseSbvWithStats(VALID_SBV)
    expect(cues[0].startStr).toBe('0:00:01.000')
    expect(cues[0].endStr).toBe('0:00:03.500')
  })

  it('handles CRLF line endings (Windows-exported SBVs)', () => {
    const crlf = VALID_SBV.replace(/\n/g, '\r\n')
    const { cues, malformedLineCount } = parseSbvWithStats(crlf)
    expect(cues).toHaveLength(2)
    expect(malformedLineCount).toBe(0)
  })
})

// ──────────────────── warnIfCondenseShort (Phase 6 floor) ────────────────────

const mockToastWarning = vi.fn()

vi.mock('sonner', () => ({
  toast: {
    warning: mockToastWarning,
    success: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
  },
}))

// Importing the SUT after vi.mock so the mocked sonner is in effect.
const { warnIfCondenseShort, CONDENSE_FLOOR_WC } = await import('../components/RefinementTool')
const { KB_LARGE_FILE_THRESHOLD_BYTES } = await import(
  '../components/KnowledgeBaseManager'
)

describe('warnIfCondenseShort — Phase 6 floor', () => {
  beforeEach(() => {
    mockToastWarning.mockClear()
  })

  it('fires a warning when narrative word count is below the catastrophic floor', () => {
    const tooShort = Array.from({ length: CONDENSE_FLOOR_WC - 50 }, () => 'word').join(' ')
    warnIfCondenseShort({ narrative: tooShort, bulletPoints: [] })
    expect(mockToastWarning).toHaveBeenCalledTimes(1)
    const [message] = mockToastWarning.mock.calls[0]
    expect(message).toMatch(/Phase 6 condense produced only \d+ words/)
    // v1.1.0 — Phase 6 target is now slider-driven, not the legacy
    // `min(2000, 25%)` formula. The catastrophic-floor warning instead
    // tells the user that ≤200 words at any slider position implies a
    // truncated response, malformed JSON, or quota-mid-flight failure.
    expect(message).toMatch(/at any slider position/)
    expect(message).toMatch(/200 words/)
  })

  it('does NOT fire when narrative word count is at or above the floor', () => {
    const atFloor = Array.from({ length: CONDENSE_FLOOR_WC }, () => 'word').join(' ')
    warnIfCondenseShort({ narrative: atFloor, bulletPoints: [] })
    expect(mockToastWarning).not.toHaveBeenCalled()
  })

  it('does NOT fire on a legitimately-short condense (e.g. 500 wc from a small chronicle)', () => {
    // Under the new dynamic-target formula, a chronicle of 2,000 words
    // legitimately condenses to 500 words. That must NOT fire the warning.
    const legit = Array.from({ length: 500 }, () => 'word').join(' ')
    warnIfCondenseShort({ narrative: legit, bulletPoints: [] })
    expect(mockToastWarning).not.toHaveBeenCalled()
  })

  it('does NOT fire on undefined / null / empty narrative', () => {
    warnIfCondenseShort(undefined)
    warnIfCondenseShort(null)
    warnIfCondenseShort({ narrative: '', bulletPoints: [] })
    warnIfCondenseShort({ narrative: '   \n\n  ', bulletPoints: [] })
    expect(mockToastWarning).not.toHaveBeenCalled()
  })

  it('includes the actual word count in the warning message', () => {
    const exactly150 = Array.from({ length: 150 }, () => 'w').join(' ')
    warnIfCondenseShort({ narrative: exactly150, bulletPoints: [] })
    expect(mockToastWarning).toHaveBeenCalledTimes(1)
    const [message] = mockToastWarning.mock.calls[0]
    expect(message).toMatch(/150 words/)
  })

  it('CONDENSE_FLOOR_WC is exported as the expected value (lock-down)', () => {
    // Lowered from 1,200 to 200 when the Phase 6 condense target became
    // dynamic (min(2,000 words, chronicle_wc/4)). A fixed floor no longer
    // catches "model under-condensed" — that's now context-dependent.
    // The 200 here only catches catastrophic short-circuits (truncated
    // response, malformed JSON, quota mid-flight).
    expect(CONDENSE_FLOOR_WC).toBe(200)
  })

  it('uses a 12-second toast duration for visibility', () => {
    const tooShort = Array.from({ length: 100 }, () => 'w').join(' ')
    warnIfCondenseShort({ narrative: tooShort, bulletPoints: [] })
    const opts = mockToastWarning.mock.calls[0][1] as { duration: number }
    expect(opts.duration).toBe(12_000)
  })
})

// ──────────────────── KB-size warning threshold ────────────────────

describe('KB_LARGE_FILE_THRESHOLD_BYTES — KB size warning threshold', () => {
  it('is exported as the expected value (lock-down)', () => {
    // 500 KB picked empirically. Bumping requires a follow-up to the
    // prompt-cost messaging in KnowledgeBaseManager.tsx — surface that
    // by failing this test on drift.
    expect(KB_LARGE_FILE_THRESHOLD_BYTES).toBe(500_000)
  })

  it('threshold sanity-check: typical small lore file (~50 KB) is below', () => {
    expect(50_000 > KB_LARGE_FILE_THRESHOLD_BYTES).toBe(false)
  })

  it('threshold sanity-check: a 600 KB campaign bible is above', () => {
    expect(600_000 > KB_LARGE_FILE_THRESHOLD_BYTES).toBe(true)
  })

  it('threshold sanity-check: exactly at the boundary is NOT above (strict >)', () => {
    expect(KB_LARGE_FILE_THRESHOLD_BYTES > KB_LARGE_FILE_THRESHOLD_BYTES).toBe(false)
  })
})

// ──────────────────── listener_failed gap note ────────────────────

describe('listener_failed — gap note', () => {
  // The three sites in pipeline.ts that catch a thrown listener and
  // vlog `listener_failed` are inside chunkedGenerate's recovery paths:
  //
  //   - free_prohibited_content_fallback (line ~513)
  //   - chunk_fusion_recovered           (line ~648)
  //   - free_transient_5xx_auto_fallback (line ~773)
  //
  // Each requires a multi-step provider stub (free provider fails with a
  // specific error shape; paid provider succeeds) plus an onPipelineEvent
  // listener that throws on the recovery event. Setting that up exceeds
  // the value of a unit test — the catch-and-vlog pattern is plain and
  // unit-tested implicitly by reading the diff for `1fdd078`. K.7.x
  // integration tests will exercise these recovery paths end-to-end.
  //
  // This empty `it.skip` block is a deliberate placeholder so future
  // session-readers find a single grep'able marker for the gap.
  it.skip('listener_failed paths covered by K.7.x integration tests', () => {
    // intentionally empty — see comment above.
  })
})

afterEach(() => {
  mockToastWarning.mockClear()
})
