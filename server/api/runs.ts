// On-disk run checkpoints for the pause/resume feature.
//
// Each {configDir}/runs/{runId}.json is a full RunCheckpoint payload
// (schema in src/lib/runCheckpoint.ts). The endpoints here let the client
// list summaries, read a full checkpoint to resume, write a new
// checkpoint, and delete one after a successful completion.
//
// We refuse writes over MAX_CHECKPOINT_BYTES so a runaway transcript or
// chronicle can't fill the user's disk silently. The client falls back to
// localStorage-only mode when this happens.

import express, { type Router } from 'express'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { ensureDir, readJson, runCheckpointFile, runsDir, writeJson } from '../appData.js'
import { isValidRunId } from '../lib/validators.js'

/** 20 MB cap — a 3hr session's transcript + chronicle measures in the
 *  low MB, well within budget. The cap is mostly a guard against
 *  pathological inputs (multi-day campaigns) silently exhausting the
 *  user's config disk. */
const MAX_CHECKPOINT_BYTES = 20 * 1024 * 1024

type CheckpointPhaseId = 1 | 2 | 3 | 4 | 6

type RunCheckpointSummary = {
  runId: string
  schemaVersion: number
  createdAt: string
  pausedAt: string
  pausedReason: string
  campaign: string
  sessionNumber: number
  progress: {
    phase: CheckpointPhaseId
    chunkIndex: number
    totalChunks: number
  }
}

const VALID_PHASES: ReadonlySet<CheckpointPhaseId> = new Set([1, 2, 3, 4, 6])

/** Reason a checkpoint file was rejected, for the server-side warning log
 *  and for any future client-side surfacing. The list endpoint omits
 *  rejected files entirely (rather than fabricating defaults) — that's
 *  the fix for Phase I bug #5, where ghost cards appeared in the Resume
 *  banner because the list endpoint fabricated `pausedAt: ""` etc. for
 *  files that the detail endpoint then 404'd. */
type RejectionReason =
  | 'not-an-object'
  | 'missing-createdAt'
  | 'missing-pausedAt'
  | 'missing-progress'
  | 'invalid-phase'
  // Covers any failure reading or parsing the file: a UTF-8 BOM prefix
  // from a text editor's default save, a half-written file from a power
  // cut mid-checkpoint, a hand-edit with a typo, or a permission glitch.
  // Without this branch the list endpoint crashed with HTTP 500 and the
  // user lost visibility of every legitimate paused run sitting next to
  // the bad one.
  | 'unreadable'

function summariseOrReject(
  runId: string,
  raw: unknown,
): { ok: true; summary: RunCheckpointSummary } | { ok: false; reason: RejectionReason } {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'not-an-object' }
  const r = raw as Record<string, unknown>
  // Required fields — without these the Resume banner can't render a
  // meaningful card and clicking Resume will 404 against /api/runs/:id.
  if (typeof r.createdAt !== 'string' || r.createdAt.length === 0) {
    return { ok: false, reason: 'missing-createdAt' }
  }
  if (typeof r.pausedAt !== 'string' || r.pausedAt.length === 0) {
    return { ok: false, reason: 'missing-pausedAt' }
  }
  if (!r.progress || typeof r.progress !== 'object') {
    return { ok: false, reason: 'missing-progress' }
  }
  const progress = r.progress as Record<string, unknown>
  const phaseRaw = progress.phase
  if (typeof phaseRaw !== 'number' || !VALID_PHASES.has(phaseRaw as CheckpointPhaseId)) {
    return { ok: false, reason: 'invalid-phase' }
  }
  const refinement = (r.refinementState ?? {}) as Record<string, unknown>
  return {
    ok: true,
    summary: {
      runId,
      schemaVersion: typeof r.schemaVersion === 'number' ? r.schemaVersion : 0,
      createdAt: r.createdAt,
      pausedAt: r.pausedAt,
      pausedReason: typeof r.pausedReason === 'string' ? r.pausedReason : 'user',
      campaign: typeof refinement.campaign === 'string' ? refinement.campaign : '',
      sessionNumber: typeof refinement.sessionNumber === 'number' ? refinement.sessionNumber : 0,
      progress: {
        phase: phaseRaw as CheckpointPhaseId,
        chunkIndex: typeof progress.chunkIndex === 'number' ? progress.chunkIndex : 0,
        totalChunks: typeof progress.totalChunks === 'number' ? progress.totalChunks : 0,
      },
    },
  }
}

