// Loopback-only gate. Used in server/index.ts to fence the /api/provider-keys
// route to same-machine callers regardless of TUSKS_HOST.
//
// Truth source = req.socket.remoteAddress (actual TCP peer, not the
// client-controlled Host header). LAN visitors get 403; same-machine
// callers (the SPA running in the user's browser, smoke tests, curl
// from a terminal on the host) pass through.
//
// IPv4-mapped IPv6 (`::ffff:127.0.0.1`) appears when the Express listener
// binds dual-stack on Linux/Windows — treat it as loopback.

import type { RequestHandler } from 'express'

/** Pure predicate, exported for unit testing. */
export function isLoopbackSource(remote: string | undefined): boolean {
  if (!remote) return false
  if (remote === '::1') return true
  if (remote === '127.0.0.1') return true
  if (remote.startsWith('127.')) return true       // 127.0.0.0/8
  if (remote === '::ffff:127.0.0.1') return true
  if (remote.startsWith('::ffff:127.')) return true
  return false
}

/** Express middleware. 403s any request whose TCP peer isn't loopback. */
export function loopbackOnly(): RequestHandler {
  return (req, res, next) => {
    if (isLoopbackSource(req.socket.remoteAddress ?? undefined)) return next()
    return res.status(403).json({
      error: 'Provider keys are accessible from this machine only. ' +
        'Visit the app at http://localhost:5173 from the machine running it.',
    })
  }
}
