// LAN-write gate.
//
// Phase 7 default: when the user opts into LAN exposure
// (`TUSKS_HOST=0.0.0.0`), other devices on the network can READ the
// app — browse chronicles, view transcripts, see session lists — but
// cannot WRITE (upload, save, modify settings, etc.) unless the user
// ALSO opts in via `TUSKS_LAN_WRITES=1`.
//
// Why split read from write: the documented LAN feature is "view
// chronicles from your tablet on the couch". Writing from a tablet
// requires explicit trust in everyone on the network. Defaulting
// writes OFF means an accidental coffee-shop bind won't let a
// stranger upload junk into your sessions or flip your settings.
//
// Loopback requests bypass the gate entirely — the SPA on the host
// machine always hits 127.0.0.1 (same-origin to the loopback listener)
// and never trips this check, regardless of `TUSKS_HOST` or
// `TUSKS_LAN_WRITES`.
//
// This is a SECOND layer above the route-level loopbackOnly() gates
// (which protect credentials / updater / launcher specifically). If
// `TUSKS_LAN_WRITES=1`, those routes are STILL loopback-only — the
// LAN-write toggle doesn't override the credential gates.

import type { RequestHandler } from 'express'
import { isLoopbackSource } from './loopbackGate.js'

export type LanWriteGateOptions = {
  /** Truthy iff the user has set TUSKS_LAN_WRITES to enable cross-device
   *  writes. Default semantics: env unset or any non-truthy value =
   *  disabled. */
  enabled: boolean
}

// HTTP methods that don't mutate server state. CORS treats them the same
// way for cross-origin preflight purposes; we use them as the read/write
// dividing line.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** Pure predicate, exported for unit testing. */
export function isWriteRequest(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase())
}

/** Pure predicate, exported for unit testing. Parses the typical boolean
 *  env-var forms (`1`, `true`, `yes`, `on` — case-insensitive). Anything
 *  else, including unset, is false (fail-closed). */
export function parseLanWritesEnv(raw: string | undefined): boolean {
  if (!raw) return false
  return /^(1|true|yes|on)$/i.test(raw.trim())
}

/** Express middleware. Returns 403 on a write request whose source
 *  isn't loopback, unless `opts.enabled` is true. */
export function lanWriteGate(opts: LanWriteGateOptions): RequestHandler {
  return (req, res, next) => {
    // Reads always proceed — even from LAN, when LAN exposure is on.
    if (!isWriteRequest(req.method)) return next()
    // Loopback writes always proceed — the SPA running on the host's
    // own browser hits 127.0.0.1 same-origin and is trusted.
    if (isLoopbackSource(req.socket.remoteAddress ?? undefined)) return next()
    // LAN write — gated by the explicit opt-in.
    if (opts.enabled) return next()
    return res.status(403).json({
      error:
        'LAN write access is disabled. ' +
        'This action would modify state and you appear to be visiting from another device on the network. ' +
        'To enable cross-device writes, set TUSKS_LAN_WRITES=1 on the host and restart — but only on networks where you trust every connected device. ' +
        'Otherwise, perform this action from the machine running Tusk’s Tomes.',
    })
  }
}