export function runsRouter(): Router {
  const router = express.Router()

  // Generous body parser — checkpoints carry the full transcript +
  // chronicle. Cap at MAX_CHECKPOINT_BYTES + 1 so requests over the limit
  // are rejected here rather than silently truncated.
  const jsonParser = express.json({ limit: `${MAX_CHECKPOINT_BYTES}b` })

  router.get('/', async (_req, res) => {
    try {
      const dir = runsDir()
      try {
        const entries = await fs.readdir(dir)
        const summaries: RunCheckpointSummary[] = []
        const skipped: Array<{ runId: string; reason: RejectionReason }> = []
        for (const entry of entries) {
          if (!entry.endsWith('.json')) continue
          const runId = entry.slice(0, -'.json'.length)
          if (!isValidRunId(runId)) continue
          try {
            const raw = await readJson<unknown>(path.join(dir, entry), null)
            const result = summariseOrReject(runId, raw)
            if (result.ok) {
              summaries.push(result.summary)
            } else {
              skipped.push({ runId, reason: result.reason })
            }
          } catch {
            // readJson rethrows on SyntaxError / EACCES / EISDIR. Treat
            // any per-entry failure as a skipped malformed checkpoint —
            // don't let one bad file crash the whole list response.
            skipped.push({ runId, reason: 'unreadable' })
          }
        }
        // Most recent paused first — that's what the banner highlights.
        summaries.sort((a, b) => b.pausedAt.localeCompare(a.pausedAt))
        if (skipped.length > 0) {
          // The malformed-checkpoint case shouldn't happen via the normal
          // pause flow (PUT writes the full schema), so a non-empty
          // skipped list almost always indicates an interrupted write,
          // disk corruption, or a hand-edited file. Log loudly so the
          // diagnose bundle captures it; the next /api/runs read will
          // re-evaluate after the user (or a script) cleans up.
          console.warn(
            `[api/runs GET] skipped ${skipped.length} malformed checkpoint(s):`,
            skipped,
          )
        }
        res.json({ runs: summaries })
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          res.json({ runs: [] })
          return
        }
        throw err
      }
    } catch (err) {
      console.error('[api/runs GET] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  router.get('/:id', async (req, res) => {
    const id = req.params.id
    if (!isValidRunId(id)) {
      res.status(400).json({ error: 'invalid runId' })
      return
    }
    try {
      let data: unknown
      try {
        data = await readJson<unknown>(runCheckpointFile(id), null)
      } catch {
        // Parse / read failure on an existing file. Match the list
        // endpoint's behaviour: present as not-found so the client falls
        // back to its localStorage-only path instead of surfacing a 500.
        console.warn(`[api/runs GET :id] checkpoint ${id} is unreadable; treating as not found`)
        res.status(404).json({ error: 'not found' })
        return
      }
      if (!data) {
        res.status(404).json({ error: 'not found' })
        return
      }
      // Mirror the list endpoint's structural validation: a parseable-but-
      // schema-broken file (missing createdAt / pausedAt / progress, or an
      // out-of-range phase) used to flow straight through here as a 200
      // with malformed body. The client's `loadRun` casts the response to
      // `RunCheckpoint` without runtime validation, so resuming on a bad
      // checkpoint surfaced as a property-access crash several layers
      // deep. Reject here so the client falls back to localStorage-only,
      // matching the list endpoint's behaviour (excludes malformed files).
      const validated = summariseOrReject(id, data)
      if (!validated.ok) {
        console.warn(`[api/runs GET :id] checkpoint ${id} rejected (${validated.reason}); treating as not found`)
        res.status(404).json({ error: 'not found' })
        return
      }
      res.json(data)
    } catch (err) {
      console.error('[api/runs GET :id] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  router.put('/:id', jsonParser, async (req, res) => {
    const id = req.params.id
    if (!isValidRunId(id)) {
      res.status(400).json({ error: 'invalid runId' })
      return
    }
    try {
      const body = req.body
      // express.json validates the parse — size cap is enforced by the
      // body-parser at the limit option above. Re-check the serialised
      // size as a belt-and-braces guard.
      const serialised = JSON.stringify(body)
      if (serialised.length > MAX_CHECKPOINT_BYTES) {
        res.status(413).json({
          error: `checkpoint exceeds ${MAX_CHECKPOINT_BYTES} bytes; localStorage-only fallback recommended`,
        })
        return
      }
      await ensureDir(runsDir())
      await writeJson(runCheckpointFile(id), body)
      res.json({ ok: true, runId: id })
    } catch (err) {
      const code = (err as { type?: string }).type
      if (code === 'entity.too.large') {
        res.status(413).json({ error: 'checkpoint too large' })
        return
      }
      console.error('[api/runs PUT] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  router.delete('/:id', async (req, res) => {
    const id = req.params.id
    if (!isValidRunId(id)) {
      res.status(400).json({ error: 'invalid runId' })
      return
    }
    try {
      await fs.unlink(runCheckpointFile(id))
      res.json({ ok: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // Idempotent — already gone is success.
        res.json({ ok: true })
        return
      }
      console.error('[api/runs DELETE] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  return router
}
