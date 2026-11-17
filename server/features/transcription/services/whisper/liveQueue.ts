// Per-session transcription queue. The multitrack upload pipeline writes
// one WAV/FLAC chunk per speaker utterance into the session directory and
// enqueues each one here. Whisper transcribes it and folds the result
// into an in-memory transcript. That transcript is re-serialised to
// `session.sbv` after every successful utterance so:
//
//   1. The Upload panel can show a running transcript while the queue
//      drains.
//   2. A server crash mid-job loses at most one utterance.
//   3. The same `session.sbv` file is the artifact the refinement
//      pipeline already consumes — there is no separate "live" code path
//      downstream.
//
// One worker drains the queue serially because we assume one GPU.
// Multiple concurrent sessions share the worker.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { ensureDir, glossaryFile, readJson, speakersFile, writeJson } from '../../../../platform/appData.js'
import { findSpeakerFor } from '../../../../../shared/speakers/identity.js'
import { throughputOf, type LiveCurrent } from '../sessions/liveSessionBridge.js'
import {
  audioDir,
  manifestPath,
  readManifest,
  sessionDir,
  type EngineSnapshot,
  type LiveRunState,
  type ProcessingProgress,
  type SessionManifest,
  type UtteranceEntry,
} from '../sessions/sessionManifest.js'
import {
  buildInitialPrompt,
  getEngineInfo,
  isCudaClassError,
  resetGpuWorker,
  transcribeFile,
  type Segment,
  type TranscribeOptions,
  type TranscribeResult,
} from './invoke.js'

type Speaker = {
  discordUserId: string
  discordDisplayName?: string
  playerName: string
  characterName: string
}

type SpeakersDocument = { version: 1; speakers: Speaker[] }

type GlossaryDocument = {
  version: 1
  safeReplacements: Array<{ from: string; to: string }>
  contextualHints: Array<{ canonical: string; commonMishears?: string[]; notes: string }>
}

export type LiveSegment = {
  userId: string
  discordDisplayName?: string
  utteranceId: string
  /** Absolute ms offset from session start to the cue start. */
  absStartMs: number
  absEndMs: number
  text: string
  /** Per-word Whisper output, preserved so future passes can re-time individual words. */
  words: Segment['words']
}

export type LiveSessionState = {
  sessionId: string
  /**
   * True while utterances are still being enqueued for this session (i.e.
   * the upload is still being expanded into per-utterance chunks). Flips
   * to false the moment ingest completes so the dashboard can switch from
   * "Enqueuing" to "Processing" while the queue continues to drain.
   */
  active: boolean
  /** Cached glossary-derived Whisper prompt. Computed once per session. */
  initialPrompt: string
  /** Every participant observed in the uploaded multitrack. */
  participants: Map<string, { discordDisplayName?: string }>
  /** One entry per Whisper segment, in the order they were transcribed. */
  segments: LiveSegment[]
  /** Utterances that have completed transcription (successfully or with error). */
  processedUtterances: number
  /** Utterances enqueued but not yet processed. */
  pending: number
  /** Total utterances enqueued for this session — used to drive a progress bar. */
  enqueued: number
  /**
   * Utterances that errored during transcription, plus `note:` lines for
   * transitions the user should see that failed no utterance — a GPU
   * worker reset, the move to the CPU.
   */
  errors: string[]
  startedAt: number
  runState: LiveRunState
  /**
   * Epoch ms of the last thing the run did: an enqueue, an utterance
   * starting, a progress tick, an utterance finishing or failing,
   * finalising. What the UI compares against `serverNow` to tell a slow
   * utterance from a stalled one.
   */
  lastActivityAt: number | null
  /** Σ manifest durationMs over every utterance in the session. */
  totalAudioMs: number
  /** Audio in completed utterances. The live figure adds `current.progressMs`. */
  processedAudioMs: number
  /** Utterances, not cues: one Whisper invocation each. */
  utterancesTotal: number
  utterancesDone: number
  current: LiveCurrent | null
  /** The engine behind the most recent completed utterance. */
  engine: EngineSnapshot | null
  /** One sample per completed utterance, for throughput. */
  completed: Array<{ audioMs: number; elapsedMs: number }>
  /** The run-level failure once `runState` is 'failed'. */
  failure: string | null
  /** Completed utterances per device. */
  devices: Record<string, number>
}

