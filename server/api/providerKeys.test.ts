// Host-header allowlist regression test. The same-origin middleware in
// server/index.ts exempts GET, which would leave /api/provider-keys
// (decrypted-keystore endpoint) exfiltratable via a DNS-rebinding
// attack — see the security review at .../i-have-wiped-the-reactive-hoare.md.
// The allowlist closes that gap; this test pins the behaviour.
//
// We mount the middleware in isolation (not the whole server) because:
//   - server/index.ts has top-level side effects (file probes, banner
//     printing, addon loading) that would slow tests and clutter output;
//   - we only need to assert the routing predicate, not the rest of the
//     stack.
//
// Implementation note: we cannot use `fetch()` because undici (Node 18+
// global fetch) silently overrides the Host header to match the URL's
// authority. Use the low-level `http.request` API to send a raw Host
// header that diverges from the target.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import express, { type Express } from 'express'
import http, { type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'

// Import the REAL host-allowlist middleware — not a re-implementation.
// This means a future change in server/lib/hostAllowlist.ts that loosens
// the predicate trips this test before reaching the next /ship.
import { hostAllowlist, isAllowedHost } from '../lib/hostAllowlist.js'

function buildAppWithHostGuard(opts: { host: string; port: number }): Express {
  const app = express()
  app.use(hostAllowlist(opts))
  app.get('/api/provider-keys', (_req, res) => {
    res.json({ ok: true })
  })
  app.get('/api/health', (_req, res) => res.json({ ok: true }))
  return app
}

async function serve(app: Express): Promise<{
  port: number
  close: () => Promise<void>
}> {
  const server = http.createServer(app)
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  )
  const addr = server.address() as AddressInfo
  return {
    port: addr.port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

function requestWithHost(args: {
  serverPort: number
  hostHeader: string
  path: string
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: args.serverPort,
        method: 'GET',
        path: args.path,
        headers: { Host: args.hostHeader },
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf-8'),
          }),
        )
      },
    )
    req.on('error', reject)
    req.end()
  })
}

describe('isAllowedHost — pure predicate (Phase 6.3)', () => {
  const port = 5173
  it('accepts the three canonical loopback forms', () => {
    expect(isAllowedHost(`127.0.0.1:${port}`, port)).toBe(true)
    expect(isAllowedHost(`localhost:${port}`, port)).toBe(true)
    expect(isAllowedHost(`[::1]:${port}`, port)).toBe(true)
  })
  it('case-folded', () => {
    expect(isAllowedHost(`LOCALHOST:${port}`, port)).toBe(true)
    expect(isAllowedHost(`LocalHost:${port}`, port)).toBe(true)
  })
  it('rejects different ports', () => {
    expect(isAllowedHost(`127.0.0.1:9999`, port)).toBe(false)
    expect(isAllowedHost(`localhost:8080`, port)).toBe(false)
  })
  it('rejects missing port', () => {
    expect(isAllowedHost('127.0.0.1', port)).toBe(false)
    expect(isAllowedHost('localhost', port)).toBe(false)
  })
  it('rejects attacker hostnames', () => {
    expect(isAllowedHost(`evil.example:${port}`, port)).toBe(false)
    expect(isAllowedHost(`127.0.0.1.attacker.com:${port}`, port)).toBe(false)
    expect(isAllowedHost('', port)).toBe(false)
  })
})

describe('Host-header allowlist (DNS rebinding defence)', () => {
  let close: () => Promise<void>
  let port: number
  const SERVE_PORT = 5173 // virtual port — the middleware compares against this

  beforeEach(async () => {
    const app = buildAppWithHostGuard({ host: '127.0.0.1', port: SERVE_PORT })
    ;({ port, close } = await serve(app))
  })
  afterEach(async () => {
    await close()
  })

  // Whitelisted hosts pass.
  for (const host of [
    `127.0.0.1:${SERVE_PORT}`,
    `localhost:${SERVE_PORT}`,
    `[::1]:${SERVE_PORT}`,
    `LOCALHOST:${SERVE_PORT}`, // case-folded match
  ]) {
    it(`accepts Host: ${host}`, async () => {
      const res = await requestWithHost({
        serverPort: port,
        hostHeader: host,
        path: '/api/provider-keys',
      })
      expect(res.status).toBe(200)
    })
  }

  // Anything else → 421 Misdirected Request.
  for (const host of [
    'attacker.example:5173',
    '127.0.0.1.attacker.com:5173',
    'evil.com',
    `127.0.0.1:9999`, // wrong port
    `127.0.0.1`, // no port
    '', // empty
  ]) {
    it(`rejects Host: ${JSON.stringify(host)}`, async () => {
      const res = await requestWithHost({
        serverPort: port,
        hostHeader: host,
        path: '/api/provider-keys',
      })
      expect(res.status).toBe(421)
    })
  }

  it('also gates /api/health (not just provider-keys)', async () => {
    const ok = await requestWithHost({
      serverPort: port,
      hostHeader: `127.0.0.1:${SERVE_PORT}`,
      path: '/api/health',
    })
    expect(ok.status).toBe(200)
    const bad = await requestWithHost({
      serverPort: port,
      hostHeader: 'evil.com',
      path: '/api/health',
    })
    expect(bad.status).toBe(421)
  })
})

