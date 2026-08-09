/** @vitest-environment jsdom */
// useRefinementState behavioral tests — locks in the contract for the
// optional-outputs refactor:
//   - completePhase4 / completePhase6 no longer flip status='done' on
//     their own; markRunComplete is the single owner.
//   - setOutputSelection persists into state.outputSelection.
//   - Legacy stored state (missing outputSelection field) backfills to
//     DEFAULT_OUTPUT_SELECTION on read.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useRefinementState } from './useRefinementState'
import { DEFAULT_OUTPUT_SELECTION, type RefinementState } from '@/types'
import { LS_REFINEMENT } from '@/lib/constants'

beforeEach(() => {
  window.localStorage.removeItem(LS_REFINEMENT)
})

afterEach(() => {
  window.localStorage.removeItem(LS_REFINEMENT)
})

describe('useRefinementState — initial state', () => {
  it('exposes DEFAULT_OUTPUT_SELECTION on a fresh mount', () => {
    const { result } = renderHook(() => useRefinementState())
    expect(result.current.state.outputSelection).toEqual(DEFAULT_OUTPUT_SELECTION)
  })

  it('backfills outputSelection when legacy localStorage state lacks the field', () => {
    // Simulate a state shape from before the feature landed: persist
    // a partial RefinementState without outputSelection.
    const legacy: Omit<RefinementState, 'outputSelection'> = {
      campaign: 'Test',
      sessionNumber: 4,
      rawTranscript: 'raw',
      groundedTranscript: 'g',
      dmQuestions: [],
      dmAnswers: {},
      chronicle: '',
      extras: null,
      condensed: null,
      status: 'idle',
      currentPhase: null,
      currentChunkIndex: 0,
      totalChunks: 0,
      partialOutput: '',
      countdownMs: 0,
      updatedAt: '2026-05-01T00:00:00.000Z',
    }
    window.localStorage.setItem(LS_REFINEMENT, JSON.stringify(legacy))
    const { result } = renderHook(() => useRefinementState())
    // Backfilled to default, other fields preserved.
    expect(result.current.state.outputSelection).toEqual(DEFAULT_OUTPUT_SELECTION)
    expect(result.current.state.campaign).toBe('Test')
    expect(result.current.state.sessionNumber).toBe(4)
  })
})

describe('useRefinementState — setRefusals', () => {
  it('persists the refusal manifest and bumps updatedAt', () => {
    const { result } = renderHook(() => useRefinementState())
    expect(result.current.state.refusals).toEqual([])
    const before = result.current.state.updatedAt
    act(() => {
      result.current.actions.setRefusals([
        {
          id: 'r-1',
          phase: 'phase3_chronicle',
          chunkIndex: 2,
          totalChunks: 9,
          sourceSpan: 'grounded span',
          refusedText: "I can't.",
          marker: '<!--TUSKS-REFUSAL:r-1-->',
          repaired: false,
          createdAt: '2026-06-04T00:00:00.000Z',
        },
      ])
    })
    expect(result.current.state.refusals).toHaveLength(1)
    expect(result.current.state.refusals?.[0].id).toBe('r-1')
    expect(result.current.state.updatedAt).not.toBe(before)
  })

  it('appendRefusal accumulates without clobbering prior entries', () => {
    const { result } = renderHook(() => useRefinementState())
    const mk = (id: string) => ({
      id,
      phase: 'phase3_chronicle',
      chunkIndex: 0,
      totalChunks: 3,
      sourceSpan: 's',
      refusedText: '',
      marker: `<!--TUSKS-REFUSAL:${id}-->`,
      repaired: false,
      createdAt: '2026-06-04T00:00:00.000Z',
    })
    act(() => {
      result.current.actions.appendRefusal(mk('r-1'))
      result.current.actions.appendRefusal(mk('r-2'))
    })
    expect(result.current.state.refusals?.map((r) => r.id)).toEqual(['r-1', 'r-2'])
  })

  it('reset() clears the refusal manifest', () => {
    const { result } = renderHook(() => useRefinementState())
    act(() => {
      result.current.actions.setRefusals([
        {
          id: 'r-9',
          phase: 'phase2_audit',
          chunkIndex: 0,
          totalChunks: 1,
          sourceSpan: 's',
          refusedText: '',
          marker: '',
          repaired: false,
          createdAt: '2026-06-04T00:00:00.000Z',
        },
      ])
    })
    act(() => result.current.actions.reset())
    expect(result.current.state.refusals).toEqual([])
  })
})

