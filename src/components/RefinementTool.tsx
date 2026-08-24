import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, Copy, Play, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { TranscriptInput } from './TranscriptInput'
import { PhaseProgress } from './PhaseProgress'
import { PhaseRail, openRoutingSurface, useSessionPreview } from './PhaseRail'
import { PersonaPicker } from './PersonaPicker'
import { FirstRunPanel, useNoCloudKeys } from './FirstRunPanel'
import { estimateRunCost, formatDollars, type PhaseRouting as PricePhaseRouting } from '@/lib/pricing'
import { buildLiveRateResolver, type LiveRateResolver } from '@/lib/liveRates'
import { getOpenRouterCatalogue } from '@/lib/openrouterModelsClient'
import { DMQuestionsModal } from './DMQuestionsModal'
import { ChronicleView } from './ChronicleView'
import { ActiveProviderBanner } from './ActiveProviderBanner'
import { RetryBanner, type RetryState } from './RetryBanner'
import { CostEstimatorCard } from './CostEstimatorCard'
import {
  RateLimitDialog,
  type QuotaKind,
  type RateLimitChoice,
} from './RateLimitDialog'
import { useLocalStorage } from '@/hooks/useLocalStorage'
import { useLoreDocuments } from '@/hooks/useLoreDocuments'
import { useRefinementState } from '@/hooks/useRefinementState'
import { LS_CAMPAIGN, LS_OUTPUT_SELECTION, LS_SESSION } from '@/lib/constants'
import { OutputPicker } from './OutputPicker'
import { hasApiKey } from '@/lib/gemini'
import { truncateAtLineBoundary } from '@/lib/devTruncate'
import {
  runPhase1,
  runPhase2,
  runPhase3,
  runPhase4,
  runPhase5Polish,
  runPhase6,
  buildKbConcat,
  type PipelineEvent,
} from '@/lib/pipeline'
import {
  repairRefusal,
  spliceProse,
  mergeQuestions,
  mergeExtras,
  type RepairContext,
} from '@/lib/repair'
import type { GeminiTier } from '@/lib/providers'
import { computeCondenseTarget, countWords } from '@/lib/wordCount'
import { isLocalProvider } from '@/lib/providers/settings'
import { PROVIDERS_CHANGED_EVENT, refreshProviders, type ProvidersChangedDetail } from '@/lib/providers'
import { vlog } from '@/lib/verboseLog'
import { extractSymbolFromError, requestBundle, shouldAutoCheckpointOnError } from '@/lib/diagnose'
import {
  autoResolveSession,
  buildSession,
  chunkSizeForSessionPhase,
  listConfiguredCloudKeys,
  type RunSession,
} from '@/lib/sessions'
import { fetchConfiguredCloudKeyOptions } from '@/lib/cloudKeys'
import { buildPartialMarkdown, downloadMarkdownFile } from '@/lib/exportMarkdown'
import { getRouting, putRouting } from '@/lib/routing'
import { saveChronicle, updateChronicle } from '@/lib/chronicleLibrary'
import { getClaudeFailsafeEnabled } from '@/lib/claudeFailsafe'
import { geminiAvailableForRestore } from '@/lib/restorePass'
import type { FallbackRecord, RefusalRecord } from '@/lib/refusalDetection'
import { genRefusalId } from '@/lib/refusalDetection'
import { emitActiveProviderChanged } from '@/lib/appEvents'
import { planResumeAction, type ResumeAction } from '@/lib/resumeFlow'
import { ResumeRunBanner } from './ResumeRunBanner'
import { deleteRun, loadRun, saveRun } from '@/lib/runStorage'
import {
  CHECKPOINT_SCHEMA_VERSION,
  type CheckpointPhaseId,
  type Phase1InputSnapshot,
  type RunCheckpoint,
} from '@/lib/runCheckpoint'
import { computeRunFingerprint } from '@/lib/runFingerprint'
import { getGlossary } from '@/lib/glossary'
import { getAliasIndex } from '@/lib/aliasIndexClient'
import { buildCheckpoint } from '@/lib/buildCheckpoint'
import { cancelRun } from '@/lib/cancelFlow'
import { fallbackToPaid } from '@/lib/fallbackFlow'
import { showCleanupToast, showPreGroundToast } from '@/lib/pipelineToasts'
import { findSelectedPersona, getPersonas, peekPersonas, subscribePersonas } from '@/lib/personas'
import type { PersonasDocument } from '@/lib/personas/types'
import {
  DEFAULT_OUTPUT_SELECTION,
  type CondenseOutput,
  type DMAnswers,
  type OutputSelection,
  type PhaseId,
  type PipelineStatus,
} from '@/types'

/** Phase 6 condense catastrophic-floor — the condense target is now dynamic
 *  (whichever is SHORTER of 2,000 words OR 25% of the chronicle word count;
 *  see `phase6CondenseParts` in `src/lib/prompts.ts`), so a fixed floor no
 *  longer makes sense. We keep a low absolute floor only to catch the case
 *  where the model produced almost nothing (≤ 200 wc) — that's a sign of an
 *  outright failure (truncated response, malformed JSON parsed empty), not
 *  the legitimate "short condense for a short chronicle" path. */
export const CONDENSE_FLOOR_WC = 200

/** v1.1.0 — symmetric overshoot ratio. If the model returns more than this
 *  multiple of the user's slider-picked target, fire a warning. Matched to
 *  the prompt's ±10% tolerance — a 1.5× output is 50% over and clearly off
 *  contract. Lower than 1.5 would false-positive on borderline cases (the
 *  model is trusted to interpret "approximately N words" liberally); much
 *  higher and the warning rarely fires on genuine overshoots. */
export const CONDENSE_OVERSHOOT_RATIO = 1.5

/** Surface a toast when Phase 6 condense output is catastrophically short.
 *  Called after every completePhase6() — the four call sites (happy path
 *  + two resume paths + the standalone runCondense button) all run this. */
export function warnIfCondenseShort(condensed: CondenseOutput | null | undefined): void {
  const narrative = condensed?.narrative ?? ''
  if (!narrative.trim()) return
  const wc = narrative.trim().split(/\s+/).filter(Boolean).length
  if (wc < CONDENSE_FLOOR_WC) {
    toast.warning(
      `Phase 6 condense produced only ${wc} words. Even a tiny chronicle should yield more than ` +
        `${CONDENSE_FLOOR_WC} words at any slider position. Likely cause: truncated model response, ` +
        'malformed JSON, or quota mid-flight. Regenerate Phase 6 from the chronicle card to retry.',
      { duration: 12_000 },
    )
  }
}

