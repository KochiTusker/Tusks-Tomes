import { useCallback } from 'react'
import { LS_REFINEMENT } from '@/lib/constants'
import { useLocalStorage } from './useLocalStorage'
import {
  DEFAULT_OUTPUT_SELECTION,
  initialRefinementState,
  type CondenseOutput,
  type DMAnswers,
  type DMQuestion,
  type ExtrasOutput,
  type OutputSelection,
  type PhaseId,
  type PipelineStatus,
  type RefinementState,
  type RefusalRecord,
} from '@/types'

export function useRefinementState() {
  const [rawState, setState] = useLocalStorage<RefinementState>(
    LS_REFINEMENT,
    initialRefinementState
  )
  // Backfill outputSelection on older persisted state. Without this, a user
  // upgrading from before this feature lands would hydrate with the field
  // missing and the picker would crash reading `state.outputSelection.chronicle`.
  // Deep-merge with DEFAULT_OUTPUT_SELECTION so partial older shapes (e.g.
  // a v1.0 state that has {chronicle, extras, condensed} but lacks
  // condensePercentage from v1.1.0) get the defaulted fields filled in.
  // Cheap object-spread defensive default — no migration write needed.
  const state: RefinementState = {
    ...rawState,
    outputSelection: { ...DEFAULT_OUTPUT_SELECTION, ...(rawState.outputSelection ?? {}) },
  }

  const patch = useCallback(
    (p: Partial<RefinementState>) => {
      setState((prev) => ({
        ...prev,
        ...p,
        updatedAt: new Date().toISOString(),
      }))
    },
    [setState]
  )

  const reset = useCallback(() => {
    setState({
      ...initialRefinementState,
      campaign: state.campaign,
      sessionNumber: state.sessionNumber,
      updatedAt: new Date().toISOString(),
    })
  }, [setState, state.campaign, state.sessionNumber])

  const setCampaign = useCallback(
    (campaign: string) => patch({ campaign }),
    [patch]
  )
  const setSessionNumber = useCallback(
    (sessionNumber: number) => patch({ sessionNumber }),
    [patch]
  )

  const setStatus = useCallback(
    (status: PipelineStatus) => patch({ status }),
    [patch]
  )

  const startPhase = useCallback(
    (phase: PhaseId, totalChunks: number, startChunkIndex = 0) =>
      patch({
        status: phase,
        currentPhase: phase,
        // On a fresh run startChunkIndex is 0 (default arg). On resume
        // it's the absolute chunk index the pipeline is about to begin
        // processing — primes the UI counter so the user doesn't see
        // "chunk 1/N" while the loop is actually working on chunk 22.
        currentChunkIndex: startChunkIndex,
        totalChunks,
        countdownMs: 0,
        lastError: undefined,
      }),
    [patch]
  )

  const onChunkDone = useCallback(
    (index: number, partialOutput: string) =>
      patch({
        currentChunkIndex: index + 1,
        partialOutput,
        countdownMs: 0,
      }),
    [patch]
  )

  const onCountdown = useCallback(
    (ms: number) => patch({ countdownMs: ms }),
    [patch]
  )

  const completePhase1 = useCallback(
    (groundedTranscript: string) =>
      patch({ groundedTranscript, partialOutput: '', countdownMs: 0 }),
    [patch]
  )
  const completePhase2 = useCallback(
    (dmQuestions: DMQuestion[]) =>
      patch({
        dmQuestions,
        status: 'awaiting_dm',
        partialOutput: '',
        countdownMs: 0,
      }),
    [patch]
  )
  const setDMAnswers = useCallback(
    (dmAnswers: DMAnswers) => patch({ dmAnswers }),
    [patch]
  )
  /** Replace the DM questions WITHOUT touching run status — used when a
   *  post-run repair merges newly-recovered audit questions into the set.
   *  (completePhase2 flips status to 'awaiting_dm', which is wrong here.) */
  const setDMQuestions = useCallback(
    (dmQuestions: DMQuestion[]) => patch({ dmQuestions }),
    [patch]
  )
  const completePhase3 = useCallback(
    (chronicle: string) => patch({ chronicle, partialOutput: '', countdownMs: 0 }),
    [patch]
  )
  // Phase 4 + 6 used to flip status='done' themselves — but with selectable
  // outputs, ANY of completePhase{3,4,6} could be the terminal action AND
  // the run might finish without one of them. Single owner of the
  // status='done' transition: `markRunComplete()`, called from the
  // dispatcher after all selected phases finish.
  const completePhase4 = useCallback(
    (extras: ExtrasOutput) => patch({ extras, partialOutput: '', countdownMs: 0 }),
    [patch]
  )
  const completePhase6 = useCallback(
    (condensed: CondenseOutput) => patch({ condensed, partialOutput: '', countdownMs: 0 }),
    [patch]
  )
  /** End-of-run transition. Sets status='done', clears currentPhase, leaves
   *  the populated outputs alone. Replaces the previous double-purpose
   *  completePhase{4,6} actions that flipped done as a side effect. */
  const markRunComplete = useCallback(
    () =>
      patch({
        status: 'done',
        currentPhase: null,
        partialOutput: '',
        countdownMs: 0,
      }),
    [patch]
  )
  const setOutputSelection = useCallback(
    (outputSelection: OutputSelection) => patch({ outputSelection }),
    [patch]
  )

  const setSavedChronicleId = useCallback(
    (savedChronicleId: string) => patch({ savedChronicleId }),
    [patch]
  )

  /** Replace the persisted refusal manifest (unrepaired Claude Code refusals).
   *  Used after a repair flips entries to repaired. */
  const setRefusals = useCallback(
    (refusals: RefusalRecord[]) => patch({ refusals }),
    [patch]
  )
  /** Append one refusal via a functional update — race-free when several
   *  refusals fire back-to-back during a run, and (unlike a replace) preserves
   *  a resumed run's prior refusals. */
  const appendRefusal = useCallback(
    (rec: RefusalRecord) =>
      setState((prev) => ({
        ...prev,
        refusals: [...(prev.refusals ?? []), rec],
        updatedAt: new Date().toISOString(),
      })),
    [setState]
  )

  const setError = useCallback(
    (message: string) => patch({ status: 'error', lastError: message }),
    [patch]
  )

  const setRawTranscript = useCallback(
    (rawTranscript: string) => patch({ rawTranscript }),
    [patch]
  )

  /** Replace the entire state with a snapshot (used when resuming a
   *  paused run from an on-disk checkpoint). */
  const hydrate = useCallback(
    (next: RefinementState) => setState({ ...next, updatedAt: new Date().toISOString() }),
    [setState]
  )

  return {
    state,
    actions: {
      setCampaign,
      setSessionNumber,
      setRawTranscript,
      setStatus,
      startPhase,
      onChunkDone,
      onCountdown,
      completePhase1,
      completePhase2,
      setDMAnswers,
      setDMQuestions,
      completePhase3,
      completePhase4,
      completePhase6,
      markRunComplete,
      setOutputSelection,
      setSavedChronicleId,
      setRefusals,
      appendRefusal,
      setError,
      reset,
      hydrate,
    },
  }
}
