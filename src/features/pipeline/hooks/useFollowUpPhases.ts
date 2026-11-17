import { useCallback, useState, type RefObject } from 'react'
import { toast } from 'sonner'
import { getAliasIndex } from '@/features/lore'
import type { PersonasDocument } from '@/features/personas'
import type { RunSession } from '@/features/routing'
import { computeCondenseTarget, countWords } from '@/platform/lib/wordCount'
import { runPhase4, runPhase6, type PipelineCallbacks } from '@/features/pipeline/lib/pipeline'
import { fetchRunSettings } from '@/features/pipeline/lib/runSettings'
import { warnIfCondenseOvershoot, warnIfCondenseShort } from '@/features/pipeline/lib/condenseWarnings'
import { resolvePersonaTemplates, sessionPhaseArgs } from '@/features/pipeline/lib/refinementRun'
import type { KBDocument, RefinementState } from '@/features/pipeline/lib/types'
import type { RefinementActions } from './useRefinementState'
import type { PipelineErrorHandler } from './usePipelineErrorHandler'

/** Condense (Phase 6) and Extras (Phase 4) run on their own from the finished
 *  chronicle, each with its own loading flag, independent of `running`. */
export function useFollowUpPhases({
  state,
  actions,
  kb,
  campaign,
  sessionNumber,
  callbacks,
  handlePipelineError,
  abortRef,
  sessionRef,
  personasRef,
  safetyMultiplierRef,
}: {
  state: RefinementState
  actions: RefinementActions
  kb: KBDocument[]
  campaign: string
  sessionNumber: number
  callbacks: PipelineCallbacks
  handlePipelineError: PipelineErrorHandler
  abortRef: RefObject<AbortController | null>
  sessionRef: RefObject<RunSession | null>
  personasRef: RefObject<PersonasDocument>
  safetyMultiplierRef: RefObject<number>
}) {
  // Phase 6 (Condense) — optional opt-in run from the ChronicleView card.
  // Doesn't affect the existing pipeline; just produces an additional
  // CondenseOutput written to state.condensed alongside the chronicle.
  const [condensing, setCondensing] = useState(false)
  const runCondense = useCallback(async () => {
    if (condensing) return
    if (!state.chronicle.trim()) {
      toast.error('No chronicle to condense.')
      return
    }
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setCondensing(true)
    actions.setStatus('phase6_condense')
    try {
      const session = sessionRef.current
      const personaTemplates = resolvePersonaTemplates(personasRef.current)
      const runSettings = await fetchRunSettings()
      const condensed = await runPhase6({
        chronicle: state.chronicle,
        kb,
        dmAnswers: state.dmAnswers,
        campaign,
        sessionNumber,
        callbacks: { ...callbacks, signal: ctrl.signal },
        ...sessionPhaseArgs(session, 'phase6'),
        personaTemplates: personaTemplates.phase6,
        safetyMultiplier: () => safetyMultiplierRef.current,
        thinkingOn: runSettings.perPhaseThinking.phase6,
            retrieveVaultKb: runSettings.retrieveVaultKb,
            aliasIndex: await getAliasIndex(),
        targetWordCount: computeCondenseTarget(countWords(state.chronicle), state.outputSelection.condensePercentage),
      })
      actions.completePhase6(condensed)
      const targetForWarning = computeCondenseTarget(countWords(state.chronicle), state.outputSelection.condensePercentage)
      warnIfCondenseShort(condensed)
      warnIfCondenseOvershoot(condensed, targetForWarning)
      actions.markRunComplete()
      toast.success('Condense complete — Condensed and Recap tabs are now available.')
    } catch (err) {
      handlePipelineError(err, { cancelMsg: 'Condense cancelled.', cancelStatus: 'done', label: 'Condense' })
    } finally {
      setCondensing(false)
      abortRef.current = null
    }
  }, [actions, callbacks, campaign, condensing, handlePipelineError, kb, sessionNumber, state.chronicle, state.dmAnswers])

  // Phase 4 (Extras) — optional opt-in run when the user opted out at the
  // OutputPicker step and later wants the extras anyway. Mirrors runCondense:
  // separate state for the loading flag, independent of `running`.
  const [generatingExtras, setGeneratingExtras] = useState(false)
  const runExtrasOnly = useCallback(async () => {
    if (generatingExtras) return
    if (!state.groundedTranscript.trim()) {
      toast.error('No grounded transcript — extras need the grounding output from Phase 1.')
      return
    }
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setGeneratingExtras(true)
    actions.setStatus('phase4_extras')
    try {
      const session = sessionRef.current
      const runSettings = await fetchRunSettings()
      const extras = await runPhase4({
        kb,
        groundedTranscript: state.groundedTranscript,
        dmAnswers: state.dmAnswers,
        callbacks: { ...callbacks, signal: ctrl.signal },
        ...sessionPhaseArgs(session, 'phase4'),
        safetyMultiplier: () => safetyMultiplierRef.current,
        thinkingOn: runSettings.perPhaseThinking.phase4,
        reassembleQuotes: runSettings.reassembleQuotes,
      })
      actions.completePhase4(extras)
      actions.markRunComplete()
      toast.success('Extras generated — quotes, jests, and gore tabs are now available.')
    } catch (err) {
      handlePipelineError(err, {
        cancelMsg: 'Extras cancelled.',
        cancelStatus: 'done',
        label: 'Extras',
      })
    } finally {
      setGeneratingExtras(false)
      abortRef.current = null
    }
  }, [
    actions,
    callbacks,
    generatingExtras,
    handlePipelineError,
    state.dmAnswers,
    state.groundedTranscript,
  ])
  return { condensing, runCondense, generatingExtras, runExtrasOnly }
}
