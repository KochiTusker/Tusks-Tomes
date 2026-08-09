// Pre-transcription stage of the multitrack upload pipeline.
//
// Takes the raw uploaded blob (one or more Craig zips, a generic zip of
// WAV/FLAC files, or a set of loose audio files) and lays it out as a
// canonical "session directory":
//
//   {dataDir}/sessions/{sessionId}/
//     manifest.json
//     audio/<speakerId>/<utteranceId>.<ext>
//
// Multi-chunk support: each .zip in the upload becomes one ordered chunk
// (e.g. four 1-hour Craig zips of the same TTRPG session). Within a chunk
// every speaker's track starts at the same chunk-relative time. Across
// chunks, speakers with the same speakerId (e.g. same Craig Discord user
// ID across all zips) are merged into one participant in the manifest,
// with utterance.startedAtMs offset by the cumulative duration of the
// previous chunks. The downstream pipeline (transcribeExistingSession in
// liveQueue.ts) just reads the manifest and runs Whisper — it doesn't
// care which upload shape produced the session.
//
// Staged batch upload: `appendMultitrackUpload` (below) takes an
// existing sessionId and stitches new chunks onto the tail of that
// session's existing timeline. The starting offset for the new batch is
// derived from `max(endedAtMs)` across the manifest's existing
// utterances, so Part 2 plays immediately after Part 1 ends. Speakers
// with the same speakerId across batches are merged into the same
// manifest participant exactly the same way as cross-chunk merging
// within a single upload.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import AdmZip from 'adm-zip'
import { ensureDir } from '../appData.js'

/**
 * Zip Slip predicate. Returns true iff `entryName` resolves to a path
 * inside `workdir`. Exported so the regression test
 * (server/upload/extractMultitrack.test.ts) can import the REAL
 * predicate rather than re-implement it — a copy-paste divergence
 * between test and production was a /ship-2 Important finding.
 *
 * The single-source-of-truth predicate. Used by the production zip-
 * entry validation loop and pinned by the regression test.
 */
export function isEntrySafe(workdir: string, entryName: string): boolean {
  const resolvedWorkdir = path.resolve(workdir)
  const target = path.resolve(workdir, entryName)
  return target === resolvedWorkdir || target.startsWith(resolvedWorkdir + path.sep)
}
import {
  audioDir,
  initManifest,
  manifestPath,
  readManifest,
  sessionDir,
  type UtteranceEntry,
} from '../sessions/sessionManifest.js'
import { writeJson } from '../appData.js'

const AUDIO_EXTS = new Set(['.wav', '.flac', '.ogg', '.opus', '.mp3', '.m4a', '.aac'])

export type ExtractedTrack = {
  /** Synthetic or Craig-derived speaker ID. Stable within a session. */
  speakerId: string
  /** Filename-derived display name shown in the UI. */
  displayName: string
  /** Path to the audio file relative to the session's audio directory. */
  filename: string
  /** Detected duration in milliseconds. 0 if probe failed. */
  durationMs: number
  /** Chunk index this track belongs to. 0 for single-chunk uploads. */
  chunkIndex: number
}

export type ExtractedChunk = {
  /** 0-based order in which the chunk was processed. */
  index: number
  /** Where this chunk starts in session-relative time. */
  startedAtMs: number
  /** Chunk duration (max of its speakers' track durations). */
  durationMs: number
  /** Display label — zip filename or "Loose files". */
  label: string
  /** Tracks within this chunk. */
  tracks: ExtractedTrack[]
}

export type ExtractResult = {
  sessionId: string
  chunks: ExtractedChunk[]
  /** Flat track list across all chunks, for the legacy single-chunk UI path. */
  tracks: ExtractedTrack[]
  /** Total session duration in ms after this batch was stitched on. */
  totalDurationMs: number
}

