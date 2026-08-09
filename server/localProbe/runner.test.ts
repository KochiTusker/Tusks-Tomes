// Tests for the local-LLM probe runner. Headline gate: bearer-token
// attachment to Unsloth requests must match the stored Unsloth host
// exactly — a hostile baseUrl on the same :8888 port must NOT see the
// stored credentials.
//
// This is the regression test that pins the security gate at
// runner.ts:isStoredUnslothHost (line 25-33). Without this test, a
// future refactor that loosens the host check (e.g. matching by port
// alone, or by domain suffix) silently exfiltrates the user's stored
// Unsloth bearer to attacker-supplied targets.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('Unsloth bearer attachment — host equality gate', () => {
  const STORED_BASE = 'http://localhost:8888'
  const STORED_BEARER = 'unsloth-bearer-secret-do-not-leak'

  beforeEach(() => {
    vi.resetModules()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  async function loadRunner(probeBaseUrl: string) {
    // Mock readUnslothConfig to return a known stored config.
    vi.doMock('./unslothAuth.js', () => ({
      readUnslothConfig: vi.fn().mockResolvedValue({
        baseUrl: STORED_BASE,
        bearerToken: STORED_BEARER,
      }),
      authHeaders: vi.fn().mockResolvedValue({
        Authorization: `Bearer ${STORED_BEARER}`,
      }),
    }))
    // Mock backendForBaseUrl to return 'unsloth' so the bearer attach
    // path runs.
    vi.doMock('../api/localLLM.js', () => ({
      backendForBaseUrl: vi.fn().mockReturnValue('unsloth'),
    }))
    // Mock validators to no-op (private host check would reject our
    // 8.8.8.8 / public IPs otherwise; we want to reach the host gate).
    vi.doMock('../lib/validators.js', () => ({
      validateLocalBaseUrl: vi.fn().mockImplementation(async (s: string) => s),
    }))
    const { runProbe } = await import('./runner.js')
    return runProbe
  }

  it('stored host matches probe host → bearer IS attached', async () => {
    let observedAuth: string | undefined
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined
      if (headers?.Authorization) observedAuth = headers.Authorization
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const runProbe = await loadRunner(STORED_BASE)
    await runProbe({ baseUrl: STORED_BASE, modelId: 'test-model' })

    expect(observedAuth).toBe(`Bearer ${STORED_BEARER}`)
  })

  it('stored host DIFFERENT from probe host → bearer is NOT attached (regression test)', async () => {
    let observedAuth: string | undefined
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined
      if (headers?.Authorization) observedAuth = headers.Authorization
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const runProbe = await loadRunner('http://otherhost:8888')
    await runProbe({ baseUrl: 'http://otherhost:8888', modelId: 'test-model' })

    // THE LOAD-BEARING ASSERTION. If this fails, an attacker who can
    // get the user to probe an attacker-controlled URL on port 8888
    // harvests the stored Unsloth bearer.
    expect(observedAuth).toBeUndefined()
  })

  it('case insensitivity: HOST in URL still matches LOWER stored host', async () => {
    let observedAuth: string | undefined
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined
      if (headers?.Authorization) observedAuth = headers.Authorization
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const runProbe = await loadRunner('http://LOCALHOST:8888')
    await runProbe({ baseUrl: 'http://LOCALHOST:8888', modelId: 'test-model' })

    expect(observedAuth).toBe(`Bearer ${STORED_BEARER}`)
  })

  it('different port on same host → bearer is NOT attached', async () => {
    let observedAuth: string | undefined
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined
      if (headers?.Authorization) observedAuth = headers.Authorization
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch

    // Stored is localhost:8888, probe is localhost:9999. Even though
    // the hostname matches, the port differs — bearer must not attach.
    const runProbe = await loadRunner('http://localhost:9999')
    await runProbe({ baseUrl: 'http://localhost:9999', modelId: 'test-model' })

    expect(observedAuth).toBeUndefined()
  })
})
