// Multitrack upload API. Three-stage flow:
//
//   1. POST /api/sessions/upload-multitrack
//      Accepts one .zip OR multiple loose audio files via multipart form.
//      Lays them out as `{dataDir}/sessions/<id>/audio/<speakerId>/*.<ext>`
//      and writes a session manifest. Returns the session ID + detected
//      speakers so the UI can show a preview before transcription starts.
//
//   2. POST /api/sessions/:id/append-multitrack         (optional, repeatable)
//      Same payload shape as upload-multitrack, but stitches the new
//      batch onto the END of an existing session's timeline so Part 2
//      plays after Part 1. Used for staged batch uploads where the user
//      uploads each part separately and commits between batches.
//
//   3. POST /api/sessions/:id/transcribe-multitrack
//      Kicks off Whisper across every utterance the upload+append calls
//      wrote. Returns immediately; the existing /api/sessions/:id/live
//      progress polling endpoint reports progress as utterances complete.

import express, { type Router, type RequestHandler } from 'express'
import multer from 'multer'
import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import {
  appendMultitrackUpload,
  extractMultitrackUpload,
  cleanupSessionDir,
  deleteSessionAudio,
  markSessionFinalized,
} from '../upload/extractMultitrack.js'
import { readManifest } from '../sessions/sessionManifest.js'
import { forgetLiveSession, transcribeExistingSession } from '../whisper/liveQueue.js'
import { rejectInvalidId } from '../lib/validators.js'

const UPLOAD_TMP_DIR = path.join(os.tmpdir(), 'tusks-tomes-uploads')

// Validates :id BEFORE multer parses the multipart body. Without this
// ordering, multer streams every uploaded byte to UPLOAD_TMP_DIR before
// our handler runs — a bogus :id (or a hostile loop of them) fills the
// tmp disk with no auth. Drains the request body on rejection so the
// client's upload buffer doesn't stay open holding GB of in-flight data.
function gateById(): RequestHandler {
  return (req, res, next) => {
    if (!rejectInvalidId(req.params.id, res)) return next()
    req.on('data', () => undefined)
    req.on('end', () => undefined)
    // res has already been written by rejectInvalidId
    return
  }
}

// System-wide in-flight upload byte counter. Beyond this cap, refuse
// new multipart uploads — before multer touches disk. The counter
// accumulates ACTUALLY-RECEIVED bytes from the request body, not the
// client-declared Content-Length header. The previous implementation
// trusted the header, which let an attacker open three keep-alive
// connections each declaring `Content-Length: 6_000_000_000` and
// sending zero body bytes — the counter immediately reserved 18 GB,
// blocking every legitimate upload with 503. The actual-bytes version
// only counts what's on the wire, so a stalled / lying client cannot
// starve the cap.
//
// On overflow we 503 and destroy the request, releasing the connection
// immediately. Multer's per-file (4 GB) and per-request (32 files)
// limits still apply downstream.
let inFlightBytes = 0
const MAX_IN_FLIGHT_BYTES = 16 * 1024 * 1024 * 1024 // 16 GB

// Test hook: expose the current counter so unit tests can assert on it
// without poking at the implementation. Not exported for production use.
export function _getInFlightBytesForTests(): number {
  return inFlightBytes
}

