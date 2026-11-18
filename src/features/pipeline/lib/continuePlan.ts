// What a run that died with its page can still do. The run state mirrors every
// finished output to localStorage, so the interrupted screen can offer to carry
// on from the first step that has no output instead of starting over.
//
// Execution order is P1, P2, (answers + output choice), P3, P5, P4, P6. The
// status that was running is lost to the 'error' status, but `currentPhase`
// survives and names the step the page died in.
import type { OutputSelection, RefinementState } from '@/features/pipeline/lib/types'

/** Which later outputs already exist, so a continued run skips them. */
export interface ContinueResume {
  /** The chronicle text already produced ('' when Phase 3 has not finished). */
  chronicle: string
  /** The page died during Polish: the chronicle exists but is not polished. */
  polishPending: boolean
  extrasDone: boolean
  condensedDone: boolean
}

export type ContinuePlan =
  /** Phase 1 finished, Phase 2 did not: audit the saved grounded transcript. */
  | { kind: 'audit'; label: string }
  /** The audit finished but its questions are not answered: reopen them. */
  | { kind: 'questions'; label: string }
  /** The questions are settled but the outputs are not picked: reopen the picker. */
  | { kind: 'picker'; label: string }
  /** Outputs were picked: run only the selected ones that are not produced yet. */
  | { kind: 'outputs'; label: string; selection: OutputSelection; resume: ContinueResume }

type PlanInput = Pick<
  RefinementState,
  | 'groundedTranscript'
  | 'currentPhase'
  | 'dmQuestions'
  | 'outputSelection'
  | 'chronicle'
  | 'extras'
  | 'condensed'
>

/** The plan for the interrupted screen, or null when no step has finished
 *  (nothing to continue from). */
export function planContinue(state: PlanInput): ContinuePlan | null {
  if (!state.groundedTranscript.trim()) return null

  const phase = state.currentPhase
  // Died in Phase 2, or between Phase 1 finishing and Phase 2 starting.
  if (phase === 'phase1_ground' || phase === 'phase2_audit') {
    return { kind: 'audit', label: 'the Audit step' }
  }

  // Phase 2 done, and the run never reached an output step.
  if (phase === null) {
    return (state.dmQuestions ?? []).length > 0
      ? { kind: 'questions', label: 'the clarifying questions' }
      : { kind: 'picker', label: 'the output choice' }
  }

  const selection = state.outputSelection
  const chronicle = state.chronicle ?? ''
  const hasChronicle = chronicle.trim().length > 0
  const polishPending = hasChronicle && phase === 'phase5_polish'
  const needChronicle = selection.chronicle && !hasChronicle
  const needExtras = selection.extras && !state.extras
  // Condense reads the chronicle, so it can only run once one exists or is chosen.
  const needCondensed =
    selection.condensed && !state.condensed && (hasChronicle || selection.chronicle)

  let label: string
  if (needChronicle) label = 'the Chronicle step'
  else if (selection.chronicle && polishPending) label = 'the Polish step'
  else if (needExtras) label = 'the Extras step'
  else if (needCondensed) label = 'the Condense step'
  else return null // every selected output exists; nothing is left to run

  return {
    kind: 'outputs',
    label,
    selection,
    resume: {
      chronicle,
      polishPending: selection.chronicle && polishPending,
      extrasDone: !needExtras,
      condensedDone: !needCondensed,
    },
  }
}
