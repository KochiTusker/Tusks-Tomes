// K.1.4 / W2 prove tests — Fallback-to-Paid rollback on checkpoint failure.
//
// Pre-K.1.4, the inline `handleRateLimitChoice('fallback')` did:
//
//   putRouting(paid) → refreshProviders() → writeCheckpoint('quota')
//
// with the checkpoint write at the end. If writeCheckpoint failed, the
// catch handler logged the error and toasted the user, but the user's
// on-disk routing.json was already on Paid (mutated by step 1), and
// the in-memory provider singletons had already rebuilt against Paid
// (step 2). The user's NEXT session would silently dispatch to Paid
// against their intent.
//
// These tests pin the rollback contract: any forward-step failure
// after putRouting succeeds MUST be followed by a best-effort
// putRouting(originalRouting) + refreshProviders() to restore the
// pre-fallback state. The FallbackResult discriminator surfaces the
// outcome to the UI so the toast copy matches reality.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fallbackToPaid, type FallbackDeps } from './fallbackFlow'
import type { RoutingDocument } from './routing'

const ORIGINAL: RoutingDocument = {
  version: 3,
  lastSelectedProvider: 'gemini',
  geminiTier: 'free',
}

type MockableDeps = {
  getRouting: FallbackDeps['getRouting']
  putRouting: FallbackDeps['putRouting']
  refreshProviders: FallbackDeps['refreshProviders']
  writeCheckpoint: FallbackDeps['writeCheckpoint']
  log: NonNullable<FallbackDeps['log']>
}

function makeDeps(overrides: Partial<MockableDeps> = {}): MockableDeps {
  return {
    getRouting: overrides.getRouting ?? vi.fn(async () => ({ ...ORIGINAL })),
    putRouting: overrides.putRouting ?? vi.fn(async () => undefined),
    refreshProviders: overrides.refreshProviders ?? vi.fn(async () => undefined),
    writeCheckpoint: overrides.writeCheckpoint ?? vi.fn(async () => true),
    log: overrides.log ?? vi.fn(),
  }
}

describe('fallbackToPaid (K.1.4 / W2)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('happy path: writes paid routing, refreshes, checkpoints, returns ok', async () => {
    const deps = makeDeps()
    const result = await fallbackToPaid(deps)
    expect(result).toEqual({ kind: 'ok' })
    expect(deps.putRouting).toHaveBeenCalledTimes(1)
    expect(deps.putRouting).toHaveBeenCalledWith({
      ...ORIGINAL,
      lastSelectedProvider: 'gemini',
      geminiTier: 'paid',
    })
    expect(deps.refreshProviders).toHaveBeenCalledTimes(1)
    expect(deps.writeCheckpoint).toHaveBeenCalledWith('quota')
  })

  it('writeCheckpoint throws → rolls back routing to original', async () => {
    const writeCheckpoint = vi.fn(async () => {
      throw new Error('disk full')
    })
    const deps = makeDeps({ writeCheckpoint })
    const result = await fallbackToPaid(deps)
    expect(result.kind).toBe('rolled_back')
    if (result.kind === 'rolled_back') {
      expect(result.error.message).toBe('disk full')
      expect(result.rollbackError).toBeNull()
    }
    // The load-bearing assertion: putRouting was called TWICE — first
    // with paid, then with the original to undo the mutation.
    expect(deps.putRouting).toHaveBeenCalledTimes(2)
    expect(deps.putRouting).toHaveBeenNthCalledWith(1, expect.objectContaining({ geminiTier: 'paid' }))
    expect(deps.putRouting).toHaveBeenNthCalledWith(2, ORIGINAL)
    // refreshProviders called twice as well (once forward, once rollback)
    // so in-memory singletons match the restored on-disk routing.
    expect(deps.refreshProviders).toHaveBeenCalledTimes(2)
  })

  it('writeCheckpoint returns false → rolls back routing to original', async () => {
    // Same as above but writeCheckpoint resolves cleanly with `false`
    // (saveRun failed; toast already shown). Must still trigger rollback.
    const writeCheckpoint = vi.fn(async () => false)
    const deps = makeDeps({ writeCheckpoint })
    const result = await fallbackToPaid(deps)
    expect(result.kind).toBe('rolled_back')
    expect(deps.putRouting).toHaveBeenCalledTimes(2)
    expect(deps.putRouting).toHaveBeenLastCalledWith(ORIGINAL)
  })

  it('refreshProviders throws → rolls back routing (the in-memory rebuild failed)', async () => {
    // Forward call throws, rollback call resolves. `mockImplementationOnce`
    // entries are consumed in FIFO order — the throwing impl runs first
    // (forward), then the rollback gets the default resolved value.
    const refreshProviders = vi.fn(async () => undefined)
    refreshProviders.mockImplementationOnce(async () => {
      throw new Error('provider rebuild failed')
    })
    const deps = makeDeps({ refreshProviders })
    const result = await fallbackToPaid(deps)
    expect(result.kind).toBe('rolled_back')
    expect(deps.putRouting).toHaveBeenCalledTimes(2)
    expect(deps.putRouting).toHaveBeenLastCalledWith(ORIGINAL)
  })

  it('rollback putRouting also throws → surfaces both errors via rollbackError', async () => {
    const putRouting = vi.fn()
      .mockResolvedValueOnce(undefined) // forward
      .mockImplementationOnce(async () => { throw new Error('disk read-only') }) // rollback
    const writeCheckpoint = vi.fn(async () => {
      throw new Error('forward checkpoint failure')
    })
    const deps = makeDeps({ putRouting, writeCheckpoint })
    const result = await fallbackToPaid(deps)
    expect(result.kind).toBe('rolled_back')
    if (result.kind === 'rolled_back') {
      expect(result.error.message).toBe('forward checkpoint failure')
      expect(result.rollbackError?.message).toBe('disk read-only')
    }
  })

  it('getRouting throws BEFORE any mutation → forward_failed_no_mutation (nothing to roll back)', async () => {
    const getRouting = vi.fn(async () => { throw new Error('routing 500') })
    const deps = makeDeps({ getRouting })
    const result = await fallbackToPaid(deps)
    expect(result.kind).toBe('forward_failed_no_mutation')
    if (result.kind === 'forward_failed_no_mutation') {
      expect(result.error.message).toBe('routing 500')
    }
    expect(deps.putRouting).not.toHaveBeenCalled()
    expect(deps.refreshProviders).not.toHaveBeenCalled()
    expect(deps.writeCheckpoint).not.toHaveBeenCalled()
  })

  it('forward putRouting throws → no rollback needed (nothing was persisted)', async () => {
    const putRouting = vi.fn(async () => { throw new Error('disk error') })
    const deps = makeDeps({ putRouting })
    const result = await fallbackToPaid(deps)
    expect(result.kind).toBe('rolled_back')
    if (result.kind === 'rolled_back') {
      expect(result.error.message).toBe('disk error')
    }
    // putRouting was called twice — once forward (threw), once rollback
    // (best-effort attempt to restore original). Even though the forward
    // call didn't persist, the rollback putRouting(originalRouting) is a
    // safe no-op on a routing.json that still has the original value.
    expect(putRouting).toHaveBeenCalledTimes(2)
    expect(putRouting).toHaveBeenLastCalledWith(ORIGINAL)
  })

  it('log forwarder receives the full event sequence on the happy path', async () => {
    const log = vi.fn()
    await fallbackToPaid(makeDeps({ log }))
    const events = log.mock.calls.map((c) => c[0])
    expect(events).toContain('snapshot_start')
    expect(events).toContain('snapshot_done')
    expect(events).toContain('forward_putRouting_start')
    expect(events).toContain('forward_putRouting_done')
    expect(events).toContain('forward_refreshProviders_start')
    expect(events).toContain('forward_refreshProviders_done')
    expect(events).toContain('forward_writeCheckpoint_start')
    expect(events).toContain('forward_writeCheckpoint_done')
    expect(events).toContain('done_ok')
  })

  it('log forwarder receives rollback_done event on rollback', async () => {
    const log = vi.fn()
    const writeCheckpoint = vi.fn(async () => { throw new Error('boom') })
    await fallbackToPaid(makeDeps({ log, writeCheckpoint }))
    const events = log.mock.calls.map((c) => c[0])
    expect(events).toContain('rollback_start')
    expect(events).toContain('rollback_done')
  })

  it('log forwarder errors do not break the orchestration', async () => {
    const log = vi.fn(() => { throw new Error('listener crash') })
    const result = await fallbackToPaid(makeDeps({ log }))
    expect(result).toEqual({ kind: 'ok' })
  })
})

