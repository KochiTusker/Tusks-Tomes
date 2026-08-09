// Diagnostics API integration tests — mount the router into a tiny
// Express app on a random port and exercise each endpoint over real HTTP.
// The diagnosticsLog module is mocked so the test writes to a tmpdir
// rather than touching the user's real ~/.config/tusks-tomes/.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express, { type Express } from 'express'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let tmpDir: string

vi.mock('../appData.js', async () => {
  const actual = await vi.importActual<typeof import('../appData.js')>('../appData.js')
  return {
    ...actual,
    configDir: () => tmpDir,
  }
})

async function serve(app: Express): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address() as AddressInfo
  return {
    port: addr.port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

async function buildApp(): Promise<Express> {
  const { diagnosticsRouter } = await import('./diagnostics.js')
  const app = express()
  app.use(express.json({ limit: '5mb' }))
  app.use('/api/diagnostics', diagnosticsRouter())
  return app
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tusks-diag-api-'))
  const mod = await import('../lib/diagnosticsLog.js')
  await mod._resetForTests()
})

afterEach(async () => {
  const mod = await import('../lib/diagnosticsLog.js')
  await mod._resetForTests()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('POST /api/diagnostics/log — browser→server forwarder', () => {
  it('accepts a batch of valid entries and reports the count', async () => {
    const app = await buildApp()
    const { port, close } = await serve(app)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/diagnostics/log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entries: [
            { ts: 1000, cat: 'pipeline', payload: { event: 'phase_start' } },
            { ts: 2000, cat: 'gemini', payload: { event: 'hard_zero_detected' } },
          ],
        }),
      })
      expect(res.ok).toBe(true)
      const body = await res.json()
      expect(body.accepted).toBe(2)
      expect(body.rejected).toBe(0)
    } finally {
      await close()
    }
  })

  it('400s when body shape is invalid', async () => {
    const app = await buildApp()
    const { port, close } = await serve(app)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/diagnostics/log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notEntries: 'nope' }),
      })
      expect(res.status).toBe(400)
    } finally {
      await close()
    }
  })

  it('400s when batch exceeds MAX_BATCH_SIZE (500)', async () => {
    const app = await buildApp()
    const { port, close } = await serve(app)
    try {
      const tooMany = Array.from({ length: 501 }, (_, i) => ({
        cat: 'pipeline',
        payload: { i },
      }))
      const res = await fetch(`http://127.0.0.1:${port}/api/diagnostics/log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries: tooMany }),
      })
      expect(res.status).toBe(400)
    } finally {
      await close()
    }
  })

  it('drops entries with invalid shape (missing cat) but accepts the rest', async () => {
    const app = await buildApp()
    const { port, close } = await serve(app)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/diagnostics/log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entries: [
            { cat: 'pipeline', payload: { ok: 1 } },
            { payload: { missingCat: true } },
            { cat: 'gemini', payload: { ok: 2 } },
          ],
        }),
      })
      const body = await res.json()
      expect(body.accepted).toBe(2)
      expect(body.rejected).toBe(1)
    } finally {
      await close()
    }
  })
})

describe('GET + POST /api/diagnostics/config', () => {
  it('GET returns defaults when no config has been written', async () => {
    const app = await buildApp()
    const { port, close } = await serve(app)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/diagnostics/config`)
      const body = await res.json()
      expect(body.terminal).toBe(false)
      expect(body.file).toBe(false)
      expect(typeof body.logFilePath).toBe('string')
      expect(body.logFilePath).toContain('diagnostics.log')
    } finally {
      await close()
    }
  })

  it('POST persists the new config and returns it', async () => {
    const app = await buildApp()
    const { port, close } = await serve(app)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/diagnostics/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ terminal: true, file: true }),
      })
      const body = await res.json()
      expect(body.terminal).toBe(true)
      expect(body.file).toBe(true)
      // Round-trip via GET to confirm the persisted state matches.
      const res2 = await fetch(`http://127.0.0.1:${port}/api/diagnostics/config`)
      const body2 = await res2.json()
      expect(body2.terminal).toBe(true)
      expect(body2.file).toBe(true)
    } finally {
      await close()
    }
  })

  it('POST silently ignores fields with wrong types', async () => {
    const app = await buildApp()
    const { port, close } = await serve(app)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/diagnostics/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ terminal: 'yes', file: 1 }),
      })
      const body = await res.json()
      // Defaults preserved when types don't match.
      expect(body.terminal).toBe(false)
      expect(body.file).toBe(false)
    } finally {
      await close()
    }
  })
})

