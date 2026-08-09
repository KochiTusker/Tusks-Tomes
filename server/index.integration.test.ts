// Phase 8 integration tests — verify the middleware chain in server/index.ts
// composes correctly, specifically the same-origin gate + lanWriteGate
// + loopback gate interactions.
//
// Phase 9 fix: this test now imports `createApiApp` from server/index.ts
// directly, so it exercises the REAL middleware chain — not a re-
// implementation. A regression in server/index.ts (e.g. removing the
// Origin===Host extension, reordering express.json above the gates,
// dropping a gate, mounting an ungated route) will fail these tests.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Express } from 'express'
import http, { type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'

// We import the REAL app builder. Any change to server/index.ts's
// middleware chain is observed by these tests.
import { createApiApp } from './index.js'

// Wrap the real createApiApp to add the test echo routes downstream of
// the gates. The test routes are mounted AFTER createApiApp's own
// mounts, so they share the same /api/* gate pipeline.
function buildAppLikeIndex(opts: {
  host: string
  port: number
  lanWritesEnabled: boolean
}): Express {
  const app = createApiApp(opts)
  // Add minimal test echo endpoints downstream of the real gates.
  app.post('/api/echo', (req, res) => {
    res.json({ ok: true, received: req.body })
  })
  app.get('/api/echo', (_req, res) => {
    res.json({ ok: true })
  })
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

function request(args: {
  serverPort: number
  hostHeader: string
  originHeader?: string
  method?: string
  path?: string
  body?: string
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: args.hostHeader }
    if (args.originHeader !== undefined) headers.Origin = args.originHeader
    if (args.body !== undefined) headers['Content-Type'] = 'application/json'
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: args.serverPort,
        method: args.method ?? 'GET',
        path: args.path ?? '/api/echo',
        headers,
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
    if (args.body !== undefined) req.write(args.body)
    req.end()
  })
}

describe('middleware chain (Phase 8) — TUSKS_HOST=127.0.0.1 default', () => {
  let close: () => Promise<void>
  let port: number
  const SERVE_PORT = 5173

  beforeEach(async () => {
    const app = buildAppLikeIndex({
      host: '127.0.0.1',
      port: SERVE_PORT,
      lanWritesEnabled: false,
    })
    ;({ port, close } = await serve(app))
  })
  afterEach(async () => {
    await close()
  })

  it('loopback POST with localhost Origin passes all gates', async () => {
    const res = await request({
      serverPort: port,
      hostHeader: `127.0.0.1:${SERVE_PORT}`,
      originHeader: `http://localhost:${SERVE_PORT}`,
      method: 'POST',
      path: '/api/echo',
      body: '{"x":1}',
    })
    expect(res.status).toBe(200)
  })

  it('loopback GET with attacker Host header → host-allowlist 421', async () => {
    const res = await request({
      serverPort: port,
      hostHeader: 'attacker.example:5173',
      method: 'GET',
    })
    expect(res.status).toBe(421)
  })

  it('loopback POST with no Origin (curl-style) → passes', async () => {
    const res = await request({
      serverPort: port,
      hostHeader: `127.0.0.1:${SERVE_PORT}`,
      method: 'POST',
      path: '/api/echo',
      body: '{"x":1}',
    })
    expect(res.status).toBe(200)
  })
})

describe('middleware chain — TUSKS_HOST=0.0.0.0 + TUSKS_LAN_WRITES off (Phase 7 default)', () => {
  let close: () => Promise<void>
  let port: number

  beforeEach(async () => {
    const app = buildAppLikeIndex({
      host: '0.0.0.0',
      port: 5173,
      lanWritesEnabled: false,
    })
    ;({ port, close } = await serve(app))
  })
  afterEach(async () => {
    await close()
  })

  it('LAN-style GET (Host = 192.168.1.42) passes (reads always allowed)', async () => {
    const res = await request({
      serverPort: port,
      hostHeader: '192.168.1.42:5173',
      originHeader: 'http://192.168.1.42:5173',
      method: 'GET',
    })
    expect(res.status).toBe(200)
  })

  // We CANNOT exercise the LAN-source-rejected-by-lanWriteGate path in
  // this integration test fixture because the http client connects via
  // loopback, so req.socket.remoteAddress is always 127.0.0.1 regardless
  // of the Host/Origin headers we set. The LAN-source 403 is covered by
  // lanWriteGate.test.ts (which directly stubs req.socket.remoteAddress).
  // What we CAN verify here: the same-origin gate composes correctly so
  // a LAN-style Origin/Host pair from a loopback client passes through
  // both gates without being mistakenly rejected as cross-origin.
  it('LAN-style POST from loopback source passes same-origin gate (Phase 8 ordering)', async () => {
    const res = await request({
      serverPort: port,
      hostHeader: '192.168.1.42:5173',
      originHeader: 'http://192.168.1.42:5173',
      method: 'POST',
      path: '/api/echo',
      body: '{"x":1}',
    })
    // Pre-Phase-8: 403 from same-origin gate because Origin not in
    // {localhost:5173, 127.0.0.1:5173}. Post-Phase-8: same-origin gate
    // accepts Origin === Host, and lanWriteGate allows because TCP
    // source is loopback. The two-layer fix.
    expect(res.status).toBe(200)
  })
})

