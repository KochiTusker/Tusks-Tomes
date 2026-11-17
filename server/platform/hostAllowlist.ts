// Host-header allowlist (DNS-rebinding defence).
//
// Express's same-origin gate covers state-changing methods, but
// `GET /api/provider-keys` would otherwise be exfiltratable by a
// page that DNS-rebinds the user's browser to 127.0.0.1. The Host
// header on a rebound request is the attacker-controlled hostname
// (e.g. `evil.com:5173`), not the user's local listener. By requiring
// `Host` to match a fixed loopback allowlist, we close that gap.
//
// Disabled when TUSKS_HOST is set to something other than 127.0.0.1
// (the user opted into LAN exposure; rebinding to a real LAN IP isn't
// meaningful, and we'd otherwise refuse the legitimate LAN traffic).
//
// Extracted from server/index.ts so the predicate is unit-testable
// without re-implementing it in the test file.

import type { RequestHandler } from 'express'

export type HostAllowlistOptions = {
  /** TUSKS_HOST value the server bound to. The gate only fires when
   *  this is the loopback default. */
  host: string
  /** Listening port — used to build the canonical allowed `Host` values. */
  port: number
}

/** Pure predicate, exported for unit testing.
 *
 *  Returns true iff the case-folded `host` header value matches one of
 *  the canonical loopback forms for `port`. */
export function isAllowedHost(host: string, port: number): boolean {
  const lc = host.toLowerCase()
  return (
    lc === `127.0.0.1:${port}` ||
    lc === `localhost:${port}` ||
    lc === `[::1]:${port}`
  )
}

/** Express middleware. 421s any request whose `Host` header isn't on
 *  the loopback allowlist (when the server bound to 127.0.0.1). */
export function hostAllowlist(opts: HostAllowlistOptions): RequestHandler {
  return (req, res, next) => {
    if (opts.host !== '127.0.0.1') return next()
    const host = req.headers.host ?? ''
    if (isAllowedHost(host, opts.port)) return next()
    return res.status(421).json({ error: 'Misdirected request' })
  }
}
