// The liveness rules the transcription view depends on, pinned at their
// boundaries: the quiet threshold, the stall budget before and after a
// track has completed, and the clock-skew correction that stops a LAN
// install's server clock from turning a healthy run into a "stalled" one.

import { describe, expect, it } from 'vitest'
import type { LiveSessionResponse } from '@/features/transcription/lib/liveSession'
import {
  QUIET_AFTER_MS,
  STALL_FLOOR_MS,
  audioPercent,
  clockOffsetMs,
  deriveDisplayPhase,
  deviceLabel,
  etaMs,
  formatAudioProgress,
  formatClock,
  formatEta,
  formatRealtime,
  formatTrackLength,
  msSince,
  observedPerTrackMs,
  stallLevel,
  stallThresholdMs,
  trackCounts,
  wholeMinutes,
} from './transcriptionLiveness'

const MIN = 60_000

function oldShape(over: Partial<LiveSessionResponse> = {}): LiveSessionResponse {
  return {
    sessionId: 's1',
    active: false,
    pending: 0,
    processed: 0,
    enqueued: 0,
    cueCount: 0,
    errors: [],
    participants: [],
    sbv: '',
    finalized: false,
    ...over,
  }
}

describe('deriveDisplayPhase', () => {
  it('maps every runState the server can send', () => {
    expect(deriveDisplayPhase(oldShape({ runState: 'loading_model' }))).toBe('loading_model')
    expect(deriveDisplayPhase(oldShape({ runState: 'transcribing' }))).toBe('transcribing')
    expect(deriveDisplayPhase(oldShape({ runState: 'finalising' }))).toBe('finalising')
    expect(deriveDisplayPhase(oldShape({ runState: 'done' }))).toBe('ready')
    expect(deriveDisplayPhase(oldShape({ runState: 'failed' }))).toBe('failed')
    expect(deriveDisplayPhase(oldShape({ runState: 'interrupted' }))).toBe('interrupted')
  })

  it('runState wins over the legacy flags when both are present', () => {
    // A server that has forgotten in-memory state still says done via the snapshot.
    expect(deriveDisplayPhase(oldShape({ runState: 'done', active: true }))).toBe('ready')
    expect(deriveDisplayPhase(oldShape({ runState: 'interrupted', finalized: false }))).toBe(
      'interrupted',
    )
  })

  it('falls back to active/finalized for a payload without runState', () => {
    expect(deriveDisplayPhase(null)).toBe('recording')
    expect(deriveDisplayPhase(oldShape({ active: true }))).toBe('recording')
    expect(deriveDisplayPhase(oldShape({ active: true, enqueued: 3, processed: 1 }))).toBe(
      'transcribing',
    )
    expect(deriveDisplayPhase(oldShape({ active: false, finalized: false }))).toBe('finalising')
    expect(deriveDisplayPhase(oldShape({ active: false, finalized: true }))).toBe('ready')
    expect(deriveDisplayPhase(oldShape({ runState: 'idle', finalized: true }))).toBe('ready')
  })
})

describe('clock skew', () => {
  it('offset is client minus server, and zero when the server sent no clock', () => {
    expect(clockOffsetMs(1_000, 1_300)).toBe(300)
    expect(clockOffsetMs(2_000, 1_300)).toBe(-700)
    expect(clockOffsetMs(undefined, 1_300)).toBe(0)
    expect(clockOffsetMs(null, 1_300)).toBe(0)
  })

  it('msSince places a server timestamp on the client clock before subtracting', () => {
    // Server runs five minutes ahead. An event 30 s ago in server time
    // must read as 30 s ago here, not as "in the future" or "5 min ago".
    const clientNow = 10_000_000
    const receivedAt = clientNow - 2_000
    const serverNow = receivedAt + 5 * MIN
    const lastActivityAt = serverNow - 30_000
    expect(msSince(lastActivityAt, { serverNow, receivedAt, clientNow })).toBe(32_000)
  })

  it('msSince never goes negative and is null without a timestamp', () => {
    const clientNow = 5_000_000
    expect(msSince(clientNow + 60_000, { serverNow: clientNow, receivedAt: clientNow, clientNow })).toBe(0)
    expect(msSince(null, { serverNow: clientNow, receivedAt: clientNow, clientNow })).toBeNull()
    expect(msSince(undefined, { serverNow: clientNow, receivedAt: clientNow, clientNow })).toBeNull()
  })
})

