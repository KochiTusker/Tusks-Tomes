// K.1.3 / W1 prove tests — halt-button stale-closure race.
//
// The user-observable bug pre-K.1.3: clicking "Halt pipeline" calls
// writeCheckpoint FIRST and aborts SECOND. Because writeCheckpoint
// awaits `getRouting()` (one or two ms of network round-trip), the
// in-flight Phase N chunk can finish during the await and dispatch a
// `chunk_done` that mutates state. By the time the abort lands, the
// run has silently completed one more chunk than the user intended.
// Worse, the persisted checkpoint can end up internally inconsistent —
// chunkIndex pointing to N+1 while partialOutput still reflects the
// N-chunk snapshot the closure captured.
//
// These tests lock the ordering invariant: abort fires BEFORE
// writeCheckpoint resolves. Without the fix, the simulated pre-K.1.3
// helper at the bottom of this file demonstrates the race.

import { describe, expect, it, vi } from 'vitest'
import { cancelRun } from './cancelFlow'

describe('cancelRun (K.1.3 / W1)', () => {
  it('aborts FIRST, then awaits writeCheckpoint', async () => {
    const events: Array<'abort' | 'write_start' | 'write_end'> = []
    const ctrl = new AbortController()
    const originalAbort = ctrl.abort.bind(ctrl)
    ctrl.abort = vi.fn(() => {
      events.push('abort')
      originalAbort()
    })
    const writeCheckpoint = vi.fn(async () => {
      events.push('write_start')
      // Simulate the getRouting() round-trip — pre-fix this was the
      // window where chunk_done could land mid-write.
      await new Promise((r) => setTimeout(r, 5))
      events.push('write_end')
      return true
    })

    await cancelRun({ abortRef: { current: ctrl }, writeCheckpoint })

    expect(events).toEqual(['abort', 'write_start', 'write_end'])
    expect(ctrl.abort).toHaveBeenCalledOnce()
    expect(writeCheckpoint).toHaveBeenCalledWith('user')
  })

  it('does not block on null abortRef (initial render race)', async () => {
    const writeCheckpoint = vi.fn(async () => true)
    await cancelRun({ abortRef: { current: null }, writeCheckpoint })
    expect(writeCheckpoint).toHaveBeenCalledOnce()
  })

  it('does not block on null writeCheckpoint (pre-useEffect first render)', async () => {
    const ctrl = new AbortController()
    const abortSpy = vi.spyOn(ctrl, 'abort')
    await cancelRun({ abortRef: { current: ctrl }, writeCheckpoint: null })
    expect(abortSpy).toHaveBeenCalledOnce()
  })

  it('swallows writeCheckpoint failures — abort still happens', async () => {
    const ctrl = new AbortController()
    const abortSpy = vi.spyOn(ctrl, 'abort')
    const writeCheckpoint = vi.fn(async () => {
      throw new Error('disk full')
    })
    await expect(
      cancelRun({ abortRef: { current: ctrl }, writeCheckpoint }),
    ).resolves.toBeUndefined()
    expect(abortSpy).toHaveBeenCalledOnce()
  })

  it('regression: no chunk_done can be observed AFTER abort fires (signal is aborted)', async () => {
    const ctrl = new AbortController()
    let signalSeenAsAborted = false
    const writeCheckpoint = vi.fn(async () => {
      // Simulate the in-flight chunkedGenerate observing the signal
      // mid-write. With abort-first, the signal is already aborted by
      // the time writeCheckpoint runs.
      signalSeenAsAborted = ctrl.signal.aborted
      return true
    })

    await cancelRun({ abortRef: { current: ctrl }, writeCheckpoint })

    expect(signalSeenAsAborted).toBe(true)
  })
})

// ─── Pre-fix simulator ──────────────────────────────────────────────────
//
// To make the prove-it methodology concrete: this test replicates the
// pre-K.1.3 ordering (write-then-abort) and demonstrates that a
// concurrent `chunk_done` lands BETWEEN the user click and the abort,
// producing the inconsistency the plan documents. The new cancelRun
// above closes the window; this test stays in the suite as a regression
// guard against any future refactor that swaps the order back.

describe('cancelRun — pre-fix simulator (bug repro)', () => {
  it('proves the race: pre-fix write-then-abort lets one more chunk land', async () => {
    const ctrl = new AbortController()
    let chunksCompleted = 0
    let writeStartedAt = 0

    // "chunkedGenerate" — a fake in-flight loop that polls signal.aborted
    // and tries to complete one more chunk per ~3ms tick. Stops when the
    // signal is aborted.
    const chunkLoop = (async () => {
      while (!ctrl.signal.aborted) {
        await new Promise((r) => setTimeout(r, 3))
        if (!ctrl.signal.aborted) chunksCompleted++
      }
    })()

    // Pre-fix cancel order: write first, abort second.
    const buggyCancel = async () => {
      writeStartedAt = chunksCompleted
      await new Promise((r) => setTimeout(r, 10)) // getRouting() round-trip
      ctrl.abort()
    }

    // Let one chunk complete first.
    await new Promise((r) => setTimeout(r, 5))
    const completedAtClickTime = chunksCompleted
    await buggyCancel()
    await chunkLoop

    // Bug signal: by the time the abort lands, AT LEAST one more chunk
    // completed during the write-await window. This is exactly the
    // chunk that pre-K.1.3 could end up in partialOutput without being
    // reflected in the checkpoint's chunkIndex.
    expect(chunksCompleted).toBeGreaterThan(completedAtClickTime)
    expect(chunksCompleted).toBeGreaterThan(writeStartedAt)
  })

  it('proves the fix: post-K.1.3 abort-first stops the loop immediately', async () => {
    const ctrl = new AbortController()
    let chunksCompleted = 0
    let writeStartedAt = 0

    const chunkLoop = (async () => {
      while (!ctrl.signal.aborted) {
        await new Promise((r) => setTimeout(r, 3))
        if (!ctrl.signal.aborted) chunksCompleted++
      }
    })()

    await new Promise((r) => setTimeout(r, 5))
    const completedAtClickTime = chunksCompleted

    // Post-fix order via cancelRun: abort first, then write.
    await cancelRun({
      abortRef: { current: ctrl },
      writeCheckpoint: async () => {
        writeStartedAt = chunksCompleted
        await new Promise((r) => setTimeout(r, 10))
        return true
      },
    })
    await chunkLoop

    // Post-fix invariant: chunksCompleted at write-start equals
    // chunksCompleted at click-time (no chunk landed in the window).
    expect(writeStartedAt).toBe(completedAtClickTime)
  })
})
