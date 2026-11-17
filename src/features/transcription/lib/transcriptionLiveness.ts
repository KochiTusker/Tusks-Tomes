// Pure helpers behind the transcription progress view. Everything here
// takes numbers in and gives strings or verdicts out, so the component
// can stay a rendering concern and these rules can be tested on their own.
//
// The problem they solve: one utterance is a whole per-speaker track file,
// up to an hour of audio, and between utterances nothing on screen
// changes. Without a liveness signal a slow run and a hung one look
// identical. The server now reports when it last did anything; the
// helpers turn that into "fresh / quiet / stalled" with thresholds that
// scale to the size of the track in flight, so a long track is not
// reported stuck merely for being long.
//
// Clocks: every timestamp the server sends is on the server's clock, and
// the response carries `serverNow` so the client can measure the skew
// between the two rather than trusting either. All "how long ago"
// arithmetic goes through `clockOffsetMs`.

import type { LiveEngine, LiveSessionResponse } from '@/features/transcription/lib/liveSession'

export type DisplayPhase =
  | 'loading_model'
  | 'transcribing'
  | 'finalising'
  | 'ready'
  | 'failed'
  | 'interrupted'
  /** Nothing has been enqueued yet — the upload is still being unpacked. */
  | 'recording'

export type StallLevel = 'fresh' | 'quiet' | 'stalled'

/** Nothing has happened for this long → "still working, be patient". */
export const QUIET_AFTER_MS = 60_000
/** Never call a run stalled sooner than this, whatever the track size. */
export const STALL_FLOOR_MS = 10 * 60_000
/** A track may take this many times its expected wall time before we worry. */
export const STALL_MULTIPLIER = 3

const IN_PROGRESS: ReadonlySet<DisplayPhase> = new Set<DisplayPhase>([
  'recording',
  'loading_model',
  'transcribing',
  'finalising',
])

export function isInProgress(phase: DisplayPhase): boolean {
  return IN_PROGRESS.has(phase)
}

/**
 * Which view to show. Prefers the server's `runState`; without one (an
 * older server) reproduces what the component used to derive from
 * `active` / `finalized`: active meant "the queue is being worked", so
 * it maps to `transcribing` once anything has been enqueued and to the
 * neutral waiting state before that; neither active nor finalised was
 * the tail of the run, which is `finalising`.
 */
export function deriveDisplayPhase(live: LiveSessionResponse | null | undefined): DisplayPhase {
  if (!live) return 'recording'
  switch (live.runState) {
    case 'loading_model':
      return 'loading_model'
    case 'transcribing':
      return 'transcribing'
    case 'finalising':
      return 'finalising'
    case 'done':
      return 'ready'
    case 'failed':
      return 'failed'
    case 'interrupted':
      return 'interrupted'
    case 'idle':
    case undefined:
    default:
      break
  }
  if (live.finalized) return 'ready'
  if (live.active) {
    const enqueued = (live.enqueued ?? 0) + (live.pending ?? 0) + (live.processed ?? 0)
    return enqueued > 0 ? 'transcribing' : 'recording'
  }
  return 'finalising'
}

// ---- Clock skew -----------------------------------------------------

/**
 * Client clock minus server clock, measured at the moment a response
 * arrived. Add it to any server timestamp to place it on the client's
 * clock. Zero when the server did not say what time it was.
 */
export function clockOffsetMs(serverNow: number | null | undefined, receivedAt: number): number {
  if (typeof serverNow !== 'number' || !Number.isFinite(serverNow)) return 0
  return receivedAt - serverNow
}

export type ClockSample = {
  serverNow?: number | null
  /** Client clock when the response carrying `serverNow` landed. */
  receivedAt: number
  /** Client clock now — the 1 s tick. */
  clientNow: number
}

/** Milliseconds since a server-clock timestamp, on the client's clock; never negative. */
export function msSince(serverTs: number | null | undefined, clock: ClockSample): number | null {
  if (typeof serverTs !== 'number' || !Number.isFinite(serverTs)) return null
  const offset = clockOffsetMs(clock.serverNow, clock.receivedAt)
  return Math.max(0, clock.clientNow - (serverTs + offset))
}

// ---- Stall detection ------------------------------------------------

export type StallBudget = {
  /** Audio length of the track in flight. */
  currentAudioMs?: number | null
  /** Mean wall time per completed track, once one has completed. */
  observedPerTrackMs?: number | null
  /** "× realtime" over completed tracks; null until one completes. */
  throughput?: number | null
}

/**
 * How long silence may last before it counts as a stall. Before any track
 * has completed nothing is known about this machine's speed, so only the
 * floor applies. Afterwards the budget is three times the larger of the
 * mean per-track wall time and this track's own expected wall time
 * (its audio length ÷ the observed throughput) — a one-hour track after a
 * run of five-minute ones must not be reported stuck at fifteen minutes.
 */
export function stallThresholdMs(budget: StallBudget): number {
  let threshold = STALL_FLOOR_MS
  const perTrack = budget.observedPerTrackMs
  if (typeof perTrack === 'number' && perTrack > 0) {
    threshold = Math.max(threshold, STALL_MULTIPLIER * perTrack)
  }
  const audio = budget.currentAudioMs
  const rate = budget.throughput
  if (typeof audio === 'number' && audio > 0 && typeof rate === 'number' && rate > 0) {
    threshold = Math.max(threshold, (STALL_MULTIPLIER * audio) / rate)
  }
  return threshold
}

