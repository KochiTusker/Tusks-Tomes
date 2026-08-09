// Pure planner for resuming a paused pipeline run from an on-disk
// checkpoint. Decides what each phase's resume looks like — which phase
// to dispatch first, whether it can continue at the saved chunk index or
// must restart that phase, and which downstream phases to chain after it.
//
// Lives separately from RefinementTool so the decision logic is unit-
// testable without React state. The actual dispatch (calling runPhaseN
// with the resolved args) stays in the component.

import type { CheckpointPhaseId, RunCheckpoint } from './runCheckpoint'
import { DEFAULT_OUTPUT_SELECTION, type ExtrasOutput, type OutputSelection } from '@/types'
import { normalizeQuotes } from './quotes'
import { vlog } from './verboseLog'

export type ResumeAction = {
  /** 'continue' = pick up the same phase at startChunkIndex with prior
   *  partial output. 'restart' = run the phase fresh from chunk 0
   *  (used for phases that don't support chunk-level resume). */
  kind: 'continue' | 'restart'
  /** Phase to start the resume on. */
  phase: CheckpointPhaseId
  /** Chunk index to start the chosen phase from. 0 for restarts. */
  startChunkIndex: number
  /** Accumulator for Phase 1 (grounded transcript so far) and Phase 3
   *  (chronicle so far). Undefined for phases that don't resume mid-flow. */
  priorPartial?: string
  /** Accumulator specifically for Phase 4 (extras has a structured
   *  accumulator, not a string). Undefined for other phases. */
  priorExtras?: ExtrasOutput
  /** Phase 4 only: true when partialOutput was present but failed to
   *  JSON.parse (torn write, malformed JSON). The UI uses this signal
   *  to toast about the lost data ("Phase 4 partial extras unreadable
   *  — restarting phase. Up to N chunks of extras lost.") before
   *  dispatching the resume with priorExtras = emptyExtras. */
  parseError?: boolean
  /** Phases to run after the resumed phase completes, in order. Mirrors
   *  the natural pipeline order. With output selection now opt-in, this
   *  list reflects the user's saved choice: Phase 5 always runs after
   *  Phase 3 (polish is a pass-through for cloud anyway); Phase 4 runs
   *  only if extras was selected; Phase 6 runs only if condensed was
   *  selected AND chronicle was selected (the picker enforces the
   *  dependency, so we trust selection.condensed here). */
  afterPhases: Array<2 | 4 | 5 | 6>
}

/** Read the persisted output selection from the checkpoint, falling back
 *  to DEFAULT_OUTPUT_SELECTION when the field is missing — i.e. when the
 *  checkpoint was created before this feature landed. The default matches
 *  today's behavior (chronicle + extras; condensed opt-in), so a legacy
 *  checkpoint resumes exactly the way it would have pre-feature. */
function selectionFromCheckpoint(checkpoint: RunCheckpoint): OutputSelection {
  return checkpoint.refinementState.outputSelection ?? DEFAULT_OUTPUT_SELECTION
}

/** Build the afterPhases list for a Phase-3 resume based on the saved
 *  output selection. Phase 5 always follows Phase 3 (it's the polish pass —
 *  a no-op for cloud anyway); Phase 4 / 6 are conditional. */
function afterPhases3(selection: OutputSelection): Array<2 | 4 | 5 | 6> {
  const list: Array<2 | 4 | 5 | 6> = [5]
  if (selection.extras) list.push(4)
  if (selection.condensed) list.push(6)
  return list
}

/** Build the afterPhases list for a Phase-4 resume. Today Phase 4 is
 *  terminal in the unconditional flow, but with the new optional outputs
 *  a user could have selected `extras + condensed` (where condensed
 *  implies chronicle, which already ran before the pause). On a Phase-4
 *  resume that means: finish Phase 4, then run Phase 6. */
function afterPhases4(selection: OutputSelection): Array<2 | 4 | 5 | 6> {
  return selection.condensed ? [6] : []
}

