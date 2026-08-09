// Kicks off and reports on the per-session transcription job. The actual
// orchestration lives in server/whisper/sessionPipeline.ts; this router only
// exposes the HTTP surface.

import express, { type Router } from 'express'
import { getSessionProgress, processSession } from '../whisper/sessionPipeline.js'
import { rejectInvalidId } from '../lib/validators.js'

export function transcribeRouter(): Router {
  const router = express.Router()

  router.post('/:id/transcribe', async (req, res) => {
    if (rejectInvalidId(req.params.id, res)) return
    try {
      const progress = await processSession(req.params.id)
      res.status(202).json(progress)
    } catch (err) {
      console.error('[api/sessions transcribe POST] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  router.get('/:id/transcribe/status', (req, res) => {
    if (rejectInvalidId(req.params.id, res)) return
    const progress = getSessionProgress(req.params.id)
    // 204 (No Content) for "no active job" — the client maps it to null
    // exactly like the prior 404 contract, but browsers don't log 2xx
    // responses as fetch errors, so the Sessions tab stops spamming the
    // DevTools console for uploaded-but-never-transcribed sessions.
    if (!progress) return res.status(204).end()
    res.json(progress)
  })

  return router
}
