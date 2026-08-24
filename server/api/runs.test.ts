import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import express from 'express'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

let WORK: string

beforeEach(async () => {
  WORK = await fs.mkdtemp(path.join(tmpdir(), 'runs-test-'))
  vi.resetModules()
  vi.doMock('../appData.js', async () => {
    const actual = await vi.importActual<typeof import('../appData')>('../appData.js')
    return {
      ...actual,
      configDir: () => WORK,
      runsDir: () => path.join(WORK, 'runs'),
      runCheckpointFile: (runId: string) => path.join(WORK, 'runs', `${runId}.json`),
    }
  })
})

afterEach(async () => {
  vi.doUnmock('../appData.js')
  vi.resetModules()
  await fs.rm(WORK, { recursive: true, force: true })
})

async function withRunsServer<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const mod = await import('./runs.js')
  const app = express()
  app.use('/api/runs', mod.runsRouter())
  const server: Server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${addr.port}/api/runs`
  try {
    return await fn(baseUrl)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

function makeCheckpoint(over: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    runId: 'test-run-1',
    createdAt: '2026-05-21T12:00:00.000Z',
    pausedAt: '2026-05-21T12:30:00.000Z',
    pausedReason: 'quota',
    routing: { version: 3, lastSelectedProvider: 'gemini', geminiTier: 'free' },
    safetyMultiplier: 1,
    refinementState: { campaign: 'Acme Bards', sessionNumber: 4 },
    progress: { phase: 3, chunkIndex: 7, totalChunks: 12 },
    ...over,
  }
}

describe('runsRouter', () => {
  it('GET /api/runs returns empty list when no checkpoints exist', async () => {
    await withRunsServer(async (base) => {
      const res = await fetch(base)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { runs: unknown[] }
      expect(body.runs).toEqual([])
    })
  })

  it('PUT then GET round-trips a checkpoint', async () => {
    await withRunsServer(async (base) => {
      const cp = makeCheckpoint()
      const put = await fetch(`${base}/test-run-1`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cp),
      })
      expect(put.status).toBe(200)
      const get = await fetch(`${base}/test-run-1`)
      expect(get.status).toBe(200)
      expect(await get.json()).toEqual(cp)
    })
  })

  it('GET /api/runs lists summaries, most recent paused first', async () => {
    await withRunsServer(async (base) => {
      const older = makeCheckpoint({ runId: 'r-old', pausedAt: '2026-05-20T10:00:00.000Z' })
      const newer = makeCheckpoint({ runId: 'r-new', pausedAt: '2026-05-21T15:00:00.000Z' })
      await fetch(`${base}/r-old`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(older),
      })
      await fetch(`${base}/r-new`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newer),
      })
      const list = await fetch(base)
      const body = (await list.json()) as { runs: Array<{ runId: string }> }
      expect(body.runs.map((r) => r.runId)).toEqual(['r-new', 'r-old'])
    })
  })

  it('DELETE removes a checkpoint and returns 404 on subsequent GET', async () => {
    await withRunsServer(async (base) => {
      const cp = makeCheckpoint()
      await fetch(`${base}/test-run-1`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cp),
      })
      const del = await fetch(`${base}/test-run-1`, { method: 'DELETE' })
      expect(del.status).toBe(200)
      const get = await fetch(`${base}/test-run-1`)
      expect(get.status).toBe(404)
    })
  })

  it('DELETE is idempotent (already-gone returns 200)', async () => {
    await withRunsServer(async (base) => {
      const del = await fetch(`${base}/never-existed`, { method: 'DELETE' })
      expect(del.status).toBe(200)
    })
  })

  it('rejects invalid runIds', async () => {
    await withRunsServer(async (base) => {
      const res = await fetch(`${base}/${encodeURIComponent('../escape')}`)
      expect(res.status).toBe(400)
    })
  })

  // Phase J — bug #5 from .diagnose/phase-i-bug-hunt.md. The list endpoint
  // used to fabricate defaults (empty createdAt, pausedReason='user') for
  // malformed checkpoint files, so the Resume banner rendered ghost cards;
  // clicking Resume hit /api/runs/:id and got 404. Fix: list endpoint
  // excludes malformed files entirely (logs a server warning); detail
  // continues to 404. The two endpoints now agree.
  it('GET /api/runs excludes malformed checkpoints (Phase J bug #5)', async () => {
    await withRunsServer(async (base) => {
      const dir = path.join(WORK, 'runs')
      await fs.mkdir(dir, { recursive: true })
      // Plant a malformed checkpoint: missing createdAt, pausedAt, progress.
      await fs.writeFile(
        path.join(dir, 'malformed-x.json'),
        JSON.stringify({ runId: 'malformed-x', schemaVersion: 99, foo: 'bar' }),
        'utf8',
      )
      // Also plant a valid one — list should still return it.
      const valid = makeCheckpoint({ runId: 'valid-y' })
      await fs.writeFile(
        path.join(dir, 'valid-y.json'),
        JSON.stringify(valid),
        'utf8',
      )
      // Silence the expected console.warn from the skip-log.
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const listRes = await fetch(base)
        expect(listRes.status).toBe(200)
        const listBody = (await listRes.json()) as { runs: Array<{ runId: string }> }
        // The malformed checkpoint is excluded; only the valid one surfaces.
        // This prevents the Resume banner from rendering a ghost card that
        // would 404 on click.
        expect(listBody.runs.map((r) => r.runId)).toEqual(['valid-y'])
        // The skip is loud so the diagnose bundle picks it up.
        expect(warnSpy).toHaveBeenCalled()
      } finally {
        warnSpy.mockRestore()
      }
    })
  })

  // Pre-ship verification (2026-05-27) found that ANY unparseable checkpoint
  // file — UTF-8 BOM prefix from a default `Out-File -Encoding utf8`, half-
  // written file from power loss, hand-edit typo — crashed the entire list
  // endpoint with HTTP 500 because `readJson` only catches ENOENT and the
  // per-entry loop didn't guard against SyntaxError. Result: a user with one
  // bad file lost visibility of every legitimate paused run sitting next to
  // it. The fix wraps the per-entry read in try/catch and pushes to the
  // `skipped` array with reason: 'unreadable'. This lock-down test makes
  // sure the failure mode never regresses.
  it('GET /api/runs survives unparseable JSON in a checkpoint file (Phase K.7 / preship)', async () => {
    await withRunsServer(async (base) => {
      const dir = path.join(WORK, 'runs')
      await fs.mkdir(dir, { recursive: true })
      // Variant 1: UTF-8 BOM-prefixed JSON (the file content IS valid JSON but
      // the BOM byte sequence ﻿ trips JSON.parse).
      await fs.writeFile(
        path.join(dir, 'bom-y.json'),
        '﻿' + JSON.stringify({ runId: 'bom-y', foo: 'bar' }),
        'utf8',
      )
      // Variant 2: completely invalid JSON (simulates a power-loss half-write
      // or a manual edit with a typo).
      await fs.writeFile(path.join(dir, 'corrupt-z.json'), 'this is not json{}[][[', 'utf8')
      // A valid checkpoint alongside the bad ones — the list MUST still
      // surface this one so the user keeps access to their legitimate run.
      const valid = makeCheckpoint({ runId: 'valid-q' })
      await fs.writeFile(path.join(dir, 'valid-q.json'), JSON.stringify(valid), 'utf8')

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const res = await fetch(base)
        // The bug returned HTTP 500 with `{"error":"Unexpected token … is not valid JSON"}`.
        // The fix returns HTTP 200 with the valid file present and the bad ones excluded.
        expect(res.status).toBe(200)
        const body = (await res.json()) as { runs: Array<{ runId: string }> }
        expect(body.runs.map((r) => r.runId)).toEqual(['valid-q'])
        // The unreadable skip is loud — diagnose bundle picks it up.
        expect(warnSpy).toHaveBeenCalled()
      } finally {
        warnSpy.mockRestore()
      }
    })
  })

  it('GET /api/runs/:id returns 404 on an unparseable checkpoint file (instead of 500)', async () => {
    await withRunsServer(async (base) => {
      const dir = path.join(WORK, 'runs')
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, 'corrupt-id.json'), 'not json', 'utf8')
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const res = await fetch(`${base}/corrupt-id`)
        expect(res.status).toBe(404)
      } finally {
        warnSpy.mockRestore()
      }
    })
  })

  // Phase K.7 / preship verification (2026-05-28) — Playwright pass found
  // that a file which PARSES as JSON but lacks the checkpoint schema
  // (missing createdAt, pausedAt, or progress) flowed through the detail
  // endpoint as a 200 with malformed body. The list endpoint correctly
  // excluded the same file. The client's `loadRun` casts to RunCheckpoint
  // without runtime validation, so any direct call to /api/runs/:id with
  // a structurally-broken file crashed the Resume flow several layers
  // deep on a property access. Fix: detail endpoint runs the same
  // summariseOrReject as the list endpoint and 404s on rejection. This
  // lock-down test ensures the two endpoints stay in sync.
  it('GET /api/runs/:id returns 404 on a structurally-malformed checkpoint (Phase K.7)', async () => {
    await withRunsServer(async (base) => {
      const dir = path.join(WORK, 'runs')
      await fs.mkdir(dir, { recursive: true })
      // Plant a file that's syntactically valid JSON but missing the
      // required RunCheckpoint fields (createdAt, pausedAt, progress).
      await fs.writeFile(
        path.join(dir, 'malformed-detail.json'),
        JSON.stringify({ runId: 'malformed-detail', schemaVersion: 99, foo: 'bar' }),
        'utf8',
      )
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const res = await fetch(`${base}/malformed-detail`)
        expect(res.status).toBe(404)
        // The skip is loud — diagnose bundle picks it up.
        expect(warnSpy).toHaveBeenCalled()
      } finally {
        warnSpy.mockRestore()
      }
    })
  })

  it('GET /api/runs excludes checkpoints with invalid progress.phase', async () => {
    await withRunsServer(async (base) => {
      const dir = path.join(WORK, 'runs')
      await fs.mkdir(dir, { recursive: true })
      // Phase 5 is the polish phase and IS valid for resume purposes, but
      // phase 7 doesn't exist — should be rejected.
      const bogusPhase = makeCheckpoint({
        runId: 'bogus-phase-z',
        progress: { phase: 7, chunkIndex: 0, totalChunks: 0 },
      })
      await fs.writeFile(
        path.join(dir, 'bogus-phase-z.json'),
        JSON.stringify(bogusPhase),
        'utf8',
      )
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const listRes = await fetch(base)
        const listBody = (await listRes.json()) as { runs: Array<{ runId: string }> }
        expect(listBody.runs.map((r) => r.runId)).not.toContain('bogus-phase-z')
        expect(warnSpy).toHaveBeenCalled()
      } finally {
        warnSpy.mockRestore()
      }
    })
  })

  it('PUT returns 413 when the checkpoint body exceeds the 20 MB cap', async () => {
    await withRunsServer(async (base) => {
      // A 21 MB filler keeps us safely above the 20 MB cap. The body
      // parser surfaces this as `entity.too.large` (type) → 413.
      const bigCheckpoint = makeCheckpoint({
        refinementState: {
          campaign: 'big',
          sessionNumber: 1,
          rawTranscript: 'x'.repeat(21 * 1024 * 1024),
        },
      })
      const res = await fetch(`${base}/big-run`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bigCheckpoint),
      })
      expect(res.status).toBe(413)
    })
  })
})
