// Diagnostics API — the bridge that lets the browser's verboseLog stream
// reach the dev-server terminal and optional JSON Lines logfile, plus a
// snapshot endpoint so the UI can show the merged browser+server ring.
//
// All routes are mounted behind `loopbackOnly()` in server/index.ts:
// log payloads can include model ids, key fingerprints, and prompt
// lengths — same threat model as /api/provider-keys (LAN gets 403).

import express, { type Router } from 'express'
import {
  clearLogFile,
  dumpRecent,
  getForwarding,
  ingest,
  logFilePath,
  setForwarding,
  type DiagnosticEntry,
  type DiagnosticsConfig,
} from '../services/diagnosticsLog.js'
import { asyncRoute } from '../../../platform/asyncRoute.js'

/** Hard cap on entries per POST /log request. Keeps a single misbehaving
 *  forwarder from filling the ring with one giant call. The browser-side
 *  debounce window is 250ms so this cap is ~50x what we'd ever see in
 *  practice. */
const MAX_BATCH_SIZE = 500

type BrowserLogEntry = {
  ts?: number
  cat: string
  payload?: unknown
}

function isValidEntry(v: unknown): v is BrowserLogEntry {
  if (!v || typeof v !== 'object') return false
  const e = v as Record<string, unknown>
  // ts is optional (server backfills with Date.now()); cat must be a string.
  if (typeof e.cat !== 'string' || e.cat.length === 0) return false
  if (e.ts !== undefined && typeof e.ts !== 'number') return false
  return true
}

export function diagnosticsRouter(): Router {
  const router = express.Router()

  // POST /api/diagnostics/log — browser pushes a batch of entries.
  // Body shape: { entries: BrowserLogEntry[] }
  router.post('/log', asyncRoute('api/diagnostics POST /log', async (req, res) => {
    const body = req.body as { entries?: unknown }
    if (!Array.isArray(body?.entries)) {
      return res.status(400).json({ error: 'Expected { entries: [...] }' })
    }
    if (body.entries.length > MAX_BATCH_SIZE) {
      return res
        .status(400)
        .json({ error: `Batch too large: ${body.entries.length} > ${MAX_BATCH_SIZE}` })
    }
    const valid = body.entries.filter(isValidEntry)
    const result = await ingest(valid, 'browser')
    res.json({ accepted: result.accepted, rejected: body.entries.length - valid.length })
  }))

  // GET /api/diagnostics/config — current { terminal, file, logFilePath }.
  router.get('/config', asyncRoute('api/diagnostics GET /config', async (_req, res) => {
    const cfg = await getForwarding()
    res.json({ ...cfg, logFilePath: logFilePath() })
  }))

  // POST /api/diagnostics/config — body { terminal?, file? } merged into
  // existing config. Returns the new merged config.
  router.post('/config', asyncRoute('api/diagnostics POST /config', async (req, res) => {
    const body = req.body as Partial<DiagnosticsConfig>
    const next: Partial<DiagnosticsConfig> = {}
    if (typeof body.terminal === 'boolean') next.terminal = body.terminal
    if (typeof body.file === 'boolean') next.file = body.file
    const merged = await setForwarding(next)
    res.json({ ...merged, logFilePath: logFilePath() })
  }))

  // POST /api/diagnostics/clear-file — wipe diagnostics.log.
  router.post('/clear-file', asyncRoute('api/diagnostics POST /clear-file', async (_req, res) => {
    await clearLogFile()
    res.json({ ok: true, logFilePath: logFilePath() })
  }))

  // GET /api/diagnostics/recent?count=N&cat=X — snapshot of the ring.
  // Used by the Diagnostics card's "Show server ring" button.
  router.get('/recent', (req, res) => {
    try {
      const count = req.query.count
        ? Math.max(1, Math.min(500, parseInt(String(req.query.count), 10) || 100))
        : 100
      const cat = typeof req.query.cat === 'string' && req.query.cat !== 'all' ? req.query.cat : undefined
      const entries: DiagnosticEntry[] = dumpRecent({ count, cat })
      res.json({ entries, total: entries.length })
    } catch (err) {
      console.error('[api/diagnostics GET /recent] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  return router
}
