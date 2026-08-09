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
import { ensureDir, sessionsRoot, writeJson, readJson } from '../appData.js'
import { assertValidSessionId, isValidSessionId } from '../lib/validators.js'

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

export type SessionManifest = {
  version: 1
  sessionId: string
  guildId: string
  voiceChannelId: string
  voiceChannelName: string
  startedAt: string
  endedAt: string | null
  participants: ParticipantEntry[]
  processing: {
    transcribedAt: string | null
    sbvPath: string | null
  }
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

export async function appendUtterance(
  sessionId: string,
  args: {
    discordUserId: string
    discordDisplayName?: string
    utterance: UtteranceEntry
  }
): Promise<void> {
  const manifest = (await readManifest(sessionId)) ?? null
  if (!manifest) return
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

export async function finalizeManifest(
  sessionId: string,
  endedAt: string
): Promise<void> {
  const manifest = await readManifest(sessionId)
  if (!manifest) return
  manifest.endedAt = endedAt
  await writeJson(manifestPath(sessionId), manifest)
}

export async function ensureAudioDir(sessionId: string, discordUserId: string): Promise<string> {
  const dir = audioDir(sessionId, discordUserId)
  await ensureDir(dir)
  return dir
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