export async function extractMultitrackUpload(args: {
  inputs: Array<{ path: string; originalName: string }>
  voiceChannelName?: string
  displayNameOverrides?: Record<string, string>
  /**
   * Order in which to process the uploaded files. Each string matches an
   * `originalName` in `inputs`. If absent, the upload order is used.
   * Affects only zips — loose audio files (if any) always form one
   * chunk at the position they appear in this list (or first if not
   * listed).
   */
  fileOrder?: string[]
}): Promise<ExtractResult> {
  const sessionId = randomUUID()
  await initManifest({
    sessionId,
    // Manifest carries guild/channel ID fields from earlier schema
    // versions. Uploads don't have either — leave them empty so
    // listSessions still works against any pre-existing on-disk sessions.
    guildId: '',
    voiceChannelId: '',
    voiceChannelName: args.voiceChannelName?.trim() || 'Uploaded session',
    startedAt: new Date().toISOString(),
  })

  try {
    return await ingestBatch({
      sessionId,
      inputs: args.inputs,
      displayNameOverrides: args.displayNameOverrides,
      fileOrder: args.fileOrder,
      startOffsetMs: 0,
      chunkIndexOffset: 0,
    })
  } catch (err) {
    // Roll back the session dir if the FIRST batch produced no audio.
    // For append mode (below) we leave the existing session intact on a
    // failed append.
    await fs.rm(sessionDir(sessionId), { recursive: true, force: true }).catch(() => undefined)
    throw err
  }
}

/**
 * Append another batch of audio files onto the tail of an existing
 * session's timeline. The new chunks start at `max(endedAtMs)` across
 * the manifest's existing utterances, so playback (and the merged SBV)
 * stays continuous across batches.
 *
 * Throws if the session doesn't exist or if it's already been
 * transcribed (we won't quietly mutate finalised data).
 */
export async function appendMultitrackUpload(args: {
  sessionId: string
  inputs: Array<{ path: string; originalName: string }>
  displayNameOverrides?: Record<string, string>
  fileOrder?: string[]
}): Promise<ExtractResult> {
  const manifest = await readManifest(args.sessionId)
  if (!manifest) {
    throw new Error(`Session ${args.sessionId} not found — start a new upload instead of appending.`)
  }
  if (manifest.processing.sbvPath || manifest.processing.transcribedAt) {
    throw new Error(`Session ${args.sessionId} has already been transcribed — appending more audio would invalidate the existing SBV. Start a new session.`)
  }
  const startOffsetMs = computeManifestEndMs(manifest)
  const chunkIndexOffset = countExistingChunks(manifest)

  return ingestBatch({
    sessionId: args.sessionId,
    inputs: args.inputs,
    displayNameOverrides: args.displayNameOverrides,
    fileOrder: args.fileOrder,
    startOffsetMs,
    chunkIndexOffset,
  })
}

