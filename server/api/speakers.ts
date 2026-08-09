// CRUD endpoints for the persistent speaker registry.
//
// The mapping `discordUserId → { discordDisplayName, playerName,
// characterName }` is filled out by the user in the Tome of Lore tab
// and auto-populated by the multitrack upload pipeline when it parses
// per-speaker filenames from a Craig zip. The Whisper pipeline reads
// this to compose speaker tags on the SBV output. The `discordUserId`
// field name is historical — for Craig-derived speakers it holds the
// Craig speaker ID; for loose-file uploads it's a synthetic ID.
//
// PUT mirrors glossary.ts: non-object body → 400. Silently-dropped
// entries (missing required `discordUserId`) → 200 with a `warnings`
// field naming the dropped count.

import express, { type Router } from 'express'
import { readJson, speakersFile, writeJson } from '../appData.js'
import { slog } from '../lib/slog.js'

export type Speaker = {
  discordUserId: string
  discordDisplayName?: string
  playerName: string
  characterName: string
}

export type SpeakersDocument = {
  version: 1
  speakers: Speaker[]
}

const SEED: SpeakersDocument = {
  version: 1,
  speakers: [],
}

function sanitize(input: unknown): SpeakersDocument {
  const raw = (input ?? {}) as Partial<SpeakersDocument>
  const speakers: Speaker[] = Array.isArray(raw.speakers)
    ? raw.speakers
        .filter((s): s is Speaker =>
          !!s && typeof (s as Speaker).discordUserId === 'string'
        )
        .map((s) => ({
          discordUserId: s.discordUserId.trim(),
          discordDisplayName:
            typeof s.discordDisplayName === 'string' && s.discordDisplayName.trim()
              ? s.discordDisplayName.trim()
              : undefined,
          playerName: typeof s.playerName === 'string' ? s.playerName : '',
          characterName: typeof s.characterName === 'string' ? s.characterName : '',
        }))
        .filter((s) => s.discordUserId.length > 0)
    : []
  return { version: 1, speakers }
}

async function loadOrSeed(): Promise<SpeakersDocument> {
  const file = speakersFile()
  const existing = await readJson<SpeakersDocument | null>(file, null)
  if (existing) return sanitize(existing)
  await writeJson(file, SEED)
  return SEED
}

export function speakersRouter(): Router {
  const router = express.Router()

  router.get('/', async (_req, res) => {
    try {
      const doc = await loadOrSeed()
      res.json(doc)
    } catch (err) {
      console.error('[api/speakers GET] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  router.put('/', async (req, res) => {
    try {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        slog('speakers', {
          event: 'putSpeakers_rejected',
          field: '_root',
          received: typeof req.body,
        })
        res.status(400).json({
          error: 'Request body must be a JSON object',
          field: '_root',
          received: typeof req.body,
        })
        return
      }
      const sanitized = sanitize(req.body)
      await writeJson(speakersFile(), sanitized)
      const rawSpeakers = Array.isArray((req.body as Partial<SpeakersDocument>).speakers)
        ? (req.body as SpeakersDocument).speakers.length
        : 0
      const dropped = Math.max(0, rawSpeakers - sanitized.speakers.length)
      const warnings: string[] = []
      if (dropped > 0) {
        warnings.push(
          `${dropped} speaker${dropped === 1 ? '' : 's'} were dropped because they were missing 'discordUserId' or had an empty one.`,
        )
        slog('speakers', { event: 'putSpeakers_warnings', warnings })
      }
      const response: SpeakersDocument & { warnings?: string[] } = { ...sanitized }
      if (warnings.length > 0) response.warnings = warnings
      res.json(response)
    } catch (err) {
      console.error('[api/speakers PUT] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  return router
}
