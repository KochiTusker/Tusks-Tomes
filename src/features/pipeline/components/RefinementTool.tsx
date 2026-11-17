import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, Copy, Play, RotateCcw } from 'lucide-react'
import { Button } from '@/platform/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/platform/ui/card'
import { TranscriptInput } from './TranscriptInput'
import { PhaseProgress } from './PhaseProgress'
import { PhaseRail, openRoutingSurface, useSessionPreview } from './PhaseRail'
import { PersonaPicker, getPersonas, peekPersonas, subscribePersonas } from '@/features/personas'
import { FirstRunPanel, useNoCloudKeys } from './FirstRunPanel'
import {
  estimateRunCost,
  formatDollars,
  type PhaseRouting as PricePhaseRouting,
  buildLiveRateResolver,
  type LiveRateResolver,
  getOpenRouterCatalogue,
  LS_CAMPAIGN,
  LS_OUTPUT_SELECTION,
  LS_SESSION,
  isLocalProvider,
  PROVIDERS_CHANGED_EVENT,
  type ProvidersChangedDetail,
} from '@/features/providers'
import { DMQuestionsModal } from './DMQuestionsModal'
import { ChronicleView, buildPartialMarkdown, downloadMarkdownFile } from '@/features/library'
import { ActiveProviderBanner } from './ActiveProviderBanner'
import { RetryBanner, type RetryState } from './RetryBanner'
import { CostEstimatorCard } from './CostEstimatorCard'
import { RateLimitDialog } from './RateLimitDialog'
import { useLocalStorage } from '@/platform/hooks/useLocalStorage'
import { useLoreDocuments, getAliasIndex } from '@/features/lore'
import { useRefinementState } from '@/features/pipeline/hooks/useRefinementState'
import { useChronicleAutoSave } from '@/features/pipeline/hooks/useChronicleAutoSave'
import { useCloudKeyStatus } from '@/features/pipeline/hooks/useCloudKeyStatus'
import {
  usePipelineEventCallbacks,
  type RateLimitDialogState,
} from '@/features/pipeline/hooks/usePipelineEventCallbacks'
import { usePipelineErrorHandler } from '@/features/pipeline/hooks/usePipelineErrorHandler'
import { useFollowUpPhases } from '@/features/pipeline/hooks/useFollowUpPhases'
import { useRefusalRepair } from '@/features/pipeline/hooks/useRefusalRepair'
import { useCheckpointWriter } from '@/features/pipeline/hooks/useCheckpointWriter'
import { useRateLimitChoice } from '@/features/pipeline/hooks/useRateLimitChoice'
import { OutputPicker } from './OutputPicker'
import { truncateAtLineBoundary, vlog } from '@/features/maintenance'
import {
  runPhase1,
  runPhase2,
  runPhase3,
  runPhase4,
  runPhase5Polish,
  runPhase6,
} from '@/features/pipeline/lib/pipeline'
import {
  computeCondenseTarget,
  countWords,
  estimateChronicleWords,
} from '@/platform/lib/wordCount'
import {
  autoResolveSession,
  buildSession,
  chunkSizeForSessionPhase,
  type RunSession,
  getRouting,
} from '@/features/routing'
import { isSbv, sbvToText } from '@/features/caption-repair'
import { getClaudeFailsafeEnabled } from '@/features/guardrails'
import { geminiAvailableForRestore } from '@/features/pipeline/lib/restorePass'
import type { FallbackRecord } from '@/features/pipeline/lib/refusalDetection'
import {
  REFORGE_COMPLETE_EVENT,
  type ReforgeCompleteDetail,
  refinementStateFromReforge,
} from '@/platform/lib/appEvents'
import { planResumeAction, type ResumeAction } from '@/features/pipeline/lib/resumeFlow'
import { ResumeRunBanner } from './ResumeRunBanner'
import { deleteRun, loadRun } from '@/features/pipeline/lib/runStorage'
import {
  CHECKPOINT_SCHEMA_VERSION,
  type Phase1InputSnapshot,
  type RunCheckpoint,
} from '@/features/pipeline/lib/runCheckpoint'
import { computeRunFingerprint } from '@/features/pipeline/lib/runFingerprint'
import { getGlossary } from '@/features/corrections'
import { fetchRunSettings } from '@/features/pipeline/lib/runSettings'
import { cancelRun } from '@/features/pipeline/lib/cancelFlow'
import type { PersonasDocument } from '@/features/personas'
import {
  DEFAULT_OUTPUT_SELECTION,
  type DMAnswers,
  type OutputSelection,
} from '@/features/pipeline/lib/types'
import { warnIfCondenseOvershoot, warnIfCondenseShort } from '../lib/condenseWarnings'
import {
  INTERRUPTED_RUN_MESSAGE,
  SHORT_TRANSCRIPT_CHARS,
  fmtKbSize,
  isRunningPhaseId,
  reportSessionWarnings,
  resolvePersonaTemplates,
  sessionPhaseArgs,
} from '../lib/refinementRun'

