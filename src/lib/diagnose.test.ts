/** @vitest-environment jsdom */
// Client wrapper contract — debounce, symbol extraction, request shape.
// The /api/diagnose/bundle endpoint is mocked at the fetch boundary.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  extractSymbolFromError,
  listRecentBundles,
  requestBundle,
  resetDebounce,
  shouldAutoCheckpointOnError,
} from './diagnose'

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  resetDebounce()
  fetchMock = vi.fn(async (input: string) => {
    if (String(input) === '/api/diagnose/bundle') {
      return new Response(
        JSON.stringify({ ok: true, latestPath: '/tmp/diagnose/latest.md', signaturesMatched: 0 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    if (String(input) === '/api/diagnose/recent') {
      return new Response(
        JSON.stringify({
          bundles: [
            { filename: 'latest.md', path: '/tmp/.diagnose/latest.md', size: 1234, modifiedAt: '2026-05-24T13:00:00Z' },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    return new Response('not configured', { status: 500 })
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('requestBundle', () => {
  it('POSTs to /api/diagnose/bundle with the trigger + state', async () => {
    const result = await requestBundle({
      trigger: 'hard_error',
      errorMessage: 'boom',
      currentState: { status: 'error' },
    })
    expect(result.ok).toBe(true)
    expect(result.latestPath).toBe('/tmp/diagnose/latest.md')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/diagnose/bundle',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const body = JSON.parse(
      ((fetchMock.mock.calls[0][1] as RequestInit).body as string) || '{}',
    )
    expect(body.trigger).toBe('hard_error')
    expect(body.errorMessage).toBe('boom')
    expect(body.currentState).toEqual({ status: 'error' })
  })

  it('debounces consecutive calls within 30s', async () => {
    const first = await requestBundle({ trigger: 'hard_error' })
    expect(first.debounced).toBeUndefined()
    expect(first.ok).toBe(true)
    // Second call within debounce window.
    const second = await requestBundle({ trigger: 'hard_error' })
    expect(second.ok).toBe(true)
    expect(second.debounced).toBe(true)
    // Fetch only fired ONCE.
    expect(fetchMock.mock.calls.filter((c) => c[0] === '/api/diagnose/bundle')).toHaveLength(1)
  })

  it('honors `force: true` to bypass debounce', async () => {
    await requestBundle({ trigger: 'manual' })
    const second = await requestBundle({ trigger: 'manual', force: true })
    expect(second.debounced).toBeUndefined()
    expect(fetchMock.mock.calls.filter((c) => c[0] === '/api/diagnose/bundle')).toHaveLength(2)
  })

  it('returns ok:false when the server responds non-2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 500 })),
    )
    const result = await requestBundle({ trigger: 'manual' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('HTTP 500')
  })

  it('returns ok:false when fetch itself throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => { throw new Error('network down') }),
    )
    const result = await requestBundle({ trigger: 'manual' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('network down')
  })

  it('uses keepalive so the call survives beforeunload', async () => {
    await requestBundle({ trigger: 'hard_error' })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/diagnose/bundle',
      expect.objectContaining({ keepalive: true }),
    )
  })
})

describe('listRecentBundles', () => {
  it('returns the bundles array from the server', async () => {
    const bundles = await listRecentBundles()
    expect(bundles).toHaveLength(1)
    expect(bundles[0].filename).toBe('latest.md')
  })

  it('returns [] on fetch failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => { throw new Error('offline') }),
    )
    const bundles = await listRecentBundles()
    expect(bundles).toEqual([])
  })

  it('returns [] on non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 500 })),
    )
    const bundles = await listRecentBundles()
    expect(bundles).toEqual([])
  })
})

describe('shouldAutoCheckpointOnError — auto-pause policy', () => {
  it('returns null for AbortError (explicit user cancel)', () => {
    const err = new Error('cancelled')
    err.name = 'AbortError'
    expect(
      shouldAutoCheckpointOnError({
        err,
        currentPhase: 'phase1_ground',
        currentChunkIndex: 12,
      }),
    ).toBeNull()
  })

  it("returns 'daily_quota' for the gemini.ts fast-fail marker regardless of chunk index", () => {
    const err = new Error('Daily quota exhausted')
    ;(err as Error & { isDailyQuotaExhaustion?: boolean }).isDailyQuotaExhaustion = true
    expect(
      shouldAutoCheckpointOnError({
        err,
        currentPhase: 'phase1_ground',
        currentChunkIndex: 0, // even at chunk 0
      }),
    ).toBe('daily_quota')
    expect(
      shouldAutoCheckpointOnError({
        err,
        currentPhase: 'phase1_ground',
        currentChunkIndex: 20,
      }),
    ).toBe('daily_quota')
  })

  it("returns 'error' for a mid-phase failure with accumulated work", () => {
    // The user-reported case: per-minute rate limit, network error,
    // 5xx exhaustion, etc. Anything that lands mid-phase with at least
    // one completed chunk should auto-checkpoint.
    expect(
      shouldAutoCheckpointOnError({
        err: new Error('boom'),
        currentPhase: 'phase3_chronicle',
        currentChunkIndex: 5,
      }),
    ).toBe('error')
  })

  it('returns null for a failure before any chunk completed (nothing to save)', () => {
    expect(
      shouldAutoCheckpointOnError({
        err: new Error('boom'),
        currentPhase: 'phase1_ground',
        currentChunkIndex: 0,
      }),
    ).toBeNull()
  })

  it('returns null when currentPhase is null (run never started)', () => {
    expect(
      shouldAutoCheckpointOnError({
        err: new Error('boom'),
        currentPhase: null,
        currentChunkIndex: 5,
      }),
    ).toBeNull()
  })

  it("returns 'daily_quota' for the marker even with currentPhase=null (defensive)", () => {
    // Edge case — shouldn't happen in practice but the daily-quota
    // marker is unambiguous, so we honour it regardless of state shape.
    const err = new Error('Daily quota exhausted')
    ;(err as Error & { isDailyQuotaExhaustion?: boolean }).isDailyQuotaExhaustion = true
    expect(
      shouldAutoCheckpointOnError({
        err,
        currentPhase: null,
        currentChunkIndex: 0,
      }),
    ).toBe('daily_quota')
  })

  it('AbortError check takes precedence over daily-quota marker', () => {
    // Belt-and-braces — if some future code path sets BOTH markers on
    // an error (it shouldn't, but…), the user cancel wins. Explicit
    // user action always trumps automatic recovery.
    const err = new Error('cancelled')
    err.name = 'AbortError'
    ;(err as Error & { isDailyQuotaExhaustion?: boolean }).isDailyQuotaExhaustion = true
    expect(
      shouldAutoCheckpointOnError({
        err,
        currentPhase: 'phase1_ground',
        currentChunkIndex: 5,
      }),
    ).toBeNull()
  })
})

describe('extractSymbolFromError', () => {
  it('extracts the first useful frame', () => {
    const err = new Error('boom')
    err.stack = `Error: boom
    at handlePipelineError (src/components/RefinementTool.tsx:281:7)
    at runWithSession (src/components/RefinementTool.tsx:300:11)`
    expect(extractSymbolFromError(err)).toBe('handlePipelineError')
  })

  it('returns null when stack is missing', () => {
    // A fresh Error() in jsdom + Node picks up the test runner's stack
    // automatically, so we manually null it out to test the
    // missing-stack branch.
    const stackless = new Error('boom')
    stackless.stack = undefined
    expect(extractSymbolFromError(stackless)).toBeNull()
    expect(extractSymbolFromError(null)).toBeNull()
    expect(extractSymbolFromError(undefined)).toBeNull()
  })

  it('skips Promise / Object frames', () => {
    const err = new Error('boom')
    err.stack = `Error: boom
    at Object.<anonymous> (foo:1:1)
    at Promise.then (<anonymous>)
    at runPhase3 (src/lib/pipeline.ts:42:1)`
    expect(extractSymbolFromError(err)).toBe('runPhase3')
  })
})
