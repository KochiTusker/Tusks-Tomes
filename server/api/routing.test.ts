import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import express from 'express'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

// Phase J — Strict validation contract for PUT /api/routing.
//
// These tests pin down the new behaviour (HTTP 400 + structured error on
// hard failures; HTTP 200 + warnings field on unknown modelId) and
// reproduce the original "silent sanitize" bugs documented in
// .diagnose/phase-i-bug-hunt.md. If a future refactor reintroduces the
// old "silently coerce-and-200" pattern, these tests fail.

let WORK: string

beforeEach(async () => {
  WORK = await fs.mkdtemp(path.join(tmpdir(), 'routing-test-'))
  vi.resetModules()
  vi.doMock('../appData.js', async () => {
    const actual = await vi.importActual<typeof import('../appData')>('../appData.js')
    return {
      ...actual,
      configDir: () => WORK,
      routingFile: () => path.join(WORK, 'routing.json'),
    }
  })
})

afterEach(async () => {
  vi.doUnmock('../appData.js')
  vi.resetModules()
  await fs.rm(WORK, { recursive: true, force: true })
})

async function withRoutingServer<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const mod = await import('./routing.js')
  const app = express()
  app.use(express.json())
  app.use('/api/routing', mod.routingRouter())
  const server: Server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${addr.port}/api/routing`
  try {
    return await fn(baseUrl)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

describe('routingRouter PUT — strict validation (Phase J)', () => {
  it('happy path: valid full doc round-trips with no warnings', async () => {
    await withRoutingServer(async (base) => {
      const res = await fetch(base, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 3,
          lastSelectedProvider: 'gemini',
          geminiTier: 'paid',
          perPhase: {},
        }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as Record<string, unknown>
      expect(body.lastSelectedProvider).toBe('gemini')
      expect(body.geminiTier).toBe('paid')
      expect(body.warnings).toBeUndefined()
    })
  })

  // Bug #1 (Phase I): invalid lastSelectedProvider used to be silently nulled.
  it('returns 400 with structured error for invalid lastSelectedProvider', async () => {
    await withRoutingServer(async (base) => {
      const res = await fetch(base, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 3,
          lastSelectedProvider: 'nonsense',
          geminiTier: 'paid',
          perPhase: {},
        }),
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as Record<string, unknown>
      expect(body.field).toBe('lastSelectedProvider')
      expect(body.received).toBe('nonsense')
      expect(body.allowedValues).toEqual(['gemini', 'claude', 'openai', 'claudeCode', 'codex', null])
      expect(String(body.error)).toContain("'nonsense'")
    })
  })

  it('accepts null lastSelectedProvider (clearing the field)', async () => {
    await withRoutingServer(async (base) => {
      const res = await fetch(base, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 3,
          lastSelectedProvider: null,
          geminiTier: 'paid',
          perPhase: {},
        }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as Record<string, unknown>
      expect(body.lastSelectedProvider).toBeNull()
    })
  })

  // Bug #2 (Phase I): invalid geminiTier used to be silently set to undefined.
  it('returns 400 with structured error for invalid geminiTier', async () => {
    await withRoutingServer(async (base) => {
      const res = await fetch(base, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 3,
          lastSelectedProvider: 'gemini',
          geminiTier: 'premium',
          perPhase: {},
        }),
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as Record<string, unknown>
      expect(body.field).toBe('geminiTier')
      expect(body.received).toBe('premium')
      expect(body.allowedValues).toEqual(['paid', 'free', 'auto'])
    })
  })

  // Bug #3 (Phase I): arbitrary modelId used to save with no signal that
  // the pipeline would fail at the LLM call.
  it('returns 200 with warnings for unknown modelId (per-phase override)', async () => {
    await withRoutingServer(async (base) => {
      const res = await fetch(base, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 3,
          lastSelectedProvider: 'gemini',
          geminiTier: 'paid',
          perPhase: {
            phase1: {
              target: 'cloud',
              cloudProvider: 'gemini',
              geminiTier: 'paid',
              modelId: 'clearly-not-a-model',
            },
          },
        }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { warnings?: string[] }
      expect(body.warnings).toBeDefined()
      expect(body.warnings!.length).toBe(1)
      expect(body.warnings![0]).toContain('clearly-not-a-model')
      expect(body.warnings![0]).toContain('gemini')
    })
  })

  it('does not warn when modelId is a known Gemini model', async () => {
    await withRoutingServer(async (base) => {
      const res = await fetch(base, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 3,
          lastSelectedProvider: 'gemini',
          geminiTier: 'paid',
          perPhase: {
            phase1: {
              target: 'cloud',
              cloudProvider: 'gemini',
              modelId: 'gemini-2.5-pro',
            },
          },
        }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { warnings?: string[] }
      expect(body.warnings).toBeUndefined()
    })
  })

  // Bug #4 (Phase I): unknown schema version used to silently downgrade to 1.
  it('returns 400 when version is newer than CURRENT_VERSION (server-too-old signal)', async () => {
    await withRoutingServer(async (base) => {
      const res = await fetch(base, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 99,
          lastSelectedProvider: 'gemini',
          geminiTier: 'paid',
          perPhase: {},
        }),
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as Record<string, unknown>
      expect(body.field).toBe('version')
      expect(body.received).toBe(99)
      expect(String(body.error)).toMatch(/newer client/i)
    })
  })

  it('returns 400 for non-integer version like 1.5', async () => {
    await withRoutingServer(async (base) => {
      const res = await fetch(base, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1.5,
          lastSelectedProvider: 'gemini',
        }),
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as Record<string, unknown>
      expect(body.field).toBe('version')
    })
  })

  it('returns 400 when perPhase entry has invalid target', async () => {
    await withRoutingServer(async (base) => {
      const res = await fetch(base, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 3,
          lastSelectedProvider: 'gemini',
          perPhase: {
            phase1: { target: 'remote', modelId: 'gemini-2.5-pro' },
          },
        }),
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as Record<string, unknown>
      expect(String(body.field)).toBe('perPhase.phase1.target')
    })
  })

  it('returns 400 when local target is missing modelId', async () => {
    await withRoutingServer(async (base) => {
      const res = await fetch(base, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 3,
          lastSelectedProvider: 'gemini',
          perPhase: {
            phase1: { target: 'local' },
          },
        }),
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as Record<string, unknown>
      expect(String(body.field)).toBe('perPhase.phase1.modelId')
    })
  })

  it('returns 400 for non-object body', async () => {
    await withRoutingServer(async (base) => {
      const res = await fetch(base, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(['not', 'an', 'object']),
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as Record<string, unknown>
      expect(body.field).toBe('_root')
    })
  })

  it('GET still tolerates older on-disk shapes (no version field)', async () => {
    // Simulate a pre-version doc on disk (sanitize defaults version to 1).
    // Verifies that strict-PUT does not break round-trip reads of legacy state.
    await fs.writeFile(
      path.join(WORK, 'routing.json'),
      JSON.stringify({ lastSelectedProvider: 'gemini' }),
      'utf8',
    )
    await withRoutingServer(async (base) => {
      const res = await fetch(base)
      expect(res.status).toBe(200)
      const body = (await res.json()) as Record<string, unknown>
      expect(body.version).toBe(1)
      expect(body.lastSelectedProvider).toBe('gemini')
    })
  })
})

// Regression: applying the Measured Hybrid preset emitted five spurious
// "not in the known-models list" warnings, because the ladder routes to the
// floating `-latest` aliases while this validator only knew pinned 2.x ids.
// The client validator has always accepted tier-named Gemini ids; the two
// disagreeing is the actual defect.
describe('routingRouter PUT — Gemini model-id recognition', () => {
  const put = (baseUrl: string, perPhase: Record<string, unknown>) =>
    fetch(baseUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 3, lastSelectedProvider: 'gemini', geminiTier: 'paid', perPhase }),
    })

  it('accepts the floating -latest aliases with no warnings', async () => {
    await withRoutingServer(async (baseUrl) => {
      const res = await put(baseUrl, {
        phase1: { target: 'cloud', cloudProvider: 'gemini', geminiTier: 'paid', modelId: 'gemini-flash-latest' },
        phase3: { target: 'cloud', cloudProvider: 'gemini', geminiTier: 'paid', modelId: 'gemini-pro-latest' },
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.warnings ?? []).toEqual([])
    })
  })

  it('accepts an unpinned future Gemini id that names its tier', async () => {
    await withRoutingServer(async (baseUrl) => {
      const res = await put(baseUrl, {
        phase1: { target: 'cloud', cloudProvider: 'gemini', geminiTier: 'paid', modelId: 'gemini-9.9-flash' },
      })
      expect((await res.json()).warnings ?? []).toEqual([])
    })
  })

  it('still warns on a genuine typo that names no tier', async () => {
    await withRoutingServer(async (baseUrl) => {
      const res = await put(baseUrl, {
        phase1: { target: 'cloud', cloudProvider: 'gemini', geminiTier: 'paid', modelId: 'gemnii-2.5' },
      })
      const body = await res.json()
      expect(body.warnings?.length).toBeGreaterThan(0)
      expect(body.warnings[0]).toMatch(/known-models list/)
    })
  })
})
