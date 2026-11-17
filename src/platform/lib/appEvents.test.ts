import { describe, expect, it } from 'vitest'
import { refinementStateFromReforge, type ReforgeCompleteDetail } from './appEvents'
import { initialRefinementState } from '@/features/pipeline/lib/types'

const detail: ReforgeCompleteDetail = {
  campaign: 'Ashfall',
  sessionNumber: 12,
  chronicle: 'The chronicle.',
  extras: { jests: [], gore: [], quotes: [] },
  condensed: null,
  groundedTranscript: '[Zuri (DM)] Grounded.',
  dmQuestions: [],
  dmAnswers: {},
  savedChronicleId: 'abc123',
}

describe('refinementStateFromReforge', () => {
  it('carries the reforge outputs and marks the run done', () => {
    const s = refinementStateFromReforge(detail, '2026-09-17T00:00:00.000Z')
    expect(s).toMatchObject({ ...detail, status: 'done', updatedAt: '2026-09-17T00:00:00.000Z' })
  })

  it('resets everything the reforge did not produce', () => {
    // A reforge has no raw transcript, no refusals and no run in progress.
    // Carrying any of those over from the previous run would pin them to a
    // chronicle they never belonged to, which is what a merge over the stored
    // state used to do on one of the two listeners.
    const s = refinementStateFromReforge(detail)
    expect(s.rawTranscript).toBe(initialRefinementState.rawTranscript)
    expect(s.refusals).toEqual(initialRefinementState.refusals)
    expect(s.currentPhase).toBe(initialRefinementState.currentPhase)
    expect(s.partialOutput).toBe(initialRefinementState.partialOutput)
    expect(s.outputSelection).toEqual(initialRefinementState.outputSelection)
  })
})
