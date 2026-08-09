// Session list + delete + live transcription state. The live state
// endpoint (`/api/sessions/:id/live`) is polled by the Upload panel while
// Whisper is grinding through a freshly-uploaded multitrack session so the
// UI can stream the running SBV + observed speakers.

import express, { type Router } from 'express'
import path from 'node:path'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import {
  deleteSession,
  listSessions,
  readManifest,
  sessionDir,
} from '../sessions/sessionManifest.js'
import { getLiveSessionState, refreshLiveSbv } from '../sessions/liveSessionBridge.js'
import { rejectInvalidId, safeResolveInside } from '../lib/validators.js'

// rejectInvalidId is the shared route-level guard (server/lib/validators.ts).
// Express's path-to-regexp decodes %2F / %2E inside a single :id segment
// before populating req.params.id, so a request like
//   DELETE /api/sessions/..%2F..%2Fetc
// reaches us with `req.params.id === "../../etc"`. The assertValidSessionId
// call inside sessionDir() is the defence-in-depth backstop.

export function sessionsRouter(): Router {
  const router = express.Router()

  router.get('/', async (_req, res) => {
    try {
      const sessions = await listSessions()
      res.json({ sessions })
    } catch (err) {
      console.error('[api/sessions GET] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  router.get('/:id', async (req, res) => {
    if (rejectInvalidId(req.params.id, res)) return
    try {
      const manifest = await readManifest(req.params.id)
      if (!manifest) return res.status(404).json({ error: 'not found' })
      res.json(manifest)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  router.delete('/:id', async (req, res) => {
    if (rejectInvalidId(req.params.id, res)) return
    try {
      await deleteSession(req.params.id)
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  /**
   * Live transcription state. Polled by the Upload panel every couple of
   * seconds while a session is in flight; also works for sessions that
   * have already finalised (returns the snapshot of the on-disk SBV).
   */
  router.get('/:id/live', async (req, res) => {
    if (rejectInvalidId(req.params.id, res)) return
    try {
      const sessionId = req.params.id
      const state = getLiveSessionState(sessionId)
      const manifest = await readManifest(sessionId)
      // Read the on-disk SBV. For active sessions liveQueue keeps this
      // file fresh after every utterance, so it always reflects current
      // transcription progress. For sessions where state was already
      // forgotten (e.g. server restart after recording ended) we still
      // serve whatever's on disk.
      let sbv = ''
      try {
        sbv = await readFile(path.join(sessionDir(sessionId), 'session.sbv'), 'utf8')
      } catch {
        // No SBV yet — the first utterance hasn't transcribed.
      }
      const participants = state
        ? Array.from(state.participants.entries()).map(([discordUserId, info]) => ({
            discordUserId,
            discordDisplayName: info.discordDisplayName,
          }))
        : (manifest?.participants ?? []).map((p) => ({
            discordUserId: p.discordUserId,
            discordDisplayName: p.discordDisplayName,
          }))
      // `processedUtterances` / `enqueued` are at the utterance granularity
      // (one Whisper invocation each) and drive the post-stop progress bar.
      // `segments` counts cues emitted into the SBV, which is per-Whisper-
      // segment (usually 1-3 segments per utterance).
      res.json({
        sessionId,
        active: state?.active ?? false,
        pending: state?.pending ?? 0,
        processed: state?.processedUtterances ?? 0,
        enqueued: state?.enqueued ?? 0,
        cueCount: state?.segments.length ?? 0,
        errors: state?.errors ?? [],
        participants,
        sbv,
        finalized: !!manifest?.processing.sbvPath,
      })
    } catch (err) {
      console.error('[api/sessions/:id/live] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  /**
   * Force a fresh SBV rewrite using the latest speakers.json mapping.
   * Used by the Upload panel after the user updates a participant's
   * player / character names — the cached cues get re-emitted with the
   * new labels without re-running Whisper.
   */
  router.post('/:id/live/refresh', async (req, res) => {
    if (rejectInvalidId(req.params.id, res)) return
    try {
      await refreshLiveSbv(req.params.id)
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  router.get('/:id/sbv', async (req, res) => {
    if (rejectInvalidId(req.params.id, res)) return
    try {
      const manifest = await readManifest(req.params.id)
      if (!manifest?.processing.sbvPath) {
        return res.status(404).json({ error: 'SBV not produced yet' })
      }
      // Defence-in-depth: the manifest is server-written and every code
      // path that writes it hardcodes 'session.sbv', so the resolved
      // path is stable today. But if a future caller (a migration, an
      // import flow) ever lets a user-controlled string land in
      // `processing.sbvPath`, this containment check refuses to read
      // outside the session directory.
      const root = sessionDir(req.params.id)
      const fullPath = safeResolveInside(root, manifest.processing.sbvPath)
      if (!fullPath) {
        return res.status(400).json({ error: 'malformed manifest sbvPath' })
      }
      await stat(fullPath)
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      // RFC 6266 encoded form. The id is already isValidSessionId() so
      // it's [a-zA-Z0-9_-]{1,64} — encodeURIComponent is a no-op for
      // those chars but keeps the header well-formed if the validator
      // is ever loosened.
      res.setHeader(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(`${req.params.id}.sbv`)}`,
      )
      createReadStream(fullPath).pipe(res)
    } catch (err) {
      res.status(404).json({ error: (err as Error).message })
    }
  })

  return router
}
