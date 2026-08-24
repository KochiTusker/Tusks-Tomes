// Diagnose API integration test — mount the router on a random port,
// hit it over real HTTP. The bundle builder is mocked so we test the
// API surface contract (body validation, response shape) without
// touching the filesystem.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express, { type Express } from 'express'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

const bundleState = vi.hoisted(() => ({
  buildShouldThrow: false,
  buildResponse: {
    markdown: '# Bundle',
    latestPath: '/tmp/diagnose/latest.md',
    bundlePath: '/tmp/diagnose/diagnose-2026-05-24.md',
    signatures: [] as Array<{ id: string; severity: string; hint: string }>,
  },
  recentBundles: [] as Array<{ filename: string; path: string; size: number; modifiedAt: string }>,
}))

vi.mock('../lib/diagnoseBundle.js', () => ({
  buildBundle: vi.fn(async () => {
    if (bundleState.buildShouldThrow) throw new Error('synthetic failure')
    return bundleState.buildResponse
  }),
  listRecentBundles: vi.fn(async () => bundleState.recentBundles),
}))

import { diagnoseRouter } from './diagnose.js'

async function serve(): Promise<{ port: number; close: () => Promise<void>; app: Express }> {
  const app = express()
  app.use(express.json({ limit: '5mb' }))
  app.use('/api/diagnose', diagnoseRouter())
  const server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address() as AddressInfo
  return {
    port: addr.port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
    app,
  }
}

beforeEach(() => {
  bundleState.buildShouldThrow = false
  bundleState.buildResponse = {
    markdown: '# Bundle',
    latestPath: '/tmp/diagnose/latest.md',
    bundlePath: '/tmp/diagnose/diagnose-2026-05-24.md',
    signatures: [],
  }
  bundleState.recentBundles = []
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('POST /api/diagnose/bundle', () => {
  it('builds a bundle with manual trigger when no body fields are set', async () => {
    const { port, close } = await serve()
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/diagnose/bundle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.ok).toBe(true)
      const body = await res.json()
      expect(body.ok).toBe(true)
      expect(body.latestPath).toBe('/tmp/diagnose/latest.md')
      expect(body.signaturesMatched).toBe(0)
    } finally {
      await close()
    }
  })

  it('echoes matched signatures in the response', async () => {
    bundleState.buildResponse.signatures = [
      { id: 'chunk_latency_outlier', severity: 'warning', hint: 'foo' },
      { id: 'auto_fallback_mid_run', severity: 'warning', hint: 'bar' },
    ]
    const { port, close } = await serve()
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/diagnose/bundle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trigger: 'hard_error' }),
      })
      const body = await res.json()
      expect(body.signaturesMatched).toBe(2)
      expect(body.signatures).toEqual([
        { id: 'chunk_latency_outlier', severity: 'warning' },
        { id: 'auto_fallback_mid_run', severity: 'warning' },
      ])
    } finally {
      await close()
    }
  })

  it('passes trigger / symbolHint / errorMessage / errorStack / currentState through to buildBundle', async () => {
    const { buildBundle } = await import('../lib/diagnoseBundle.js')
    const { port, close } = await serve()
    try {
      await fetch(`http://127.0.0.1:${port}/api/diagnose/bundle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trigger: 'soft_match',
          symbolHint: 'runPhase3',
          errorMessage: 'boom',
          errorStack: 'Error: boom\n    at runPhase3 (foo.ts:1:1)',
          currentState: { status: 'error' },
        }),
      })
      expect(buildBundle).toHaveBeenCalledWith(
        expect.objectContaining({
          trigger: 'soft_match',
          symbolHint: 'runPhase3',
          errorMessage: 'boom',
          errorStack: expect.stringContaining('runPhase3'),
          currentState: { status: 'error' },
        }),
      )
    } finally {
      await close()
    }
  })

  it('falls back to manual trigger when trigger value is invalid', async () => {
    const { buildBundle } = await import('../lib/diagnoseBundle.js')
    const { port, close } = await serve()
    try {
      await fetch(`http://127.0.0.1:${port}/api/diagnose/bundle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trigger: 'bogus' }),
      })
      expect(buildBundle).toHaveBeenCalledWith(
        expect.objectContaining({ trigger: 'manual' }),
      )
    } finally {
      await close()
    }
  })

  it('drops malformed browserRing entries but preserves valid ones', async () => {
    const { buildBundle } = await import('../lib/diagnoseBundle.js')
    const { port, close } = await serve()
    try {
      await fetch(`http://127.0.0.1:${port}/api/diagnose/bundle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          browserRing: [
            { ts: 1000, cat: 'pipeline', payload: { ok: true } },
            { cat: '', payload: {} }, // invalid — empty cat
            'not an object', // invalid
            { ts: 2000, cat: 'gemini', payload: { ok: true } },
          ],
        }),
      })
      const call = (buildBundle as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
        browserRing: unknown[]
      }
      expect(call.browserRing).toHaveLength(2)
    } finally {
      await close()
    }
  })

  it('returns 500 when buildBundle throws', async () => {
    bundleState.buildShouldThrow = true
    const { port, close } = await serve()
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/diagnose/bundle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(500)
      const body = await res.json()
      expect(body.ok).toBe(false)
      expect(body.error).toContain('synthetic')
    } finally {
      await close()
    }
  })
})

describe('GET /api/diagnose/recent', () => {
  it('returns the listRecentBundles output verbatim', async () => {
    bundleState.recentBundles = [
      { filename: 'latest.md', path: '/tmp/.diagnose/latest.md', size: 1234, modifiedAt: '2026-05-24T13:00:00Z' },
      { filename: 'diagnose-2026-05-24T12-00-00Z.md', path: '/tmp/.diagnose/diagnose-2026-05-24T12-00-00Z.md', size: 1100, modifiedAt: '2026-05-24T12:00:00Z' },
    ]
    const { port, close } = await serve()
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/diagnose/recent`)
      expect(res.ok).toBe(true)
      const body = await res.json()
      expect(body.bundles).toHaveLength(2)
      expect(body.bundles[0].filename).toBe('latest.md')
    } finally {
      await close()
    }
  })

  it('returns empty list when listRecentBundles returns []', async () => {
    bundleState.recentBundles = []
    const { port, close } = await serve()
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/diagnose/recent`)
      const body = await res.json()
      expect(body.bundles).toEqual([])
    } finally {
      await close()
    }
  })
})
