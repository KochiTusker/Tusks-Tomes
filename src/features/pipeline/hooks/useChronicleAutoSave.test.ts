/** @vitest-environment jsdom */
// The auto-save keeps a finished run in the Saved Chronicles library. A
// chronicle can also be edited from Saved Chronicles, so the run's copy must
// never write its older text over that edit.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { initialRefinementState, type RefinementState } from '@/features/pipeline/lib/types'
import type { RefinementActions } from './useRefinementState'
import { useChronicleAutoSave } from './useChronicleAutoSave'

const lib = vi.hoisted(() => ({
  saveChronicle: vi.fn(),
  updateChronicle: vi.fn(),
  getChronicle: vi.fn(),
}))
vi.mock('@/features/library', () => ({ ...lib, CHRONICLE_LIBRARY_EVENT: 'sbts:chronicle-library-changed' }))
vi.mock('@/features/routing', () => ({ getRouting: vi.fn(async () => ({ lastSelectedProvider: 'gemini' })) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

function doneState(over: Partial<RefinementState> = {}): RefinementState {
  return { ...initialRefinementState, status: 'done', chronicle: 'The party marched.', ...over }
}

function setup(initial: RefinementState) {
  const actions = { setSavedChronicleId: vi.fn(), completePhase3: vi.fn() } as unknown as RefinementActions
  const stateRef = { current: initial }
  const hook = renderHook(
    ({ state }: { state: RefinementState }) => {
      stateRef.current = state
      useChronicleAutoSave({ state, actions, stateRef, campaign: 'Campaign-Alpha', sessionNumber: 3 })
    },
    { initialProps: { state: initial } },
  )
  return { ...hook, actions }
}

beforeEach(() => {
  lib.saveChronicle.mockResolvedValue({ id: 'rec-1' })
  lib.updateChronicle.mockResolvedValue({ id: 'rec-1' })
})
afterEach(() => vi.clearAllMocks())

describe('useChronicleAutoSave', () => {
  it('does nothing until the run is done', () => {
    setup({ ...initialRefinementState, status: 'phase3_chronicle', chronicle: 'Half a story.' })
    expect(lib.saveChronicle).not.toHaveBeenCalled()
    expect(lib.updateChronicle).not.toHaveBeenCalled()
  })

  it('creates one library entry when a run finishes and remembers its id', async () => {
    const { actions } = setup(doneState())
    await waitFor(() => expect(lib.saveChronicle).toHaveBeenCalledTimes(1))
    expect(lib.saveChronicle.mock.calls[0][0]).toMatchObject({
      campaign: 'Campaign-Alpha',
      sessionNumber: 3,
      chronicle: 'The party marched.',
    })
    await waitFor(() => expect(actions.setSavedChronicleId).toHaveBeenCalledWith('rec-1'))
  })

  it('does not resend an already-saved chronicle when the page loads', async () => {
    setup(doneState({ savedChronicleId: 'rec-1' }))
    await waitFor(() => expect(lib.updateChronicle).toHaveBeenCalled())
    expect(lib.updateChronicle.mock.calls[0][1]).not.toHaveProperty('chronicle')
  })

  it('sends the chronicle when it changes in the run, and leaves it out when only extras change', async () => {
    const { rerender } = setup(doneState({ savedChronicleId: 'rec-1' }))
    await waitFor(() => expect(lib.updateChronicle).toHaveBeenCalledTimes(1))

    rerender({ state: doneState({ savedChronicleId: 'rec-1', chronicle: 'The party marched at dawn.' }) })
    await waitFor(() => expect(lib.updateChronicle).toHaveBeenCalledTimes(2))
    expect(lib.updateChronicle.mock.calls[1][1]).toMatchObject({ chronicle: 'The party marched at dawn.' })

    const extras = { jests: [], gore: [], quotes: [] }
    rerender({
      state: doneState({ savedChronicleId: 'rec-1', chronicle: 'The party marched at dawn.', extras }),
    })
    await waitFor(() => expect(lib.updateChronicle).toHaveBeenCalledTimes(3))
    expect(lib.updateChronicle.mock.calls[2][1]).not.toHaveProperty('chronicle')
    expect(lib.updateChronicle.mock.calls[2][1]).toMatchObject({ extras })
  })

  it('takes an edit made in Saved Chronicles into the run', async () => {
    const { actions } = setup(doneState({ savedChronicleId: 'rec-1' }))
    await waitFor(() => expect(lib.updateChronicle).toHaveBeenCalledTimes(1))

    lib.getChronicle.mockResolvedValue({ id: 'rec-1', chronicle: 'Edited in the library.' })
    act(() => {
      window.dispatchEvent(new CustomEvent('sbts:chronicle-library-changed'))
    })
    await waitFor(() => expect(actions.completePhase3).toHaveBeenCalledWith('Edited in the library.'))
    expect(lib.getChronicle).toHaveBeenCalledWith('rec-1')
  })

  it('ignores library changes that match the run or belong to another entry', async () => {
    const { actions } = setup(doneState({ savedChronicleId: 'rec-1' }))
    await waitFor(() => expect(lib.updateChronicle).toHaveBeenCalledTimes(1))

    lib.getChronicle.mockResolvedValue({ id: 'rec-1', chronicle: 'The party marched.' })
    act(() => {
      window.dispatchEvent(new CustomEvent('sbts:chronicle-library-changed'))
    })
    await waitFor(() => expect(lib.getChronicle).toHaveBeenCalledTimes(1))
    expect(actions.completePhase3).not.toHaveBeenCalled()
  })
})
