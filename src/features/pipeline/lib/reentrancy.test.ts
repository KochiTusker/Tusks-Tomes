// The double-spend guard, as a property rather than a component test.
//
// The bug: the Run handler awaited provider/routing/profile fetches before
// anything set the status that disables the button. A second click landed
// inside that window and started a second, separately-billed pipeline.
//
// The guard is a synchronous check-and-set on a ref. These tests pin the
// property that makes it correct: because JavaScript runs the synchronous
// prologue of the second call to completion before any await resumes, the
// second caller always observes the flag already set.

import { describe, expect, it } from 'vitest'

/** The exact shape used in RefinementTool.runFromPhase1. */
function makeGuardedRunner(work: () => Promise<void>) {
  const ref = { current: false }
  let started = 0
  return {
    ref,
    get started() {
      return started
    },
    async run() {
      if (ref.current) return
      ref.current = true
      try {
        started += 1
        await work()
      } finally {
        ref.current = false
      }
    },
  }
}

describe('run re-entrancy guard', () => {
  it('a second click during the async prologue does not start a second run', async () => {
    const slow = () => new Promise<void>((r) => setTimeout(r, 30))
    const g = makeGuardedRunner(slow)
    // Both clicks fire before the first await resolves — the real scenario.
    await Promise.all([g.run(), g.run(), g.run()])
    expect(g.started).toBe(1)
  })

  it('releases afterwards, so a deliberate second run still works', async () => {
    const g = makeGuardedRunner(() => Promise.resolve())
    await g.run()
    await g.run()
    expect(g.started).toBe(2)
  })

  it('releases even when the run throws, so one failure cannot wedge the button', async () => {
    const g = makeGuardedRunner(() => Promise.reject(new Error('provider exploded')))
    await expect(g.run()).rejects.toThrow('provider exploded')
    expect(g.ref.current).toBe(false)
    await expect(g.run()).rejects.toThrow('provider exploded')
    expect(g.started).toBe(2)
  })
})