type QueueItem = {
  sessionId: string
  participant: { discordUserId: string; discordDisplayName?: string }
  utterance: UtteranceEntry
  audioPath: string
}

const sessions = new Map<string, LiveSessionState>()
const queue: QueueItem[] = []
let workerRunning = false
const subscribers = new Set<(sessionId: string) => void>()

function notify(sessionId: string): void {
  for (const fn of subscribers) {
    try {
      fn(sessionId)
    } catch (err) {
      console.warn('[liveQueue] subscriber threw:', err)
    }
  }
}

async function loadSpeakers(): Promise<Speaker[]> {
  const doc = await readJson<SpeakersDocument | null>(speakersFile(), null)
  return doc?.speakers ?? []
}

async function buildBiasPrompt(): Promise<string> {
  const doc = await readJson<GlossaryDocument | null>(glossaryFile(), null)
  const names: string[] = []
  if (doc) {
    for (const h of doc.contextualHints ?? []) {
      if (h.canonical) names.push(h.canonical)
    }
    for (const r of doc.safeReplacements ?? []) {
      if (r.to && /^[A-Z]/.test(r.to)) names.push(r.to)
    }
  }
  return buildInitialPrompt(names)
}

function speakerDisplayFor(
  userId: string,
  manifestDisplayName: string | undefined,
  speakers: Speaker[]
): string {
  // Match on ID, then on Discord display name — mappings saved before
  // speaker identity moved off Craig's track index are keyed by that old
  // numeric ID, and would otherwise stop applying to new uploads.
  const entry = findSpeakerFor(speakers, userId, manifestDisplayName)
  if (entry) {
    const character = entry.characterName?.trim()
    const player = entry.playerName?.trim()
    if (character && player) return `${character} (${player})`
    if (character) return character
    if (player) return player
    if (entry.discordDisplayName) return entry.discordDisplayName
  }
  return manifestDisplayName ?? userId
}

