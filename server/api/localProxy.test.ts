// Tests for the local-LLM proxy + launch route. Pins the Phase 1.2
// regression invariant: `spawn` must be called with `shell: true` so
// Windows PATHEXT walks .cmd shims. The audit-security-contracts.mjs
// script catches the source-level regression; this test catches the
// behavioural regression.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mockSpawn, resetSpawnMock, spawnCalls, whenCommand } from '../testing/spawnMock.js'
import { withRouter } from '../testing/httpFixture.js'

vi.mock('node:child_process', () => mockSpawn())

// The route also probes runner-live status with fetch — stub ONLY the
// runner-probing fetches (localhost:11434/1234/8888) so isRunnerLive
// returns false and the spawn path is always taken. Test-fixture
// fetches against our test server are passed through unchanged.
const originalFetch = globalThis.fetch
beforeEach(() => {
  resetSpawnMock()
  globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    if (
      url.includes('localhost:11434') ||
      url.includes('localhost:1234') ||
      url.includes('localhost:8888')
    ) {
      return Promise.reject(new Error('mocked runner probe — not live'))
    }
    return originalFetch(input as RequestInfo | URL, init)
  }) as unknown as typeof fetch
})
afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('POST /launch — spawn invariants (Phase 1.2 regression test)', () => {
  // provider → command-name passed to spawn. From launchSpecFor in
  // server/api/localProxy.ts lines 49-77.
  const PROVIDER_TO_COMMAND: Record<string, string> = {
    ollama: 'ollama',
    lmstudio: 'lms',
    unsloth: 'unsloth',
  }
  for (const provider of ['ollama', 'lmstudio', 'unsloth'] as const) {
    it(`spawns ${provider} with shell:true (Windows PATHEXT walks .cmd)`, async () => {
      const expectedCommand = PROVIDER_TO_COMMAND[provider]
      whenCommand(expectedCommand, () => ({ code: 0 }))
      const { localProxyRouter } = await import('./localProxy.js')
      await withRouter('/api/local', localProxyRouter(), async (baseUrl) => {
        const res = await fetch(`${baseUrl}/launch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider }),
        })
        // Either 200 (spawn launched) or 500 (we mocked early-error).
        // What matters is the spawn call shape.
        expect(res.status).toBeGreaterThanOrEqual(200)
      })
      const spawnsForProvider = spawnCalls().filter((c) => c.command === expectedCommand)
      expect(spawnsForProvider.length).toBe(1)
      // THE REGRESSION TEST. If this assertion fails, the Windows
      // local-LLM launch is broken — spawn cannot resolve a bare-name
      // command to its .cmd shim without shell:true.
      expect(spawnsForProvider[0].options.shell).toBe(true)
      // Also pin that args were passed argv-style — never a templated
      // shell string. shell:true with arg array is the safe combo.
      expect(Array.isArray(spawnsForProvider[0].args)).toBe(true)
    })
  }

  it('400 when provider is not in the enum', async () => {
    const { localProxyRouter } = await import('./localProxy.js')
    await withRouter('/api/local', localProxyRouter(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/launch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'curl-evil-shell-thing' }),
      })
      expect(res.status).toBe(400)
    })
    // No spawn call happened — argument never reached spawn.
    expect(spawnCalls()).toHaveLength(0)
  })

  it('500 with PATH-hint message when spawn emits early ENOENT', async () => {
    whenCommand('ollama', () => ({
      code: 1,
      emitError: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) as Error,
    }))
    const { localProxyRouter } = await import('./localProxy.js')
    await withRouter('/api/local', localProxyRouter(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/launch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'ollama' }),
      })
      expect(res.status).toBe(500)
      const body = (await res.json()) as Record<string, unknown>
      // Helpful operator message — points at the actual fix path.
      expect(String(body.message)).toMatch(/PATH/)
    })
  })
})

describe('POST /list-models and /generate — validator-throw status code (Phase 6.5 regression)', () => {
  // Phase 6.5 changed the route from `return 500` to `return 400` when
  // validateLocalBaseUrl throws (bad client input, not server error).
  // Pin both routes — a future refactor that re-wraps the validator in
  // the outer catch would silently regress to 500 without breaking
  // anything functionally but degrading the API contract.

  it('POST /list-models with public-IP baseUrl → 400 (not 500)', async () => {
    const { localProxyRouter } = await import('./localProxy.js')
    await withRouter('/api/local', localProxyRouter(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/list-models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'ollama', baseUrl: 'http://8.8.8.8/' }),
      })
      expect(res.status).toBe(400)
    })
  })

  it('POST /generate with public-IP baseUrl → 400 (not 500)', async () => {
    const { localProxyRouter } = await import('./localProxy.js')
    await withRouter('/api/local', localProxyRouter(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'ollama', baseUrl: 'http://8.8.8.8/', body: { prompt: 'x' } }),
      })
      expect(res.status).toBe(400)
    })
  })

  it('POST /list-models with userinfo-bypass baseUrl → 400', async () => {
    const { localProxyRouter } = await import('./localProxy.js')
    await withRouter('/api/local', localProxyRouter(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/list-models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'ollama', baseUrl: 'http://1.2.3.4@127.0.0.1/' }),
      })
      expect(res.status).toBe(400)
    })
  })

  it('POST /list-models with non-http scheme → 400', async () => {
    const { localProxyRouter } = await import('./localProxy.js')
    await withRouter('/api/local', localProxyRouter(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/list-models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'ollama', baseUrl: 'file:///etc/passwd' }),
      })
      expect(res.status).toBe(400)
    })
  })
})

describe('POST /launch — input does not flow into spawn (literal-input invariant)', () => {
  it('spawn command is always one of {ollama, lms, unsloth} — never req-derived', async () => {
    whenCommand('ollama', () => ({ code: 0 }))
    whenCommand('lms', () => ({ code: 0 }))
    whenCommand('unsloth', () => ({ code: 0 }))
    const { localProxyRouter } = await import('./localProxy.js')
    for (const provider of ['ollama', 'lmstudio', 'unsloth'] as const) {
      await withRouter('/api/local', localProxyRouter(), async (baseUrl) => {
        await fetch(`${baseUrl}/launch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider,
            // Try to smuggle a value into spec.command — should be ignored.
            command: 'rm -rf /',
            args: ['; calc.exe'],
          }),
        })
      })
    }
    const validCommands = new Set(['ollama', 'lms', 'unsloth'])
    for (const call of spawnCalls()) {
      expect(validCommands.has(call.command)).toBe(true)
    }
  })
})