describe('useRefinementState — setOutputSelection', () => {
  it('persists into state.outputSelection', () => {
    const { result } = renderHook(() => useRefinementState())
    act(() => {
      result.current.actions.setOutputSelection({
        chronicle: false,
        extras: true,
        condensed: false,
        condensePercentage: 20,
      })
    })
    expect(result.current.state.outputSelection).toEqual({
      chronicle: false,
      extras: true,
      condensed: false,
      condensePercentage: 20,
    })
  })

  // v1.1.0 backfill — when a v1.0 user's persisted state lacks
  // condensePercentage, the deep-merge in useRefinementState fills it
  // from DEFAULT_OUTPUT_SELECTION rather than letting the picker render
  // with `undefined` and crashing the slider math.
  it('backfills condensePercentage from DEFAULT_OUTPUT_SELECTION when caller omits it', () => {
    const { result } = renderHook(() => useRefinementState())
    act(() => {
      // Cast emulates a v1.0 caller / corrupt localStorage that wrote
      // a partial OutputSelection without condensePercentage.
      result.current.actions.setOutputSelection({
        chronicle: false,
        extras: true,
        condensed: false,
      } as unknown as Parameters<typeof result.current.actions.setOutputSelection>[0])
    })
    // The hook's render-time deep-merge fills the missing field.
    expect(result.current.state.outputSelection.condensePercentage).toBe(20)
    expect(result.current.state.outputSelection.chronicle).toBe(false)
    expect(result.current.state.outputSelection.extras).toBe(true)
  })
})

describe('useRefinementState — completePhaseN does NOT flip done', () => {
  it('completePhase4 leaves status unchanged (no auto-done)', () => {
    const { result } = renderHook(() => useRefinementState())
    act(() => {
      result.current.actions.setStatus('phase4_extras')
    })
    expect(result.current.state.status).toBe('phase4_extras')
    act(() => {
      result.current.actions.completePhase4({ jests: ['hi'], gore: [], quotes: [] })
    })
    // Status still phase4_extras — the dispatcher decides when to mark done.
    expect(result.current.state.status).toBe('phase4_extras')
    expect(result.current.state.extras).toEqual({ jests: ['hi'], gore: [], quotes: [] })
  })

  it('completePhase6 leaves status unchanged', () => {
    const { result } = renderHook(() => useRefinementState())
    act(() => {
      result.current.actions.setStatus('phase6_condense')
    })
    act(() => {
      result.current.actions.completePhase6({ narrative: 'short', bulletPoints: ['x'] })
    })
    expect(result.current.state.status).toBe('phase6_condense')
    expect(result.current.state.condensed).toEqual({ narrative: 'short', bulletPoints: ['x'] })
  })
})

describe('useRefinementState — markRunComplete is the single done owner', () => {
  it('flips status to done and clears currentPhase + partial fields', () => {
    const { result } = renderHook(() => useRefinementState())
    act(() => {
      result.current.actions.setStatus('phase4_extras')
    })
    act(() => {
      // Simulate a partial output mid-phase.
      result.current.actions.onChunkDone(0, 'partial-output')
    })
    act(() => {
      result.current.actions.markRunComplete()
    })
    expect(result.current.state.status).toBe('done')
    expect(result.current.state.currentPhase).toBeNull()
    expect(result.current.state.partialOutput).toBe('')
    expect(result.current.state.countdownMs).toBe(0)
  })

  it('does NOT clobber populated outputs (extras + condensed stay set)', () => {
    const { result } = renderHook(() => useRefinementState())
    act(() => {
      result.current.actions.completePhase3('chronicle-text')
      result.current.actions.completePhase4({ jests: ['j'], gore: [], quotes: [] })
      result.current.actions.completePhase6({ narrative: 'n', bulletPoints: [] })
      result.current.actions.markRunComplete()
    })
    expect(result.current.state.chronicle).toBe('chronicle-text')
    expect(result.current.state.extras).toEqual({ jests: ['j'], gore: [], quotes: [] })
    expect(result.current.state.condensed).toEqual({ narrative: 'n', bulletPoints: [] })
    expect(result.current.state.status).toBe('done')
  })
})