describe('Host-header allowlist (LAN-bind opt-in)', () => {
  let close: () => Promise<void>
  let port: number

  beforeEach(async () => {
    // When TUSKS_HOST is anything but 127.0.0.1, the guard becomes a
    // no-op (legitimate LAN traffic carries the LAN IP in Host, not
    // 127.0.0.1, and rebinding to a real reachable LAN IP isn't a
    // meaningful exfil attack — the attacker would have to control DNS
    // for that LAN and also be on it).
    const app = buildAppWithHostGuard({ host: '0.0.0.0', port: 5173 })
    ;({ port, close } = await serve(app))
  })
  afterEach(async () => {
    await close()
  })

  it('is disabled when TUSKS_HOST is not 127.0.0.1', async () => {
    const res = await requestWithHost({
      serverPort: port,
      hostHeader: 'attacker.example:5173',
      path: '/api/provider-keys',
    })
    expect(res.status).toBe(200)
  })
})

// ============================================================================
// loopback-only gate on /api/provider-keys (Phase 1.4 regression test)
// ============================================================================

// Imports the *real* gate from server/lib/loopbackGate.ts — not a copy.
// A future regression that loosens the gate fails these tests.
import { isLoopbackSource, loopbackOnly } from '../lib/loopbackGate.js'
import type { Request, Response } from 'express'

describe('isLoopbackSource — pure predicate (Phase 1.4)', () => {
  const accept = [
    '127.0.0.1',
    '127.0.0.5',
    '127.255.255.254',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:127.0.0.5',
  ]
  const reject = [
    '',
    undefined,
    '192.168.1.42',          // LAN
    '10.0.0.5',              // RFC1918
    '172.16.0.1',            // RFC1918
    '8.8.8.8',               // public
    '::ffff:192.168.1.42',   // IPv4-mapped LAN
    '::ffff:8.8.8.8',        // IPv4-mapped public
    'fe80::1',               // link-local IPv6
    'fc00::1',               // ULA — not loopback even though private
    '2001:4860:4860::8888',  // public IPv6
  ]
  for (const r of accept) {
    it(`accepts ${r}`, () => expect(isLoopbackSource(r)).toBe(true))
  }
  for (const r of reject) {
    it(`rejects ${JSON.stringify(r)}`, () =>
      expect(isLoopbackSource(r as string | undefined)).toBe(false))
  }
})

describe('loopbackOnly middleware (provider-keys 403 for LAN sources)', () => {
  type Captured = { status?: number; json?: unknown; nextCalled?: boolean }

  function exercise(remoteAddress: string | undefined): Captured {
    const captured: Captured = {}
    const req = {
      socket: { remoteAddress },
    } as unknown as Request
    const res = {
      status(n: number) {
        captured.status = n
        return this
      },
      json(body: unknown) {
        captured.json = body
        return this
      },
    } as unknown as Response
    const next = () => {
      captured.nextCalled = true
    }
    loopbackOnly()(req, res, next)
    return captured
  }

  it('calls next() for loopback IPv4', () => {
    const c = exercise('127.0.0.1')
    expect(c.nextCalled).toBe(true)
    expect(c.status).toBeUndefined()
  })

  it('calls next() for loopback IPv6', () => {
    const c = exercise('::1')
    expect(c.nextCalled).toBe(true)
  })

  it('403 with informative error for LAN IPv4 source', () => {
    const c = exercise('192.168.1.42')
    expect(c.nextCalled).toBeUndefined()
    expect(c.status).toBe(403)
    expect((c.json as { error: string }).error).toMatch(/this machine only|localhost/i)
  })

  it('403 for public IPv4 (e.g. badly-configured reverse proxy)', () => {
    expect(exercise('8.8.8.8').status).toBe(403)
  })

  it('403 for IPv4-mapped IPv6 LAN address (::ffff:192.168.1.42)', () => {
    expect(exercise('::ffff:192.168.1.42').status).toBe(403)
  })

  it('403 for undefined remoteAddress (fail-closed)', () => {
    expect(exercise(undefined).status).toBe(403)
  })

  it('403 even when TUSKS_HOST opted into LAN bind (the gate is INDEPENDENT)', () => {
    // The middleware doesn't read TUSKS_HOST — it just checks the
    // actual TCP peer. So even with TUSKS_HOST=0.0.0.0, a LAN visit
    // still 403s on this route.
    process.env.TUSKS_HOST = '0.0.0.0'
    try {
      expect(exercise('192.168.1.42').status).toBe(403)
    } finally {
      delete process.env.TUSKS_HOST
    }
  })
})
