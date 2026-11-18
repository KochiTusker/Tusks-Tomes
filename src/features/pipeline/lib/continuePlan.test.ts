import { describe, expect, it } from 'vitest'
import { planContinue } from './continuePlan'
import { DEFAULT_OUTPUT_SELECTION, initialRefinementState, type RefinementState } from './types'

const base = (over: Partial<RefinementState>) => ({ ...initialRefinementState, ...over })
const picked = (o: Partial<typeof DEFAULT_OUTPUT_SELECTION>) => ({ ...DEFAULT_OUTPUT_SELECTION, ...o })

describe('planContinue', () => {
  it('offers nothing before any step has finished', () => {
    expect(planContinue(base({ currentPhase: 'phase1_ground' }))).toBeNull()
    expect(planContinue(base({ currentPhase: null }))).toBeNull()
  })

  it('Phase 1 finished: audits the saved grounded transcript', () => {
    for (const currentPhase of ['phase1_ground', 'phase2_audit'] as const) {
      expect(planContinue(base({ groundedTranscript: 'G', currentPhase }))).toEqual({
        kind: 'audit',
        label: 'the Audit step',
      })
    }
  })

  it('Phase 2 finished with questions unanswered: reopens the questions', () => {
    const plan = planContinue(
      base({ groundedTranscript: 'G', currentPhase: null, dmQuestions: [{ id: 'q', question: '?' }] }),
    )
    expect(plan?.kind).toBe('questions')
  })

  it('Phase 2 finished with no questions and no output choice: reopens the picker', () => {
    expect(planContinue(base({ groundedTranscript: 'G', currentPhase: null }))?.kind).toBe('picker')
  })

  it('outputs picked, nothing produced: starts at the Chronicle', () => {
    const plan = planContinue(
      base({ groundedTranscript: 'G', currentPhase: 'phase3_chronicle', outputSelection: picked({}) }),
    )
    expect(plan).toMatchObject({
      kind: 'outputs',
      label: 'the Chronicle step',
      resume: { chronicle: '', polishPending: false, extrasDone: false, condensedDone: true },
    })
  })

  it('chronicle exists: skips it and names Extras', () => {
    const plan = planContinue(
      base({
        groundedTranscript: 'G',
        currentPhase: 'phase4_extras',
        chronicle: 'Text.',
        outputSelection: picked({ extras: true }),
      }),
    )
    expect(plan).toMatchObject({
      label: 'the Extras step',
      resume: { chronicle: 'Text.', polishPending: false, extrasDone: false },
    })
  })

  it('died in Polish: the chronicle is kept and only polish is pending', () => {
    const plan = planContinue(
      base({
        groundedTranscript: 'G',
        currentPhase: 'phase5_polish',
        chronicle: 'Text.',
        outputSelection: picked({ extras: false }),
      }),
    )
    expect(plan).toMatchObject({ label: 'the Polish step', resume: { polishPending: true } })
  })

  it('chronicle and extras exist, Condense chosen: only Condense is left', () => {
    const plan = planContinue(
      base({
        groundedTranscript: 'G',
        currentPhase: 'phase6_condense',
        chronicle: 'Text.',
        extras: { jests: [], gore: [], quotes: [] },
        outputSelection: picked({ extras: true, condensed: true }),
      }),
    )
    expect(plan).toMatchObject({
      label: 'the Condense step',
      resume: { extrasDone: true, condensedDone: false },
    })
  })

  it('every chosen output exists: nothing left to continue', () => {
    expect(
      planContinue(
        base({
          groundedTranscript: 'G',
          currentPhase: 'phase6_condense',
          chronicle: 'Text.',
          extras: { jests: [], gore: [], quotes: [] },
          condensed: { narrative: 'n', bulletPoints: [] },
          outputSelection: picked({ extras: true, condensed: true }),
        }),
      ),
    ).toBeNull()
  })
})
