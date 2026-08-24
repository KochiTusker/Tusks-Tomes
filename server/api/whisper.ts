// Minimal Whisper inspection endpoint. Step 11 builds on this with
// `/api/sessions/:id/transcribe`; for Step 10, exposing the status is
// enough for the React UI (when it lands) to surface a "Set up Whisper"
// prompt.

import { promises as fs } from 'node:fs'
import express, { type Router } from 'express'
import { runSetup, venvDir, whisperStatus } from '../whisper/bootstrap.js'

export function whisperRouter(): Router {
  const router = express.Router()

  router.get('/status', async (_req, res) => {
    try {
      const status = await whisperStatus()
      res.json(status)
    } catch (err) {
      console.error('[api/whisper/status] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // Streams setup script output line-by-line (Server-Sent Events). The
  // React UI consumes the stream via `fetch().body.getReader()` so a
  // POST works just as well as GET, and avoids drive-by CSRF triggering
  // the Python venv install.
  router.post('/setup', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders?.()
    try {
      const exitCode = await runSetup((entry) => {
        res.write(`event: line\n`)
        res.write(`data: ${JSON.stringify(entry)}\n\n`)
      })
      res.write(`event: done\n`)
      res.write(`data: ${JSON.stringify({ exitCode })}\n\n`)
    } catch (err) {
      res.write(`event: error\n`)
      res.write(`data: ${JSON.stringify({ error: (err as Error).message })}\n\n`)
    } finally {
      res.end()
      if (req) {
        // Best-effort cleanup on client disconnect.
      }
    }
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