export function RefinementTool() {
  const { state, actions } = useRefinementState()
  const { documents: kb } = useLoreDocuments()
  // First-run detection — must sit with the top-level hooks (the
  // component has early returns for every running state below).
  const noCloudKeys = useNoCloudKeys()
  /** True between a Run click and the pipeline actually taking over the
   *  status — see the guard in runFromPhase1. */
  const startingRunRef = useRef(false)
  // Read-only resolution shared by the idle rail and the Run button's
  // estimate — one buildSession, two consumers, dryRun always.
  const { session: previewSession } = useSessionPreview()
  const [liveRates, setLiveRates] = useState<LiveRateResolver | null>(null)
  useEffect(() => {
    let cancelled = false
    getOpenRouterCatalogue()
      .then((r) => {
        if (!cancelled) setLiveRates(buildLiveRateResolver(r.models))
      })
      .catch(() => {
        /* offline — the estimate falls back to the static tables */
      })
    return () => {
      cancelled = true
    }
  }, [])
  // The Header writes the campaign + session number to their own LS keys.
  // The pipeline state has separate `campaign` / `sessionNumber` fields
  // that nothing currently sets, which left the chronicle view (and the
  // Phase 6 condense prompt) staring at empty strings. Read the Header
  // values directly so downstream consumers see what the user typed.
  const [campaign] = useLocalStorage<string>(LS_CAMPAIGN, '')
  const [sessionNumber] = useLocalStorage<number>(LS_SESSION, 1)
  // Persisted across runs (independent of the per-run state) so a returning
  // user gets their last picker shape. Survives a refinement-state reset.
  // Confirmed-once: each run mirrors this into state.outputSelection at the
  // moment the user clicks "Run with selection" so the checkpoint captures it.
  const [persistedSelectionRaw, setPersistedSelection] = useLocalStorage<OutputSelection>(
    LS_OUTPUT_SELECTION,
    DEFAULT_OUTPUT_SELECTION,
  )
  // Defensive deep-merge — a user upgrading from v1.0 has a stored
  // selection that lacks condensePercentage; spread defaults first so
  // missing-since-v1.1.0 fields fill in cleanly without losing the user's
  // chronicle/extras/condensed choices.
  const persistedSelection: OutputSelection = {
    ...DEFAULT_OUTPUT_SELECTION,
    ...persistedSelectionRaw,
  }
  const [running, setRunning] = useState(false)
  // Claude Code refusals the failsafe repaired this run — surfaced post-run
  // in the chronicle view's review modal so the user can ground them. Reset
  // when a run starts.
  const [fallbacks, setFallbacks] = useState<FallbackRecord[]>([])
  useEffect(() => {
    if (running) setFallbacks([])
  }, [running])
  // NOTE: the persisted refusal manifest (state.refusals) is NOT reset here —
  // a fresh run clears it via actions.reset() in runWithSession, while a resume
  // must KEEP the paused run's refusals. New refusals are appended race-free via
  // actions.appendRefusal (functional update), so no ref accumulator is needed.
  // Mirror of `running` in a ref so the race-window-tightened fallback
  // handler can poll it without forcing the callback to re-bind every state
  // tick. Kept in sync via a tiny effect below.
  const runningRef = useRef(running)
  useEffect(() => { runningRef.current = running }, [running])

  // A run lives in this component's closure — the AbortController, the
  // provider calls, the loop over chunks — and only its status is persisted.
  // A page reload therefore comes back with a status that says "phase 3,
  // chunk 12" and nothing running behind it: the progress view rendered,
  // the spinner turned, and nothing would ever change. The user could not
  // even cancel, because the Cancel control needs the run this page never
  // had. On the first mount, a running status with no run behind it is
  // recorded as an interruption, which lands on the error surface with
  // Retry and Reset, and with the checkpoint banner if the run left one.
  // Mount-once: a legitimate run flips the status to a phase id later, and
  // this must never see that.
  const interruptionCheckedRef = useRef(false)
  useEffect(() => {
    if (interruptionCheckedRef.current) return
    interruptionCheckedRef.current = true
    if (runningRef.current || startingRunRef.current) return
    // The mount closure's `state` is exactly the persisted state.
    if (!isRunningPhaseId(state.status)) return
    actions.setError(INTERRUPTED_RUN_MESSAGE)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // v1.1.0 — mid-run provider-switch warning. When the user opens
  // Settings and edits an API key during an in-flight run, refreshProviders
  // rebuilds the singletons and the NEXT chunk will dispatch to the new
  // key. Pre-fix bug: this happened silently — users could see unexpected
  // bills on the wrong account. The fix surfaces a toast so the user can
  // halt if the change was unintentional. The pipeline itself doesn't
  // need to do anything fancy: chunks dispatched after the swap pick up
  // the new singleton naturally on the next `getCloudProvider()` call.
  useEffect(() => {
    function onProvidersChanged(e: Event) {
      if (!runningRef.current) return
      const detail = (e as CustomEvent<ProvidersChangedDetail>).detail
      if (!detail || detail.changedKeys.length === 0) return
      toast.warning(
        `Active provider keys changed mid-run (${detail.changedKeys.join(', ')}). The next chunk will dispatch to the new key — halt if this was unintentional.`,
        { duration: 12_000 },
      )
    }
    window.addEventListener(PROVIDERS_CHANGED_EVENT, onProvidersChanged)
    return () => window.removeEventListener(PROVIDERS_CHANGED_EVENT, onProvidersChanged)
  }, [])
  // K.1.3 / W1 — refs that always hold the latest state at the moment
  // writeCheckpoint actually runs. Without these, writeCheckpoint's
  // useCallback closure captures `state`/`campaign`/`sessionNumber` at
  // render time; if a chunk_done lands mid-write the persisted
  // checkpoint can record stale values (chunkIndex N+1 alongside
  // partialOutput from chunk N). Reading via refs at the top of
  // writeCheckpoint takes a coherent snapshot at call-time instead.
  const stateRef = useRef(state)
  const campaignRef = useRef(campaign)
  const sessionNumberRef = useRef(sessionNumber)
  useEffect(() => { stateRef.current = state }, [state])
  useEffect(() => { campaignRef.current = campaign }, [campaign])
  useEffect(() => { sessionNumberRef.current = sessionNumber }, [sessionNumber])

  useChronicleAutoSave({ state, actions, stateRef, campaign, sessionNumber })
  const [retryState, setRetryState] = useState<RetryState | null>(null)
  /** Dev test mode: when truncation just happened, the banner shows the
   *  before/after char counts. null when the current run wasn't truncated
   *  (or no run has started yet). */
  const [devTruncation, setDevTruncation] = useState<{
    originalChars: number
    outputChars: number
  } | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const sessionRef = useRef<RunSession | null>(null)
  /** Unique id for the in-flight run, used as the on-disk checkpoint
   *  filename. Reset on every run-start; cleared after a clean finish. */
  const currentRunIdRef = useRef<string | null>(null)
  /** Bump to force the ResumeRunBanner to re-fetch (e.g. after we write a
   *  fresh checkpoint via the dialog's Pause choice). */
  const [resumeBannerKey, setResumeBannerKey] = useState(0)
  // Track personas doc in a ref so phase-run callbacks see the freshest
  // selection without re-instantiating the callbacks themselves. The picker
  // (App.tsx → PersonaPicker) mutates this via setSelectedPersona, which
  // fans out through subscribePersonas.
  const personasRef = useRef<PersonasDocument>(peekPersonas())
  useEffect(() => {
    let cancelled = false
    getPersonas()
      .then((doc) => { if (!cancelled) personasRef.current = doc })
      .catch(() => { /* add-on off → 404, fine, ref stays empty */ })
    const unsub = subscribePersonas((doc) => { personasRef.current = doc })
    return () => { cancelled = true; unsub() }
  }, [])

  // Rate-limit dialog state. Opens when the provider emits quota_exhausted.
  // The multiplier lives in a ref so the dialog can flip it mid-run and the
  // chunk loop reads the latest value before each chunk's pacing.
  const safetyMultiplierRef = useRef<number>(1)
  const [rateLimitDialog, setRateLimitDialog] = useState<RateLimitDialogState | null>(null)
  const { apiKeyMissing, paidKeyAvailable } = useCloudKeyStatus()

  const callbacks = usePipelineEventCallbacks({
    actions,
    setRetryState,
    setRateLimitDialog,
    setFallbacks,
  })

  /** Forward-reference to writeCheckpoint (defined ~800 lines below).
   *  handlePipelineError needs to call it for the daily-quota auto-pause
   *  case, but writeCheckpoint depends on state/campaign/sessionNumber
   *  which appear later in the component. The ref gets populated by a
   *  useEffect once writeCheckpoint is defined, so the first paint
   *  before handlePipelineError can possibly fire (no error has happened
   *  yet) is the only window where the ref is null — and even then the
   *  fallback toast still surfaces. */
  const writeCheckpointRef = useRef<
    ((reason: 'user' | 'quota' | 'error') => Promise<boolean>) | null
  >(null)

  /** K.1.2 / B2 — Phase 1 prep snapshot. runPhase1 emits this once via
   *  `onInputSnapshot` after chunking completes; writeCheckpoint stuffs
   *  it into the next checkpoint so a resume after a glossary edit can
   *  honour the original chunk boundaries instead of recomputing them
   *  against the live (mutated) glossary. Cleared on fresh-run start so
   *  a stale snapshot from a previous run can't contaminate a new one. */
  const phase1InputSnapshotRef = useRef<Phase1InputSnapshot | null>(null)
  /** K.1.2 / B2 — fingerprint of the prep-stage inputs at the time the
   *  most-recent run started. Recomputed at resume time and compared
   *  against the checkpoint's saved value so the UI can warn when the
   *  glossary / alias index has shifted since pause. */
  const runFingerprintRef = useRef<string | null>(null)

  const handlePipelineError = usePipelineErrorHandler({
    actions,
    state,
    setRetryState,
    writeCheckpointRef,
  })

  /** Poll `runningRef` at 50ms intervals until it flips to false (the
   *  in-flight chunk loop's finally-block has run) OR the timeout elapses.
   *  Used by the race-window-tightened fallback handler to ensure the
   *  routing flip + refreshProviders happen AFTER the old chunk has fully
   *  settled, so the dialog's `tier` label on any re-fire reflects the
   *  CURRENT singleton/tier rather than the pre-switch one.
   *
   *  Returns true if the loop settled within the timeout, false otherwise
   *  (caller proceeds either way — racing is better than blocking the user
   *  on a hung SDK call). */
  const settleInFlight = useCallback(async (timeoutMs: number): Promise<boolean> => {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if (!runningRef.current) return true
      await new Promise((r) => setTimeout(r, 50))
    }
    return false
  }, [])

  const surfaceSessionWarnings = useCallback(reportSessionWarnings, [])

  /** Drop the on-disk checkpoint once a run finishes cleanly. */
  const clearActiveCheckpoint = useCallback(() => {
    const id = currentRunIdRef.current
    if (!id) return
    currentRunIdRef.current = null
    void deleteRun(id).catch(() => {
      // Best-effort cleanup; a stale checkpoint is annoying but harmless.
    })
    setResumeBannerKey((k) => k + 1)
  }, [])

  const runWithSession = useCallback(
    async (rawTranscript: string, session: RunSession | null) => {
      sessionRef.current = session
      surfaceSessionWarnings(session)
      setRunning(true)
      // Generate a unique runId for this run so any subsequent pause
      // writes a fresh checkpoint and a clean finish can delete it.
      currentRunIdRef.current = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const ctrl = new AbortController()
      abortRef.current = ctrl
      try {
        actions.reset()
        // Read cross-cutting toggles once per run. Defaults preserve
        // existing behaviour on any fetch failure.
        const runSettings = await fetchRunSettings()
        // Dev test mode: truncate the transcript at a clean line boundary
        // BEFORE Phase 1 sees it. Every phase then runs on the truncated
        // content end-to-end, so the user can verify the pipeline at a
        // fraction of the cost of a full-session run.
        let effectiveTranscript = rawTranscript
        if (runSettings.devTestMode.enabled) {
          const trunc = truncateAtLineBoundary(rawTranscript, runSettings.devTestMode.maxChars)
          effectiveTranscript = trunc.text
          setDevTruncation(trunc.truncated ? { originalChars: trunc.originalChars, outputChars: trunc.outputChars } : null)
          if (trunc.truncated) {
            toast.info(
              `Dev test mode: truncated transcript from ${trunc.originalChars.toLocaleString()} → ${trunc.outputChars.toLocaleString()} chars before Phase 1.`,
              { duration: 6000 },
            )
          }
        } else {
          setDevTruncation(null)
        }
        actions.setRawTranscript(effectiveTranscript)
        // K.1.2 / B2 — fresh run: clear any stale snapshot from a previous
        // run, capture this run's fingerprint NOW (before the first chunk
        // dispatches) so writeCheckpoint can persist it on pause, and let
        // runPhase1 emit the prep snapshot via onInputSnapshot below.
        phase1InputSnapshotRef.current = null
        runFingerprintRef.current = await computeRunFingerprint({
          rawTranscript: effectiveTranscript,
          glossary: await getGlossary(),
          aliasIndex: runSettings.phase1AliasHints ? await getAliasIndex() : null,
          phase1AliasHints: runSettings.phase1AliasHints,
        })
        const grounded = await runPhase1({
          rawTranscript: effectiveTranscript,
          kb,
          callbacks: { ...callbacks, signal: ctrl.signal },
          ...sessionPhaseArgs(session, 'phase1'),
          safetyMultiplier: () => safetyMultiplierRef.current,
          disableThinkingOnGrounding: runSettings.disableThinkingOnGrounding,
          phase1AliasHints: runSettings.phase1AliasHints,
          onInputSnapshot: (snapshot) => {
            phase1InputSnapshotRef.current = snapshot
          },
        })
        actions.completePhase1(grounded)
        const questions = await runPhase2({
          kb,
          rawTranscript: effectiveTranscript,
          groundedTranscript: grounded,
          callbacks: { ...callbacks, signal: ctrl.signal },
          ...sessionPhaseArgs(session, 'phase2'),
          safetyMultiplier: () => safetyMultiplierRef.current,
        })
        actions.completePhase2(questions)
        toast.success(`Phase 2 complete — ${questions.length} clarifications surfaced.`)
      } catch (err) {
        handlePipelineError(err)
      } finally {
        setRunning(false)
        abortRef.current = null
      }
    },
    [actions, callbacks, handlePipelineError, kb, surfaceSessionWarnings]
  )

  const runFromPhase1 = useCallback(
    async (rawTranscript: string) => {
      // Re-entrancy guard, checked and set synchronously so a second click
      // cannot slip through. The Run button only disables once `status`
      // becomes a running phase, and getting there awaits provider,
      // routing and profile fetches — a wide enough window that an
      // impatient double-click started two concurrent, separately-billed
      // pipelines.
      if (startingRunRef.current) return
      startingRunRef.current = true
      try {
      if (apiKeyMissing) {
        toast.error('No cloud provider key configured. Add one in the Settings tab.')
        return
      }
      if (!rawTranscript.trim()) {
        toast.error('Transcript is empty.')
        return
      }
      // For local provider, no cloud-session resolution is needed.
      if (isLocalProvider()) {
        await runWithSession(rawTranscript, null)
        return
      }
      try {
        const session = await autoResolveSession()
        if (!session) {
          toast.error('No cloud API key configured. Add one in the Settings tab.')
          return
        }
        await runWithSession(rawTranscript, session)
      } catch (err) {
        handlePipelineError(err)
      }
      } finally {
        startingRunRef.current = false
      }
    },
    [apiKeyMissing, handlePipelineError, runWithSession]
  )

  /** Step 1 of the two-step continue flow: capture DM answers and route the
   *  user to the OutputPicker. Replaces the old "submit DM answers → run
   *  Phase 3+5+4 unconditionally" shortcut. Sequenced so the picker can
   *  surface only AFTER the user has had a chance to provide DM context
   *  (which Phase 3 / 4 both consume). */
  const dmAnswersReceived = useCallback(
    (dmAnswers: DMAnswers) => {
      actions.setDMAnswers(dmAnswers)
      actions.setStatus('awaiting_outputs')
    },
    [actions],
  )

  /** Step 2: dispatch the run with the picked output selection. Conditional
   *  per-phase — only the selected phases call the model, so unchecking a
   *  box genuinely saves tokens. Phase 6 (Condensed) implicitly requires
   *  Phase 3 (Chronicle) because the condense prompt consumes the chronicle
   *  text; the picker UI enforces this so we can trust the selection here. */
  const continueWithSelectedOutputs = useCallback(
    async (dmAnswers: DMAnswers, selection: OutputSelection) => {
      if (!state.groundedTranscript) {
        toast.error('No grounded transcript yet.')
        return
      }
      if (!selection.chronicle && !selection.extras && !selection.condensed) {
        toast.error('Select at least one output.')
        return
      }
      // Persist the selection for both this run (state.outputSelection so
      // the checkpoint captures it for resume) and across-run defaults
      // (localStorage so the user's next run pre-fills the picker).
      actions.setOutputSelection(selection)
      setPersistedSelection(selection)

      setRunning(true)
      const ctrl = new AbortController()
      abortRef.current = ctrl

      const session = sessionRef.current
      const personaTemplates = resolvePersonaTemplates(personasRef.current)
      const runSettings = await fetchRunSettings()
      try {
        let chronicle = ''
        // ---- Phase 3 + Phase 5 (Chronicle + Polish) ----
        if (selection.chronicle) {
          const rawChronicle = await runPhase3({
            groundedTranscript: state.groundedTranscript,
            dmQuestions: state.dmQuestions,
            dmAnswers,
            kb,
            callbacks: { ...callbacks, signal: ctrl.signal },
            ...sessionPhaseArgs(session, 'phase3'),
            personaTemplates: personaTemplates.phase3,
            safetyMultiplier: () => safetyMultiplierRef.current,
            retrieveVaultKb: runSettings.retrieveVaultKb,
            aliasIndex: await getAliasIndex(),
          })
          actions.completePhase3(rawChronicle)
          // Phase 5 (Polish) is a no-op pass-through for cloud, a smoothing
          // pass for local. Either way, only run it when Chronicle was
          // generated — there's nothing to polish otherwise.
          const polished = await runPhase5Polish({
            chronicle: rawChronicle,
            kb,
            callbacks: { ...callbacks, signal: ctrl.signal },
            personaTemplate: personaTemplates.phase5,
            safetyMultiplier: () => safetyMultiplierRef.current,
          })
          chronicle = polished
          if (polished !== rawChronicle) {
            actions.completePhase3(polished)
          }
        }

        // ---- Phase 4 (Extras) ----
        // Independent of Phase 3 — operates on groundedTranscript + dmAnswers.
        // Confirmed in the exploration audit (pipeline.ts:1067-1082).
        if (selection.extras) {
          const extras = await runPhase4({
            kb,
            groundedTranscript: state.groundedTranscript,
            dmAnswers,
            callbacks: { ...callbacks, signal: ctrl.signal },
            ...sessionPhaseArgs(session, 'phase4'),
            safetyMultiplier: () => safetyMultiplierRef.current,
            thinkingOn: runSettings.perPhaseThinking.phase4,
            reassembleQuotes: runSettings.reassembleQuotes,
          })
          actions.completePhase4(extras)
        }

        // ---- Phase 6 (Condense) ----
        // Depends on Chronicle. The picker enforces selection.chronicle
        // is true whenever selection.condensed is true, so this assertion
        // is defense-in-depth.
        if (selection.condensed && chronicle.trim()) {
          // v1.1.0 Condense Slider — target word count computed from the
          // actual generated chronicle (not the grounded-transcript
          // estimate the picker showed) so the user's % choice resolves
          // against truth at runtime.
          const condensed = await runPhase6({
            chronicle,
            kb,
            dmAnswers,
            campaign,
            sessionNumber,
            callbacks: { ...callbacks, signal: ctrl.signal },
            ...sessionPhaseArgs(session, 'phase6'),
            personaTemplates: personaTemplates.phase6,
            safetyMultiplier: () => safetyMultiplierRef.current,
            thinkingOn: runSettings.perPhaseThinking.phase6,
            retrieveVaultKb: runSettings.retrieveVaultKb,
            aliasIndex: await getAliasIndex(),
            targetWordCount: computeCondenseTarget(countWords(chronicle), selection.condensePercentage),
          })
          actions.completePhase6(condensed)
          const targetForWarning = computeCondenseTarget(countWords(chronicle), selection.condensePercentage)
          warnIfCondenseShort(condensed)
          warnIfCondenseOvershoot(condensed, targetForWarning)
        }

        actions.markRunComplete()
        clearActiveCheckpoint()
        toast.success('Refinement complete!')
      } catch (err) {
        handlePipelineError(err)
      } finally {
        setRunning(false)
        abortRef.current = null
      }
    },
    [
      actions,
      callbacks,
      campaign,
      clearActiveCheckpoint,
      handlePipelineError,
      kb,
      sessionNumber,
      setPersistedSelection,
      state.dmQuestions,
      state.groundedTranscript,
    ],
  )

  /** Dispatch a resumed run for a phase that was paused mid-execution.
   *  Lives next to runWithSession + continueFromPhase3 because it shares
   *  their callbacks + abort + session shape — just primed with the
   *  checkpoint's startChunkIndex / priorPartial / priorExtras so the
   *  phase function picks up at the exact chunk the pause stopped at,
   *  rather than re-running chunks already in the accumulator.
   *
   *  An earlier implementation noted that
   *  "mid-chunk auto-continuation is a follow-up — for now resume
   *  restores state and the user manually re-triggers the next phase."
   *  But Phase 1 has no manual re-trigger UI (Continue only shows for
   *  awaiting_dm), so resume was effectively dead for Phase 1. This
   *  closes that gap by wiring the existing planResumeAction() planner
   *  (already fully tested in resumeFlow.test.ts but until now never
   *  imported in production) into a real dispatcher.  */
  const runFromResumeAction = useCallback(
    async (checkpoint: RunCheckpoint, action: ResumeAction) => {
      vlog('resume', {
        event: 'runFromResumeAction_start',
        runId: checkpoint.runId,
        action,
        checkpointRouting: checkpoint.routing,
      })
      setRunning(true)
      setRetryState(null)
      // Reuse the checkpoint's runId so a subsequent pause overwrites
      // the same on-disk file instead of orphaning a second checkpoint.
      currentRunIdRef.current = checkpoint.runId
      const ctrl = new AbortController()
      abortRef.current = ctrl

      // Resume honors the user's CURRENT Active Provider — if they hit
      // a Free-tier quota at pause and switched to Paid, the resumed
      // chunks dispatch to the Paid key. Two sessions are built:
      //
      //   - originalSession (dry-run from checkpoint.routing): used ONLY
      //     to compute the chunk size that the paused run was using, so
      //     chunk boundaries stay aligned even when the user switched
      //     tier (Free → Paid changes per-tier chunk size in chunking.ts).
      //     dryRun=true ensures this read doesn't overwrite the user's
      //     current Active Provider as a side effect of buildSession.
      //   - session (live, from current routing): the dispatch target.
      //     This is what hits the cloud API for chunks N..end.
      let session: RunSession | null = null
      let originalSession: RunSession | null = null
      const currentRouting = await getRouting()
      const dispatchProvider = currentRouting.lastSelectedProvider
      if (!isLocalProvider()) {
        if (!dispatchProvider) {
          toast.error(
            'Cannot resume: no Active Provider set. Pick one in Settings, then click Resume again.',
          )
          setRunning(false)
          return
        }
        try {
          session = await buildSession(dispatchProvider, {
            geminiTier: currentRouting.geminiTier,
          })
          sessionRef.current = session
          surfaceSessionWarnings(session)
        } catch (err) {
          handlePipelineError(err, { label: 'Resume — buildSession (dispatch)' })
          setRunning(false)
          return
        }
        // Compute the paused-run's chunk size for the resumed phase.
        // dryRun=true so this side-effect-free read doesn't overwrite
        // the user's current Active Provider with the checkpoint's.
        const originalProvider = checkpoint.routing.lastSelectedProvider
        if (originalProvider) {
          try {
            originalSession = await buildSession(originalProvider, {
              geminiTier: checkpoint.routing.geminiTier,
              routingOverride: checkpoint.routing,
              dryRun: true,
            })
          } catch (err) {
            // Best-effort — if the checkpoint's provider can't be
            // re-resolved (e.g. its profile was deleted), fall back to
            // the current session's chunk size and accept potential
            // boundary drift. Loud-log so we know.
            console.warn(
              '[resume] could not rebuild originalSession; chunk boundaries may drift:',
              err,
            )
          }
        }
        // Notify if dispatch and original providers differ — the user
        // explicitly switched and should see we noticed.
        if (
          originalProvider &&
          (originalProvider !== dispatchProvider ||
            (checkpoint.routing.geminiTier ?? 'auto') !== (currentRouting.geminiTier ?? 'auto'))
        ) {
          toast.info(
            `Resuming with current Active Provider (${dispatchProvider}` +
              `${currentRouting.geminiTier ? ` / ${currentRouting.geminiTier}` : ''})` +
              ` instead of the paused-run's (${originalProvider}` +
              `${checkpoint.routing.geminiTier ? ` / ${checkpoint.routing.geminiTier}` : ''})` +
              `. Chunk boundaries from the original run are preserved.`,
          )
        }
      }

      const rawTranscript = checkpoint.refinementState.rawTranscript
      const personaTemplates = resolvePersonaTemplates(personasRef.current)
      // Load settings ONCE at the top so per-phase thinking overrides
      // are available to ALL branches below (Phase 1/2/3/4/6 resumes).
      const runSettings = await fetchRunSettings()

      try {
        // Phase 1 resume: continue grounding, then chain into Phase 2
        // (which lands the user at awaiting_dm — same shape as a fresh
        // runWithSession after Phase 2).
        if (action.phase === 1) {
          // Resume path: re-read run settings. The pre-pause run may have
          // truncated the transcript via dev test mode; if the user has
          // since toggled the setting OFF, this resume will run on the
          // SAME truncated content that already exists in state (the
          // store was updated with the truncated value at the original
          // run start). When the setting was OFF before AND is OFF now,
          // no truncation happens — full transcript.
          const grounded = await runPhase1({
            rawTranscript,
            kb,
            callbacks: { ...callbacks, signal: ctrl.signal },
            ...sessionPhaseArgs(session, 'phase1'),
            disableThinkingOnGrounding: runSettings.disableThinkingOnGrounding,
          phase1AliasHints: runSettings.phase1AliasHints,
            // Force the original chunk size when available so chunk
            // boundaries align with the run that was paused, even
            // though dispatch goes to the (possibly switched) current
            // routing.
            chunkSizeChars: originalSession
              ? chunkSizeForSessionPhase(originalSession, 'phase1')
              : undefined,
            startChunkIndex: action.startChunkIndex,
            priorPartial: action.priorPartial,
            safetyMultiplier: () => safetyMultiplierRef.current,
            // K.1.2 / B2 — feed the prep snapshot (if present in the
            // checkpoint) so runPhase1 skips cleanup/preGround/detach
            // and re-uses the exact chunk boundaries captured at pause.
            // When the snapshot is absent (older checkpoint or pause
            // before first chunk), runPhase1 falls back to recomputing
            // from rawTranscript, which is invariant across sessions.
            inputSnapshot: checkpoint.inputSnapshot,
            // Stash the snapshot the resumed run uses, so a subsequent
            // pause re-saves it into the next checkpoint. On the
            // snapshot-restore path runPhase1 won't fire this callback —
            // the existing snapshot stays in the ref untouched.
            onInputSnapshot: (snapshot) => {
              phase1InputSnapshotRef.current = snapshot
            },
          })
          // Resume re-uses the SAME runFingerprint the checkpoint carried.
          // The fingerprint protects the chunk boundaries; once we've
          // committed to honouring the saved snapshot the live inputs
          // don't matter for boundary alignment anymore.
          if (checkpoint.runFingerprint) {
            runFingerprintRef.current = checkpoint.runFingerprint
          }
          // If the checkpoint had a snapshot, hydrate the ref from it so
          // a subsequent pause without further chunks (e.g. user clicks
          // Halt immediately after Resume) still persists the snapshot.
          if (checkpoint.inputSnapshot) {
            phase1InputSnapshotRef.current = checkpoint.inputSnapshot
          }
          actions.completePhase1(grounded)
          if (action.afterPhases.includes(2)) {
            const questions = await runPhase2({
              kb,
              rawTranscript,
              groundedTranscript: grounded,
              callbacks: { ...callbacks, signal: ctrl.signal },
              ...sessionPhaseArgs(session, 'phase2'),
              safetyMultiplier: () => safetyMultiplierRef.current,
            })
            actions.completePhase2(questions)
            toast.success(`Phase 2 complete — ${questions.length} clarifications surfaced.`)
          }
        }
        // Phase 3 resume: continue chronicle, then chain Phase 5 (polish,
        // local-only no-op for cloud), Phase 4 (extras), and/or Phase 6
        // (condense) — whichever the saved selection includes.
        else if (action.phase === 3) {
          const dmAnswers = checkpoint.refinementState.dmAnswers
          const groundedTranscript = checkpoint.refinementState.groundedTranscript ?? ''
          const dmQuestions = checkpoint.refinementState.dmQuestions ?? []
          const rawChronicle = await runPhase3({
            groundedTranscript,
            dmQuestions,
            dmAnswers,
            kb,
            callbacks: { ...callbacks, signal: ctrl.signal },
            ...sessionPhaseArgs(session, 'phase3'),
            chunkSizeChars: originalSession
              ? chunkSizeForSessionPhase(originalSession, 'phase3')
              : undefined,
            startChunkIndex: action.startChunkIndex,
            priorPartial: action.priorPartial,
            personaTemplates: personaTemplates.phase3,
            safetyMultiplier: () => safetyMultiplierRef.current,
            retrieveVaultKb: runSettings.retrieveVaultKb,
            aliasIndex: await getAliasIndex(),
          })
          actions.completePhase3(rawChronicle)
          let finalChronicle = rawChronicle
          if (action.afterPhases.includes(5)) {
            const chronicle = await runPhase5Polish({
              chronicle: rawChronicle,
              kb,
              callbacks: { ...callbacks, signal: ctrl.signal },
              personaTemplate: personaTemplates.phase5,
              safetyMultiplier: () => safetyMultiplierRef.current,
            })
            if (chronicle !== rawChronicle) actions.completePhase3(chronicle)
            finalChronicle = chronicle
          }
          if (action.afterPhases.includes(4)) {
            const extras = await runPhase4({
              kb,
              groundedTranscript,
              dmAnswers,
              callbacks: { ...callbacks, signal: ctrl.signal },
              ...sessionPhaseArgs(session, 'phase4'),
              safetyMultiplier: () => safetyMultiplierRef.current,
              thinkingOn: runSettings.perPhaseThinking.phase4,
              reassembleQuotes: runSettings.reassembleQuotes,
            })
            actions.completePhase4(extras)
          }
          if (action.afterPhases.includes(6) && finalChronicle.trim()) {
            const condensed = await runPhase6({
              chronicle: finalChronicle,
              kb,
              dmAnswers,
              campaign,
              sessionNumber,
              callbacks: { ...callbacks, signal: ctrl.signal },
              ...sessionPhaseArgs(session, 'phase6'),
              personaTemplates: personaTemplates.phase6,
              safetyMultiplier: () => safetyMultiplierRef.current,
              thinkingOn: runSettings.perPhaseThinking.phase6,
            retrieveVaultKb: runSettings.retrieveVaultKb,
            aliasIndex: await getAliasIndex(),
              targetWordCount: computeCondenseTarget(countWords(finalChronicle), state.outputSelection.condensePercentage),
            })
            actions.completePhase6(condensed)
            const targetForWarning = computeCondenseTarget(countWords(finalChronicle), state.outputSelection.condensePercentage)
            warnIfCondenseShort(condensed)
            warnIfCondenseOvershoot(condensed, targetForWarning)
          }
          actions.markRunComplete()
          clearActiveCheckpoint()
          toast.success('Refinement complete!')
        }
        // Phase 4 resume: continue extras from the partial accumulator
        // (priorExtras). With selectable outputs, a paused Phase-4 run
        // could still have Phase 6 (Condense) ahead of it if the user
        // had selected `extras + condensed` (which implies chronicle ran
        // before the pause). action.afterPhases reflects that selection.
        else if (action.phase === 4) {
          const dmAnswers = checkpoint.refinementState.dmAnswers
          const groundedTranscript = checkpoint.refinementState.groundedTranscript ?? ''
          const savedChronicle = checkpoint.refinementState.chronicle ?? ''
          const extras = await runPhase4({
            kb,
            groundedTranscript,
            dmAnswers,
            callbacks: { ...callbacks, signal: ctrl.signal },
            ...sessionPhaseArgs(session, 'phase4'),
            chunkSizeChars: originalSession
              ? chunkSizeForSessionPhase(originalSession, 'phase4')
              : undefined,
            startChunkIndex: action.startChunkIndex,
            priorExtras: action.priorExtras,
            safetyMultiplier: () => safetyMultiplierRef.current,
            thinkingOn: runSettings.perPhaseThinking.phase4,
            reassembleQuotes: runSettings.reassembleQuotes,
          })
          actions.completePhase4(extras)
          if (action.afterPhases.includes(6) && savedChronicle.trim()) {
            const condensed = await runPhase6({
              chronicle: savedChronicle,
              kb,
              dmAnswers,
              campaign,
              sessionNumber,
              callbacks: { ...callbacks, signal: ctrl.signal },
              ...sessionPhaseArgs(session, 'phase6'),
              personaTemplates: personaTemplates.phase6,
              safetyMultiplier: () => safetyMultiplierRef.current,
              thinkingOn: runSettings.perPhaseThinking.phase6,
            retrieveVaultKb: runSettings.retrieveVaultKb,
            aliasIndex: await getAliasIndex(),
              targetWordCount: computeCondenseTarget(countWords(savedChronicle), state.outputSelection.condensePercentage),
            })
            actions.completePhase6(condensed)
            const targetForWarning = computeCondenseTarget(countWords(savedChronicle), state.outputSelection.condensePercentage)
            warnIfCondenseShort(condensed)
            warnIfCondenseOvershoot(condensed, targetForWarning)
          }
          actions.markRunComplete()
          clearActiveCheckpoint()
          toast.success('Refinement complete!')
        }
        // Phase 2 / Phase 6: 'restart' kinds — fall through, the user
        // re-triggers them manually (Phase 2 only happens as a follow-up
        // to Phase 1; Phase 6 condense is opt-in from the chronicle card).
      } catch (err) {
        handlePipelineError(err)
      } finally {
        setRunning(false)
        abortRef.current = null
      }
    },
    [actions, callbacks, clearActiveCheckpoint, handlePipelineError, kb, surfaceSessionWarnings],
  )

  // Broadcast whether a run is in flight. The app shell listens and marks
  // the document root, which lets the ambient background react to real
  // pipeline state instead of animating identically whether the app is
  // idle or three phases deep. Purely decorative — nothing reads it back.
  useEffect(() => {
    const running = isRunningPhaseId(state.status)
    document.documentElement.dataset.pipeline = running ? 'running' : 'idle'
    return () => {
      delete document.documentElement.dataset.pipeline
    }
  }, [state.status])

  // Cancel in-flight on unmount
  useEffect(
    () => () => {
      abortRef.current?.abort()
    },
    []
  )

  // Hand-off from Sessions tab: someone clicked "Send to Refinement" on
  // a processed upload. We pre-fill the transcript so the user can hit
  // Run immediately.
  useEffect(() => {
    function onLoad(e: Event) {
      const detail = (e as CustomEvent).detail as { text?: string } | undefined
      if (detail?.text) {
        // Sessions / Upload hand off the raw .sbv, timestamp lines and all.
        // App.tsx's twin listener converts before persisting; this one has to
        // agree or the two disagree about what the transcript is. It matters
        // more now than it used to: this component stays mounted across tab
        // switches, so this listener runs on the hand-off path that used to
        // reach only App.tsx, and state beats the localStorage write.
        const incoming = isSbv(detail.text) ? sbvToText(detail.text) : detail.text
        actions.setRawTranscript(incoming)
        toast.message('SBV loaded from session — ready to run.')
        // The transcript arrived pre-loaded, so step 1 is already done:
        // land the user on the Run step (rail + estimate + button).
        requestAnimationFrame(() => {
          document
            .getElementById('chronicle-run-step')
            ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        })
      }
    }
    window.addEventListener('sbts:load-transcript', onLoad)
    return () => window.removeEventListener('sbts:load-transcript', onLoad)
  }, [actions])

  // A reforge finished — its outputs become the chronicle on screen.
  //
  // The Reforge panel sits on this same tab, so this component is mounted and
  // its state, not localStorage, is what the view reads. App.tsx persists the
  // same detail for the case where it is not; whichever writes last writes the
  // same thing.
  useEffect(() => {
    function onReforged(e: Event) {
      const d = (e as CustomEvent).detail as ReforgeCompleteDetail | undefined
      if (!d) return
      // The transcript rides along so the run stays re-reforgeable and the
      // repair panel keeps its source; the raw transcript is not carried
      // because a reforge never had one. See refinementStateFromReforge.
      actions.hydrate(refinementStateFromReforge(d))
      toast.success('Chronicle updated with the reforged output.')
      requestAnimationFrame(() => {
        document.getElementById('chronicle-run-step')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      })
    }
    window.addEventListener(REFORGE_COMPLETE_EVENT, onReforged)
    return () => window.removeEventListener(REFORGE_COMPLETE_EVENT, onReforged)
  }, [actions])

  const { condensing, runCondense, generatingExtras, runExtrasOnly } = useFollowUpPhases({
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
  })

  const handleRepairRefusal = useRefusalRepair({ actions, kb, stateRef })

  /** "Halt pipeline" / user-initiated pause. Aborts the in-flight fetch
   *  FIRST so no further chunk_done events can fire during the write
   *  window, then writes a `pausedReason: 'user'` checkpoint of the
   *  live state. K.1.3 / W1 fix: pre-K.1.3 the order was reversed
   *  (write-then-abort), which let an in-flight chunk complete during
   *  writeCheckpoint's getRouting() round-trip and land state mutations
   *  the persisted checkpoint never captured. Delegated to cancelRun
   *  in src/features/pipeline/lib/cancelFlow.ts so the ordering invariant is unit-testable
   *  without mounting this component. */
  const cancel = async () => {
    await cancelRun({
      abortRef,
      writeCheckpoint: writeCheckpointRef.current,
    })
  }

  const writeCheckpoint = useCheckpointWriter({
    stateRef,
    campaignRef,
    sessionNumberRef,
    runFingerprintRef,
    phase1InputSnapshotRef,
    safetyMultiplierRef,
    currentRunIdRef,
    setResumeBannerKey,
    writeCheckpointRef,
  })

  // Triggers a markdown download of whatever pipeline state we have so
  // far. Tolerant of phase-1-only stops (renders the grounded transcript)
  // and post-chronicle stops (uses the full markdown builder).
  const exportPartial = useCallback(() => {
    const md = buildPartialMarkdown({ ...state, campaign, sessionNumber })
    const fname = `${campaign || 'session'}-${sessionNumber}-partial.md`
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .toLowerCase()
    downloadMarkdownFile(fname, md)
  }, [campaign, sessionNumber, state])

  const handleRateLimitChoice = useRateLimitChoice({
    setRateLimitDialog,
    abortRef,
    exportPartial,
    safetyMultiplierRef,
    writeCheckpoint,
    settleInFlight,
  })

  /** Resume a paused run from its on-disk checkpoint. Hydrates state,
   *  then auto-dispatches the right phase function with the saved
   *  startChunkIndex + priorPartial via planResumeAction. Before this
   *  was wired up, Resume hydrated state and then did nothing — the
   *  user appeared stuck on the same chunk because no chunks were
   *  actually firing. The "Continue from the chronicle card" toast
   *  was misleading: that Continue button only exists for awaiting_dm
   *  (between Phases 2 and 3), so Phase 1 / 3 / 4 resumes had no UI
   *  affordance to actually continue. */
  const resumeFromCheckpoint = useCallback(
    async (runId: string) => {
      try {
        const checkpoint = await loadRun(runId)
        if (!checkpoint) {
          toast.error('Checkpoint not found.')
          return
        }
        if (checkpoint.schemaVersion !== CHECKPOINT_SCHEMA_VERSION) {
          toast.error(
            `Checkpoint is from an older version (v${checkpoint.schemaVersion}). Export the partial output and delete it.`,
          )
          return
        }
        actions.hydrate(checkpoint.refinementState)
        safetyMultiplierRef.current = checkpoint.safetyMultiplier
        currentRunIdRef.current = runId
        // K.1.2 / B2 — fingerprint drift detection. If the checkpoint
        // carries a fingerprint, compare it against a freshly-computed
        // one over the current glossary / alias index / transcript /
        // toggle state. A mismatch means the user edited inputs between
        // pause and resume; surface a warning so they know the resumed
        // run will use the snapshot's chunk boundaries (saved at pause
        // time) rather than the live state. Phase 1 with a saved
        // inputSnapshot is fully protected — the snapshot wins. Phase 1
        // without a snapshot (paused before first chunk) WILL see drift
        // if the glossary changed; the warning gives the user a chance
        // to cancel and re-paste the transcript instead.
        if (checkpoint.runFingerprint && checkpoint.progress.phase === 1) {
          try {
            const runSettings = await fetchRunSettings()
            const liveFingerprint = await computeRunFingerprint({
              rawTranscript: checkpoint.refinementState.rawTranscript,
              glossary: await getGlossary(),
              aliasIndex: runSettings.phase1AliasHints ? await getAliasIndex() : null,
              phase1AliasHints: runSettings.phase1AliasHints,
            })
            if (liveFingerprint && liveFingerprint !== checkpoint.runFingerprint) {
              const protectedBySnapshot = !!checkpoint.inputSnapshot
              toast.warning(
                protectedBySnapshot
                  ? 'Glossary or alias-index has changed since this run was paused. ' +
                      'Resume will use the chunk boundaries captured at pause time — ' +
                      'glossary edits will NOT apply to chunks already dispatched.'
                  : 'Glossary or alias-index has changed since this run was paused, ' +
                      'and the pause happened before the first chunk completed (no snapshot saved). ' +
                      'The resumed run will re-chunk against the LIVE glossary — ' +
                      'consider discarding this run and starting fresh.',
                { duration: 16_000 },
              )
              vlog('resume', {
                event: 'fingerprint_mismatch',
                checkpointFingerprint: checkpoint.runFingerprint,
                liveFingerprint,
                protectedBySnapshot,
              })
            }
          } catch (err) {
            // Fingerprint comparison is best-effort. A failure here must
            // not block the resume — log and continue.
            console.warn('[resume] fingerprint comparison failed:', err)
          }
        }
        const action = planResumeAction(checkpoint)
        toast.success(
          `Resumed: ${checkpoint.refinementState.campaign || 'session'} #${checkpoint.refinementState.sessionNumber} — ` +
            `${action.kind === 'continue' ? 'continuing' : 'restarting'} Phase ${action.phase} at chunk ${action.startChunkIndex + 1}.`,
        )
        if (action.parseError) {
          // B1 fix surface: the in-progress Phase 4 extras accumulator
          // (refinementState.partialOutput) couldn't be JSON.parsed —
          // torn write, hand-edit, or schema mismatch. The resume will
          // continue at the saved chunk index but with an empty extras
          // accumulator, meaning every chunk completed before the pause
          // is lost. Surface this loudly rather than silently dropping
          // the chunks like the pre-K.1.1 behaviour.
          toast.warning(
            `Phase 4 partial extras unreadable — resuming from saved chunk with empty extras. Up to ${action.startChunkIndex} chunk(s) of extras content was lost.`,
            { duration: 12_000 },
          )
        }
        setResumeBannerKey((k) => k + 1)
        // Dispatch the resumed run. The 'restart' kinds (Phase 2 + Phase 6)
        // are intentionally not auto-dispatched today — Phase 2 is reached
        // via the runPhase1 -> runPhase2 chain inside runFromResumeAction
        // when the resume started at Phase 1, and Phase 6 is opt-in from
        // the chronicle card.
        if (action.kind === 'continue') {
          await runFromResumeAction(checkpoint, action)
        }
      } catch (err) {
        toast.error(`Resume failed: ${(err as Error).message}`)
      }
    },
    [actions, runFromResumeAction],
  )

  // Dialog renders to a Radix Portal (body), so as long as it's mounted
  // anywhere in the tree it surfaces. Defined once and tacked onto every
  // return branch so quota_exhausted opens it regardless of which phase
  // is currently rendering.
  const rateLimitDialogEl = (
    <RateLimitDialog
      open={rateLimitDialog !== null}
      quotaKind={rateLimitDialog?.quotaKind ?? 'rate_limit'}
      phaseLabel={rateLimitDialog?.phaseLabel}
      paidKeyAvailable={paidKeyAvailable}
      activeTier={rateLimitDialog?.activeTier ?? 'auto'}
      provider={rateLimitDialog?.provider ?? 'gemini'}
      model={rateLimitDialog?.model}
      keyFingerprint={rateLimitDialog?.keyFingerprint}
      requestsInLastMinute={rateLimitDialog?.requestsInLastMinute}
      rpmCap={rateLimitDialog?.rpmCap}
      tpmCap={rateLimitDialog?.tpmCap}
      permanentlyOnFallback={rateLimitDialog?.permanentlyOnFallback ?? false}
      onChoose={handleRateLimitChoice}
      onClose={() => {
        setRateLimitDialog(null)
        abortRef.current?.abort()
      }}
    />
  )

  // ----- Render branches -----

  if (apiKeyMissing) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-5 w-5" />
            Gemini API key missing
          </CardTitle>
          <CardDescription>
            Create <code>.env</code> in the project root with{' '}
            <code>PAID_GEMINI_API_KEY=your_key</code> (preferred — Gemini 3.x
            requires a billing-enabled project) and restart{' '}
            <code>npm run dev</code>.
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  if (state.status === 'done' || state.status === 'phase6_condense') {
    return (
      <>
        <ChronicleView
          campaign={campaign}
          sessionNumber={sessionNumber}
          chronicle={state.chronicle}
          extras={state.extras}
          condensed={state.condensed}
          condensing={condensing}
          onCondense={runCondense}
          generatingExtras={generatingExtras}
          onGenerateExtras={runExtrasOnly}
          onReset={actions.reset}
          groundedTranscript={state.groundedTranscript}
          restoreEligible={getClaudeFailsafeEnabled() && geminiAvailableForRestore()}
          fallbacks={fallbacks}
          onApplyFallbackEdit={(index, edited) => {
            const rec = fallbacks[index]
            const current = stateRef.current.chronicle
            if (!rec?.replacementText || !current.includes(rec.replacementText)) {
              return {
                ok: false,
                reason:
                  "Couldn't locate this passage in the chronicle — it may be a grounding/extras fallback (reference only), or the text has since changed.",
              }
            }
            actions.completePhase3(current.replace(rec.replacementText, edited))
            setFallbacks((prev) =>
              prev.map((r, j) => (j === index ? { ...r, replacementText: edited } : r)),
            )
            return { ok: true }
          }}
          onChronicleRestored={(restoredChronicle, restoredExtras) => {
            actions.completePhase3(restoredChronicle)
            if (restoredExtras) actions.completePhase4(restoredExtras)
          }}
          refusals={state.refusals}
          onRepairRefusal={handleRepairRefusal}
        />
        {rateLimitDialogEl}
      </>
    )
  }

  if (state.status === 'awaiting_dm') {
    return (
      <>
        <Card>
          <CardHeader>
            <CardTitle>Awaiting DM clarifications</CardTitle>
            <CardDescription>
              Phase 2 surfaced {state.dmQuestions.length} question
              {state.dmQuestions.length === 1 ? '' : 's'}. Answer them to continue, or skip
              to the output picker without clarifications.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex gap-2">
            <Button onClick={() => dmAnswersReceived({})} variant="outline">
              Skip and continue
            </Button>
            <Button onClick={() => actions.setStatus('awaiting_dm')}>
              Open clarifications
            </Button>
          </CardContent>
        </Card>
        <DMQuestionsModal
          open
          questions={state.dmQuestions}
          initialAnswers={state.dmAnswers}
          onSubmit={dmAnswersReceived}
          onSkip={() => dmAnswersReceived({})}
        />
        {rateLimitDialogEl}
      </>
    )
  }

  if (state.status === 'awaiting_outputs') {
    // After DM answers (or skip), the user picks which downstream outputs
    // this run should produce. Saves tokens by avoiding phases the user
    // doesn't want. The picker uses the cross-run persisted selection as
    // its initial value so a returning user defaults to what they picked
    // last time.
    return (
      <>
        <OutputPicker
          initial={persistedSelection}
          onConfirm={(selection) =>
            void continueWithSelectedOutputs(state.dmAnswers, selection)
          }
          onBack={() => actions.setStatus('awaiting_dm')}
          estimatedChunks={state.totalChunks || undefined}
          // Best-available chronicle-length proxy at picker time: the
          // grounded transcript hasn't been narrated yet, so we scale it by
          // the measured chronicle:transcript ratio (see
          // CHRONICLE_TO_TRANSCRIPT_WORD_RATIO). Phase 6 recomputes the
          // actual target from the real chronicle word count at runtime.
          chronicleWordCountEstimate={estimateChronicleWords(countWords(state.groundedTranscript))}
        />
        {rateLimitDialogEl}
      </>
    )
  }

  if (isRunningPhaseId(state.status)) {
    // Partial export becomes available once Phase 1 has produced its
    // grounded transcript — earlier than that there's nothing useful to
    // export besides the raw input.
    const canExportPartial = state.groundedTranscript.trim().length > 0
    // Build the active-tier badge label from the current run's session
    // (sessionRef captures buildSession's output at runWithSession /
    // runFromResumeAction time). The label format mirrors the dialog so
    // a user comparing the two sees identical wording.
    const activeProviderLabel = (() => {
      const sess = sessionRef.current
      if (!sess) return undefined
      if (sess.provider !== 'gemini') return sess.provider
      const tier = sess.geminiTier ?? 'auto'
      return `gemini ${tier}`
    })()
    // The rail names every phase's model, so a phase differing from the
    // default is visible information rather than a dismissible warning —
    // the old override banner is retired. perPhaseOverrides stays on the
    // session (checkpoints carry it; resume compares against it).
    const sess = sessionRef.current
    const railLive = (() => {
      if (!sess) return undefined
      const key = state.status.split('_')[0] as
        | 'phase1' | 'phase2' | 'phase3' | 'phase4' | 'phase5' | 'phase6'
      const EXEC_ORDER = ['phase1', 'phase2', 'phase3', 'phase5', 'phase4', 'phase6'] as const
      const idx = EXEC_ORDER.indexOf(key as (typeof EXEC_ORDER)[number])
      const polishRuns = sess.phases.phase3.phaseTarget.target === 'local'
      const done: Partial<Record<(typeof EXEC_ORDER)[number], string>> = {}
      for (const p of EXEC_ORDER.slice(0, Math.max(0, idx))) {
        if (p === 'phase5' && !polishRuns) continue // skipped, not done
        done[p] = ''
      }
      const skipped: Partial<Record<(typeof EXEC_ORDER)[number], string>> = {}
      if (!state.outputSelection?.condensed && key !== 'phase6') {
        skipped.phase6 = 'not requested'
      }
      return {
        activePhase: key,
        activeNote: `chunk ${Math.min(state.currentChunkIndex + 1, state.totalChunks)} of ${state.totalChunks}`,
        done,
        skipped,
      }
    })()
    return (
      <>
        {devTruncation && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
            <strong>Dev test mode active.</strong>{' '}
            Transcript truncated from <strong>{devTruncation.originalChars.toLocaleString()}</strong>{' '}
            to <strong>{devTruncation.outputChars.toLocaleString()}</strong> chars before Phase 1.
            The full pipeline still runs end-to-end on this slice — the output below is NOT a complete
            chronicle of the original transcript. Disable in Settings → Dev test mode to run on the full input.
          </div>
        )}
        <PhaseProgress
          phase={state.status}
          currentChunkIndex={state.currentChunkIndex}
          totalChunks={state.totalChunks}
          countdownMs={state.countdownMs}
          partial={state.partialOutput}
          onCancel={running ? cancel : undefined}
          onExportPartial={canExportPartial ? exportPartial : undefined}
          activeProviderLabel={activeProviderLabel}
          session={sess}
          railLive={railLive}
        />
        {rateLimitDialogEl}
      </>
    )
  }

  if (state.status === 'error') {
    const errText = state.lastError ?? 'Unknown error.'
    const interrupted = errText === INTERRUPTED_RUN_MESSAGE
    return (
      <>
        {/* The checkpoint banner sat only on the idle view, so a run that
            stopped with work on disk — an auto-checkpointed failure, or a
            reload mid-run — told the user to resume from a banner they
            could only reach by pressing Reset first. It self-hides when
            there is nothing on disk, so it costs an error with no
            checkpoint nothing. */}
        <ResumeRunBanner key={resumeBannerKey} onResume={resumeFromCheckpoint} />
        <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-5 w-5" />
            {interrupted ? 'Run interrupted' : 'Pipeline error'}
          </CardTitle>
          <CardDescription>
            {interrupted
              ? 'The page was reloaded or closed while the pipeline was running, and a run cannot outlive its page. If it left a checkpoint, Resume above picks up at that chunk.'
              : 'The pipeline stopped. The full diagnostic below is safe to paste into Claude Code. Open the browser console (F12) for the raw SDK response object.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="relative">
            <Button
              variant="outline"
              size="sm"
              className="absolute right-2 top-2 z-10"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(errText)
                  toast.success('Error copied to clipboard')
                } catch {
                  toast.error('Clipboard write failed')
                }
              }}
            >
              <Copy className="mr-1 h-4 w-4" />
              Copy
            </Button>
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/50 p-4 pr-24 font-mono text-xs leading-relaxed">
              {errText}
            </pre>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => runFromPhase1(state.rawTranscript)}>
              <Play className="mr-1 h-4 w-4" />
              {interrupted ? 'Start again from Phase 1' : 'Retry from Phase 1'}
            </Button>
            <Button variant="outline" onClick={actions.reset}>
              <RotateCcw className="mr-1 h-4 w-4" />
              Reset
            </Button>
          </div>
        </CardContent>
        </Card>
      </>
    )
  }

  // idle
  // First run: no cloud key configured means nothing below can work.
  // One panel with one primary action replaces a form that could only
  // fail. (noCloudKeys is null while unknown — configured users see the
  // form instantly rather than a setup flash.)
  if (noCloudKeys === true) {
    return (
      <>
        <FirstRunPanel />
        {rateLimitDialogEl}
      </>
    )
  }
  // The Run button carries the estimate for THIS run — the active
  // routing, this transcript, this lore — not a preset comparison.
  const kbChars = kb.reduce((acc, d) => acc + d.text.length, 0)
  const runEstimate = (() => {
    if (!previewSession || state.rawTranscript.length === 0) return null
    const routing: Record<string, PricePhaseRouting> = {}
    const KEY_TO_ID: Record<string, string> = {
      phase1: 'phase1_ground',
      phase2: 'phase2_audit',
      phase3: 'phase3_chronicle',
      phase4: 'phase4_extras',
      phase6: 'phase6_condense',
    }
    for (const [key, id] of Object.entries(KEY_TO_ID)) {
      const ph = previewSession.phases[key as keyof typeof previewSession.phases]
      // Local phases bill nothing; leaving them out prices them at zero.
      if (ph.phaseTarget.target === 'local' || !ph.cloudProvider) continue
      routing[id] = { provider: ph.cloudProvider, tier: ph.geminiTier, model: ph.model }
    }
    if (Object.keys(routing).length === 0) return null
    return estimateRunCost({
      routing,
      transcriptChars: state.rawTranscript.length,
      kbChars,
      liveRates,
    })
  })()

  return (
    <>
      <ResumeRunBanner key={resumeBannerKey} onResume={resumeFromCheckpoint} />
      <Card>
        <CardHeader>
          <CardTitle>Chronicle a session</CardTitle>
          <CardDescription>
            {kb.length > 0 ? (
              <>
                Grounding against {kb.length} lore document{kb.length === 1 ? '' : 's'} (
                {fmtKbSize(kbChars)}).
              </>
            ) : (
              <span className="text-amber-600">
                No lore yet — chronicles still work, but names ground better with your notes.
                Add documents in the Tome of Lore tab.
              </span>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <ActiveProviderBanner />
          {retryState && <RetryBanner state={retryState} />}

          {/* Chronicle genuinely is a sequence — you cannot pick a voice for
              a transcript you have not loaded — so ordinals carry real
              information here (and only here). */}
          <section className="space-y-2">
            <h3 className="flex items-baseline gap-2 font-display text-xs uppercase tracking-wider text-muted-foreground">
              <span className="text-ember">01</span> Your transcript
            </h3>
            <TranscriptInput
              value={state.rawTranscript}
              onChange={actions.setRawTranscript}
              onRun={() => runFromPhase1(state.rawTranscript)}
              disabled={running}
              hideRunButton
            />
          </section>

          <section className="space-y-2">
            <h3 className="flex items-baseline gap-2 font-display text-xs uppercase tracking-wider text-muted-foreground">
              <span className="text-ember">02</span> How it should read
            </h3>
            <PersonaPicker />
          </section>

          <section id="chronicle-run-step" className="scroll-mt-4 space-y-2">
            <h3 className="flex items-baseline gap-2 font-display text-xs uppercase tracking-wider text-muted-foreground">
              <span className="text-ember">03</span> Run
            </h3>
            {previewSession && (
              <PhaseRail session={previewSession} onSelectPhase={() => openRoutingSurface()} />
            )}
            {state.rawTranscript.trim().length > 0 &&
              state.rawTranscript.trim().length < SHORT_TRANSCRIPT_CHARS && (
                <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
                  <strong>That looks too short for a session.</strong> A real transcript runs to
                  tens of thousands of characters; this one is{' '}
                  {state.rawTranscript.trim().length.toLocaleString()}. The run will still cost
                  {runEstimate && runEstimate.totalDollars > 0
                    ? ` about ${formatDollars(runEstimate.totalDollars)}`
                    : ' money'}
                  , because your lore is sent regardless of how little transcript there is.
                </p>
              )}
            <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
              <p className="text-xs text-muted-foreground">
                {runEstimate
                  ? 'Estimated for this transcript and routing — actual cost varies ~10–20%.'
                  : 'Load a transcript to see the estimated cost.'}
              </p>
              <Button
                data-slot="primary-cta"
                onClick={() => runFromPhase1(state.rawTranscript)}
                disabled={running || !state.rawTranscript.trim()}
                size="lg"
                className="font-display tracking-wider uppercase"
              >
                Begin the Chronicle
                {runEstimate && runEstimate.totalDollars > 0 && (
                  <span className="ml-2 font-sans text-xs font-normal normal-case opacity-90">
                    ~{formatDollars(runEstimate.totalDollars)}
                  </span>
                )}
              </Button>
            </div>
          </section>

          <details className="rounded-md border border-border/70 bg-card/30 p-3">
            <summary className="cursor-pointer text-sm font-medium">
              Compare plan costs
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                — what this transcript would cost on each Gemini plan.
              </span>
            </summary>
            <div className="reveal-on-open mt-3">
              <CostEstimatorCard
                transcriptChars={state.rawTranscript.length}
                kbChars={kbChars}
              />
            </div>
          </details>
        </CardContent>
      </Card>
      {rateLimitDialogEl}
    </>
  )
}

export { CONDENSE_FLOOR_WC, warnIfCondenseShort } from '../lib/condenseWarnings'