/** v1.1.0 — symmetric overshoot warning. Pairs with warnIfCondenseShort.
 *  The user picks a target word count via the Condense Slider; if the
 *  model returns >1.5× that target, we surface a toast so the user can
 *  rerun at a tighter slider position. Target=0 (legacy callers without
 *  a slider) disables the check. */
export function warnIfCondenseOvershoot(
  condensed: CondenseOutput | null | undefined,
  targetWordCount: number,
): void {
  if (targetWordCount <= 0) return
  const narrative = condensed?.narrative ?? ''
  if (!narrative.trim()) return
  const wc = narrative.trim().split(/\s+/).filter(Boolean).length
  if (wc > targetWordCount * CONDENSE_OVERSHOOT_RATIO) {
    const pct = Math.round((wc / targetWordCount) * 100)
    toast.warning(
      `Phase 6 condense returned ${wc.toLocaleString()} words — about ${pct}% of your chosen target ` +
        `(${targetWordCount.toLocaleString()} words). The model overshot the Condense Slider's ` +
        '±10% contract. You can rerun Phase 6 at a tighter slider position, or edit the output directly. ' +
        `This warning fires above ${Math.round(CONDENSE_OVERSHOOT_RATIO * 100)}% of the target.`,
      { duration: 12_000 },
    )
  }
}

/** Pulls the persona templates relevant to phases 3/5/6 out of the current
 *  personas document. Returns empty objects when the add-on is off or no
 *  persona is selected — the pipeline then falls back to the locked bard
 *  prompts. */
/** Pull the cross-cutting toggles that affect a pipeline run from
 *  /api/settings. Safe defaults on any fetch failure — these are all
 *  opt-in features, so a missing/unreadable settings file should never
 *  block a run, only forfeit the opt-in benefit. */
type PerPhaseThinking = { phase1?: boolean; phase2?: boolean; phase4?: boolean; phase6?: boolean }

async function fetchRunSettings(): Promise<{
  disableThinkingOnGrounding: boolean
  phase1AliasHints: boolean
  reassembleQuotes: boolean
  retrieveVaultKb: boolean
  perPhaseThinking: PerPhaseThinking
  devTestMode: { enabled: boolean; maxChars: number }
}> {
  const FALLBACK = {
    disableThinkingOnGrounding: false,
    phase1AliasHints: false,
    reassembleQuotes: false,
    retrieveVaultKb: false,
    perPhaseThinking: {} as PerPhaseThinking,
    devTestMode: { enabled: false, maxChars: 24000 },
  }
  try {
    const res = await fetch('/api/settings', { signal: AbortSignal.timeout(2000) })
    if (!res.ok) return FALLBACK
    const body = (await res.json()) as {
      disableThinkingOnGrounding?: boolean
      phase1AliasHints?: boolean
      reassembleQuotes?: boolean
      retrieveVaultKb?: boolean
      perPhaseThinking?: PerPhaseThinking
      devTestMode?: { enabled?: boolean; maxChars?: number }
    }
    return {
      disableThinkingOnGrounding: body.disableThinkingOnGrounding === true,
      phase1AliasHints: body.phase1AliasHints === true,
      reassembleQuotes: body.reassembleQuotes === true,
      retrieveVaultKb: body.retrieveVaultKb === true,
      perPhaseThinking: (body.perPhaseThinking ?? {}) as PerPhaseThinking,
      devTestMode: {
        enabled: body.devTestMode?.enabled === true,
        maxChars: typeof body.devTestMode?.maxChars === 'number' ? body.devTestMode.maxChars : 24000,
      },
    }
  } catch {
    return FALLBACK
  }
}

function resolvePersonaTemplates(doc: PersonasDocument) {
  const p = findSelectedPersona(doc)
  if (!p) return { phase3: undefined, phase5: undefined, phase6: undefined }
  return {
    phase3: { cloud: p.prompts.phase3Cloud, local: p.prompts.phase3Local },
    phase5: p.prompts.phase5Local,
    phase6: { cloud: p.prompts.phase6Cloud, local: p.prompts.phase6Local },
  }
}

// phase6_condense is intentionally absent — it is caught by the earlier
// `done || phase6_condense` render branch above, so it never reaches this check.
const PIPELINE_RUNNING_PHASES = new Set<PipelineStatus>([
  'phase1_ground', 'phase2_audit', 'phase3_chronicle', 'phase4_extras', 'phase5_polish',
])

function isRunningPhaseId(s: PipelineStatus): s is PhaseId {
  return PIPELINE_RUNNING_PHASES.has(s)
}

function fmtKbSize(chars: number): string {
  if (chars < 1024) return `${chars} chars`
  if (chars < 1024 * 1024) return `${(chars / 1024).toFixed(1)} KB`
  return `${(chars / (1024 * 1024)).toFixed(2)} MB`
}

/** Below this, a transcript is almost certainly a mistake — a stray
 *  keystroke or a failed paste. Real sessions run to tens of thousands of
 *  characters. Used only to warn; the run is never blocked. */
