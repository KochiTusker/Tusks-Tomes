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
import { ensureDir, glossaryFile, readJson, speakersFile, writeJson } from '../appData.js'
import { findSpeakerFor } from '../lib/speakerIdentity.js'
import {
  audioDir,
  manifestPath,
  readManifest,
  sessionDir,
  type SessionManifest,
  type UtteranceEntry,
} from '../sessions/sessionManifest.js'
import { buildInitialPrompt, transcribeFile, type Segment } from './invoke.js'

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
  /** Utterances that errored during transcription. */
  errors: string[]
  startedAt: number
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

export function subscribeLive(fn: (sessionId: string) => void): () => void {
  subscribers.add(fn)
  return () => subscribers.delete(fn)
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

async function processItem(item: QueueItem): Promise<void> {
  const state = sessions.get(item.sessionId)
  if (!state) {
    console.warn(`[liveQueue] dropping utterance for unknown session ${item.sessionId}`)
    return
  }
  const tag = `${item.participant.discordUserId}/${item.utterance.utteranceId}`
  console.log(`[liveQueue] start ${tag} (${item.audioPath})`)
  try {
    const speakers = await loadSpeakers()
    const speakerDisplay = speakerDisplayFor(
      item.participant.discordUserId,
      item.participant.discordDisplayName,
      speakers
    )
    // GPU goes through the persistent worker (see server/whisper/worker.ts),
    // which loads the model once per server lifetime — that alone eliminates
    // the cuDNN re-init crash class (STATUS_STACK_BUFFER_OVERRUN / 0xC0000409)
    // that used to bite back-to-back one-shot spawns. Two further layers of
    // safety net for the rare in-flight failure:
    //
    //   1. If GPU attempt #1 throws (e.g. the worker process died
    //      mid-request), retry on GPU once. The worker auto-restarts on
    //      the next call, so attempt #2 hits a fresh Python process and
    //      a freshly loaded model — most transient cuDNN faults clear here.
    //
    //   2. If GPU attempt #2 also fails, fall back to a CPU one-shot.
    //      ~6-10x slower but doesn't touch cuDNN at all.
    //
    // The utterance only gets marked errored after all three fail.
    let result: Awaited<ReturnType<typeof transcribeFile>>
    const baseRequest = {
      audio: item.audioPath,
      speakerId: item.participant.discordUserId,
      speakerDisplay,
      initialPrompt: state.initialPrompt,
    }
    try {
      result = await transcribeFile(baseRequest)
    } catch (gpuErr1) {
      const msg1 = (gpuErr1 as Error).message.split('\n')[0]
      console.warn(`[liveQueue] retry ${tag} on GPU after failure: ${msg1}`)
      try {
        result = await transcribeFile(baseRequest)
      } catch (gpuErr2) {
        const msg2 = (gpuErr2 as Error).message.split('\n')[0]
        console.warn(`[liveQueue] retry ${tag} on CPU after GPU failure: ${msg2}`)
        result = await transcribeFile({
          ...baseRequest,
          device: 'cpu',
          computeType: 'int8',
        })
      }
    }
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
    console.log(
      `[liveQueue] done  ${tag} — ${result.segments.length} segments in ${result.elapsedMs}ms`
    )
  } catch (err) {
    const message = `${tag}: ${(err as Error).message}`
    console.error('[liveQueue] FAIL', message)
    state.errors.push(message)
    // Persist into the manifest so the error survives the in-memory
    // state being forgotten after finalize. Best-effort — if the manifest
    // write fails we still have the console log.
    try {
      const manifest = await readManifest(item.sessionId)
      if (manifest) {
        const existing = (manifest.processing as { errors?: string[] }).errors ?? []
        const next = {
          ...manifest,
          processing: {
            ...manifest.processing,
            errors: [...existing, message],
          },
        }
        await writeJson(manifestPath(item.sessionId), next)
      }
    } catch (persistErr) {
      console.warn('[liveQueue] failed to persist error to manifest:', persistErr)
    }
  } finally {
    state.pending = Math.max(0, state.pending - 1)
    state.processedUtterances += 1
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

/** Initialise live state for a session that just started recording. */
export async function startLiveSession(manifest: SessionManifest): Promise<void> {
  if (sessions.has(manifest.sessionId)) return
  const initialPrompt = await buildBiasPrompt().catch(() => '')
  const state: LiveSessionState = {
    sessionId: manifest.sessionId,
    active: true,
    initialPrompt,
    participants: new Map(),
    segments: [],
    processedUtterances: 0,
    pending: 0,
    enqueued: 0,
    errors: [],
    startedAt: Date.now(),
  }
  sessions.set(manifest.sessionId, state)
  notify(manifest.sessionId)
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
    await new Promise((r) => setTimeout(r, 200))
  }

  const manifest = await readManifest(sessionId)
  if (manifest) {
    manifest.processing = {
      transcribedAt: new Date().toISOString(),
      sbvPath: 'session.sbv',
    }
    await writeJson(manifestPath(sessionId), manifest)
  }
  await rewriteSbv(state)
  notify(sessionId)
  return state
}

/** Drop in-memory state. Disk artifacts are preserved. */
export function forgetLiveSession(sessionId: string): void {
  sessions.delete(sessionId)
}

export function getLiveSessionState(sessionId: string): LiveSessionState | undefined {
  return sessions.get(sessionId)
}

export function listActiveLiveSessions(): LiveSessionState[] {
  return Array.from(sessions.values()).filter((s) => s.active)
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
  const manifest = await readManifest(sessionId)
  if (!manifest) throw new Error(`session ${sessionId} not found`)
  let state = sessions.get(sessionId)
  if (!state) {
    await startLiveSession(manifest)
    state = sessions.get(sessionId)!
  }
  state.active = true
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
    await new Promise((r) => setTimeout(r, 200))
  }
  return (await finalizeLiveSession(sessionId)) ?? state
}