async function ingestBatch(args: {
  sessionId: string
  inputs: Array<{ path: string; originalName: string }>
  displayNameOverrides?: Record<string, string>
  fileOrder?: string[]
  startOffsetMs: number
  chunkIndexOffset: number
}): Promise<ExtractResult> {
  if (args.inputs.length === 0) {
    throw new Error('No files uploaded.')
  }

  // Partition into chunks. A chunk is either:
  //   - one .zip file (extracted to a workdir, audio files inside)
  //   - the group of all loose audio files (treated as one chunk together)
  // Order: respect args.fileOrder where present, otherwise upload order.
  const orderedInputs = orderInputs(args.inputs, args.fileOrder)
  const chunkGroups: Array<
    | { kind: 'zip'; input: { path: string; originalName: string } }
    | { kind: 'loose'; inputs: Array<{ path: string; originalName: string }> }
  > = []
  const looseBuffer: Array<{ path: string; originalName: string }> = []
  for (const input of orderedInputs) {
    if (/\.zip$/i.test(input.originalName)) {
      if (looseBuffer.length > 0) {
        chunkGroups.push({ kind: 'loose', inputs: [...looseBuffer] })
        looseBuffer.length = 0
      }
      chunkGroups.push({ kind: 'zip', input })
    } else {
      looseBuffer.push(input)
    }
  }
  if (looseBuffer.length > 0) {
    chunkGroups.push({ kind: 'loose', inputs: looseBuffer })
  }

  if (chunkGroups.length === 0) {
    throw new Error('No files uploaded.')
  }

  const { sessionId } = args
  const overrides = normalizeOverrides(args.displayNameOverrides)
  const allChunks: ExtractedChunk[] = []
  const flatTracks: ExtractedTrack[] = []
  const workdirs: string[] = []
  let cumulativeMs = args.startOffsetMs

  try {
    for (let localIndex = 0; localIndex < chunkGroups.length; localIndex++) {
      const chunkIndex = args.chunkIndexOffset + localIndex
      const group = chunkGroups[localIndex]
      // Resolve the candidate audio files for this chunk.
      let candidates: Array<{ absPath: string; originalName: string }> = []
      let chunkLabel: string
      if (group.kind === 'zip') {
        const workdir = path.join(
          path.dirname(group.input.path),
          `unzip-${randomUUID().slice(0, 8)}`
        )
        await ensureDir(workdir)
        workdirs.push(workdir)
        const zip = new AdmZip(group.input.path)
        // Zip Slip defence (CVE class). adm-zip claims internal
        // protection but we verify explicitly: every entry's resolved
        // target must remain inside workdir. A malicious craig.zip with
        // an entry like `../../escape.flac` would otherwise write outside
        // the temp directory we just created.
        for (const entry of zip.getEntries()) {
          if (!isEntrySafe(workdir, entry.entryName)) {
            throw new Error(
              `Zip entry escapes workdir: ${entry.entryName} (resolves outside ${path.resolve(workdir)})`,
            )
          }
        }
        zip.extractAllTo(workdir, /* overwrite */ true)
        candidates = await listAudioFilesIn(workdir)
        chunkLabel = group.input.originalName
      } else {
        candidates = group.inputs.map((i) => ({
          absPath: i.path,
          originalName: i.originalName,
        }))
        chunkLabel = `Loose files (${group.inputs.length})`
      }
      const audioFiles = candidates.filter((c) =>
        AUDIO_EXTS.has(path.extname(c.originalName).toLowerCase())
      )
      if (audioFiles.length === 0) {
        // A chunk with no audio is weird but not fatal — skip it.
        allChunks.push({
          index: chunkIndex,
          startedAtMs: cumulativeMs,
          durationMs: 0,
          label: chunkLabel,
          tracks: [],
        })
        continue
      }

      const chunkTracks: ExtractedTrack[] = []
      let chunkDurationMs = 0
      for (const candidate of audioFiles) {
        const parsed = parseSpeakerFromFilename(candidate.originalName)
        const overrideKey = candidate.originalName.toLowerCase()
        const displayName = overrides[overrideKey]?.trim() || parsed.displayName
        const speakerId = parsed.speakerId
        const ext = path.extname(candidate.originalName).toLowerCase()
        const utteranceId = `u_${randomUUID().slice(0, 8)}`
        const targetDir = audioDir(sessionId, speakerId)
        await ensureDir(targetDir)
        const targetFilename = `${utteranceId}${ext}`
        const targetPath = path.join(targetDir, targetFilename)
        await moveOrCopy(candidate.absPath, targetPath)

        const durationMs = await probeDurationMs(targetPath).catch(() => 0)
        if (durationMs > chunkDurationMs) chunkDurationMs = durationMs

        const utterance: UtteranceEntry = {
          utteranceId,
          startedAtMs: cumulativeMs,
          endedAtMs: cumulativeMs + durationMs,
          filename: targetFilename,
          durationMs,
        }
        await appendTrackToManifest(sessionId, {
          discordUserId: speakerId,
          discordDisplayName: displayName,
          utterance,
        })

        const track: ExtractedTrack = {
          speakerId,
          displayName,
          filename: targetFilename,
          durationMs,
          chunkIndex,
        }
        chunkTracks.push(track)
        flatTracks.push(track)
      }

      allChunks.push({
        index: chunkIndex,
        startedAtMs: cumulativeMs,
        durationMs: chunkDurationMs,
        label: chunkLabel,
        tracks: chunkTracks,
      })
      cumulativeMs += chunkDurationMs
    }
  } finally {
    // Best-effort cleanup of zip workdirs whether the loop succeeded or not.
    for (const wd of workdirs) {
      await fs.rm(wd, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  if (flatTracks.length === 0) {
    throw new Error('No audio files found in the upload (expected .wav, .flac, .ogg, .opus, .mp3, .m4a, or .aac).')
  }

  return {
    sessionId,
    chunks: allChunks,
    tracks: flatTracks,
    totalDurationMs: cumulativeMs,
  }
}

/**
 * Highest `endedAtMs` across every utterance in the manifest. Used as
 * the next batch's start offset so Part 2 plays immediately after
 * Part 1. Returns 0 for empty manifests.
 */
function computeManifestEndMs(manifest: { participants: Array<{ utterances: Array<{ endedAtMs: number }> }> }): number {
  let max = 0
  for (const p of manifest.participants) {
    for (const u of p.utterances) {
      if (u.endedAtMs > max) max = u.endedAtMs
    }
  }
  return max
}

/**
 * Best-effort count of existing chunks in a manifest, used to assign
 * sequential chunkIndex values across batches so the UI can render a
 * stable batch label per chunk. The manifest doesn't directly store
 * chunk boundaries (utterances are flat per participant), so we
 * approximate using distinct startedAtMs values across participants —
 * each unique start time corresponds to one chunk's start.
 */
function countExistingChunks(manifest: { participants: Array<{ utterances: Array<{ startedAtMs: number }> }> }): number {
  const starts = new Set<number>()
  for (const p of manifest.participants) {
    for (const u of p.utterances) starts.add(u.startedAtMs)
  }
  return starts.size
}

function orderInputs(
  inputs: Array<{ path: string; originalName: string }>,
  fileOrder: string[] | undefined
): Array<{ path: string; originalName: string }> {
  if (!fileOrder || fileOrder.length === 0) return inputs
  const byName = new Map<string, { path: string; originalName: string }>()
  for (const input of inputs) byName.set(input.originalName, input)
  const ordered: Array<{ path: string; originalName: string }> = []
  const used = new Set<string>()
  for (const name of fileOrder) {
    const hit = byName.get(name)
    if (hit && !used.has(name)) {
      ordered.push(hit)
      used.add(name)
    }
  }
  // Append anything the client didn't mention (defensive — shouldn't happen)
  // so we don't silently drop uploads.
  for (const input of inputs) {
    if (!used.has(input.originalName)) ordered.push(input)
  }
  return ordered
}

async function listAudioFilesIn(
  rootDir: string
): Promise<Array<{ absPath: string; originalName: string }>> {
  const out: Array<{ absPath: string; originalName: string }> = []
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(abs)
      } else if (entry.isFile()) {
        out.push({ absPath: abs, originalName: entry.name })
      }
    }
  }
  await walk(rootDir)
  return out
}