describe('POST /api/diagnostics/clear-file', () => {
  it('truncates the on-disk log file', async () => {
    const app = await buildApp()
    const { port, close } = await serve(app)
    try {
      // Enable file logging.
      await fetch(`http://127.0.0.1:${port}/api/diagnostics/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: true }),
      })
      // Push some entries.
      await fetch(`http://127.0.0.1:${port}/api/diagnostics/log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries: [{ cat: 'pipeline', payload: { i: 1 } }] }),
      })
      await new Promise((r) => setTimeout(r, 100))
      // Clear.
      const clearRes = await fetch(`http://127.0.0.1:${port}/api/diagnostics/clear-file`, {
        method: 'POST',
      })
      expect(clearRes.ok).toBe(true)
      const mod = await import('../lib/diagnosticsLog.js')
      const content = await fs.readFile(mod.logFilePath(), 'utf8').catch(() => '')
      expect(content).toBe('')
    } finally {
      await close()
    }
  })
})

describe('GET /api/diagnostics/recent — merged ring snapshot', () => {
  it('returns the recent ring entries (default 100)', async () => {
    const app = await buildApp()
    const { port, close } = await serve(app)
    try {
      // Push some entries.
      await fetch(`http://127.0.0.1:${port}/api/diagnostics/log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entries: [
            { cat: 'pipeline', payload: { i: 1 } },
            { cat: 'gemini', payload: { i: 2 } },
            { cat: 'pipeline', payload: { i: 3 } },
          ],
        }),
      })
      const res = await fetch(`http://127.0.0.1:${port}/api/diagnostics/recent`)
      const body = await res.json()
      expect(body.entries).toHaveLength(3)
      expect(body.total).toBe(3)
    } finally {
      await close()
    }
  })

  it('respects ?cat= filter', async () => {
    const app = await buildApp()
    const { port, close } = await serve(app)
    try {
      await fetch(`http://127.0.0.1:${port}/api/diagnostics/log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entries: [
            { cat: 'pipeline', payload: { i: 1 } },
            { cat: 'gemini', payload: { i: 2 } },
          ],
        }),
      })
      const res = await fetch(`http://127.0.0.1:${port}/api/diagnostics/recent?cat=gemini`)
      const body = await res.json()
      expect(body.entries).toHaveLength(1)
      expect(body.entries[0].cat).toBe('gemini')
    } finally {
      await close()
    }
  })

  it('caps ?count= at 500', async () => {
    const app = await buildApp()
    const { port, close } = await serve(app)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/diagnostics/recent?count=9999`)
      expect(res.ok).toBe(true)
      // No assertion on length (ring is empty) — just verifies no 500.
    } finally {
      await close()
    }
  })
})

describe('POST /api/diagnostics/clear-ring', () => {
  it('wipes the in-memory ring but leaves the file untouched', async () => {
    const app = await buildApp()
    const { port, close } = await serve(app)
    try {
      await fetch(`http://127.0.0.1:${port}/api/diagnostics/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: true }),
      })
      await fetch(`http://127.0.0.1:${port}/api/diagnostics/log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries: [{ cat: 'pipeline', payload: { i: 1 } }] }),
      })
      await new Promise((r) => setTimeout(r, 100))
      await fetch(`http://127.0.0.1:${port}/api/diagnostics/clear-ring`, { method: 'POST' })
      // Ring is empty.
      const ringRes = await fetch(`http://127.0.0.1:${port}/api/diagnostics/recent`)
      const ringBody = await ringRes.json()
      expect(ringBody.entries).toHaveLength(0)
      // File still has the entry.
      const mod = await import('../lib/diagnosticsLog.js')
      const content = await fs.readFile(mod.logFilePath(), 'utf8')
      expect(content).toContain('"i":1')
    } finally {
      await close()
    }
  })
})
