// Saved Chronicles library — server-side persistence for finished pipeline
// runs. The client auto-saves a completed run here the moment it finishes, so
// a chronicle survives page reloads, dev-server restarts, and browser-cache
// clears (the localStorage refinement_state is wiped on a new server boot).
//
// One {id}.json file per chronicle under {dataDir}/chronicle-library. The
// store is deliberately dumb: it holds opaque chronicle/extras/condensed
// payloads plus a little metadata for the library list. Separate from the
// grounding Knowledge Base (chronicles are outputs, not canonical lore inputs)
// AND from the singular /api/chronicle markdown export.

import express, { type Router } from 'express'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { chronicleLibraryDir, ensureDir, writeJson } from '../appData.js'

/** Persisted record. extras/condensed are opaque (the server doesn't need
 *  their shape — see src/types for ExtrasOutput / CondenseOutput). */
export type SavedChronicle = {
  id: string
  createdAt: string
  campaign: string
  sessionNumber: number
  provider?: string
  chronicle: string
  extras?: unknown
  condensed?: unknown
  groundedTranscript?: string
  /** Unrepaired Claude Code refusals (opaque to the server — shape in
   *  src/lib/refusalDetection RefusalRecord). Carried so the Review & Repair
   *  panel works from the library. */
  refusals?: unknown
  /** DM audit questions + answers snapshots (opaque) so a library-launched
   *  Phase 2/3 repair has the per-chunk prompt context. */
  dmQuestions?: unknown
  dmAnswers?: unknown
}

/** Summary returned by the list endpoint — no heavy content. */
export type ChronicleSummary = {
  id: string
  createdAt: string
  campaign: string
  sessionNumber: number
  provider?: string
  wordCount: number
  hasExtras: boolean
  hasCondensed: boolean
}

// Filesystem-safe id. Guards the :id routes against path traversal — only
// these characters are ever produced by makeId(), and anything else is
// rejected before it touches the filesystem.
const ID_RE = /^[A-Za-z0-9_-]+$/

function makeId(): string {
  // ISO date (colon-free) + random suffix. Sorts roughly chronologically and
  // is collision-resistant. Date/randomBytes are fine here (not a workflow).
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `${stamp}-${randomBytes(3).toString('hex')}`
}

function countWords(s: string): number {
  const t = s.trim()
  return t ? t.split(/\s+/).length : 0
}

function fileFor(id: string): string {
  return path.join(chronicleLibraryDir(), `${id}.json`)
}

async function readOne(id: string): Promise<SavedChronicle | null> {
  try {
    const buf = await fs.readFile(fileFor(id), 'utf8')
    return JSON.parse(buf) as SavedChronicle
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

function summarize(c: SavedChronicle): ChronicleSummary {
  return {
    id: c.id,
    createdAt: c.createdAt,
    campaign: c.campaign,
    sessionNumber: c.sessionNumber,
    provider: c.provider,
    wordCount: countWords(c.chronicle || ''),
    hasExtras: c.extras != null,
    hasCondensed: c.condensed != null,
  }
}

export function chronicleLibraryRouter(): Router {
  const router = express.Router()

  // List — summaries only, newest first.
  router.get('/', async (_req, res) => {
    try {
      const dir = chronicleLibraryDir()
      let names: string[]
      try {
        names = await fs.readdir(dir)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return res.json({ chronicles: [] })
        throw err
      }
      const out: ChronicleSummary[] = []
      for (const name of names) {
        if (!name.endsWith('.json')) continue
        try {
          const buf = await fs.readFile(path.join(dir, name), 'utf8')
          out.push(summarize(JSON.parse(buf) as SavedChronicle))
        } catch {
          // Skip a corrupt/partial file rather than failing the whole list.
        }
      }
      out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      res.json({ chronicles: out })
    } catch (err) {
      console.error('[api/chronicles GET] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // Full record.
  router.get('/:id', async (req, res) => {
    const id = req.params.id
    if (!ID_RE.test(id)) return res.status(400).json({ error: 'invalid id' })
    try {
      const rec = await readOne(id)
      if (!rec) return res.status(404).json({ error: 'not found' })
      res.json(rec)
    } catch (err) {
      console.error('[api/chronicles GET :id] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // Save a finished run. Returns the persisted record (with id + createdAt).
  router.post('/', async (req, res) => {
    const body = (req.body ?? {}) as Partial<SavedChronicle>
    if (typeof body.chronicle !== 'string' || !body.chronicle.trim()) {
      return res.status(400).json({ error: 'chronicle (non-empty string) is required' })
    }
    const rec: SavedChronicle = {
      id: makeId(),
      createdAt: new Date().toISOString(),
      campaign: typeof body.campaign === 'string' ? body.campaign : '',
      sessionNumber: typeof body.sessionNumber === 'number' ? body.sessionNumber : 0,
      provider: typeof body.provider === 'string' ? body.provider : undefined,
      chronicle: body.chronicle,
      extras: body.extras ?? undefined,
      condensed: body.condensed ?? undefined,
      groundedTranscript:
        typeof body.groundedTranscript === 'string' ? body.groundedTranscript : undefined,
      refusals: body.refusals ?? undefined,
      dmQuestions: body.dmQuestions ?? undefined,
      dmAnswers: body.dmAnswers ?? undefined,
    }
    try {
      await ensureDir(chronicleLibraryDir())
      await writeJson(fileFor(rec.id), rec)
      res.status(201).json(rec)
    } catch (err) {
      console.error('[api/chronicles POST] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // Update an existing record — used when extras / condensed are generated
  // after the initial save. Merges provided fields; missing fields untouched.
  router.put('/:id', async (req, res) => {
    const id = req.params.id
    if (!ID_RE.test(id)) return res.status(400).json({ error: 'invalid id' })
    try {
      const existing = await readOne(id)
      if (!existing) return res.status(404).json({ error: 'not found' })
      const body = (req.body ?? {}) as Partial<SavedChronicle>
      const merged: SavedChronicle = {
        ...existing,
        chronicle: typeof body.chronicle === 'string' && body.chronicle.trim() ? body.chronicle : existing.chronicle,
        extras: body.extras !== undefined ? body.extras : existing.extras,
        condensed: body.condensed !== undefined ? body.condensed : existing.condensed,
        groundedTranscript:
          typeof body.groundedTranscript === 'string' ? body.groundedTranscript : existing.groundedTranscript,
        refusals: body.refusals !== undefined ? body.refusals : existing.refusals,
        dmQuestions: body.dmQuestions !== undefined ? body.dmQuestions : existing.dmQuestions,
        dmAnswers: body.dmAnswers !== undefined ? body.dmAnswers : existing.dmAnswers,
      }
      await writeJson(fileFor(id), merged)
      res.json(merged)
    } catch (err) {
      console.error('[api/chronicles PUT] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  router.delete('/:id', async (req, res) => {
    const id = req.params.id
    if (!ID_RE.test(id)) return res.status(400).json({ error: 'invalid id' })
    try {
      await fs.rm(fileFor(id), { force: true })
      res.json({ ok: true })
    } catch (err) {
      console.error('[api/chronicles DELETE] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  return router
}
