// Probe route rejects non-private baseUrls with 400 before reaching the
// runner. Regression test for the SSRF that allowed any attacker-
// supplied baseUrl through to fetch() — leaking the user's stored
// Unsloth credentials via the bearer-attachment heuristic.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import express from 'express'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

async function withProbeRouter<T>(
  fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const { probeRouter } = await import('./probe.js')
  const app = express()
  app.use(express.json())
  app.use('/api/local-llm', probeRouter())
  const server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${addr.port}/api/local-llm`
  try {
    return await fn(baseUrl)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

describe('POST /api/local-llm/probe', () => {
  it('rejects missing baseUrl with 400', async () => {
    await withProbeRouter(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/probe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId: 'x' }),
      })
      expect(res.status).toBe(400)
    })
  })

  it('rejects public baseUrl (SSRF) with 400', async () => {
    await withProbeRouter(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/probe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseUrl: 'http://169.254.169.254/',
          modelId: 'whatever',
        }),
      })
      expect(res.status).toBe(400)
      const body = await res.json() as { error?: string }
      expect(body.error).toMatch(/non-local/)
    })
  })

  it('rejects userinfo-bypass baseUrl with 400', async () => {
    await withProbeRouter(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/probe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseUrl: 'http://1.2.3.4@127.0.0.1/',
          modelId: 'whatever',
        }),
      })
      expect(res.status).toBe(400)
    })
  })
})