// Exported for Phase 8 — `/api/parse/pdf` and `/api/parse/docx` are
// upload routes that live in server/index.ts (not under uploadRouter),
// so they need to import uploadGate to share the same system-wide cap.
export function uploadGate(): RequestHandler {
  return (req, res, next) => {
    // Fast-fail on egregiously-large declared Content-Length so we don't
    // even start receiving the body. Any value above the system-wide
    // cap is rejected outright (with header truth still verified by
    // the streaming check below). A missing/zero/unparseable header
    // proceeds to streaming verification.
    const lenHeader = req.get('content-length')
    const declared = lenHeader ? Number(lenHeader) : 0
    if (Number.isFinite(declared) && declared > MAX_IN_FLIGHT_BYTES) {
      return res.status(503).json({ error: 'Upload queue full, try again shortly.' })
    }

    let bytesThisReq = 0
    let rejected = false
    req.on('data', (chunk: Buffer) => {
      if (rejected) return
      bytesThisReq += chunk.length
      inFlightBytes += chunk.length
      if (inFlightBytes > MAX_IN_FLIGHT_BYTES) {
        rejected = true
        // Roll back our contribution so the counter doesn't leak above
        // the cap once this request is closed.
        inFlightBytes -= bytesThisReq
        if (!res.headersSent) {
          res.status(503).json({ error: 'Upload queue full, try again shortly.' })
        }
        req.destroy()
      }
    })
    res.on('close', () => {
      if (!rejected) {
        inFlightBytes = Math.max(0, inFlightBytes - bytesThisReq)
      }
    })
    return next()
  }
}

// Per-file size limit: 4 GB. Per-request limit (number of files): 32. These
// are well above realistic D&D session sizes — 4-hour 8-speaker FLAC tops
// out around 6 GB total spread across files, so per-file 4 GB is plenty.
const PER_FILE_MAX_BYTES = 4 * 1024 * 1024 * 1024
const MAX_FILES_PER_REQUEST = 32

const uploadDisk = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdir(UPLOAD_TMP_DIR, { recursive: true })
        .then(() => cb(null, UPLOAD_TMP_DIR))
        .catch((err) => cb(err, UPLOAD_TMP_DIR))
    },
    filename: (_req, file, cb) => {
      const ts = Date.now().toString(36)
      const safe = file.originalname.replace(/[^\w.-]+/g, '_')
      cb(null, `${ts}-${safe}`)
    },
  }),
  limits: {
    fileSize: PER_FILE_MAX_BYTES,
    files: MAX_FILES_PER_REQUEST,
  },
})