const SHORT_TRANSCRIPT_CHARS = 500

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

  // Auto-save a finished run to the Saved Chronicles library (server disk
  // store) so it can never be lost to a reload / dev-server restart /
  // browser-cache clear. Saves once on completion, then UPDATEs the same
  // record when extras / condensed are generated afterwards (tracked via
  // state.savedChronicleId). reset() clears savedChronicleId, so the next
  // run gets its own entry and the previous one stays on disk (auto-keep
  // both). Best-effort — a save failure surfaces a toast but never blocks.
  const chronicleSavingRef = useRef(false)
  useEffect(() => {
    if (state.status !== 'done') return
    if (!state.chronicle.trim()) return
    if (chronicleSavingRef.current) return
    let cancelled = false
    chronicleSavingRef.current = true
    void (async () => {
      try {
        const existingId = stateRef.current.savedChronicleId
        if (existingId) {
          await updateChronicle(existingId, {
            chronicle: state.chronicle,
            extras: state.extras ?? undefined,
            condensed: state.condensed ?? undefined,
            groundedTranscript: state.groundedTranscript || undefined,
            refusals: stateRef.current.refusals ?? undefined,
            dmQuestions: stateRef.current.dmQuestions ?? undefined,
            dmAnswers: stateRef.current.dmAnswers ?? undefined,
          })
        } else {
          let provider: string | undefined
          try {
            provider = (await getRouting()).lastSelectedProvider ?? undefined
          } catch {
            /* metadata only — fine to omit */
          }
          const saved = await saveChronicle({
            campaign,
            sessionNumber,
            provider,
            chronicle: state.chronicle,
            extras: state.extras ?? undefined,
            condensed: state.condensed ?? undefined,
            groundedTranscript: state.groundedTranscript || undefined,
            refusals: stateRef.current.refusals ?? undefined,
            dmQuestions: stateRef.current.dmQuestions ?? undefined,
            dmAnswers: stateRef.current.dmAnswers ?? undefined,
          })
          if (!cancelled) {
            actions.setSavedChronicleId(saved.id)
            toast.success('Chronicle saved to your library (Tome of Lore → Saved Chronicles).')
          }
        }
      } catch (err) {
        toast.error(`Couldn't auto-save the chronicle to your library: ${(err as Error).message}`)
      } finally {
        chronicleSavingRef.current = false
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status, state.chronicle, state.extras, state.condensed])
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
  const [cloudKeys, setCloudKeys] = useState<Array<unknown> | null>(null)
  const apiKeyMissing =
    !isLocalProvider() && cloudKeys !== null && cloudKeys.length === 0 && !hasApiKey()

  // Rate-limit dialog state. Opens when the provider emits quota_exhausted.
  // The multiplier lives in a ref so the dialog can flip it mid-run and the
  // chunk loop reads the latest value before each chunk's pacing.
  const safetyMultiplierRef = useRef<number>(1)
  const [rateLimitDialog, setRateLimitDialog] = useState<
    {
      quotaKind: QuotaKind
      phaseLabel: string
      // Verbose-dialog payload — every field is best-effort, the dialog
      // gracefully degrades when any is missing.
      provider: 'gemini' | 'claude' | 'openai' | 'local' | 'claudeCode' | 'codex' | 'openrouter'
      activeTier: 'free' | 'paid' | 'auto'
      model: string
      keyFingerprint?: string
      requestsInLastMinute?: number
      rpmCap?: number
      tpmCap?: number
      permanentlyOnFallback: boolean
    } | null
  >(null)
  const [paidKeyAvailable, setPaidKeyAvailable] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetchConfiguredCloudKeyOptions()
      .then((opts) => {
        if (!cancelled) setPaidKeyAvailable(opts.some((o) => o.id === 'gemini-paid'))
      })
      .catch(() => {
        if (!cancelled) setPaidKeyAvailable(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    listConfiguredCloudKeys()
      .then((c) => {
        if (!cancelled) setCloudKeys(c)
      })
      .catch(() => {
        if (!cancelled) setCloudKeys([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  const callbacks = useMemo(
    () => ({
      onEvent: (e: PipelineEvent) => {
        // Mirror every PipelineEvent into the verbose ring buffer so
        // window.__tusk.dumpRecentEvents() shows the full event timeline
        // even when no diagnostic toast fired. Cheap when verbose is off
        // (just a push to the bounded ring).
        vlog('pipeline', e)
        switch (e.type) {
          case 'phase_start':
            // Forward the optional resumed startChunkIndex so the UI
            // counter primes correctly instead of briefly showing
            // "chunk 1/N" while the loop is actually working on chunk N.
            actions.startPhase(e.phase, e.totalChunks, e.startChunkIndex ?? 0)
            break
          case 'chunk_done':
            actions.onChunkDone(e.index, e.partial)
            // A successful chunk means any pending retry resolved — drop
            // the banner so it doesn't linger past its useful life.
            setRetryState(null)
            break
          case 'countdown':
            actions.onCountdown(e.msRemaining)
            break
          case 'retry_waiting':
            // Provider hit a transient error and is pausing. Show the
            // countdown banner so the UI doesn't look hung.
            setRetryState({
              phase: e.phase,
              attempt: e.attempt,
              maxAttempts: e.maxAttempts,
              resumeAt: Date.now() + e.waitMs,
            })
            break
          case 'phase_complete':
            // handled by per-phase completion in runAll
            break
          case 'cleanup':
            showCleanupToast(e.report)
            break
          case 'pre_ground':
            showPreGroundToast(e.report)
            break
          case 'quota_exhausted':
            // Surface the dialog. The chunk loop continues retrying
            // internally; the user's choice either lets it keep going
            // (slow down / fallback) or aborts (stop / pause).
            // Carries the verbose payload (key fingerprint, recent-call
            // count, RPM/TPM caps, permanent-fallback flag) so the dialog
            // can produce specific advice instead of a generic message.
            setRateLimitDialog({
              quotaKind: e.quotaKind,
              phaseLabel: `${e.phase.replace('_', ' ')} — ${e.provider} ${e.tier}`,
              provider: e.provider,
              activeTier: e.tier,
              model: e.model,
              keyFingerprint: e.keyFingerprint,
              requestsInLastMinute: e.requestsInLastMinute,
              rpmCap: e.rpmCap,
              tpmCap: e.tpmCap,
              permanentlyOnFallback: e.permanentlyOnFallback ?? false,
            })
            break
          case 'auto_fallback':
            if (e.reason === 'claude_refusal') {
              // Claude Code refused/blanked a chunk. Always surface it in the
              // post-run review modal; ALSO persist a repairable RefusalRecord
              // when it was NOT auto-repaired in-run.
              setFallbacks((prev) => [
                ...prev,
                {
                  phase: e.phase,
                  chunkIndex: e.chunkIndex ?? 0,
                  transcriptExcerpt: e.transcriptExcerpt ?? '',
                  refusedText: e.refusedText ?? '',
                  replacementText: e.replacementText ?? '',
                },
              ])
              if (e.repaired) {
                toast.warning(
                  `Claude Code looked like it refused chunk ${(e.chunkIndex ?? 0) + 1} — ` +
                    `the failsafe redid it on Gemini. Review & ground it from the chronicle when the run finishes.`,
                )
              } else {
                // Unrepaired: marked in the document + recorded for targeted
                // repair. Persist via a ref-backed accumulator (avoids the
                // stale-closure race when multiple refusals fire in a row).
                const rec: RefusalRecord = {
                  id: e.refusalId ?? genRefusalId(),
                  phase: e.phase,
                  chunkIndex: e.chunkIndex ?? 0,
                  totalChunks: e.totalChunks ?? 0,
                  sourceSpan: e.transcriptExcerpt ?? '',
                  refusedText: e.refusedText ?? '',
                  marker: e.marker ?? '',
                  chunkSizeChars: e.chunkSizeChars,
                  repaired: false,
                  createdAt: new Date().toISOString(),
                }
                actions.appendRefusal(rec)
                toast.warning(
                  `Claude Code refused chunk ${(e.chunkIndex ?? 0) + 1} and it wasn't auto-repaired — ` +
                    `marked it in the output. Use “Review & Repair Refusals” after the run to restore it.`,
                )
              }
              break
            }
            toast.info(
              e.reason === 'hard_zero_quota'
                ? 'Switched to the fallback Gemini key (zero quota on the primary).'
                : e.reason === 'repeated_exhaustion'
                  ? 'Switched to the fallback Gemini key after repeated rate-limiting.'
                  : e.reason === 'free_prohibited_content'
                    ? `Free Gemini blocked chunk ${(e.chunkIndex ?? 0) + 1} as PROHIBITED_CONTENT; retrying on the Paid key.`
                    : `Free Gemini ${e.model ?? ''} was overloaded on chunk ${(e.chunkIndex ?? 0) + 1}; recovered via the Paid key.`,
            )
            break
          case 'chunk_fusion_recovered':
            // Layer B fusion fallback rescued the chunk by joining it with
            // chunk i-1 to dilute the meta-filter trigger. No content was
            // lost — let the user know rather than have them wonder if
            // something silently soft-skipped.
            toast.success(
              `Chunk ${e.chunkIndex + 1} hit a content filter — recovered by ` +
                `merging with the previous chunk's context. No data lost.`,
            )
            break
          case 'audit_skipped':
            // Diagnostic toast — surfaces the Phase 2 optimisation when it
            // actually fires. The user sees "saved N calls" rather than
            // wondering why Phase 2 was fast.
            toast.info(
              `Phase 2 audit skipped ${e.skippedChunks}/${e.totalChunks} chunks ` +
                `(grounded text was identical to raw — no clarifications to ask).`,
            )
            break
          case 'speaker_dropout':
            // Phase 1's speaker-detach optimisation lost > 15% of markers.
            // Surface so the user can opt out of detach on the next run if
            // attribution quality suffered.
            toast.warning(
              `Speaker attribution: ${(e.dropoutRate * 100).toFixed(0)}% of ` +
                `${e.sourceLines} lines lost their bracket during grounding. ` +
                `Consider running again without the speaker-detach optimisation if ` +
                `the chronicle attributes dialogue incorrectly.`,
            )
            break
          case 'tier_escalated':
            // The pipeline auto-escalated a Free-tier dispatch to Paid for
            // a paid-only model. Surface so the user understands why their
            // Free-tier run is touching Paid budget for this phase.
            toast.info(
              `${e.phase.replace('_', ' ')}: model "${e.model}" requires the Paid tier — ` +
                `this phase will dispatch to the Paid Gemini singleton for its chunks.`,
            )
            break
        }
      },
    }),
    [actions]
  )

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

  const handlePipelineError = useCallback(
    (err: unknown, opts?: { cancelMsg?: string; cancelStatus?: PipelineStatus; label?: string }) => {
      // The run either errored out (retry exhausted) or was aborted —
      // either way the banner is no longer meaningful.
      setRetryState(null)
      if ((err as Error).name === 'AbortError') {
        toast.info(opts?.cancelMsg ?? 'Refinement cancelled.')
        actions.setStatus(opts?.cancelStatus ?? 'idle')
        return
      }
      console.error(err)
      const msg = (err as Error).message
      actions.setError(msg)
      // Decide whether to auto-checkpoint. Returns 'daily_quota' for the
      // gemini.ts fast-fail marker, 'error' for any other mid-phase
      // failure with accumulated work, or null when there's nothing
      // worth preserving (e.g. failure before chunk 1 completes).
      // The principle: the user should NEVER lose in-progress work to
      // a transient or unattended-recovery failure. Checkpoint by
      // default; the Resume banner gives them a one-click retry.
      const checkpointReason = shouldAutoCheckpointOnError({
        err,
        currentPhase: state.currentPhase,
        currentChunkIndex: state.currentChunkIndex,
      })
      const isDailyQuota = checkpointReason === 'daily_quota'
      if (checkpointReason !== null) {
        const checkpointFn = writeCheckpointRef.current
        // Map the helper's reason into the checkpoint's persisted reason
        // set ('user' | 'quota' | 'error'). The helper distinguishes
        // 'daily_quota' for toast-copy branching above; on disk we collapse
        // it to 'quota' because the Resume banner only needs the broad
        // category.
        const persistedReason = checkpointReason === 'daily_quota' ? 'quota' : 'error'
        if (checkpointFn) {
          void checkpointFn(persistedReason).then((ok) => {
            if (ok) {
              if (isDailyQuota) {
                // Provider-specific quota copy. Claude Code exhaustion is a
                // subscription usage window (typically 5 h), not a daily
                // free-tier quota — telling the user to wait for midnight
                // UTC or buy a Gemini key would be wrong on both counts.
                const quotaMarked = err as Error & {
                  quotaProvider?: string
                  quotaResetsAt?: string | null
                }
                const phaseLabel = state.currentPhase?.replace('_', ' ') ?? 'this phase'
                if (quotaMarked.quotaProvider === 'claudeCode') {
                  const when = quotaMarked.quotaResetsAt
                    ? ` (expected around ${new Date(quotaMarked.quotaResetsAt).toLocaleTimeString()})`
                    : ''
                  toast.warning(
                    `Claude Code usage limit hit at ${phaseLabel} chunk ${state.currentChunkIndex}. ` +
                      `Run auto-paused — your progress is saved. ` +
                      `Resume from the banner when your usage window resets${when}.`,
                    { duration: 20_000 },
                  )
                } else {
                  toast.warning(
                    `Daily Free-tier quota hit at ${phaseLabel} chunk ${state.currentChunkIndex}. ` +
                      `Run auto-paused — your progress is saved. ` +
                      `Resume after midnight UTC, OR add a Paid Gemini key in Settings → API Keys.`,
                    { duration: 20_000 },
                  )
                }
              } else {
                // Generic recovery toast — applies to per-minute rate
                // limits, exhausted 5xx retries, network errors, any
                // mid-phase failure that left accumulated work. The user
                // sees the Resume banner regardless of what failed.
                toast.warning(
                  `${opts?.label ?? 'Pipeline'} failed at ${state.currentPhase?.replace('_', ' ') ?? 'this phase'} chunk ${state.currentChunkIndex} — run auto-paused. ` +
                    `Your progress is saved. Click Resume in the banner to retry, or fix the underlying issue first. ` +
                    `Error: ${msg.slice(0, 600)}`,
                  { duration: 20_000 },
                )
              }
            } else {
              // Checkpoint write failed — surface a softer error that
              // still tells the user where state lives. localStorage
              // mirror still has the in-progress run, just no Resume
              // banner backing it.
              toast.error(
                `${opts?.label ?? 'Pipeline'} failed and the checkpoint couldn't be written. ` +
                  `Your progress through chunk ${state.currentChunkIndex} is still in localStorage. ` +
                  `Error: ${msg.slice(0, 600)}`,
              )
            }
          })
        } else {
          // writeCheckpointRef not populated yet — extremely rare race
          // window before first phase fires. Fall back to the recovery
          // toast without the actual checkpoint write.
          toast.warning(
            `${opts?.label ?? 'Pipeline'} failed before the auto-pause system was ready. ` +
              `Refresh and click Resume in the banner if your in-progress state is there. ` +
              `Error: ${msg.slice(0, 600)}`,
            { duration: 20_000 },
          )
        }
      } else {
        // No accumulated work — failure before any chunk completed.
        // Plain error toast; nothing to checkpoint.
        // Surface full error detail (up to 600 chars) — the previous 200-char
        // limit cut off recovery hints from the gold-standard messages (e.g.
        // "Daily quota exhausted… resume tomorrow OR add Paid key"). Sonner
        // can render multi-line; phase+chunk on the first line ensures the
        // load-bearing context survives any later truncation.
        const phaseChunk = state.currentPhase
          ? ` [${state.currentPhase.replace('_', ' ')} chunk ${state.currentChunkIndex}]`
          : ''
        toast.error(`${opts?.label ?? 'Pipeline'}${phaseChunk} failed: ${msg.slice(0, 600)}`)
      }
      // Auto-build the diagnosis bundle so the user can paste
      // @.diagnose/latest.md into Claude Code without copy-pasting events.
      // Debounced in the client wrapper — repeated identical errors won't
      // produce duplicate bundles. Snapshot a minimal state shape; the
      // ring + probe cache + routing carry the rest of the context.
      const stack = (err as Error).stack
      const symbolHint = extractSymbolFromError(err) ?? undefined
      void requestBundle({
        trigger: 'hard_error',
        errorMessage: msg,
        errorStack: stack,
        symbolHint,
        currentState: {
          status: state.status,
          currentPhase: state.currentPhase,
          currentChunkIndex: state.currentChunkIndex,
          totalChunks: state.totalChunks,
          chronicle: state.chronicle,
          lastError: msg,
          outputSelection: state.outputSelection,
        },
      })
        .then((result) => {
          if (result.ok && !result.debounced && result.latestPath) {
            const sigSuffix = result.signaturesMatched
              ? ` (${result.signaturesMatched} soft-error${result.signaturesMatched === 1 ? '' : 's'} matched)`
              : ''
            // Only show diagnosis toast when NOT the daily-quota case —
            // that case has its own specific toast above with longer
            // duration so the user sees it on return.
            if (!isDailyQuota) {
              toast.message(
                `Diagnosis ready — paste @.diagnose/latest.md into Claude Code${sigSuffix}.`,
                { duration: 10_000 },
              )
            }
          }
        })
        .catch(() => {
          // Bundle build is diagnostic; never surface its failure as a
          // toast that overshadows the original error.
        })
    },
    [actions, state.status, state.currentPhase, state.currentChunkIndex, state.totalChunks, state.chronicle, state.outputSelection]
    // writeCheckpoint accessed via writeCheckpointRef (forward-ref) so
    // it's NOT in deps — its identity is stable via the ref.
  )

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

  /** Surface session-level warnings (modelAvailabilityWarning,
   *  modelSubstitutions, etc.) as toasts so the user knows the run is
   *  proceeding under a non-default config — vs. the silent-failure path
   *  where buildSession would just leave fields undefined and the user
   *  would discover the consequence mid-phase. */
  const surfaceSessionWarnings = useCallback((session: RunSession | null) => {
    if (!session) return
    if (session.modelAvailabilityWarning) {
      const w = session.modelAvailabilityWarning
      toast.warning(
        `Gemini model availability couldn't load — auto-escalation to Paid for ` +
          `paid-only models is OFF for this run (${w.consequence}). ` +
          `If a phase uses gemini-2.5-pro on a Free key, expect a verbose ` +
          `mid-phase error. Probe both Gemini slots in Settings → API Keys to fix.`,
      )
      console.warn(
        `[run-start] modelAvailabilityWarning: ${w.error} (consequence: ${w.consequence})`,
      )
    }
    // Model substitutions — buildSession swapped one or more phases'
    // configured model for something the Free probe says is accessible.
    // The user MUST be told: their UI showed gemini-2.5-flash but the
    // pipeline will actually call e.g. gemini-flash-lite-latest. We toast
    // each substitution individually so the user sees the exact swap and
    // its reason. Dubious swaps (lite / experimental / -latest variants)
    // get an extra-loud warning since they're rarely what the user meant.
    if (session.modelSubstitutions && session.modelSubstitutions.length > 0) {
      for (const sub of session.modelSubstitutions) {
        const dubious = sub.dubious === true
        const message =
          `${sub.phase} model swapped: ${sub.from} → ${sub.to}. Reason: ${sub.reason}.` +
          (dubious
            ? ` ⚠ ${sub.to} is a lite/experimental/latest variant — likely NOT what you picked. ` +
              `Open Plan & routing to pin a specific model, OR probe again.`
            : ' Open Plan & routing to override.')
        if (dubious) toast.warning(message, { duration: 12_000 })
        else toast.info(message, { duration: 8_000 })
        console.warn(`[run-start] modelSubstitution:`, sub)
      }
    }
  }, [])

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
          model: session?.phases.phase1.model,
          phaseTarget: session?.phases.phase1.phaseTarget,
          cloudProvider: session?.phases.phase1.cloudProvider,
          geminiTier: session?.phases.phase1.geminiTier,
          geminiPaidOnlyModels: session?.geminiPaidOnlyModels,
          allPhasesFast: session?.allPhasesFast,
          safetyMultiplier: () => safetyMultiplierRef.current,
          disableThinkingOnGrounding: runSettings.disableThinkingOnGrounding,
          phase1AliasHints: runSettings.phase1AliasHints,
          onInputSnapshot: (snapshot) => {
            phase1InputSnapshotRef.current = snapshot
          },
        })
        actions.completePhase1(grounded)
        const questions = await runPhase2({
          rawTranscript: effectiveTranscript,
          groundedTranscript: grounded,
          callbacks: { ...callbacks, signal: ctrl.signal },
          model: session?.phases.phase2.model,
          phaseTarget: session?.phases.phase2.phaseTarget,
          cloudProvider: session?.phases.phase2.cloudProvider,
          geminiTier: session?.phases.phase2.geminiTier,
          geminiPaidOnlyModels: session?.geminiPaidOnlyModels,
          allPhasesFast: session?.allPhasesFast,
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
            model: session?.phases.phase3.model,
            phaseTarget: session?.phases.phase3.phaseTarget,
            cloudProvider: session?.phases.phase3.cloudProvider,
            geminiTier: session?.phases.phase3.geminiTier,
            geminiPaidOnlyModels: session?.geminiPaidOnlyModels,
            allPhasesFast: session?.allPhasesFast,
            personaTemplates: personaTemplates.phase3,
            safetyMultiplier: () => safetyMultiplierRef.current,
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
            groundedTranscript: state.groundedTranscript,
            dmAnswers,
            callbacks: { ...callbacks, signal: ctrl.signal },
            model: session?.phases.phase4.model,
            phaseTarget: session?.phases.phase4.phaseTarget,
            cloudProvider: session?.phases.phase4.cloudProvider,
            geminiTier: session?.phases.phase4.geminiTier,
            geminiPaidOnlyModels: session?.geminiPaidOnlyModels,
            allPhasesFast: session?.allPhasesFast,
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
            model: session?.phases.phase6.model,
            phaseTarget: session?.phases.phase6.phaseTarget,
            cloudProvider: session?.phases.phase6.cloudProvider,
            geminiTier: session?.phases.phase6.geminiTier,
            geminiPaidOnlyModels: session?.geminiPaidOnlyModels,
            allPhasesFast: session?.allPhasesFast,
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
            model: session?.phases.phase1.model,
            phaseTarget: session?.phases.phase1.phaseTarget,
            cloudProvider: session?.phases.phase1.cloudProvider,
            geminiTier: session?.phases.phase1.geminiTier,
            geminiPaidOnlyModels: session?.geminiPaidOnlyModels,
            allPhasesFast: session?.allPhasesFast,
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
              rawTranscript,
              groundedTranscript: grounded,
              callbacks: { ...callbacks, signal: ctrl.signal },
              model: session?.phases.phase2.model,
              phaseTarget: session?.phases.phase2.phaseTarget,
              cloudProvider: session?.phases.phase2.cloudProvider,
              geminiTier: session?.phases.phase2.geminiTier,
              geminiPaidOnlyModels: session?.geminiPaidOnlyModels,
              allPhasesFast: session?.allPhasesFast,
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
            model: session?.phases.phase3.model,
            phaseTarget: session?.phases.phase3.phaseTarget,
            cloudProvider: session?.phases.phase3.cloudProvider,
            geminiTier: session?.phases.phase3.geminiTier,
            geminiPaidOnlyModels: session?.geminiPaidOnlyModels,
            allPhasesFast: session?.allPhasesFast,
            chunkSizeChars: originalSession
              ? chunkSizeForSessionPhase(originalSession, 'phase3')
              : undefined,
            startChunkIndex: action.startChunkIndex,
            priorPartial: action.priorPartial,
            personaTemplates: personaTemplates.phase3,
            safetyMultiplier: () => safetyMultiplierRef.current,
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
              groundedTranscript,
              dmAnswers,
              callbacks: { ...callbacks, signal: ctrl.signal },
              model: session?.phases.phase4.model,
              phaseTarget: session?.phases.phase4.phaseTarget,
              cloudProvider: session?.phases.phase4.cloudProvider,
              geminiTier: session?.phases.phase4.geminiTier,
              geminiPaidOnlyModels: session?.geminiPaidOnlyModels,
              allPhasesFast: session?.allPhasesFast,
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
              model: session?.phases.phase6.model,
              phaseTarget: session?.phases.phase6.phaseTarget,
              cloudProvider: session?.phases.phase6.cloudProvider,
              geminiTier: session?.phases.phase6.geminiTier,
              geminiPaidOnlyModels: session?.geminiPaidOnlyModels,
              allPhasesFast: session?.allPhasesFast,
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
            groundedTranscript,
            dmAnswers,
            callbacks: { ...callbacks, signal: ctrl.signal },
            model: session?.phases.phase4.model,
            phaseTarget: session?.phases.phase4.phaseTarget,
            cloudProvider: session?.phases.phase4.cloudProvider,
            geminiTier: session?.phases.phase4.geminiTier,
            geminiPaidOnlyModels: session?.geminiPaidOnlyModels,
            allPhasesFast: session?.allPhasesFast,
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
              model: session?.phases.phase6.model,
              phaseTarget: session?.phases.phase6.phaseTarget,
              cloudProvider: session?.phases.phase6.cloudProvider,
              geminiTier: session?.phases.phase6.geminiTier,
              geminiPaidOnlyModels: session?.geminiPaidOnlyModels,
              allPhasesFast: session?.allPhasesFast,
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
        actions.setRawTranscript(detail.text)
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
        model: session?.phases.phase6.model,
        phaseTarget: session?.phases.phase6.phaseTarget,
        cloudProvider: session?.phases.phase6.cloudProvider,
        geminiTier: session?.phases.phase6.geminiTier,
        geminiPaidOnlyModels: session?.geminiPaidOnlyModels,
        allPhasesFast: session?.allPhasesFast,
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
        groundedTranscript: state.groundedTranscript,
        dmAnswers: state.dmAnswers,
        callbacks: { ...callbacks, signal: ctrl.signal },
        model: session?.phases.phase4.model,
        phaseTarget: session?.phases.phase4.phaseTarget,
        cloudProvider: session?.phases.phase4.cloudProvider,
        geminiTier: session?.phases.phase4.geminiTier,
        geminiPaidOnlyModels: session?.geminiPaidOnlyModels,
        allPhasesFast: session?.allPhasesFast,
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

  /** Re-process ONE unrepaired Claude Code refusal on a chosen Gemini tier and
   *  fold the result back into the run state + Saved Chronicle. Returns
   *  {ok:false, reason} on any failure so the panel can surface it (never a
   *  silent no-op — the original bug). */
  const handleRepairRefusal = useCallback(
    async (
      rec: RefusalRecord,
      opts: { geminiTier: GeminiTier },
    ): Promise<{ ok: boolean; reason?: string }> => {
      const s = stateRef.current
      const ctx: RepairContext = {
        groundedTranscript: s.groundedTranscript,
        rawTranscript: s.rawTranscript,
        chronicle: s.chronicle,
        dmQuestions: s.dmQuestions,
        dmAnswers: s.dmAnswers,
        kbConcat: buildKbConcat(kb),
        campaign: s.campaign,
        sessionNumber: s.sessionNumber,
        targetWordCount: undefined,
      }
      const outcome = await repairRefusal(rec, ctx, { geminiTier: opts.geminiTier })
      if (!outcome.ok) return { ok: false, reason: outcome.reason }

      // Compute the NEW field values into locals first (stateRef.current won't
      // reflect actions.* until after the next render), apply via actions, AND
      // persist the locals so the library write isn't stale.
      let nextChronicle = s.chronicle
      let nextGrounded = s.groundedTranscript
      let nextDmQuestions = s.dmQuestions
      let nextExtras = s.extras
      let nextCondensed = s.condensed

      if (outcome.kind === 'prose') {
        if (rec.phase === 'phase3_chronicle') {
          const { doc, found } = spliceProse(s.chronicle, rec.marker, outcome.text)
          if (!found) {
            return {
              ok: false,
              reason: 'Repaired text generated, but the marker was no longer in the chronicle (was it edited?).',
            }
          }
          nextChronicle = doc
          actions.completePhase3(doc)
        } else if (rec.phase === 'phase1_ground') {
          const { doc, found } = spliceProse(s.groundedTranscript, rec.sourceSpan, outcome.text)
          if (!found) {
            return {
              ok: false,
              reason: 'Re-grounded text generated, but the original span was no longer in the grounded transcript.',
            }
          }
          nextGrounded = doc
          actions.completePhase1(doc)
        }
      } else if (outcome.kind === 'questions') {
        nextDmQuestions = mergeQuestions(s.dmQuestions, outcome.questions)
        actions.setDMQuestions(nextDmQuestions)
      } else if (outcome.kind === 'extras') {
        const base = s.extras ?? { jests: [], gore: [], quotes: [] }
        nextExtras = mergeExtras(base, outcome.extras)
        actions.completePhase4(nextExtras)
      } else if (outcome.kind === 'condense') {
        nextCondensed = s.condensed
          ? {
              narrative: [s.condensed.narrative, outcome.condensed.narrative].filter(Boolean).join('\n\n'),
              bulletPoints: [...s.condensed.bulletPoints, ...outcome.condensed.bulletPoints],
            }
          : outcome.condensed
        actions.completePhase6(nextCondensed)
      }

      // Flip this refusal to repaired in the persisted manifest. Read the
      // freshest manifest (handleRepairRefusal is awaited sequentially, incl.
      // inside "Repair all", so stateRef is current at each call).
      const nextRefusals = (stateRef.current.refusals ?? []).map((r) =>
        r.id === rec.id ? { ...r, repaired: true } : r,
      )
      actions.setRefusals(nextRefusals)

      // Persist the updated outputs + manifest to the Saved Chronicle.
      const savedId = s.savedChronicleId
      if (savedId) {
        try {
          await updateChronicle(savedId, {
            chronicle: nextChronicle,
            extras: nextExtras ?? undefined,
            condensed: nextCondensed ?? undefined,
            groundedTranscript: nextGrounded || undefined,
            refusals: nextRefusals,
            dmQuestions: nextDmQuestions ?? undefined,
            dmAnswers: s.dmAnswers ?? undefined,
          })
        } catch (err) {
          // The in-memory repair succeeded; only the library write failed.
          // Surface it but don't claim the whole repair failed.
          toast.warning(`Repaired, but couldn't update the saved library copy: ${(err as Error).message}`)
        }
      }
      return { ok: true }
    },
    [actions, kb],
  )

  /** "Halt pipeline" / user-initiated pause. Aborts the in-flight fetch
   *  FIRST so no further chunk_done events can fire during the write
   *  window, then writes a `pausedReason: 'user'` checkpoint of the
   *  live state. K.1.3 / W1 fix: pre-K.1.3 the order was reversed
   *  (write-then-abort), which let an in-flight chunk complete during
   *  writeCheckpoint's getRouting() round-trip and land state mutations
   *  the persisted checkpoint never captured. Delegated to cancelRun
   *  in src/lib/cancelFlow.ts so the ordering invariant is unit-testable
   *  without mounting this component. */
  const cancel = async () => {
    await cancelRun({
      abortRef,
      writeCheckpoint: writeCheckpointRef.current,
    })
  }

  /** Map the internal PhaseId enum to the checkpoint's numeric phase id. */
  const phaseIdToNumber = (p: PhaseId | null): CheckpointPhaseId | null => {
    switch (p) {
      case 'phase1_ground': return 1
      case 'phase2_audit': return 2
      case 'phase3_chronicle': return 3
      case 'phase4_extras': return 4
      case 'phase6_condense': return 6
      default: return null
    }
  }

  /** Build a RunCheckpoint from the live state and persist it. Called by
   *  the rate-limit dialog's Pause option AND the Halt cancel() above.
   *
   *  K.1.3 / W1 — state is read from refs at the TOP of the function
   *  rather than via the useCallback closure. Without this, a chunk_done
   *  landing during the `await getRouting()` window would mutate state
   *  to N+1 while this callback still saw N, producing a checkpoint with
   *  inconsistent (chunkIndex, partialOutput). The deps list is empty
   *  because every value the body reads comes from a ref — the callback
   *  never needs to re-bind.
   *
   *  Resolves to true on success. */
  const writeCheckpoint = useCallback(
    async (reason: 'user' | 'quota' | 'error'): Promise<boolean> => {
      // Snapshot EVERYTHING at the top so an interleaving chunk_done
      // can't fracture the checkpoint mid-build. Object spreads make
      // state a frozen-from-this-moment value — subsequent mutations
      // to the React store don't reach into this captured shape.
      const snapshotState = stateRef.current
      const snapshotCampaign = campaignRef.current
      const snapshotSessionNumber = sessionNumberRef.current
      const snapshotFingerprint = runFingerprintRef.current
      const snapshotInputSnapshot = phase1InputSnapshotRef.current
      const snapshotSafetyMultiplier = safetyMultiplierRef.current

      const phaseNumeric = phaseIdToNumber(snapshotState.currentPhase)
      if (!phaseNumeric) {
        toast.error('Cannot pause: no active phase to save.')
        return false
      }
      const runId =
        currentRunIdRef.current ?? `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      currentRunIdRef.current = runId
      let routing
      try {
        routing = await getRouting()
      } catch {
        // Falling back to a minimal stub keeps the resume usable — the
        // user can re-pick the routing manually if needed.
        routing = { version: 3 as const, lastSelectedProvider: null }
      }
      const checkpoint = buildCheckpoint({
        snapshot: {
          state: snapshotState,
          campaign: snapshotCampaign,
          sessionNumber: snapshotSessionNumber,
        },
        runId,
        routing,
        pausedReason: reason,
        phaseNumeric,
        safetyMultiplier: snapshotSafetyMultiplier,
        runFingerprint: snapshotFingerprint,
        inputSnapshot: snapshotInputSnapshot,
      })
      const result = await saveRun(checkpoint)
      if (!result.ok) {
        toast.error(result.message)
        return false
      }
      setResumeBannerKey((k) => k + 1)
      return true
    },
    [],
  )

  // Populate the forward-reference ref for handlePipelineError. Mounted
  // here (instead of inline at the writeCheckpoint declaration) so the
  // dependency array stays clean and React's exhaustive-deps lint
  // doesn't complain about a missing dep on the callback.
  useEffect(() => {
    writeCheckpointRef.current = writeCheckpoint
  }, [writeCheckpoint])

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

  // Handles the user's choice from the rate-limit dialog. Routes to the
  // appropriate side-effect — abort + export / dial the multiplier mid-run
  // / pause to disk / explicit fallback. Dialog closes either way.
  const handleRateLimitChoice = useCallback((choice: RateLimitChoice) => {
    setRateLimitDialog(null)
    switch (choice.kind) {
      case 'stop':
        abortRef.current?.abort()
        exportPartial()
        toast.message('Stopped. Downloaded the partial output as Markdown.')
        break
      case 'slowdown':
        safetyMultiplierRef.current = choice.multiplier
        toast.info(`Pacing now ${choice.multiplier}× slower for the rest of this run.`)
        break
      case 'pause':
        // Save the full state to disk, then abort. The Resume banner picks
        // it up next time the Chronicle tab mounts (or right now once the
        // banner re-fetches).
        void writeCheckpoint('quota').then((ok) => {
          if (ok) {
            abortRef.current?.abort()
            toast.success('Run paused — resume from the banner when the quota resets.')
          }
        })
        break
      case 'fallback':
        // Race-window-tightened fallback sequence:
        //   1. Abort the in-flight chunk loop. This signals the AbortController
        //      but the SDK call already in flight may still complete (and
        //      potentially re-fire quota_exhausted on the OLD singleton/tier).
        //   2. Wait up to 5s for the in-flight call to settle. We listen for
        //      `running=false` via a polling promise. If the SDK call hangs
        //      past the timeout, we give up and proceed anyway — better to
        //      take the race than block the user indefinitely.
        //   3. Delegate the routing-mutation sequence to fallbackToPaid
        //      (src/lib/fallbackFlow.ts). K.1.4 / W2 fix: that helper
        //      snapshots the original routing and rolls it back if
        //      writeCheckpoint fails, so a checkpoint-write failure no
        //      longer leaves the user silently on Paid on disk.
        //   4. emitActiveProviderChanged — refreshes ActiveProviderCard etc.
        //
        // The user sees: "Switched to Gemini Paid and paused (provider state
        // refreshed) — click Resume in the banner to continue."
        ;(async () => {
          vlog('fallback', { event: 'sequence_start' })
          vlog('fallback', { event: 'step1_abort' })
          abortRef.current?.abort()
          vlog('fallback', { event: 'step2_settle_wait', timeoutMs: 5000 })
          const settled = await settleInFlight(5_000)
          vlog('fallback', { event: 'step2_settle_done', settled })
          const result = await fallbackToPaid({
            getRouting,
            putRouting,
            refreshProviders,
            writeCheckpoint: (reason) => writeCheckpoint(reason),
            log: (event, payload) => vlog('fallback', { event, ...(payload ?? {}) }),
          })
          if (result.kind === 'ok') {
            vlog('fallback', { event: 'sequence_done' })
            emitActiveProviderChanged()
            toast.success(
              'Switched to Gemini Paid and refreshed provider singletons. ' +
                'Click Resume in the banner to continue on the paid key — the next chunk will dispatch fresh.',
            )
          } else if (result.kind === 'rolled_back') {
            // Forward step failed AFTER putRouting; fallbackToPaid
            // attempted to restore the original routing. Surface the
            // outcome so the user knows where they stand.
            vlog('fallback', { event: 'sequence_rolled_back', error: result.error.message })
            emitActiveProviderChanged()
            if (result.rollbackError) {
              // Rollback ALSO failed — the user's routing is in an
              // undefined state. Tell them to fix it manually.
              console.error('[fallback] forward and rollback both failed:', result.error, result.rollbackError)
              toast.error(
                `Fallback failed (${result.error.message}) and the rollback ALSO failed (${result.rollbackError.message}). ` +
                  `Open Settings → Active Provider and pick a tier manually before retrying.`,
              )
            } else {
              toast.error(
                `Fallback failed: ${result.error.message}. ` +
                  `Routing was restored to its previous state — your in-flight run is paused but still on the original tier.`,
              )
            }
          } else {
            // forward_failed_no_mutation — getRouting itself failed; nothing was touched.
            vlog('fallback', { event: 'sequence_no_mutation', error: result.error.message })
            console.error('[fallback] could not read routing:', result.error)
            toast.error(
              `Could not read routing: ${result.error.message}. Open Settings → Active Provider to switch tier manually.`,
            )
          }
        })()
        break
    }
  }, [exportPartial, writeCheckpoint, settleInFlight])

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
          // grounded transcript hasn't been narrated yet, but Phase 3
          // chronicles run close to the grounded length on real sessions
          // (1.0× rough average). Phase 6 recomputes the actual target
          // using the real chronicle word count at runtime.
          chronicleWordCountEstimate={countWords(state.groundedTranscript)}
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
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-5 w-5" />
            Pipeline error
          </CardTitle>
          <CardDescription>
            The pipeline stopped. The full diagnostic below is safe to paste into Claude Code.
            Open the browser console (F12) for the raw SDK response object.
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
              Retry from Phase 1
            </Button>
            <Button variant="outline" onClick={actions.reset}>
              <RotateCcw className="mr-1 h-4 w-4" />
              Reset
            </Button>
          </div>
        </CardContent>
      </Card>
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
