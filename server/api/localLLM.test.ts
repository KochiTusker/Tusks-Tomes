// backendForBaseUrl regression. The previous implementation did a
// substring match on `baseUrl.toLowerCase()` for ':8888', which let any
// URL containing ":8888" (including attacker-controlled hosts) be
// classified as Unsloth. The probe runner then attached the user's
// stored Unsloth credentials to the outbound request — a working
// credential exfil gadget when combined with SSRF in /api/local-llm/probe.
//
// The fix parses the URL and matches on URL.port exactly. Credential
// attachment in the probe runner is additionally gated by host-equality
// against the stored Unsloth baseUrl (covered in localProxy.test.ts).
//
// Phase 6.5 adds: storage-boundary validation tests for PUT
// /unsloth-config and unslothAuthProvider re-validation tests.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { backendForBaseUrl } from './localLLM.js'

describe('backendForBaseUrl', () => {
  it('classifies Ollama on :11434', () => {
    expect(backendForBaseUrl('http://127.0.0.1:11434/')).toBe('ollama')
  })
  it('classifies LM Studio on :1234', () => {
    expect(backendForBaseUrl('http://localhost:1234')).toBe('lmstudio')
  })
  it('classifies llama.cpp on :8080', () => {
    expect(backendForBaseUrl('http://10.0.0.1:8080')).toBe('llamacpp')
  })
  it('classifies Unsloth on :8888', () => {
    expect(backendForBaseUrl('http://127.0.0.1:8888')).toBe('unsloth')
  })
  it('returns "unknown" for an unrecognised port', () => {
    expect(backendForBaseUrl('http://127.0.0.1:9999')).toBe('unknown')
  })
  it('returns "unknown" for a malformed URL', () => {
    expect(backendForBaseUrl('not a url')).toBe('unknown')
  })

  // Regression: previous substring scan matched any URL containing
  // ":8888" anywhere — including the path (`/api/8888-test`) or the
  // userinfo segment. The parsed-port check is exact.
  it('does NOT classify path containing :8888 as Unsloth', () => {
    expect(backendForBaseUrl('http://127.0.0.1:11434/v1/:8888-test')).toBe('ollama')
  })
  it('does NOT classify userinfo containing :8888 as Unsloth', () => {
    // The :8888 here is part of the username — port is empty (default).
    expect(backendForBaseUrl('http://user:8888@127.0.0.1/')).toBe('unknown')
  })
})

// ============================================================================
// PUT /unsloth-config — storage-boundary baseUrl validation (Phase 6.5)
// ============================================================================
//
// Even though loopbackOnly() gates this route, the validator at the
// storage boundary is the load-bearing defence against a stored-then-
// read-later credential exfil. A future refactor that bypasses the
// gate (or a malicious add-on with same-origin access) would still
// fail at the validator. These tests pin that contract.