export type StallInput = StallBudget & {
  lastActivityAt: number | null | undefined
  serverNow?: number | null
  receivedAt: number
  clientNow: number
}

export function stallLevel(input: StallInput): StallLevel {
  const since = msSince(input.lastActivityAt, input)
  if (since === null) return 'fresh'
  if (since < QUIET_AFTER_MS) return 'fresh'
  if (since < stallThresholdMs(input)) return 'quiet'
  return 'stalled'
}

/**
 * Mean wall time per completed track, recovered from the throughput the
 * server reports: Σ elapsed = Σ completed audio ÷ throughput. The
 * in-flight track's progress is excluded because it is not yet part of
 * the throughput sample.
 */
export function observedPerTrackMs(live: LiveSessionResponse): number | null {
  const done = live.utterancesDone ?? 0
  const rate = live.throughput
  if (done <= 0 || typeof rate !== 'number' || !(rate > 0)) return null
  const completedAudio = (live.processedAudioMs ?? 0) - (live.current?.progressMs ?? 0)
  if (!(completedAudio > 0)) return null
  return completedAudio / rate / done
}

// ---- Progress and ETA ----------------------------------------------

export type AudioTotals = {
  processedAudioMs?: number | null
  totalAudioMs?: number | null
}

/** 0–100, or null when the server has not said how much audio there is. */
export function audioPercent(t: AudioTotals): number | null {
  const total = t.totalAudioMs
  if (typeof total !== 'number' || !(total > 0)) return null
  const done = Math.max(0, t.processedAudioMs ?? 0)
  return Math.min(100, (done / total) * 100)
}

export function etaMs(t: AudioTotals & { throughput?: number | null }): number | null {
  const rate = t.throughput
  if (typeof rate !== 'number' || !(rate > 0)) return null
  const total = t.totalAudioMs
  if (typeof total !== 'number' || !(total > 0)) return null
  const remaining = Math.max(0, total - Math.max(0, t.processedAudioMs ?? 0))
  return remaining / rate
}

/** Tracks done / total, preferring the true utterance counts over the older cue-shaped ones. */
export function trackCounts(live: LiveSessionResponse | null | undefined): { done: number; total: number } {
  if (!live) return { done: 0, total: 0 }
  const done = live.utterancesDone ?? live.processed ?? 0
  const total = live.utterancesTotal ?? live.enqueued ?? 0
  return { done: Math.max(0, done), total: Math.max(0, total) }
}

// ---- Formatting -----------------------------------------------------

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function split(ms: number): { h: number; m: number; s: number } {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  return {
    h: Math.floor(totalSec / 3600),
    m: Math.floor((totalSec % 3600) / 60),
    s: totalSec % 60,
  }
}

/** "1h 12m" · "14m 02s" · "12s" — for elapsed, "ago" and audio positions. */
export function formatClock(ms: number): string {
  const { h, m, s } = split(ms)
  if (h > 0) return `${h}h ${pad2(m)}m`
  if (m > 0) return `${m}m ${pad2(s)}s`
  return `${s}s`
}

/** "1h 12m of 4h 03m" */
export function formatAudioProgress(processedMs: number, totalMs: number): string {
  return `${formatClock(Math.min(processedMs, totalMs))} of ${formatClock(totalMs)}`
}

/** "58 min" · "1h 02m" · "45 s" — a track's length, coarse on purpose. */
export function formatTrackLength(ms: number): string {
  const { h, m, s } = split(ms)
  if (h > 0) return `${h}h ${pad2(m)}m`
  if (m > 0) return `${m} min`
  return `${s} s`
}

/** "≈18× realtime" · "≈0.8× realtime" */
export function formatRealtime(throughput: number): string {
  const shown = throughput >= 10 ? Math.round(throughput).toString() : throughput.toFixed(1)
  return `≈${shown}× realtime`
}

/** "~9 min" · "~1h 05m" · "< 1 min" — coarse, because an estimate is not a clock. */
export function formatEta(ms: number): string {
  const { h, m } = split(ms)
  if (h > 0) return `~${h}h ${pad2(m)}m`
  if (m > 0) return `~${m} min`
  return '< 1 min'
}

/**
 * Nearest whole minute, at least 1 — for "No progress for N minutes".
 * Rounded rather than floored so a threshold crossed a moment ago reads
 * as the round number the person expects, not one below it.
 */
export function wholeMinutes(ms: number): number {
  return Math.max(1, Math.round(ms / 60_000))
}

/** "CUDA" · "CPU" · "CPU (fallback)" */
export function deviceLabel(engine: Pick<LiveEngine, 'device' | 'fallback'>): string {
  const device = engine.device.trim().toLowerCase()
  const base = device === 'cuda' ? 'CUDA' : device === 'cpu' ? 'CPU' : engine.device.toUpperCase()
  return engine.fallback ? `${base} (fallback)` : base
}

/**
 * The server keeps informational transitions in the same list as failures —
 * a GPU worker reset, the move to the CPU engine — prefixed "note:", so one
 * field survives a restart. They are not failures and must not be counted as
 * such; here they part ways.
 */
export function splitErrorLines(errors: readonly string[] | undefined | null): {
  errors: string[]
  notes: string[]
} {
  const out = { errors: [] as string[], notes: [] as string[] }
  for (const line of errors ?? []) {
    if (line.startsWith('note:')) out.notes.push(line.replace(/^note:\s*/, ''))
    else out.errors.push(line)
  }
  return out
}