describe('stallLevel', () => {
  const clientNow = 20 * 60 * MIN
  function level(sinceMs: number, budget: Parameters<typeof stallThresholdMs>[0] = {}) {
    // Server and client clocks agree; response landed 1 s ago.
    const receivedAt = clientNow - 1_000
    const serverNow = receivedAt
    return stallLevel({
      lastActivityAt: clientNow - sinceMs,
      serverNow,
      receivedAt,
      clientNow,
      ...budget,
    })
  }

  it('is fresh at 59 s and quiet at 61 s', () => {
    expect(level(59_000)).toBe('fresh')
    expect(level(61_000)).toBe('quiet')
    expect(level(QUIET_AFTER_MS)).toBe('quiet')
  })

  it('before any track has completed, the 10 minute floor is the only budget', () => {
    expect(level(STALL_FLOOR_MS - 1_000, { currentAudioMs: 60 * MIN })).toBe('quiet')
    expect(level(STALL_FLOOR_MS + 1_000, { currentAudioMs: 60 * MIN })).toBe('stalled')
    expect(stallThresholdMs({ currentAudioMs: 60 * MIN, throughput: null })).toBe(STALL_FLOOR_MS)
  })

  it('after a track completes, the budget is 3× the observed per-track time, floored at 10 min', () => {
    const budget = { observedPerTrackMs: 5 * MIN }
    expect(stallThresholdMs(budget)).toBe(15 * MIN)
    expect(level(14 * MIN, budget)).toBe('quiet')
    expect(level(16 * MIN, budget)).toBe('stalled')
    // Short tracks do not pull the budget under the floor.
    expect(stallThresholdMs({ observedPerTrackMs: 1 * MIN })).toBe(STALL_FLOOR_MS)
  })

  it('a long track in flight extends the budget to 3× its own expected wall time', () => {
    // 60 min of audio at 10× realtime is 6 min expected → 18 min budget,
    // even though the completed tracks averaged 2 min.
    const budget = { observedPerTrackMs: 2 * MIN, currentAudioMs: 60 * MIN, throughput: 10 }
    expect(stallThresholdMs(budget)).toBe(18 * MIN)
    expect(level(17 * MIN, budget)).toBe('quiet')
    expect(level(19 * MIN, budget)).toBe('stalled')
  })

  it('corrects for a server clock that is behind ours', () => {
    // Server is 20 minutes behind. Uncorrected, "last activity" would look
    // 20 minutes stale and the run would be called stalled at once.
    const receivedAt = clientNow - 1_000
    const serverNow = receivedAt - 20 * MIN
    expect(
      stallLevel({ lastActivityAt: serverNow - 10_000, serverNow, receivedAt, clientNow }),
    ).toBe('fresh')
  })

  it('corrects for a server clock that is ahead of ours', () => {
    // Server is 20 minutes ahead. Uncorrected, activity would sit in the
    // future and a genuinely stalled run would read as fresh.
    const receivedAt = clientNow - 1_000
    const serverNow = receivedAt + 20 * MIN
    expect(
      stallLevel({ lastActivityAt: serverNow - 11 * MIN, serverNow, receivedAt, clientNow }),
    ).toBe('stalled')
  })

  it('is fresh when there is nothing to judge', () => {
    expect(stallLevel({ lastActivityAt: null, receivedAt: clientNow, clientNow })).toBe('fresh')
  })
})

describe('observedPerTrackMs', () => {
  it('recovers the mean wall time per completed track from the throughput', () => {
    // 3 tracks done, 30 min of completed audio at 10× realtime → 3 min wall → 1 min each.
    const live = oldShape({
      utterancesDone: 3,
      throughput: 10,
      processedAudioMs: 30 * MIN + 5 * MIN,
      current: {
        utteranceId: 'u4',
        speakerDisplay: 'Zuri',
        audioMs: 20 * MIN,
        startedAt: 0,
        attempt: 1,
        progressMs: 5 * MIN,
      },
    })
    expect(observedPerTrackMs(live)).toBe(1 * MIN)
  })

  it('is null before a track has completed or without throughput', () => {
    expect(observedPerTrackMs(oldShape({ utterancesDone: 0, throughput: 10 }))).toBeNull()
    expect(observedPerTrackMs(oldShape({ utterancesDone: 2, throughput: null }))).toBeNull()
  })
})

