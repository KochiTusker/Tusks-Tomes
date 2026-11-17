// Minimal Whisper inspection endpoint. Step 11 builds on this with
// `/api/sessions/:id/transcribe`; for Step 10, exposing the status is
// enough for the React UI (when it lands) to surface a "Set up Whisper"
// prompt.

import { promises as fs } from 'node:fs'
import express, { type Router } from 'express'
import { runSetup, venvDir, whisperStatus } from '../services/whisper/bootstrap.js'
import { streamLogToSse } from '../../../platform/sseLogStream.js'
import { asyncRoute } from '../../../platform/asyncRoute.js'

export function whisperRouter(): Router {
  const router = express.Router()

  router.get('/status', asyncRoute('api/whisper/status', async (_req, res) => {
    const status = await whisperStatus()
    res.json(status)
  }))

  // Streams setup script output line-by-line (Server-Sent Events). The
  // React UI consumes the stream via `fetch().body.getReader()` so a
  // POST works just as well as GET, and avoids drive-by CSRF triggering
  // the Python venv install.
  router.post('/setup', async (_req, res) => {
    await streamLogToSse(res, runSetup)
  })

  router.delete('/', async (_req, res) => {
    try {
      await fs.rm(venvDir(), { recursive: true, force: true })
      res.json({ ok: true })
    } catch (err) {
      console.error('[api/whisper DELETE] failed:', err)
      res.status(500).json({ ok: false, error: (err as Error).message })
    }
  })

  return router
}