function fmtSbvTime(ms: number): string {
  const totalSeconds = ms / 1000
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = Math.floor(totalSeconds % 60)
  const millis = Math.floor(ms % 1000)
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${pad(hours, 1)}:${pad(minutes)}:${pad(seconds)}.${pad(millis, 3)}`
}

/** Re-build session.sbv from the current segments + the current speakers.json mapping. */
async function rewriteSbv(state: LiveSessionState): Promise<string> {
  const speakers = await loadSpeakers()
  const sorted = [...state.segments].sort((a, b) => a.absStartMs - b.absStartMs)
  const lines: string[] = []
  for (const seg of sorted) {
    const display = speakerDisplayFor(seg.userId, seg.discordDisplayName, speakers)
    const text = seg.text.trim()
    if (!text) continue
    lines.push(`${fmtSbvTime(seg.absStartMs)},${fmtSbvTime(seg.absEndMs)}`)
    lines.push(`[${display}] ${text}`)
    lines.push('')
  }
  const sbv = lines.join('\n')
  const sbvPath = path.join(sessionDir(state.sessionId), 'session.sbv')
  await ensureDir(path.dirname(sbvPath))
  await fs.writeFile(sbvPath, sbv, 'utf8')
  return sbv
}

/**
 * Maximum silence (ms) between consecutive Whisper words before we treat
 * them as separate spoken moments. 2s is loose enough to keep natural
 * sentence-internal pauses together, tight enough to break across
 * "speaker stopped talking, came back later" gaps.
 */
const SEGMENT_SPLIT_GAP_MS = 2000

/**
 * Split a Whisper segment into one or more sub-segments at any
 * word-to-word silence gap longer than SEGMENT_SPLIT_GAP_MS. Re-derives
 * the sub-segment's start/end from the first/last word of each cluster
 * so timestamps reflect when the speaker was actually talking. Returns
 * the original segment unchanged if it has no word timings or no gap
 * exceeds the threshold.
 */
function splitSegmentByGaps(segment: Segment): Segment[] {
  if (!segment.words || segment.words.length === 0) return [segment]
  const groups: Segment['words'][] = []
  let current: Segment['words'] = []
  for (const word of segment.words) {
    if (current.length > 0) {
      const last = current[current.length - 1]
      if (word.startMs - last.endMs > SEGMENT_SPLIT_GAP_MS) {
        groups.push(current)
        current = []
      }
    }
    current.push(word)
  }
  if (current.length > 0) groups.push(current)
  if (groups.length <= 1) return [segment]
  return groups.map((words) => ({
    startMs: words[0].startMs,
    endMs: words[words.length - 1].endMs,
    text: words.map((w) => w.text).join(' ').trim(),
    words,
    confidence: segment.confidence,
  }))
}

async function persistUtteranceJson(args: {
  sessionId: string
  discordUserId: string
  utteranceId: string
  data: unknown
}): Promise<void> {
  const dir = path.join(sessionDir(args.sessionId), 'transcripts', args.discordUserId)
  await ensureDir(dir)
  await fs.writeFile(
    path.join(dir, `${args.utteranceId}.json`),
    JSON.stringify(args.data, null, 2),
    'utf8'
  )
}

/**
 * Set once the CPU has finished an utterance the GPU could not, and read by
 * every utterance after it. Without this each later utterance pays for two
 * failed GPU attempts before reaching the CPU, and on a session of a few
 * hundred utterances that turns a slow fallback into a stalled one. Nothing
 * clears it but a server restart: a GPU that failed mid-run will not recover
 * before then, and restarting is how the user asks for another attempt.
 */
let gpuUnavailable: { reason: string } | null = null

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function firstLine(err: unknown): string {
  return String((err as Error)?.message ?? err).split('\n')[0]
}

/**
 * Transitions the user should see but that failed no utterance go into the
 * same list as the failures, with a `note:` prefix that sets them apart. The
 * list is what the live panel shows and what the manifest keeps, so a note
 * written here survives the run being forgotten.
 */
function addNote(state: LiveSessionState, text: string): void {
  state.errors.push(`note: ${text}`)
}

function setAttempt(state: LiveSessionState, attempt: number): void {
  if (state.current) state.current.attempt = attempt
  state.lastActivityAt = Date.now()
}

type Attempt = {
  result: TranscribeResult
  /** True when the CPU worker produced the result because the GPU could not. */
  cpuFallback: boolean
  fallbackReason?: string
}

/**
 * GPU, GPU again, then CPU. The persistent worker (server/features/transcription/services/whisper/worker.ts)
 * loads the model once per server lifetime, which removed the per-utterance
 * cuDNN re-initialisation that used to crash back-to-back spawns; what is
 * left is the rare in-flight failure, and this ladder covers it:
 *
 *   1. If the first GPU attempt fails, retry on the GPU once. A worker that
 *      died mid-request restarts on the next call, so the retry runs in a
 *      fresh process with a freshly loaded model. When the failure is a
 *      CUDA-class one the worker is reset first: a CUDA context that has
 *      just faulted tends to fault again, and a retry into it fails the same
 *      way.
 *
 *   2. If the retry also fails, run the utterance on the CPU worker:
 *      several times slower, but it does not touch CUDA at all. Once that
 *      has succeeded, every later utterance goes straight there.
 *
 * The utterance is only marked errored after all three fail.
 */
async function transcribeWithFallback(
  state: LiveSessionState,
  tag: string,
  request: TranscribeOptions
): Promise<Attempt> {
  const cpuRequest: TranscribeOptions = { ...request, device: 'cpu', computeType: 'int8' }
  if (gpuUnavailable) {
    setAttempt(state, 3)
    return {
      result: await transcribeFile(cpuRequest),
      cpuFallback: true,
      fallbackReason: gpuUnavailable.reason,
    }
  }
  try {
    return { result: await transcribeFile(request), cpuFallback: false }
  } catch (gpuErr1) {
    const msg1 = firstLine(gpuErr1)
    if (isCudaClassError(msg1)) {
      console.warn(`[liveQueue] ${tag}: resetting the GPU worker after a CUDA-class failure: ${msg1}`)
      addNote(state, `${tag}: GPU worker reset after a CUDA-class failure (${msg1})`)
      await resetGpuWorker().catch((resetErr) => {
        console.warn('[liveQueue] GPU worker reset failed:', resetErr)
      })
    }
    console.warn(`[liveQueue] retry ${tag} on GPU after failure: ${msg1}`)
    setAttempt(state, 2)
    try {
      return { result: await transcribeFile(request), cpuFallback: false }
    } catch (gpuErr2) {
      const msg2 = firstLine(gpuErr2)
      console.warn(`[liveQueue] retry ${tag} on CPU after GPU failure: ${msg2}`)
      setAttempt(state, 3)
      const result = await transcribeFile(cpuRequest)
      if (!gpuUnavailable) {
        gpuUnavailable = { reason: msg2 }
        console.warn(
          `[liveQueue] GPU unavailable until the server restarts; later utterances go straight to the CPU: ${msg2}`
        )
        addNote(
          state,
          `GPU unavailable after ${tag} (${msg2}); the rest of this run is transcribing on the CPU, which is slower`
        )
      }
      return { result, cpuFallback: true, fallbackReason: msg2 }
    }
  }
}

/**
 * What ran. `getEngineInfo()` describes the engine behind the latest result
 * from any worker; the result itself names the model and the device it
 * actually ran on. On the CPU path the answer is a fallback whatever the
 * CPU worker reports about itself, because the run asked for the GPU.
 */
function describeEngine(attempt: Attempt): EngineSnapshot {
  const info = getEngineInfo()
  const { result } = attempt
  const engine: EngineSnapshot = {
    name: info?.name ?? 'faster-whisper',
    model: result.model || info?.model || '',
    device: result.device || info?.device || 'cuda',
    computeType: info?.computeType ?? '',
    fallback: info?.fallback ?? false,
  }
  if (!attempt.cpuFallback) return engine
  return {
    ...engine,
    device: 'cpu',
    computeType: info?.device === 'cpu' && info.computeType ? info.computeType : 'int8',
    fallback: true,
    ...(attempt.fallbackReason ? { fallbackReason: attempt.fallbackReason } : {}),
  }
}

function buildSnapshot(state: LiveSessionState): ProcessingProgress {
  return {
    runState: state.runState,
    startedAt: state.startedAt,
    lastActivityAt: state.lastActivityAt,
    totalAudioMs: state.totalAudioMs,
    processedAudioMs: state.processedAudioMs,
    utterancesTotal: state.utterancesTotal,
    utterancesDone: state.utterancesDone,
    engine: state.engine,
    throughput: throughputOf(state.completed),
    devices: { ...state.devices },
    failure: state.failure,
  }
}

/**
 * Write the run's progress, error list and device tally into the manifest,
 * on top of whatever else `processing` holds. Throws on a failed write;
 * see `persistSnapshot` for the caller that must not.
 */
async function writeSnapshot(
  state: LiveSessionState,
  extra: Partial<SessionManifest['processing']> = {}
): Promise<void> {
  const manifest = await readManifest(state.sessionId)
  if (!manifest) return
  manifest.processing = {
    ...manifest.processing,
    ...extra,
    errors: [...state.errors],
    devices: { ...state.devices },
    progress: buildSnapshot(state),
  }
  await writeJson(manifestPath(state.sessionId), manifest)
}

/**
 * Best-effort snapshot. The queue must keep draining whether or not the
 * manifest could be written, and the console still has the run's history
 * if it could not.
 */
async function persistSnapshot(state: LiveSessionState): Promise<void> {
  try {
    await writeSnapshot(state)
  } catch (err) {
    console.warn('[liveQueue] failed to persist progress to manifest:', err)
  }
}

async function processItem(item: QueueItem): Promise<void> {
  const state = sessions.get(item.sessionId)
  if (!state) {
    console.warn(`[liveQueue] dropping utterance for unknown session ${item.sessionId}`)
    return
  }
  const tag = `${item.participant.discordUserId}/${item.utterance.utteranceId}`
  console.log(`[liveQueue] start ${tag} (${item.audioPath})`)
  const startedAt = Date.now()
  const current: LiveCurrent = {
    utteranceId: item.utterance.utteranceId,
    speakerDisplay: item.participant.discordDisplayName ?? item.participant.discordUserId,
    audioMs: item.utterance.durationMs || 0,
    startedAt,
    attempt: 1,
    progressMs: 0,
  }
  state.current = current
  if (state.runState === 'idle') state.runState = 'transcribing'
  state.lastActivityAt = startedAt
  notify(item.sessionId)
  try {
    const speakers = await loadSpeakers()
    const speakerDisplay = speakerDisplayFor(
      item.participant.discordUserId,
      item.participant.discordDisplayName,
      speakers
    )
    current.speakerDisplay = speakerDisplay
    const request: TranscribeOptions = {
      audio: item.audioPath,
      speakerId: item.participant.discordUserId,
      speakerDisplay,
      initialPrompt: state.initialPrompt,
      onProgress: (p) => {
        // The manifest's duration is the denominator everywhere else, so
        // the engine's figure is clamped to it. A zero means the probe
        // failed at upload, and then the engine's figure is all there is.
        current.progressMs = current.audioMs > 0 ? Math.min(p.processedMs, current.audioMs) : p.processedMs
        state.lastActivityAt = Date.now()
        notify(item.sessionId)
      },
      onStatus: (stage) => {
        // Only while the run is still in flight: a run failed from outside
        // mid-utterance stays failed whatever the engine says next.
        if (state.runState === 'loading_model' || state.runState === 'transcribing') {
          state.runState = stage === 'loading_model' ? 'loading_model' : 'transcribing'
        }
        // Name the engine as soon as the model is up rather than waiting for
        // the first track to finish. A track can run for minutes, and "which
        // device is this actually on" is the question being asked for all of
        // them. The post-result snapshot still overwrites this with what the
        // result itself reports, including a fallback the worker cannot know
        // about yet.
        if (!state.engine) {
          const info = getEngineInfo()
          if (info) {
            state.engine = {
              name: info.name,
              model: info.model,
              device: info.device,
              computeType: info.computeType,
              fallback: info.fallback,
            }
          }
        }
        state.lastActivityAt = Date.now()
        notify(item.sessionId)
      },
    }
    const attempt = await transcribeWithFallback(state, tag, request)
    const { result } = attempt
    await persistUtteranceJson({
      sessionId: item.sessionId,
      discordUserId: item.participant.discordUserId,
      utteranceId: item.utterance.utteranceId,
      data: result,
    })
    // Split Whisper's segments at long word-gaps before pushing.
    // faster-whisper (especially on CPU) sometimes returns one segment
    // spanning a long stretch with multi-second silence between words —
    // e.g. a single track's first segment can come back as 0:01–2:41
    // covering five separate spoken moments. Without splitting, that
    // cue sorts to the start of the SBV and the chronicle pipeline
    // reads it as the opening monologue instead of interleaving the
    // moments with the other speakers.
    for (const segment of result.segments as Segment[]) {
      for (const sub of splitSegmentByGaps(segment)) {
        state.segments.push({
          userId: item.participant.discordUserId,
          discordDisplayName: item.participant.discordDisplayName,
          utteranceId: item.utterance.utteranceId,
          absStartMs: item.utterance.startedAtMs + sub.startMs,
          absEndMs: item.utterance.startedAtMs + sub.endMs,
          text: sub.text,
          words: sub.words,
        })
      }
    }
    // Refresh the SBV on disk after each utterance. This makes the live
    // transcript available to /api/sessions/:id/sbv even while recording.
    await rewriteSbv(state)
    const audioMs = item.utterance.durationMs || 0
    // The engine's own elapsed time leaves out the one-off model load, so
    // the first utterance of a run does not drag the projection for every
    // utterance after it. Wall-clock stands in when an engine reports none.
    const elapsedMs =
      Number.isFinite(result.elapsedMs) && result.elapsedMs > 0
        ? result.elapsedMs
        : Date.now() - startedAt
    state.completed.push({ audioMs, elapsedMs })
    state.processedAudioMs += audioMs
    const device = attempt.cpuFallback ? 'cpu' : result.device || 'cuda'
    state.devices[device] = (state.devices[device] ?? 0) + 1
    state.engine = describeEngine(attempt)
    console.log(
      `[liveQueue] done  ${tag} — ${result.segments.length} segments in ${result.elapsedMs}ms`
    )
  } catch (err) {
    const message = `${tag}: ${(err as Error).message}`
    console.error('[liveQueue] FAIL', message)
    state.errors.push(message)
  } finally {
    state.pending = Math.max(0, state.pending - 1)
    state.processedUtterances += 1
    state.utterancesDone += 1
    state.current = null
    state.lastActivityAt = Date.now()
    // The snapshot carries the error list, so a failure survives the
    // in-memory state being forgotten after finalize.
    await persistSnapshot(state)
    notify(item.sessionId)
  }
}

async function drain(): Promise<void> {
  if (workerRunning) return
  workerRunning = true
  try {
    while (queue.length > 0) {
      const next = queue.shift()
      if (!next) break
      await processItem(next)
    }
  } finally {
    workerRunning = false
  }
}

function createLiveState(sessionId: string): LiveSessionState {
  return {
    sessionId,
    active: true,
    initialPrompt: '',
    participants: new Map(),
    segments: [],
    processedUtterances: 0,
    pending: 0,
    enqueued: 0,
    errors: [],
    startedAt: Date.now(),
    runState: 'idle',
    lastActivityAt: null,
    totalAudioMs: 0,
    processedAudioMs: 0,
    utterancesTotal: 0,
    utterancesDone: 0,
    current: null,
    engine: null,
    completed: [],
    failure: null,
    devices: {},
  }
}

/** Push a freshly-closed utterance onto the queue. Called by voiceCapture. */
export function enqueueUtterance(args: QueueItem): void {
  const state = sessions.get(args.sessionId)
  if (!state) {
    console.warn(`[liveQueue] enqueueUtterance: no state for session ${args.sessionId}`)
    return
  }
  state.participants.set(args.participant.discordUserId, {
    discordDisplayName: args.participant.discordDisplayName,
  })
  state.pending += 1
  state.enqueued += 1
  state.lastActivityAt = Date.now()
  queue.push(args)
  notify(args.sessionId)
  void drain()
}

/**
 * Drain the queue for a session, mark it inactive, update the manifest with
 * the final SBV path, and return the in-memory state. Called once the
 * upload pipeline has finished enqueuing every utterance.
 */
export async function finalizeLiveSession(sessionId: string): Promise<LiveSessionState | null> {
  const state = sessions.get(sessionId)
  if (!state) return null

  // Flip active immediately so the dashboard switches from "Enqueuing"
  // to "Processing" the moment ingest completes, even if Whisper still
  // has a tail of utterances to chew through.
  state.active = false
  notify(sessionId)

  while (state.pending > 0) {
    await sleep(200)
  }

  state.runState = 'finalising'
  state.lastActivityAt = Date.now()
  notify(sessionId)
  await rewriteSbv(state)
  state.runState = 'done'
  state.lastActivityAt = Date.now()
  // Written before this returns, and not best-effort: callers forget the
  // in-memory state straight after, and from then on the manifest is the
  // only copy of these numbers. A finished session with no snapshot would
  // read as one that never ran.
  await writeSnapshot(state, {
    transcribedAt: new Date().toISOString(),
    sbvPath: 'session.sbv',
  })
  notify(sessionId)
  return state
}

/** Drop in-memory state. Disk artifacts are preserved. */
export function forgetLiveSession(sessionId: string): void {
  sessions.delete(sessionId)
}

function isRunning(state: LiveSessionState): boolean {
  return (
    state.runState === 'loading_model' ||
    state.runState === 'transcribing' ||
    state.runState === 'finalising'
  )
}

/** True while a run for the session is under way in this process. */
export function isLiveSessionRunning(sessionId: string): boolean {
  const state = sessions.get(sessionId)
  return state !== undefined && isRunning(state)
}

/**
 * Record a run-level failure: the run itself threw, as opposed to one
 * utterance failing inside it. The state is kept so the live endpoint can
 * say what happened; the next run for the session replaces it.
 */
export async function failLiveSession(sessionId: string, message: string): Promise<void> {
  const state = sessions.get(sessionId)
  if (state) {
    state.active = false
    state.runState = 'failed'
    state.failure = message
    state.current = null
    state.lastActivityAt = Date.now()
    await persistSnapshot(state)
    notify(sessionId)
    return
  }
  // Nothing in memory describes the run. Record the failure on whatever
  // the manifest already holds, so the session still shows it afterwards.
  try {
    const manifest = await readManifest(sessionId)
    if (!manifest) return
    const prior = manifest.processing.progress
    manifest.processing = {
      ...manifest.processing,
      progress: {
        runState: 'failed',
        startedAt: prior?.startedAt ?? null,
        lastActivityAt: Date.now(),
        totalAudioMs: prior?.totalAudioMs ?? 0,
        processedAudioMs: prior?.processedAudioMs ?? 0,
        utterancesTotal: prior?.utterancesTotal ?? 0,
        utterancesDone: prior?.utterancesDone ?? 0,
        engine: prior?.engine ?? null,
        throughput: prior?.throughput ?? null,
        devices: prior?.devices ?? {},
        failure: message,
      },
    }
    await writeJson(manifestPath(sessionId), manifest)
  } catch (err) {
    console.warn('[liveQueue] failed to persist failure to manifest:', err)
  }
}

export function getLiveSessionState(sessionId: string): LiveSessionState | undefined {
  return sessions.get(sessionId)
}

/**
 * Force a fresh SBV write — used after the user updates the speaker
 * mapping via the Upload panel so the new player / character labels
 * propagate to the on-disk transcript immediately.
 */
export async function refreshLiveSbv(sessionId: string): Promise<void> {
  const state = sessions.get(sessionId)
  if (!state) return
  await rewriteSbv(state)
  notify(sessionId)
}

/**
 * Run the same per-utterance transcription pipeline against every utterance
 * already on disk for a session. Used by the legacy "Process session" button
 * in the Sessions tab so batch and live paths share one implementation.
 */
export async function transcribeExistingSession(sessionId: string): Promise<LiveSessionState> {
  const existing = sessions.get(sessionId)
  if (existing && isRunning(existing)) {
    // Join the run under way rather than start another: enqueuing the
    // manifest again would transcribe every utterance twice and write
    // every cue into the SBV twice.
    while (isRunning(existing)) {
      await sleep(200)
    }
    return existing
  }
  // Claim the session before the first await, so a second caller in the
  // same tick finds a run in progress instead of starting its own. State
  // left by a finished or failed run is replaced: its counters describe
  // that run, not this one.
  const state = createLiveState(sessionId)
  state.runState = 'transcribing'
  state.lastActivityAt = Date.now()
  sessions.set(sessionId, state)
  notify(sessionId)

  let manifest: SessionManifest | null
  try {
    manifest = await readManifest(sessionId)
    if (!manifest) throw new Error(`session ${sessionId} not found`)
  } catch (err) {
    // Release the claim, marked so a caller that joined the run stops waiting.
    state.runState = 'failed'
    state.failure = (err as Error).message
    sessions.delete(sessionId)
    throw err
  }
  state.initialPrompt = await buildBiasPrompt().catch(() => '')
  for (const participant of manifest.participants) {
    for (const utterance of participant.utterances) {
      state.utterancesTotal += 1
      state.totalAudioMs += utterance.durationMs || 0
    }
  }
  // A snapshot before the first utterance: a server that dies while the
  // model is still loading would otherwise leave nothing on disk to say a
  // run had begun.
  await persistSnapshot(state)
  for (const participant of manifest.participants) {
    for (const utterance of participant.utterances) {
      const audioPath = path.join(
        audioDir(sessionId, participant.discordUserId),
        utterance.filename
      )
      enqueueUtterance({
        sessionId,
        participant: {
          discordUserId: participant.discordUserId,
          discordDisplayName: participant.discordDisplayName,
        },
        utterance,
        audioPath,
      })
    }
  }
  // Wait for completion.
  while (state.pending > 0) {
    await sleep(200)
  }
  return (await finalizeLiveSession(sessionId)) ?? state
}