describe('progress and ETA', () => {
  it('etaMs is remaining audio over throughput, null until throughput exists', () => {
    expect(etaMs({ processedAudioMs: 30 * MIN, totalAudioMs: 120 * MIN, throughput: 10 })).toBe(
      9 * MIN,
    )
    expect(etaMs({ processedAudioMs: 30 * MIN, totalAudioMs: 120 * MIN, throughput: null })).toBeNull()
    expect(etaMs({ processedAudioMs: 30 * MIN, totalAudioMs: 0, throughput: 10 })).toBeNull()
    expect(etaMs({ processedAudioMs: 200 * MIN, totalAudioMs: 120 * MIN, throughput: 10 })).toBe(0)
  })

  it('audioPercent is null without totals and clamps at 100', () => {
    expect(audioPercent({ processedAudioMs: 30 * MIN, totalAudioMs: 120 * MIN })).toBe(25)
    expect(audioPercent({ processedAudioMs: 30 * MIN })).toBeNull()
    expect(audioPercent({ processedAudioMs: 500 * MIN, totalAudioMs: 120 * MIN })).toBe(100)
  })

  it('trackCounts prefers utterance counts and falls back to the cue-shaped ones', () => {
    expect(trackCounts(oldShape({ processed: 2, enqueued: 5 }))).toEqual({ done: 2, total: 5 })
    expect(
      trackCounts(oldShape({ processed: 0, enqueued: 0, utterancesDone: 7, utterancesTotal: 12 })),
    ).toEqual({ done: 7, total: 12 })
    expect(trackCounts(null)).toEqual({ done: 0, total: 0 })
  })
})

describe('formatting', () => {
  it('formatClock pads the small unit once an hour or a minute is on the left', () => {
    expect(formatClock(72 * MIN)).toBe('1h 12m')
    expect(formatClock(243 * MIN)).toBe('4h 03m')
    expect(formatClock(14 * MIN + 2_000)).toBe('14m 02s')
    expect(formatClock(3 * MIN + 10_000)).toBe('3m 10s')
    expect(formatClock(12_000)).toBe('12s')
    expect(formatClock(0)).toBe('0s')
  })

  it('formatAudioProgress reads "1h 12m of 4h 03m" and never overshoots the total', () => {
    expect(formatAudioProgress(72 * MIN, 243 * MIN)).toBe('1h 12m of 4h 03m')
    expect(formatAudioProgress(300 * MIN, 243 * MIN)).toBe('4h 03m of 4h 03m')
  })

  it('formatTrackLength is coarse', () => {
    expect(formatTrackLength(58 * MIN)).toBe('58 min')
    expect(formatTrackLength(62 * MIN)).toBe('1h 02m')
    expect(formatTrackLength(45_000)).toBe('45 s')
  })

  it('formatRealtime rounds fast runs and keeps a decimal for slow ones', () => {
    expect(formatRealtime(18.4)).toBe('≈18× realtime')
    expect(formatRealtime(0.83)).toBe('≈0.8× realtime')
  })

  it('formatEta is coarse and prefixed', () => {
    expect(formatEta(9 * MIN + 20_000)).toBe('~9 min')
    expect(formatEta(65 * MIN)).toBe('~1h 05m')
    expect(formatEta(20_000)).toBe('< 1 min')
  })

  it('wholeMinutes rounds to the nearest minute and never reports zero', () => {
    expect(wholeMinutes(10_000)).toBe(1)
    expect(wholeMinutes(14 * MIN + 59_000)).toBe(15)
    expect(wholeMinutes(15 * MIN + 20_000)).toBe(15)
  })

  it('deviceLabel names the device and marks a fallback', () => {
    expect(deviceLabel({ device: 'cuda', fallback: false })).toBe('CUDA')
    expect(deviceLabel({ device: 'cpu', fallback: false })).toBe('CPU')
    expect(deviceLabel({ device: 'cpu', fallback: true })).toBe('CPU (fallback)')
    expect(deviceLabel({ device: 'metal', fallback: false })).toBe('METAL')
  })
})