/**
 * Filename conventions we recognise:
 *   - Craig 2.x:  "1-{username}_{discriminator}.flac" (or with discord user id)
 *   - Craig (newer): "{discordUserId}-{username}.flac"
 *   - Generic:    "{displayName}.{ext}"
 *
 * Strategy: if the stem starts with a numeric token followed by separator,
 * strip the numeric prefix and treat the rest as the display name. The
 * numeric prefix (Craig track index or Discord user ID) becomes the speaker
 * ID so downstream code can keep its `discordUserId`-keyed maps. If no
 * numeric prefix, we synthesise a stable ID from the display name so the
 * same speaker across chunks merges into one participant.
 */
export function parseSpeakerFromFilename(originalName: string): {
  speakerId: string
  displayName: string
} {
  const stem = originalName.replace(/\.[^./\\]+$/, '')
  const numericPrefix = stem.match(/^(\d+)[-_](.+)$/)
  if (numericPrefix) {
    const id = numericPrefix[1]
    const name = numericPrefix[2].trim() || 'Unnamed'
    return { speakerId: id, displayName: name }
  }
  const synthetic = `u_${hashAscii(stem.toLowerCase())}`
  return { speakerId: synthetic, displayName: stem.trim() || 'Unnamed' }
}

function normalizeOverrides(input: Record<string, string> | undefined): Record<string, string> {
  if (!input) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string') out[k.toLowerCase()] = v
  }
  return out
}

