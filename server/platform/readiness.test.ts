// The readiness gate is what a browser, a launcher or a client fetch meets
// between the port opening and the last start-up step finishing. These
// tests pin the contract each of those callers relies on: health and boot
// always answer, other API calls get a retryable 503 with the phase, a
// page load gets the self-refreshing starting page, and once ready the
// gate gets out of the way entirely.
//
// The probe used by the whisper status check is covered here too, under
// the same heading: start-up must never wait on a child process that
// might not come back.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  bootState,
  PHASE_LABELS,
  readinessGate,
  setBootPhase,
  startingPage,
  step,
  type ReadinessSource,
} from './readiness.js'
import { runProbe } from '../features/transcription/services/whisper/bootstrap.js'

/** Serve the gate in front of a stub app that answers 200 to everything,
 *  so "passed through" is observable as a 200 with a known body. */
async function serveGated(source: ReadinessSource): Promise<{ base: string; close: () => Promise<void> }> {
  const app = express()
  app.use(readinessGate(source))
  app.get('/api/health', (_req, res) => res.json({ ok: true, from: 'health' }))
  app.get('/api/boot', (_req, res) => res.json({ bootId: 'b' }))
  app.all('*', (_req, res) => res.status(200).type('text').send('downstream'))
  const server: Server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address() as AddressInfo
  return {
    base: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

describe('readinessGate — while the server is still starting', () => {
  let base: string
  let close: () => Promise<void>

  beforeEach(async () => {
    ;({ base, close } = await serveGated({ isReady: () => false, phase: () => 'vite' }))
  })
  afterEach(async () => {
    await close()
  })

  it('GET / → 503 with a self-contained html page that says starting and names the phase', async () => {
    const res = await fetch(`${base}/`)
    expect(res.status).toBe(503)
    expect(res.headers.get('content-type')).toMatch(/text\/html/)
    expect(res.headers.get('retry-after')).toBe('1')
    expect(res.headers.get('cache-control')).toBe('no-store')
    const html = await res.text()
    expect(html).toContain('starting')
    expect(html).toContain("Tusk's Tomes")
    expect(html).toContain(PHASE_LABELS.vite)
    // Nothing is being served yet, so the page must not depend on anything
    // else being served: no external stylesheet, script or font.
    expect(html).not.toMatch(/<link[^>]+href=/i)
    expect(html).not.toMatch(/<script[^>]+src=/i)
    expect(html).toContain('/api/health')
  })

  it('HEAD / → 503 as well', async () => {
    const res = await fetch(`${base}/`, { method: 'HEAD' })
    expect(res.status).toBe(503)
  })

  it('GET /api/glossary → 503 JSON carrying the phase and Retry-After', async () => {
    const res = await fetch(`${base}/api/glossary`)
    expect(res.status).toBe(503)
    expect(res.headers.get('retry-after')).toBe('1')
    expect(await res.json()).toEqual({ error: 'starting', phase: 'vite' })
  })

  it('POST /api/anything → 503 JSON too', async () => {
    const res = await fetch(`${base}/api/runs`, { method: 'POST' })
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: 'starting' })
  })

  it('/api/health passes through to the real handler', async () => {
    const res = await fetch(`${base}/api/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, from: 'health' })
  })

  it('/api/boot passes through to the real handler', async () => {
    const res = await fetch(`${base}/api/boot`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ bootId: 'b' })
  })

  it('a non-API POST passes through', async () => {
    const res = await fetch(`${base}/upload`, { method: 'POST' })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('downstream')
  })
})

describe('readinessGate — once ready', () => {
  it('falls through to the next handler for every path', async () => {
    const { base, close } = await serveGated({ isReady: () => true, phase: () => 'ready' })
    try {
      const page = await fetch(`${base}/`)
      expect(page.status).toBe(200)
      expect(await page.text()).toBe('downstream')
      const api = await fetch(`${base}/api/glossary`)
      expect(api.status).toBe(200)
    } finally {
      await close()
    }
  })

  it('re-checks on every request, so flipping the source opens the gate', async () => {
    let ready = false
    const { base, close } = await serveGated({ isReady: () => ready, phase: () => 'lore' })
    try {
      expect((await fetch(`${base}/`)).status).toBe(503)
      ready = true
      expect((await fetch(`${base}/`)).status).toBe(200)
    } finally {
      await close()
    }
  })
})

describe('startingPage', () => {
  it('escapes a phase it does not recognise rather than injecting it', () => {
    const html = startingPage('<img src=x onerror=alert(1)>')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })
})

describe('boot state', () => {
  it('records when ready was first reached and keeps it', () => {
    setBootPhase('addons')
    expect(bootState().phase).toBe('addons')
    expect(bootState().readySince).toBeNull()
    setBootPhase('ready')
    const first = bootState().readySince
    expect(first).not.toBeNull()
    setBootPhase('ready')
    expect(bootState().readySince).toBe(first)
    expect(bootState().startedAt).toBeLessThanOrEqual(first as number)
  })
})

describe('step', () => {
  it('prints [n/total] +seconds label', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      step(2, 5, 'loading add-ons')
      expect(log).toHaveBeenCalledTimes(1)
      expect(log.mock.calls[0][0]).toMatch(/^\s*\[2\/5\] \+\d+\.\d{2}s loading add-ons$/)
    } finally {
      log.mockRestore()
    }
  })
})

describe('runProbe — the whisper import check must always come back', () => {
  it('reports ok for a child that exits 0', async () => {
    const r = await runProbe(process.execPath, ['-e', 'process.exit(0)'], 10_000)
    expect(r).toEqual({ ok: true, timedOut: false })
  })

  it('reports the exit code for a child that fails', async () => {
    const r = await runProbe(process.execPath, ['-e', 'process.exit(3)'], 10_000)
    expect(r.ok).toBe(false)
    expect(r.timedOut).toBe(false)
    expect(r.error).toContain('3')
  })

  it('kills a child that overruns the timeout and says so', async () => {
    const started = Date.now()
    const r = await runProbe(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], 300)
    expect(r.ok).toBe(false)
    expect(r.timedOut).toBe(true)
    expect(r.error).toMatch(/did not finish/)
    // Settled on the timeout, not on the child's own 60 s timer.
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('reports a command that cannot be started', async () => {
    const r = await runProbe('definitely-not-a-real-binary-for-this-test', [], 2_000)
    expect(r.ok).toBe(false)
    expect(r.timedOut).toBe(false)
    expect(r.error).toBeTruthy()
  })
})
