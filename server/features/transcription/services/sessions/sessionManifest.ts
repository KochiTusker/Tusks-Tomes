// Per-session manifest writer. Each transcription session lives at
// {dataDir}/sessions/{sessionId}/ with a manifest.json describing every
// participant (speaker) and every utterance. The manifest is written
// atomically and updated as utterances complete so the UI can surface
// progress in real time.
//
// Sessions originate from one of two upload pipelines today:
//
//   - Craig Bot multitrack zip — one per-speaker FLAC track per
//     participant, mapped 1:1 to ParticipantEntry rows.
//   - Loose audio files — the user uploads per-speaker WAV/MP3/FLAC/etc.
//     and labels each row by hand.
//
// In both cases the resulting on-disk shape and the manifest schema are
// identical, so the live-transcript / refinement code downstream doesn't
// care which path produced the session.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { ensureDir, sessionsRoot, writeJson, readJson } from '../../../../platform/appData.js'
import { assertValidSessionId, isValidSessionId } from '../../../../platform/validators.js'

export type UtteranceEntry = {
  utteranceId: string
  startedAtMs: number
  endedAtMs: number
  filename: string
  durationMs: number
}

export type ParticipantEntry = {
  discordUserId: string
  discordDisplayName?: string
  utterances: UtteranceEntry[]
}

/**
 * Where a transcription run is. The three in-flight states only ever
 * describe a run the server is holding in memory; read back from disk
 * after the server has forgotten the run, they mean it never reached
 * `done` or `failed`, which the live endpoint reports as `interrupted`.
 */
export type LiveRunState =
  | 'idle'
  | 'loading_model'
  | 'transcribing'
  | 'finalising'
  | 'done'
  | 'failed'
  | 'interrupted'

/** The engine behind the most recent utterance of a run. */
export type EngineSnapshot = {
  name: string
  model: string
  device: string
  computeType: string
  /** True when the utterance ran somewhere other than where the run asked. */
  fallback: boolean
  /** The GPU failure that sent the run to the CPU, when `fallback` is true. */
  fallbackReason?: string
}

/**
 * Progress persisted after every utterance. The in-memory run state is
 * forgotten when a run completes and lost when the server restarts; this
 * is what lets a finished session still report its counts, and a session
 * the server died under report that it was cut short rather than nothing.
 */
export type ProcessingProgress = {
  runState: LiveRunState
  /** Epoch ms. */
  startedAt: number | null
  /** Epoch ms of the last thing the run did. */
  lastActivityAt: number | null
  totalAudioMs: number
  /** Audio in completed utterances only. */
  processedAudioMs: number
  utterancesTotal: number
  utterancesDone: number
  engine: EngineSnapshot | null
  /** Audio seconds transcribed per second of engine time: "× realtime". */
  throughput: number | null
  /** How many utterances ran on each device. */
  devices: Record<string, number>
  failure: string | null
}

export type SessionManifest = {
  version: 1
  sessionId: string
  guildId: string
  voiceChannelId: string
  voiceChannelName: string
  startedAt: string
  endedAt: string | null
  participants: ParticipantEntry[]
  // Everything beyond `transcribedAt` and `sbvPath` is optional: manifests
  // written before runs recorded their progress carry neither, and every
  // reader must treat a missing field as "not recorded", never as an error.
  processing: {
    transcribedAt: string | null
    sbvPath: string | null
    /** Per-utterance failures and `note:` lines from the most recent run. */
    errors?: string[]
    devices?: Record<string, number>
    progress?: ProcessingProgress
  }
}

/**
 * The run state for a session the server holds nothing in memory for.
 *
 * The manifest's snapshot is the record of the last run. The three
 * in-flight states are ones only a live run can be in, so read back from
 * disk they mean the server went away mid-run. They outrank
 * `transcribedAt`, which a re-run leaves in place from the run before it,
 * because that re-run had been rewriting the SBV as it went and the
 * transcript on disk is partial. `failed` outranks it for the same reason.
 * A manifest from before snapshots existed is complete if it says it was
 * transcribed, and cut short if it recorded errors and nothing else.
 *
 * It lives here rather than in the router that first needed it because two
 * surfaces answer this question — the live view and the sessions list — and
 * a list that says "recorded" over a view that says "interrupted" is the
 * disagreement the state was added to end.
 */
export function deriveRunState(manifest: SessionManifest | null): LiveRunState {
  if (!manifest) return 'idle'
  const progress = manifest.processing.progress
  if (progress?.runState === 'failed') return 'failed'
  const hasUtterances = manifest.participants.some((p) => p.utterances.length > 0)
  if (!hasUtterances) return 'idle'
  if (progress) {
    if (
      progress.runState === 'loading_model' ||
      progress.runState === 'transcribing' ||
      progress.runState === 'finalising'
    ) {
      return 'interrupted'
    }
    if (progress.runState !== 'idle') return progress.runState
  }
  if (manifest.processing.transcribedAt) return 'done'
  if (!progress && (manifest.processing.errors?.length ?? 0) > 0) return 'interrupted'
  return 'idle'
}

// Each of these composes the sessionId into a filesystem path. Routes
// SHOULD validate via isValidSessionId before they get here, but we
// fail closed at the definition so a future caller that forgets still
// can't walk out of sessionsRoot via "../" — turning a missed
// validation into a 400, not arbitrary-directory traversal.
export function sessionDir(sessionId: string): string {
  assertValidSessionId(sessionId)
  return path.join(sessionsRoot(), sessionId)
}

export function audioDir(sessionId: string, discordUserId: string): string {
  return path.join(sessionDir(sessionId), 'audio', discordUserId)
}

export function manifestPath(sessionId: string): string {
  return path.join(sessionDir(sessionId), 'manifest.json')
}

export async function initManifest(args: {
  sessionId: string
  guildId: string
  voiceChannelId: string
  voiceChannelName: string
  startedAt: string
}): Promise<SessionManifest> {
  const manifest: SessionManifest = {
    version: 1,
    sessionId: args.sessionId,
    guildId: args.guildId,
    voiceChannelId: args.voiceChannelId,
    voiceChannelName: args.voiceChannelName,
    startedAt: args.startedAt,
    endedAt: null,
    participants: [],
    processing: { transcribedAt: null, sbvPath: null },
  }
  await ensureDir(sessionDir(args.sessionId))
  await writeJson(manifestPath(args.sessionId), manifest)
  return manifest
}

export async function readManifest(sessionId: string): Promise<SessionManifest | null> {
  const doc = await readJson<SessionManifest | null>(manifestPath(sessionId), null)
  return doc
}

export async function listSessions(): Promise<SessionManifest[]> {
  const root = sessionsRoot()
  try {
    const ids = await fs.readdir(root)
    const out: SessionManifest[] = []
    for (const id of ids) {
      // The assert in sessionDir() would throw on a non-conforming
      // entry (e.g. a stray file left by some other process). Skip it
      // here so a single junk entry doesn't break the whole listing.
      if (!isValidSessionId(id)) continue
      const manifest = await readManifest(id)
      if (manifest) out.push(manifest)
    }
    out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
    return out
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

export async function deleteSession(sessionId: string): Promise<void> {
  const dir = sessionDir(sessionId)
  await fs.rm(dir, { recursive: true, force: true })
}
