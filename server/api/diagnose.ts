// Diagnose API — the bridge that the browser's auto-trigger hits when a
// pipeline error fires (or a soft-signature scan finds something fishy).
// Builds the markdown bundle, writes it to `.diagnose/latest.md` in the
// repo root, returns the paths so the toast can echo them.
//
// All routes mounted behind `loopbackOnly()` like /api/diagnostics —
// the bundle payload can include key fingerprints, routing snapshots,
// and event histories. LAN gets 403.

import express, { type Router } from 'express'
import {
  buildBundle,
  listRecentBundles,
  type BundleTrigger,
} from '../lib/diagnoseBundle.js'
import {
  captureBlockedChunk,
  listCapturedChunks,
} from '../lib/blockedChunkCapture.js'
import type { DiagnosticEntry } from '../lib/diagnosticsLog.js'

/** Validate that an incoming browser-ring entry is well-shaped enough
 *  to merge with the server ring. Drops malformed entries silently —
 *  we'd rather have a partial bundle than a 500. */
function sanitizeRingEntry(raw: unknown): DiagnosticEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const e = raw as Record<string, unknown>
  if (typeof e.cat !== 'string' || e.cat.length === 0) return null
  return {
    ts: typeof e.ts === 'number' ? e.ts : Date.now(),
    source: 'browser',
    cat: e.cat,
    payload: e.payload,
  }
}

function isValidTrigger(value: unknown): value is BundleTrigger {
  return value === 'hard_error' || value === 'soft_match' || value === 'manual'
}

export function diagnoseRouter(): Router {
  const router = express.Router()

  /** POST /api/diagnose/bundle
   *
   * Body: {
   *   trigger: 'hard_error' | 'soft_match' | 'manual',
   *   browserRing?: BrowserLogEntry[],
   *   symbolHint?: string,
   *   errorMessage?: string,
   *   errorStack?: string,
   *   currentState?: RefinementStateSnapshot,
   * }
   * Returns: { ok, latestPath, bundlePath, signaturesMatched: number }
   */
  router.post('/bundle', async (req, res) => {
    try {
      const body = req.body as {
        trigger?: unknown
        browserRing?: unknown
        symbolHint?: unknown
        errorMessage?: unknown
        errorStack?: unknown
        currentState?: unknown
      }
      const trigger = isValidTrigger(body.trigger) ? body.trigger : 'manual'
      const browserRing = Array.isArray(body.browserRing)
        ? (body.browserRing.map(sanitizeRingEntry).filter((e): e is DiagnosticEntry => e !== null))
        : undefined
      const symbolHint = typeof body.symbolHint === 'string' ? body.symbolHint : undefined
      const errorMessage = typeof body.errorMessage === 'string' ? body.errorMessage : undefined
      const errorStack = typeof body.errorStack === 'string' ? body.errorStack : undefined
      const currentState =
        body.currentState && typeof body.currentState === 'object'
          ? (body.currentState as Record<string, unknown>)
          : undefined

      const result = await buildBundle({
        trigger,
        browserRing,
        symbolHint,
        errorMessage,
        errorStack,
        currentState,
      })
      res.json({
        ok: true,
        latestPath: result.latestPath,
        bundlePath: result.bundlePath,
        signaturesMatched: result.signatures.length,
        // Echo the matched signature IDs + severities so the client can
        // surface a toast like "Diagnosis ready (3 soft errors: latency,
        // auto_fallback, stale_perPhase)".
        signatures: result.signatures.map((s) => ({
          id: s.id,
          severity: s.severity,
        })),
      })
    } catch (err) {
      console.error('[api/diagnose POST /bundle] failed:', err)
      res.status(500).json({
        ok: false,
        error: (err as Error).message,
      })
    }
  })

  /** GET /api/diagnose/recent
   *
   * Returns: { bundles: Array<{ filename, path, size, modifiedAt }> }
   * Lists the most recent diagnosis bundles in `.diagnose/`.
   */
  router.get('/recent', async (_req, res) => {
    try {
      const bundles = await listRecentBundles()
      res.json({ bundles })
    } catch (err) {
      console.error('[api/diagnose GET /recent] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  /** POST /api/diagnose/capture-blocked-chunk
   *
   * Body: {
   *   phase?: string,
   *   index?: number,
   *   totalChunks?: number,
   *   model?: string,
   *   tier?: string,
   *   blockReason?: string,
   *   prompt: string  // the FULL composedPrompt the model rejected
   * }
   * Returns: { ok, filename, path, bytesWritten }
   *
   * Writes the rejected chunk to `.diagnose/blocked-chunks/<phase>-<ISO>.txt`.
   * Opt-in only (DiagnosticsCard toggle); the pipeline gates the POST on
   * `isPersistingBlockedChunks()`. This endpoint is unconditionally
   * available — the server doesn't enforce the opt-in; the client side
   * holds the gate.
   */
  router.post('/capture-blocked-chunk', async (req, res) => {
    try {
      const body = req.body as {
        phase?: unknown
        index?: unknown
        totalChunks?: unknown
        model?: unknown
        tier?: unknown
        blockReason?: unknown
        prompt?: unknown
      }
      if (typeof body.prompt !== 'string' || body.prompt.length === 0) {
        res.status(400).json({ ok: false, error: 'prompt (string, non-empty) is required' })
        return
      }
      const result = await captureBlockedChunk({
        phase: typeof body.phase === 'string' ? body.phase : null,
        index: typeof body.index === 'number' ? body.index : null,
        totalChunks: typeof body.totalChunks === 'number' ? body.totalChunks : null,
        model: typeof body.model === 'string' ? body.model : null,
        tier: typeof body.tier === 'string' ? body.tier : null,
        blockReason: typeof body.blockReason === 'string' ? body.blockReason : null,
        prompt: body.prompt,
      })
      res.json({ ok: true, ...result })
    } catch (err) {
      console.error('[api/diagnose POST /capture-blocked-chunk] failed:', err)
      res.status(500).json({ ok: false, error: (err as Error).message })
    }
  })

  /** GET /api/diagnose/captured-chunks
   *
   * Returns: { chunks: Array<{ filename, path, size, modifiedAt }> }
   * Lists the captured blocked-chunk files newest-first. Used by the
   * Diagnostics card's recent-captures list.
   */
  router.get('/captured-chunks', async (_req, res) => {
    try {
      const chunks = await listCapturedChunks()
      res.json({ chunks })
    } catch (err) {
      console.error('[api/diagnose GET /captured-chunks] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  return router
}
