// Path-traversal regression test for /api/sessions/:id/*.
//
// req.params.id is user-controlled. Express's path-to-regexp decodes
// percent-encoded slashes inside a single :id segment, so a hostile
// request like `DELETE /api/sessions/..%2F..%2Fetc` reaches the handler
// with `req.params.id === "../../etc"`. Without validation, that gets
// composed into `path.join(sessionsRoot(), id)` and the request
// becomes a directory deletion gadget rooted anywhere the server
// process can write.
//
// This test pins three behaviours:
//   1. Every :id route returns 400 on a malformed id (we never reach
//      the filesystem layer).
//   2. A well-formed but unknown id returns 404 (the route is alive).
//   3. sessionDir() itself fails closed if a future caller forgets the
//      route-level guard.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import express from 'express'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

let WORK: string

beforeEach(async () => {
  WORK = await fs.mkdtemp(path.join(tmpdir(), 'sessions-test-'))
  vi.resetModules()
  vi.doMock('../appData.js', async () => {
    const actual = await vi.importActual<typeof import('../appData')>('../appData.js')
    return {
      ...actual,
      sessionsRoot: () => path.join(WORK, 'sessions'),
      configDir: () => WORK,
    }
  })
})

afterEach(async () => {
  vi.doUnmock('../appData.js')
  vi.resetModules()
  await fs.rm(WORK, { recursive: true, force: true })
})

async function withSessionsServer<T>(
  fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const { sessionsRouter } = await import('./sessions.js')
  const app = express()
  app.use(express.json())
  app.use('/api/sessions', sessionsRouter())
  const server: Server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${addr.port}/api/sessions`
  try {
    return await fn(baseUrl)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

describe('Path traversal — /api/sessions/:id', () => {
  // Note: we intentionally omit the empty string here. An HTTP request
  // for `/api/sessions/` is routed to the *list* handler (GET /), not to
  // `:id`, so it doesn't exercise the validator and returns 200/404
  // depending on method — not 400.
  const malicious = [
    '../etc',
    '..\\etc',
    'a/b',
    'a%2Fb', // double-encoded segment, just in case
    'a.b', // dot in id (not allowed by ID_RE)
    'x'.repeat(65), // oversize
    'with space',
    'null\x00byte',
  ]

  for (const evilId of malicious) {
    it(`GET    ${JSON.stringify(evilId)} → 400`, async () => {
      await withSessionsServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/${encodeURIComponent(evilId)}`)
        expect(res.status).toBe(400)
      })
    })
    it(`DELETE ${JSON.stringify(evilId)} → 400 (no filesystem touch)`, async () => {
      await withSessionsServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/${encodeURIComponent(evilId)}`, {
          method: 'DELETE',
        })
        expect(res.status).toBe(400)
      })
    })
    it(`GET    ${JSON.stringify(evilId)}/sbv → 400`, async () => {
      await withSessionsServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/${encodeURIComponent(evilId)}/sbv`)
        expect(res.status).toBe(400)
      })
    })
    it(`GET    ${JSON.stringify(evilId)}/live → 400`, async () => {
      await withSessionsServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/${encodeURIComponent(evilId)}/live`)
        expect(res.status).toBe(400)
      })
    })
  }

  it('GET /api/sessions/<valid-but-unknown> → 404 (handler reached)', async () => {
    await withSessionsServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/2025-01-01-unknown-id`)
      expect(res.status).toBe(404)
    })
  })

  it('Content-Disposition uses RFC 6266 encoded form', async () => {
    // Seed a minimal session on disk so the SBV route reaches the
    // header-setting code path.
    const sid = 'test-session-abc'
    const dir = path.join(WORK, 'sessions', sid)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      path.join(dir, 'manifest.json'),
      JSON.stringify({
        version: 1, sessionId: sid, guildId: 'g', voiceChannelId: 'c',
        voiceChannelName: 'C', startedAt: 'now', endedAt: null,
        participants: [], processing: { transcribedAt: 'now', sbvPath: 'session.sbv' },
      }),
    )
    await fs.writeFile(path.join(dir, 'session.sbv'), '0:00:00.000,0:00:01.000\nhi\n\n')
    await withSessionsServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/${sid}/sbv`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-disposition')).toMatch(/filename\*=UTF-8''/)
    })
  })
})

describe('sessionDir fail-closed at definition', () => {
  it('throws on a non-conforming id even when called directly', async () => {
    const { sessionDir } = await import('../sessions/sessionManifest.js')
    expect(() => sessionDir('../etc')).toThrow(/invalid session id/)
    expect(() => sessionDir('a/b')).toThrow(/invalid session id/)
    expect(() => sessionDir('')).toThrow(/invalid session id/)
  })
  it('accepts a conforming id', async () => {
    const { sessionDir } = await import('../sessions/sessionManifest.js')
    expect(() => sessionDir('valid-id-1')).not.toThrow()
  })
})