export function planResumeAction(checkpoint: RunCheckpoint): ResumeAction {
  const { progress, refinementState } = checkpoint
  const safeIndex = Math.max(0, progress.chunkIndex)
  const selection = selectionFromCheckpoint(checkpoint)

  switch (progress.phase) {
    case 1: {
      const grounded = refinementState.groundedTranscript ?? ''
      const partial = refinementState.partialOutput ?? ''
      // Prefer the canonical post-completion field (groundedTranscript).
      // Fall back to the in-flight chunk accumulator (partialOutput) if the
      // phase paused mid-flow — e.g. free-tier daily quota hit between chunks,
      // an unrecoverable provider error, or a user-initiated pause — so the
      // resume picks up at chunk N with chunks 0..N-1 already accumulated.
      // Without this fallback, mid-flight pauses silently restart from
      // chunk 0 and overwrite the checkpoint, erasing the user's progress.
      const carryover = grounded.length > 0 ? grounded : partial
      const startIndex = carryover.length === 0 ? 0 : safeIndex
      return {
        kind: 'continue',
        phase: 1,
        startChunkIndex: startIndex,
        priorPartial: carryover,
        afterPhases: [2],
      }
    }
    case 2:
      return {
        kind: 'restart',
        phase: 2,
        startChunkIndex: 0,
        afterPhases: [],
      }
    case 3: {
      const chronicle = refinementState.chronicle ?? ''
      const partial = refinementState.partialOutput ?? ''
      // Same fallback rationale as Phase 1: `chronicle` only populates on
      // phase completion, so a mid-Phase-3 pause without the fallback would
      // start at the saved chunkIndex with priorPartial='', silently
      // dropping chunks 0..safeIndex-1 from the final narrative.
      const carryover = chronicle.length > 0 ? chronicle : partial
      const startIndex = carryover.length === 0 ? 0 : safeIndex
      return {
        kind: 'continue',
        phase: 3,
        startChunkIndex: startIndex,
        priorPartial: carryover,
        afterPhases: afterPhases3(selection),
      }
    }
    case 4: {
      // Same fallback rationale as Phase 1 + Phase 3: refinementState.extras
      // only populates on phase completion. Mid-flight pauses (quota, error,
      // user Halt) leave the in-progress ExtrasOutput accumulator in
      // refinementState.partialOutput as a JSON.stringify of the
      // { jests, gore, quotes } shape. Without this recovery, every chunk
      // completed before the pause is silently dropped on resume.
      const canonical = refinementState.extras
      const hasCanonical =
        !!canonical &&
        (canonical.jests.length > 0 ||
          canonical.gore.length > 0 ||
          canonical.quotes.length > 0)
      if (hasCanonical) {
        return {
          kind: 'continue',
          phase: 4,
          startChunkIndex: safeIndex,
          priorExtras: canonical!,
          afterPhases: afterPhases4(selection),
        }
      }
      const partial = (refinementState.partialOutput ?? '').trim()
      if (!partial) {
        // Genuine "no chunks completed yet" pause. Safe to restart phase.
        return {
          kind: 'continue',
          phase: 4,
          startChunkIndex: safeIndex,
          priorExtras: { jests: [], gore: [], quotes: [] },
          afterPhases: afterPhases4(selection),
        }
      }
      try {
        const parsed = JSON.parse(partial) as Partial<ExtrasOutput>
        return {
          kind: 'continue',
          phase: 4,
          startChunkIndex: safeIndex,
          priorExtras: {
            jests: Array.isArray(parsed.jests) ? parsed.jests : [],
            gore: Array.isArray(parsed.gore) ? parsed.gore : [],
            quotes: normalizeQuotes(parsed.quotes),
          },
          afterPhases: afterPhases4(selection),
        }
      } catch (err) {
        // Torn write (crash mid-disk-write) or hand-edited corruption.
        // Refuse silent loss: log via vlog so the diagnose bundle captures
        // the failure, then signal parseError so the UI toasts about the
        // lost chunks before the resume dispatches with empty extras.
        vlog('resume', {
          event: 'phase4_partial_parse_failed',
          preview: partial.slice(0, 200),
          length: partial.length,
          err: String((err as Error)?.message ?? err),
        })
        return {
          kind: 'continue',
          phase: 4,
          startChunkIndex: safeIndex,
          priorExtras: { jests: [], gore: [], quotes: [] },
          parseError: true,
          afterPhases: afterPhases4(selection),
        }
      }
    }
    case 6:
      return {
        kind: 'restart',
        phase: 6,
        startChunkIndex: 0,
        afterPhases: [],
      }
  }
}