describe('middleware chain — TUSKS_HOST=0.0.0.0 + TUSKS_LAN_WRITES=1 (the Phase 8 critical fix)', () => {
  let close: () => Promise<void>
  let port: number

  beforeEach(async () => {
    const app = buildAppLikeIndex({
      host: '0.0.0.0',
      port: 5173,
      lanWritesEnabled: true,
    })
    ;({ port, close } = await serve(app))
  })
  afterEach(async () => {
    await close()
  })

  it('LAN browser POST with Origin === Host now passes (the regression test for Phase 8)', async () => {
    // The bug Phase 8 fixed: a phone visits http://192.168.1.42:5173,
    // browser sends Origin: http://192.168.1.42:5173 on POST. Pre-Phase-8
    // this was 403'd by the same-origin gate before lanWriteGate even
    // ran. After Phase 8, Origin===Host is recognised as same-origin.
    const res = await request({
      serverPort: port,
      hostHeader: '192.168.1.42:5173',
      originHeader: 'http://192.168.1.42:5173',
      method: 'POST',
      path: '/api/echo',
      body: '{"x":1}',
    })
    expect(res.status).toBe(200)
  })

  it('LAN browser POST from evil.com (Origin !== Host) → 403 (CSRF still blocked)', async () => {
    // The flip side: the Origin===Host check must NOT open a hole for
    // cross-origin CSRF. A malicious page on evil.com posting to the
    // LAN-bound server still has Origin: http://evil.com which mismatches
    // Host: 192.168.1.42:5173 → reject.
    const res = await request({
      serverPort: port,
      hostHeader: '192.168.1.42:5173',
      originHeader: 'http://evil.example',
      method: 'POST',
      path: '/api/echo',
      body: '{"x":1}',
    })
    expect(res.status).toBe(403)
    expect(JSON.parse(res.body).error).toMatch(/Cross-origin/i)
  })

  it('LAN browser POST with no Origin → still passes (non-browser caller path)', async () => {
    const res = await request({
      serverPort: port,
      hostHeader: '192.168.1.42:5173',
      method: 'POST',
      path: '/api/echo',
      body: '{"x":1}',
    })
    expect(res.status).toBe(200)
  })

  it('LAN browser POST with malformed Origin → 403', async () => {
    const res = await request({
      serverPort: port,
      hostHeader: '192.168.1.42:5173',
      originHeader: 'not a url',
      method: 'POST',
      path: '/api/echo',
      body: '{"x":1}',
    })
    expect(res.status).toBe(403)
  })

  it('LAN browser POST with port-mismatched Origin → 403 (host check is strict)', async () => {
    // Origin host 192.168.1.42:1234 vs Host 192.168.1.42:5173 — same
    // hostname, different port. Not same-origin.
    const res = await request({
      serverPort: port,
      hostHeader: '192.168.1.42:5173',
      originHeader: 'http://192.168.1.42:1234',
      method: 'POST',
      path: '/api/echo',
      body: '{"x":1}',
    })
    expect(res.status).toBe(403)
  })
})

// ============================================================================
// /api/parse/{pdf,docx} — gate + 400 on missing file (Phase 9 closing)
// ============================================================================

describe('/api/parse/{pdf,docx} — uploadGate applied + 400 on no file', () => {
  let close: () => Promise<void>
  let port: number
  // Use TUSKS_HOST=0.0.0.0 so the hostAllowlist is disabled in the test
  // fixture — otherwise the dynamic-port Host header from http.request
  // mismatches the static port we'd have to put into the allowlist.
  // The parse routes themselves don't care about HOST.

  beforeEach(async () => {
    const app = createApiApp({ host: '0.0.0.0', port: 5173, lanWritesEnabled: true })
    ;({ port, close } = await serve(app))
  })
  afterEach(async () => {
    await close()
  })

  function postParse(path: string, contentType: string, body: string | Buffer, contentLength?: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          method: 'POST',
          path,
          headers: {
            'Content-Type': contentType,
            'Content-Length': contentLength ?? String(typeof body === 'string' ? Buffer.byteLength(body) : body.length),
          },
        },
        (res2: IncomingMessage) => {
          const chunks: Buffer[] = []
          res2.on('data', (c) => chunks.push(c))
          res2.on('end', () =>
            resolve({ status: res2.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }),
          )
        },
      )
      req.on('error', reject)
      if (contentLength === undefined) req.write(body)
      req.end()
    })
  }

  it('POST /api/parse/pdf with no file field → 400 "No file uploaded"', async () => {
    const boundary = 'b-no-file'
    const body = `--${boundary}--\r\n`
    const res = await postParse('/api/parse/pdf', `multipart/form-data; boundary=${boundary}`, body)
    expect(res.status).toBe(400)
    expect(JSON.parse(res.body).error).toMatch(/No file uploaded/)
  })

  it('POST /api/parse/docx with no file field → 400 "No file uploaded"', async () => {
    const boundary = 'b-no-file-docx'
    const body = `--${boundary}--\r\n`
    const res = await postParse('/api/parse/docx', `multipart/form-data; boundary=${boundary}`, body)
    expect(res.status).toBe(400)
    expect(JSON.parse(res.body).error).toMatch(/No file uploaded/)
  })

  it('POST /api/parse/pdf with absurd Content-Length → 503 from parseUploadGate (gate-applied regression)', async () => {
    // Declared Content-Length > 16 GB cap. parseUploadGate's fast-fail
    // must reject. If the gate were removed in a future refactor, the
    // route would accept the request (or just multer-limit by file
    // size only). 503 proves the gate is wired.
    const oversizedCL = String(17 * 1024 * 1024 * 1024)
    const res = await postParse(
      '/api/parse/pdf',
      'multipart/form-data; boundary=x',
      '',
      oversizedCL,
    )
    expect(res.status).toBe(503)
  })

  it('POST /api/parse/docx with absurd Content-Length → 503 from parseUploadGate', async () => {
    const oversizedCL = String(17 * 1024 * 1024 * 1024)
    const res = await postParse(
      '/api/parse/docx',
      'multipart/form-data; boundary=x',
      '',
      oversizedCL,
    )
    expect(res.status).toBe(503)
  })
})