function hashAscii(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
  }
  return h.toString(16)
}

async function moveOrCopy(from: string, to: string): Promise<void> {
  try {
    await fs.rename(from, to)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      await fs.copyFile(from, to)
      await fs.unlink(from).catch(() => undefined)
    } else {
      throw err
    }
  }
}

async function appendTrackToManifest(
  sessionId: string,
  args: {
    discordUserId: string
    discordDisplayName?: string
    utterance: UtteranceEntry
  }
): Promise<void> {
  const manifest = await readManifest(sessionId)
  if (!manifest) throw new Error(`Manifest not found for session ${sessionId}`)
  let participant = manifest.participants.find((p) => p.discordUserId === args.discordUserId)
  if (!participant) {
    participant = {
      discordUserId: args.discordUserId,
      discordDisplayName: args.discordDisplayName,
      utterances: [],
    }
    manifest.participants.push(participant)
  } else if (args.discordDisplayName && !participant.discordDisplayName) {
    participant.discordDisplayName = args.discordDisplayName
  }
  participant.utterances.push(args.utterance)
  await writeJson(manifestPath(sessionId), manifest)
}

async function probeDurationMs(audioPath: string): Promise<number> {
  const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg'
  return new Promise<number>((resolve) => {
    const child = spawn(ffmpegPath, ['-hide_banner', '-i', audioPath], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    const chunks: Buffer[] = []
    child.stderr.on('data', (b: Buffer) => chunks.push(b))
    child.on('error', () => resolve(0))
    child.on('close', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      const m = text.match(/Duration:\s+(\d+):(\d+):(\d+)(?:\.(\d+))?/)
      if (!m) return resolve(0)
      const hh = Number(m[1])
      const mm = Number(m[2])
      const ss = Number(m[3])
      const frac = m[4] ? Number(`0.${m[4]}`) : 0
      resolve(Math.round(((hh * 3600 + mm * 60 + ss) + frac) * 1000))
    })
  })
}

/** Mark the session "processed" by setting processing.transcribedAt + sbvPath. */
export async function markSessionFinalized(sessionId: string): Promise<void> {
  const m = await readManifest(sessionId)
  if (!m) return
  m.endedAt = m.endedAt ?? new Date().toISOString()
  m.processing = {
    transcribedAt: new Date().toISOString(),
    sbvPath: 'session.sbv',
  }
  await writeJson(manifestPath(sessionId), m)
}

export async function cleanupSessionDir(sessionId: string): Promise<void> {
  await fs.rm(sessionDir(sessionId), { recursive: true, force: true }).catch(() => undefined)
}

/**
 * Delete only the audio/ subdirectory. Keeps manifest.json, session.sbv,
 * and per-utterance transcripts/. Used by the "Delete audio (keep
 * transcript)" button on the Sessions tab to reclaim disk space without
 * losing the chronicle input.
 */
export async function deleteSessionAudio(sessionId: string): Promise<number> {
  const audioRoot = path.join(sessionDir(sessionId), 'audio')
  const bytes = await directorySizeBytes(audioRoot).catch(() => 0)
  await fs.rm(audioRoot, { recursive: true, force: true }).catch(() => undefined)
  return bytes
}

async function directorySizeBytes(dir: string): Promise<number> {
  let total = 0
  async function walk(d: string): Promise<void> {
    const entries = await fs.readdir(d, { withFileTypes: true })
    for (const entry of entries) {
      const abs = path.join(d, entry.name)
      if (entry.isDirectory()) {
        await walk(abs)
      } else if (entry.isFile()) {
        const stat = await fs.stat(abs)
        total += stat.size
      }
    }
  }
  try {
    await walk(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw err
  }
  return total
}