// ─── Pre-fix simulator (bug repro) ──────────────────────────────────────
//
// The plan's prove-it requirement: demonstrate the actual bug exists.
// The pre-K.1.4 inline implementation persisted putRouting BEFORE
// writeCheckpoint, with no rollback. If you simulate that ordering with
// no protection, a writeCheckpoint failure leaves routing on Paid.

describe('fallbackToPaid — pre-fix simulator (bug repro)', () => {
  it('the pre-fix ordering leaves routing on Paid if checkpoint fails', async () => {
    // Replicate the pre-K.1.4 inline code path WITHOUT using the new
    // helper. Routing state lives in a single mutable cell; observe the
    // value after the simulated failure.
    let onDiskRouting: RoutingDocument = { ...ORIGINAL }
    const putRouting = async (r: RoutingDocument) => {
      onDiskRouting = r
    }
    const refreshProviders = async () => undefined
    const writeCheckpoint_failing = async () => {
      throw new Error('quota write failed')
    }
    try {
      // No snapshot. No try-around-the-mutations. Just sequential await.
      await putRouting({
        ...onDiskRouting,
        lastSelectedProvider: 'gemini',
        geminiTier: 'paid',
      })
      await refreshProviders()
      await writeCheckpoint_failing()
    } catch {
      // Toast and exit — the old behaviour.
    }
    // Bug signal: routing is now Paid, even though the checkpoint never landed.
    expect(onDiskRouting.geminiTier).toBe('paid')
  })

  it('the post-fix orchestrator restores the original routing on the same failure', async () => {
    let onDiskRouting: RoutingDocument = { ...ORIGINAL }
    await fallbackToPaid({
      getRouting: async () => onDiskRouting,
      putRouting: async (r) => { onDiskRouting = r },
      refreshProviders: async () => undefined,
      writeCheckpoint: async () => { throw new Error('quota write failed') },
    })
    // Fix signal: routing was restored to Free.
    expect(onDiskRouting.geminiTier).toBe('free')
    expect(onDiskRouting).toEqual(ORIGINAL)
  })
})