export function uploadRouter(): Router {
  const router = express.Router()

  router.post('/upload-multitrack', uploadGate(), uploadDisk.array('files', MAX_FILES_PER_REQUEST), async (req, res) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? []
    if (files.length === 0) {
      return res.status(400).json({ error: 'No files received under the "files" field.' })
    }
    try {
      const channelName = typeof req.body.voiceChannelName === 'string'
        ? req.body.voiceChannelName
        : undefined
      let displayNameOverrides: Record<string, string> | undefined
      if (typeof req.body.displayNameOverrides === 'string' && req.body.displayNameOverrides.trim()) {
        try {
          const parsed = JSON.parse(req.body.displayNameOverrides)
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            displayNameOverrides = parsed as Record<string, string>
          }
        } catch {
          // ignore malformed overrides — falls back to filename-derived names
        }
      }
      let fileOrder: string[] | undefined
      if (typeof req.body.fileOrder === 'string' && req.body.fileOrder.trim()) {
        try {
          const parsed = JSON.parse(req.body.fileOrder)
          if (Array.isArray(parsed) && parsed.every((s) => typeof s === 'string')) {
            fileOrder = parsed as string[]
          }
        } catch {
          // ignore malformed fileOrder — falls back to upload order
        }
      }
      const result = await extractMultitrackUpload({
        inputs: files.map((f) => ({ path: f.path, originalName: f.originalname })),
        voiceChannelName: channelName,
        displayNameOverrides,
        fileOrder,
      })
      res.json(result)
    } catch (err) {
      // Best-effort cleanup of any partially-extracted session and the
      // tmp files multer wrote. If extract threw before we even created
      // the session dir there's nothing to clean.
      for (const f of files) {
        await fs.unlink(f.path).catch(() => undefined)
      }
      console.error('[api/upload-multitrack] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // Append another batch of audio onto the tail of an existing session.
  // Same multipart payload shape as POST /upload-multitrack. Refuses to
  // append if the session is already transcribed.
  //
  // gateById runs BEFORE multer so a bogus :id (or a hostile loop of
  // them) never makes it to disk via UPLOAD_TMP_DIR. uploadGate caps
  // total in-flight bytes system-wide.
  router.post('/:id/append-multitrack', gateById(), uploadGate(), uploadDisk.array('files', MAX_FILES_PER_REQUEST), async (req, res) => {
    const sessionId = req.params.id
    const files = (req.files as Express.Multer.File[] | undefined) ?? []
    if (files.length === 0) {
      return res.status(400).json({ error: 'No files received under the "files" field.' })
    }
    try {
      let displayNameOverrides: Record<string, string> | undefined
      if (typeof req.body.displayNameOverrides === 'string' && req.body.displayNameOverrides.trim()) {
        try {
          const parsed = JSON.parse(req.body.displayNameOverrides)
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            displayNameOverrides = parsed as Record<string, string>
          }
        } catch {
          // ignore malformed overrides — falls back to filename-derived names
        }
      }
      let fileOrder: string[] | undefined
      if (typeof req.body.fileOrder === 'string' && req.body.fileOrder.trim()) {
        try {
          const parsed = JSON.parse(req.body.fileOrder)
          if (Array.isArray(parsed) && parsed.every((s) => typeof s === 'string')) {
            fileOrder = parsed as string[]
          }
        } catch {
          // ignore malformed fileOrder — falls back to upload order
        }
      }
      const result = await appendMultitrackUpload({
        sessionId,
        inputs: files.map((f) => ({ path: f.path, originalName: f.originalname })),
        displayNameOverrides,
        fileOrder,
      })
      res.json(result)
    } catch (err) {
      // Don't delete the existing session on a failed append — the user
      // may want to retry. Just clean up the tmp upload files.
      for (const f of files) {
        await fs.unlink(f.path).catch(() => undefined)
      }
      console.error('[api/append-multitrack] failed:', err)
      const status = /not found/i.test((err as Error).message)
        ? 404
        : /already been transcribed/i.test((err as Error).message)
          ? 409
          : 500
      res.status(status).json({ error: (err as Error).message })
    }
  })

  router.post('/:id/transcribe-multitrack', async (req, res) => {
    if (rejectInvalidId(req.params.id, res)) return
    const sessionId = req.params.id
    const manifest = await readManifest(sessionId)
    if (!manifest) {
      return res.status(404).json({ error: `Session ${sessionId} not found.` })
    }
    // Kick off transcription async so the HTTP response returns immediately
    // and the UI can switch to polling the live state for progress.
    res.json({ sessionId, started: true })
    void (async () => {
      try {
        // transcribeExistingSession internally handles startLiveSession +
        // queue drain + finalizeLiveSession (which writes processing.*
        // into the manifest). We just need to set endedAt afterwards
        // and drop the in-memory state.
        await transcribeExistingSession(sessionId)
        await markSessionFinalized(sessionId)
        forgetLiveSession(sessionId)
      } catch (err) {
        console.error('[api/transcribe-multitrack] worker failed:', err)
      }
    })()
  })

  router.delete('/:id/upload-multitrack', async (req, res) => {
    if (rejectInvalidId(req.params.id, res)) return
    try {
      await cleanupSessionDir(req.params.id)
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // Reclaim disk space without losing the transcript. Wipes audio/<id>
  // but leaves manifest.json, session.sbv, and per-utterance JSONs intact
  // so the Sessions tab still shows the session and Refinement can still
  // load the SBV. Audio files cannot be recovered — re-uploading the
  // original Craig zip is the only way.
  router.delete('/:id/audio', async (req, res) => {
    if (rejectInvalidId(req.params.id, res)) return
    try {
      const bytesFreed = await deleteSessionAudio(req.params.id)
      res.json({ ok: true, bytesFreed })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  return router
}
