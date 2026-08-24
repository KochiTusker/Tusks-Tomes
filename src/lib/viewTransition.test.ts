// The property that matters: the state change happens on every path, and a
// transition the platform declines to run never surfaces as an error.

import { describe, expect, it, vi } from 'vitest'
import { transitionOrJustDo, type TransitionCapableDocument } from './viewTransition'

/** Lets the microtask queue drain, so an unhandled rejection would surface. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

describe('transitionOrJustDo', () => {
  it('applies the update directly when the platform has no transitions', () => {
    let ran = false
    transitionOrJustDo(() => { ran = true }, {}, false)
    expect(ran).toBe(true)
  })

  it('applies the update directly, and starts no transition, under reduced motion', () => {
    let ran = false
    const startViewTransition = vi.fn()
    transitionOrJustDo(() => { ran = true }, { startViewTransition }, true)
    expect(ran).toBe(true)
    expect(startViewTransition).not.toHaveBeenCalled()
  })

  it('routes the update through the transition when it can', () => {
    let ran = false
    const doc: TransitionCapableDocument = {
      startViewTransition: (cb) => { cb(); return { ready: Promise.resolve(), finished: Promise.resolve() } },
    }
    transitionOrJustDo(() => { ran = true }, doc, false)
    expect(ran).toBe(true)
  })

  it('a transition the platform skips still applies the update', async () => {
    let ran = false
    const doc: TransitionCapableDocument = {
      startViewTransition: (cb) => {
        cb()
        return { ready: Promise.reject(new Error('Transition was aborted because of invalid state')) }
      },
    }
    transitionOrJustDo(() => { ran = true }, doc, false)
    await settle()
    expect(ran).toBe(true)
  })

  it('a skipped transition does not become an unhandled rejection', async () => {
    const unhandled: unknown[] = []
    const capture = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', capture)
    try {
      const doc: TransitionCapableDocument = {
        startViewTransition: (cb) => {
          cb()
          // Exactly what a hidden document produces.
          return {
            ready: Promise.reject(new Error('Transition was aborted because of invalid state')),
            finished: Promise.reject(new Error('Transition was aborted because of invalid state')),
          }
        },
      }
      transitionOrJustDo(() => {}, doc, false)
      await settle()
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', capture)
    }
  })

  it('tolerates a transition object the platform does not return', () => {
    let ran = false
    transitionOrJustDo(() => { ran = true }, { startViewTransition: (cb) => { cb() } }, false)
    expect(ran).toBe(true)
  })
})