describe('PUT /unsloth-config — baseUrl validation', () => {
  let setKeyCalls: Array<[string, string]> = []
  let storedConfig: { baseUrl?: string; bearerToken?: string } | null = null

  beforeEach(() => {
    setKeyCalls = []
    storedConfig = null
    vi.resetModules()
    vi.doMock('../crypto/keyStore.js', () => ({
      setKey: vi.fn(async (name: string, value: string) => {
        setKeyCalls.push([name, value])
        if (name === 'unsloth') {
          storedConfig = JSON.parse(value) as { baseUrl?: string; bearerToken?: string }
        }
      }),
      clearKey: vi.fn(async () => undefined),
      loadKeys: vi.fn(async () => ({})),
    }))
    vi.doMock('../localProbe/unslothAuth.js', () => ({
      authHeaders: vi.fn(async () => ({})),
      invalidateTokenCache: vi.fn(),
      readUnslothConfig: vi.fn(async () => storedConfig),
    }))
    // Skip the loopback gate for the test — we're testing validation,
    // not the gate.
    vi.doMock('../lib/loopbackGate.js', () => ({
      loopbackOnly: () => (_req: unknown, _res: unknown, next: () => void) => next(),
    }))
  })

  afterEach(() => {
    vi.doUnmock('../crypto/keyStore.js')
    vi.doUnmock('../localProbe/unslothAuth.js')
    vi.doUnmock('../lib/loopbackGate.js')
    vi.resetModules()
  })

  async function putConfig(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const { localLLMRouter } = await import('./localLLM.js')
    const { withRouter } = await import('../testing/httpFixture.js')
    return withRouter('/api/local-llm', localLLMRouter(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/unsloth-config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      let json: Record<string, unknown> = {}
      try {
        json = (await res.json()) as Record<string, unknown>
      } catch {
        // ignore
      }
      return { status: res.status, body: json }
    })
  }

  it('400 on a public-IP baseUrl (does not write to keystore)', async () => {
    const { status } = await putConfig({ baseUrl: 'http://8.8.8.8/' })
    expect(status).toBe(400)
    expect(setKeyCalls).toHaveLength(0)
  })

  it('400 on AWS metadata IP', async () => {
    const { status } = await putConfig({ baseUrl: 'http://169.254.169.254/' })
    expect(status).toBe(400)
    expect(setKeyCalls).toHaveLength(0)
  })

  it('400 on userinfo bypass attempt', async () => {
    const { status } = await putConfig({ baseUrl: 'http://1.2.3.4@127.0.0.1/' })
    expect(status).toBe(400)
    expect(setKeyCalls).toHaveLength(0)
  })

  it('400 on non-http scheme', async () => {
    const { status } = await putConfig({ baseUrl: 'file:///etc/passwd' })
    expect(status).toBe(400)
    expect(setKeyCalls).toHaveLength(0)
  })

  it('400 on missing baseUrl', async () => {
    const { status } = await putConfig({})
    expect(status).toBe(400)
    expect(setKeyCalls).toHaveLength(0)
  })

  it('accepts http://localhost:8888 and writes the normalised value to keystore', async () => {
    const { status, body } = await putConfig({ baseUrl: 'http://localhost:8888' })
    expect(status).toBe(200)
    expect(body.configured).toBe(true)
    expect(setKeyCalls).toHaveLength(1)
    expect(setKeyCalls[0][0]).toBe('unsloth')
    const stored = JSON.parse(setKeyCalls[0][1]) as { baseUrl: string }
    // Normalised form returned by validateLocalBaseUrl — no trailing
    // path / query, scheme + host only.
    expect(stored.baseUrl).toBe('http://localhost:8888')
  })

  it('accepts http://127.0.0.1:8888 (loopback IP form)', async () => {
    const { status } = await putConfig({ baseUrl: 'http://127.0.0.1:8888' })
    expect(status).toBe(200)
    expect(setKeyCalls).toHaveLength(1)
  })
})

// ============================================================================
// unslothAuthProvider — re-validates stored baseUrl before attaching creds
// ============================================================================
//
// The defence depth covers a hypothetical state where a public-IP value
// landed in the keystore via legacy code, manual edit, or migration —
// the runtime read MUST refuse to attach the bearer to it.

describe('unslothAuthProvider — re-validates stored baseUrl', () => {
  beforeEach(() => {
    vi.resetModules()
  })
  afterEach(() => {
    vi.resetModules()
  })

  it('does NOT attach the bearer when stored baseUrl is now public', async () => {
    let authHeadersCalled = false
    vi.doMock('../localProbe/unslothAuth.js', () => ({
      authHeaders: vi.fn(async () => {
        authHeadersCalled = true
        return { Authorization: 'Bearer SHOULD-NOT-BE-RETURNED' }
      }),
      invalidateTokenCache: vi.fn(),
      readUnslothConfig: vi.fn(async () => ({
        baseUrl: 'http://8.8.8.8/', // public — leaked into store somehow
        bearerToken: 'SECRET-BEARER',
      })),
    }))
    vi.doMock('../lib/loopbackGate.js', () => ({
      loopbackOnly: () => (_req: unknown, _res: unknown, next: () => void) => next(),
    }))

    // Track whether the bearer ever reaches a fetch call.
    let bearerLeaked = false
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined
      if (headers?.Authorization?.includes('SECRET-BEARER')) {
        bearerLeaked = true
      }
      // Return a fake "no models" response so the probe completes.
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch

    try {
      // Exercise via the public route /detect.
      const { localLLMRouter } = await import('./localLLM.js')
      const { withRouter } = await import('../testing/httpFixture.js')
      await withRouter('/api/local-llm', localLLMRouter(), async (baseUrl) => {
        await fetch(`${baseUrl}/detect`)
      })

      // The defence-in-depth contract: unslothAuthProvider returns null
      // when the stored value fails re-validation, so authHeaders is
      // never called, and no bearer reaches outbound fetch.
      expect(authHeadersCalled).toBe(false)
      expect(bearerLeaked).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
