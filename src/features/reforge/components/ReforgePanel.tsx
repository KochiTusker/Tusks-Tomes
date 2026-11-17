// Chronicle Reforge — re-run the downstream pipeline (optionally the chronicle,
// then extras + condense) on Gemini for an existing/re-uploaded chronicle.
//
// Why it exists: Claude Code often writes a solid chronicle but refuses or
// underperforms on the later phases (extras: dark/explicit extraction; condense).
// Reforge lets you keep the good chronicle (or regenerate it to fix the
// player-action-vs-dialogue problem) and redo the downstream work on Gemini —
// which is stronger at quotes/jests/gore and condensing — without re-running the
// whole pipeline.
//
// UX: a collapsible card in the Tome of Lore tab with a guided three-step flow
// (1 pick a chronicle · 2 choose what to produce · 3 review + run). Options that
// need inputs you don't have are disabled with a plain reason. Results render in
// the shared ChronicleView and auto-save as a NEW library entry — the original
// is never overwritten. Launchable per-row from Saved Chronicles.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Wand2, Upload, X, ChevronDown, ChevronRight, Check, FileText, ScrollText, MessageSquareQuote, Loader2, AlertTriangle, RotateCcw } from 'lucide-react'
import { Button } from '@/platform/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/platform/ui/card'
import { Label } from '@/platform/ui/label'
import { Input } from '@/platform/ui/input'
import { Textarea } from '@/platform/ui/textarea'
import { Progress } from '@/platform/ui/progress'
import {
  ChronicleView,
  getChronicle,
  listChronicles,
  saveChronicle,
  CHRONICLE_LIBRARY_EVENT,
  type ChronicleSummary,
  type SavedChronicle,
} from '@/features/library'
import { useLoreDocuments, getAliasIndex } from '@/features/lore'
import { isSbv, sbvToText } from '@/features/caption-repair'
import { getPersonas } from '@/features/personas'
import {
  hasResumableWork,
  phasesAlreadyDone,
  runReforge,
  validateReforge,
  type ReforgeConfig,
  type ReforgeInput,
  type ReforgeProgress,
  type ReforgeResult,
} from '@/features/reforge/lib/reforge'
import {
  clearStoppedReforge,
  describeKeptWork,
  loadStoppedReforge,
  saveStoppedReforge,
  type StoppedReforge,
} from '@/features/reforge/lib/reforgeResume'
import type { CloudProvider } from '@/features/providers'
import { CondenseSlider, fetchRunSettings } from '@/features/pipeline'
import { ReforgeModelPicker, type ReforgeModelSelection } from './ReforgeModelPicker'
import { ReforgeComparison } from './ReforgeComparison'
import { countWords } from '@/platform/lib/wordCount'
import { emitReforgeComplete, emitReforgeRunning } from '@/platform/lib/appEvents'
import { requestBundle } from '@/features/maintenance'
import type {
  PipelineEvent,
  CondenseOutput,
  DMAnswers,
  DMQuestion,
  ExtrasOutput,
  KBDocument,
} from '@/features/pipeline'
import type { Persona, PersonasDocument } from '@/features/personas'

/** Per-row launch from SavedChroniclesPanel: `detail = { id }`. */
export const REFORGE_EVENT = 'sbts:reforge-chronicle'

const PHASE_LABEL: Record<string, string> = {
  phase1_ground: 'Grounding',
  phase2_audit: 'Audit',
  phase3_chronicle: 'Chronicle',
  phase4_extras: 'Extras',
  phase6_condense: 'Condense',
}

type SourceMode = 'library' | 'upload'

/** A Saved Chronicle as reforge input. Shared by the source picker and by a
 *  resume after a page reload, which rebuilds the input it did not store. */
function inputFromRecord(record: SavedChronicle, kb: KBDocument[]): ReforgeInput {
  return {
    chronicle: record.chronicle,
    groundedTranscript: record.groundedTranscript || undefined,
    dmQuestions: (record.dmQuestions ?? []) as DMQuestion[],
    dmAnswers: (record.dmAnswers ?? {}) as DMAnswers,
    kb,
    campaign: record.campaign,
    sessionNumber: record.sessionNumber,
  }
}

/** Everything one run needs — a fresh run and a resume share the same path. */
type RunSpec = {
  input: ReforgeInput
  runConfig: ReforgeConfig
  provider: CloudProvider
  modelLabel: string
  priorOutputs: { extras: ExtrasOutput | null; condensed: CondenseOutput | null }
  /** Saved Chronicle id of the source, when it came from the library. */
  sourceId?: string
  resumeFrom?: ReforgeProgress
}

/** Small segmented (pill) control for binary/short choices. */
function Segmented<T extends string>({
  value,
  onChange,
  options,
  disabled,
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string; disabled?: boolean; title?: string }[]
  disabled?: boolean
}) {
  return (
    <div className="inline-flex rounded-md border border-border p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          disabled={disabled || o.disabled}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={`rounded px-3 py-1 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
            value === o.value ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** A "what this source carries" availability chip. */
function AvailChip({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${
        ok
          ? 'border-emerald-500/40 text-emerald-700 dark:text-emerald-300'
          : 'border-border text-muted-foreground'
      }`}
    >
      {ok ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
      {label}
    </span>
  )
}

export function ReforgePanel() {
  const { documents: kb } = useLoreDocuments()

  const [open, setOpen] = useState(false)

  // Source.
  const [mode, setMode] = useState<SourceMode>('library')
  const [items, setItems] = useState<ChronicleSummary[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [record, setRecord] = useState<SavedChronicle | null>(null)
  const [loadingRecord, setLoadingRecord] = useState(false)
  const [pastedChronicle, setPastedChronicle] = useState('')
  const [pastedTranscript, setPastedTranscript] = useState('')
  const [campaign, setCampaign] = useState('')
  const [sessionNumber, setSessionNumber] = useState(0)

  // Config.
  const [regenerateChronicle, setRegenerateChronicle] = useState(false)
  const [doExtras, setDoExtras] = useState(true)
  const [doCondense, setDoCondense] = useState(true)
  const [extrasSource, setExtrasSource] = useState<'transcript' | 'chronicle'>('transcript')
  const [condensePercentage, setCondensePercentage] = useState(20)
  const [personas, setPersonas] = useState<PersonasDocument | null>(null)
  const [personaId, setPersonaId] = useState('')

  // Re-reforge: when set, this overrides the library/paste source so the user
  // can reforge a freshly-reforged result again. The pre-reforge outputs that
  // become the comparison baseline ride alongside.
  const [overrideInput, setOverrideInput] = useState<ReforgeInput | null>(null)
  const [priorOutputs, setPriorOutputs] = useState<{ extras: ExtrasOutput | null; condensed: CondenseOutput | null }>({
    extras: null,
    condensed: null,
  })

  // Run state.
  const [pickerOpen, setPickerOpen] = useState(false)
  const [running, setRunning] = useState(false)
  const [progressPct, setProgressPct] = useState(0)
  const [progressLabel, setProgressLabel] = useState('')
  const [result, setResult] = useState<ReforgeResult | null>(null)
  const [modelLabel, setModelLabel] = useState('')
  // Unique filename discriminator so each reforge / iteration auto-saves to its
  // OWN on-disk markdown file instead of overwriting the original session
  // export — every copy is kept until the user deletes it.
  const [resultVariant, setResultVariant] = useState('')
  // Snapshot of the pre-reforge outputs, captured at run start, for the
  // old-vs-new comparison in the result view.
  const [baseline, setBaseline] = useState<{
    chronicle: string
    extras: ExtrasOutput | null
    condensed: CondenseOutput | null
  } | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  // A run that stopped with finished work to keep. Lives outside this
  // component (see reforgeResume.ts), so it outlasts a tab switch.
  const [stopped, setStopped] = useState<StoppedReforge | null>(() => loadStoppedReforge())

  const refreshList = useCallback(async () => {
    try {
      setItems(await listChronicles())
    } catch (err) {
      toast.error(`Couldn't load saved chronicles: ${(err as Error).message}`)
    }
  }, [])

  useEffect(() => {
    void refreshList()
    void getPersonas().then(setPersonas).catch(() => {})
    const handler = () => void refreshList()
    window.addEventListener(CHRONICLE_LIBRARY_EVENT, handler)
    return () => window.removeEventListener(CHRONICLE_LIBRARY_EVENT, handler)
  }, [refreshList])

  const loadRecord = useCallback(async (id: string) => {
    setSelectedId(id)
    setRecord(null)
    setResult(null)
    if (!id) return
    setLoadingRecord(true)
    try {
      const rec = await getChronicle(id)
      setRecord(rec)
      setOverrideInput(null)
      setCampaign(rec.campaign)
      setSessionNumber(rec.sessionNumber)
      const hasTx = !!rec.groundedTranscript?.trim()
      setExtrasSource(hasTx ? 'transcript' : 'chronicle')
      if (!hasTx) setRegenerateChronicle(false)
      // Seed the condense slider from the original's ratio so it defaults to
      // "what was chosen originally"; fall back to 20% when there's no prior
      // condensed narrative to measure.
      setPriorOutputs({ extras: rec.extras ?? null, condensed: rec.condensed ?? null })
      const origWords = countWords(rec.chronicle)
      const condWords = countWords(rec.condensed?.narrative ?? '')
      if (origWords > 0 && condWords > 0) {
        const pct = Math.round((condWords / origWords) * 100 / 5) * 5
        setCondensePercentage(Math.max(5, Math.min(100, pct)))
      } else {
        setCondensePercentage(20)
      }
    } catch (err) {
      toast.error(`Couldn't open chronicle: ${(err as Error).message}`)
    } finally {
      setLoadingRecord(false)
    }
  }, [])

  // Per-row launch from Saved Chronicles → expand, switch to library, load.
  useEffect(() => {
    const handler = (e: Event) => {
      const id = (e as CustomEvent<{ id?: string }>).detail?.id
      if (!id) return
      setOpen(true)
      setMode('library')
      void loadRecord(id)
    }
    window.addEventListener(REFORGE_EVENT, handler)
    return () => window.removeEventListener(REFORGE_EVENT, handler)
  }, [loadRecord])

  // Assemble the reforge input from the active source. A re-reforge override
  // (the previous result fed back in) takes precedence over library/paste.
  const input: ReforgeInput | null = useMemo(() => {
    if (overrideInput) return overrideInput
    if (mode === 'library') {
      if (!record) return null
      return inputFromRecord(record, kb)
    }
    if (!pastedChronicle.trim()) return null
    return {
      chronicle: pastedChronicle,
      groundedTranscript: pastedTranscript.trim() || undefined,
      dmQuestions: [],
      dmAnswers: {},
      kb,
      campaign: campaign || 'Reforged chronicle',
      sessionNumber,
    }
  }, [overrideInput, mode, record, pastedChronicle, pastedTranscript, campaign, sessionNumber, kb])

  const hasTranscript = !!input?.groundedTranscript?.trim()
  const hasDmQa = !!(input && (input.dmQuestions.length || Object.keys(input.dmAnswers).length))

  // Keep config coherent with availability.
  useEffect(() => {
    if (!hasTranscript) {
      if (regenerateChronicle) setRegenerateChronicle(false)
      if (extrasSource === 'transcript') setExtrasSource('chronicle')
    }
  }, [hasTranscript, regenerateChronicle, extrasSource])

  const personaTemplates = useMemo(() => {
    if (!personaId || !personas) return undefined
    const p = personas.personas.find((x: Persona) => x.id === personaId)
    if (!p) return undefined
    return { phase3: { cloud: p.prompts.phase3Cloud }, phase6: { cloud: p.prompts.phase6Cloud } }
  }, [personaId, personas])

  // Base config minus the provider/model — those come from the picker at run
  // time. geminiTier is a placeholder here (overridden by the chosen option).
  const config: ReforgeConfig = {
    regenerateChronicle: regenerateChronicle && hasTranscript,
    doExtras,
    doCondense,
    extrasSource: hasTranscript ? extrasSource : 'chronicle',
    geminiTier: 'auto',
    condensePercentage,
    personaTemplates,
  }

  const validationReason = input ? validateReforge(input, config) : 'Pick a chronicle to reforge first.'

  // Plain-English plan summary.
  const planSummary = useMemo(() => {
    if (!input) return ''
    const personaName = personaId ? personas?.personas.find((p) => p.id === personaId)?.name : null
    const voice = personaName ? `voiced as ${personaName}` : 'in the default Bard voice'
    const steps: string[] = []
    if (config.regenerateChronicle) steps.push(`rewrite the chronicle ${voice}`)
    if (config.doExtras) {
      steps.push(`extract quotes / jests / gore from the ${config.extrasSource === 'transcript' ? 'grounded transcript' : 'chronicle prose'}`)
    }
    if (config.doCondense) steps.push(`write a condensed version ${voice} (~${condensePercentage}% length)`)
    if (!steps.length) return ''
    const list = steps.length === 1 ? steps[0] : steps.slice(0, -1).join(', ') + ', and ' + steps[steps.length - 1]
    return `You'll pick the model next, then it will ${list}. Saved as a new entry — your original is kept.`
  }, [input, config, personaId, personas, condensePercentage])

  const onFile = (setter: (s: string) => void, convertSbv = false) => async (file: File) => {
    try {
      const raw = await file.text()
      setter(convertSbv && isSbv(raw) ? sbvToText(raw) : raw)
      toast.success(`Loaded ${file.name} (${raw.length.toLocaleString()} chars)`)
    } catch (err) {
      toast.error(`Couldn't read file: ${(err as Error).message}`)
    }
  }

  const run = async (selection: ReforgeModelSelection) => {
    const choice = selection.primary
    if (!input) return
    if (validationReason) {
      toast.error(validationReason)
      return
    }
    const runConfig: ReforgeConfig = {
      ...config,
      provider: choice.provider,
      model: choice.model,
      geminiTier: choice.geminiTier,
      // Per-phase routing. The top-level fields above stay as the fallback for
      // any phase the dialog did not ask about.
      phaseModels: Object.fromEntries(
        Object.entries(selection.perPhase).map(([phase, c]) => [
          phase,
          { provider: c.provider, geminiTier: c.geminiTier, model: c.model },
        ]),
      ),
    }
    await execute({
      input,
      runConfig,
      provider: choice.provider,
      modelLabel: choice.label,
      priorOutputs,
      sourceId: mode === 'library' && !overrideInput ? record?.id : undefined,
    })
  }

  // Carry on from a stopped run: same input, same config, same models, merged
  // with the work it finished.
  const resumeStopped = async () => {
    const s = stopped
    if (!s || running) return
    let resumeInput = s.input
    if (!resumeInput) {
      // After a page reload only the Saved Chronicle's id survived.
      try {
        resumeInput = inputFromRecord(await getChronicle(s.record.sourceId ?? ''), kb)
      } catch (err) {
        toast.error(
          `Couldn't reopen the chronicle this Reforge was working on — it may have been removed from Saved Chronicles. ${(err as Error).message}`,
        )
        return
      }
    }
    // The resumed run is now the source on screen, so the result view and
    // "Reforge again" work from what was actually run.
    setOverrideInput(resumeInput)
    setPriorOutputs(s.record.priorOutputs)
    await execute({
      input: resumeInput,
      runConfig: s.record.config,
      provider: s.record.provider,
      modelLabel: s.record.modelLabel,
      priorOutputs: s.record.priorOutputs,
      sourceId: s.record.sourceId,
      resumeFrom: s.record.progress,
    })
  }

  const discardStopped = () => {
    clearStoppedReforge()
    setStopped(null)
  }

  const execute = async (spec: RunSpec) => {
    const { input, runConfig, priorOutputs } = spec
    // A new run supersedes a stopped one; if this one stops too, it leaves its
    // own record — which already holds everything the resumed-from run kept.
    clearStoppedReforge()
    setStopped(null)
    // Capture the pre-reforge outputs for the old-vs-new comparison.
    setBaseline({
      chronicle: input.chronicle,
      extras: priorOutputs.extras,
      condensed: priorOutputs.condensed,
    })
    setModelLabel(spec.modelLabel)
    // Compact, filesystem-friendly timestamp (server sanitizes again). Unique
    // per run so iterations never collide on disk.
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    setResultVariant(`reforge-${spec.provider}-${stamp}`)
    // Coarse progress: weight each planned phase equally, fill by chunk fraction.
    const plannedPhaseCount =
      (runConfig.regenerateChronicle ? 1 : 0) + (runConfig.doExtras ? 1 : 0) + (runConfig.doCondense ? 1 : 0)
    // What has finished so far. A resume starts from what it carried in.
    let latest: ReforgeProgress | null = spec.resumeFrom ?? null
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setRunning(true)
    // Whatever the panel was left as, a run it is about to start belongs on
    // screen; and the collapsibles above it need to know one is in flight so
    // they can say so rather than render their idle selves over it.
    setOpen(true)
    emitReforgeRunning(true)
    setResult(null)
    // Phases a resume skips outright count as done from the start.
    let done = phasesAlreadyDone(runConfig, spec.resumeFrom)
    setProgressPct(plannedPhaseCount ? Math.max(2, Math.round((done / plannedPhaseCount) * 100)) : 2)
    setProgressLabel(spec.resumeFrom ? 'Resuming…' : 'Starting…')
    try {
      const runSettings = await fetchRunSettings()
      const inputWithLore: ReforgeInput = {
        ...input,
        retrieveVaultKb: runSettings.retrieveVaultKb,
        aliasIndex: await getAliasIndex(),
      }
      const res = await runReforge(inputWithLore, runConfig, {
        signal: ctrl.signal,
        onEvent: (e: PipelineEvent) => {
          if (e.type === 'phase_start') {
            setProgressLabel(`${PHASE_LABEL[e.phase] ?? e.phase}…`)
          } else if (e.type === 'chunk_done') {
            const frac = e.totalChunks ? (e.index + 1) / e.totalChunks : 1
            const pct = plannedPhaseCount ? ((done + frac) / plannedPhaseCount) * 100 : frac * 100
            setProgressPct(Math.min(99, Math.round(pct)))
            setProgressLabel(`${PHASE_LABEL[e.phase] ?? e.phase} — chunk ${e.index + 1}/${e.totalChunks}`)
          } else if (e.type === 'phase_complete') {
            done += 1
            setProgressPct(Math.min(99, Math.round((done / Math.max(1, plannedPhaseCount)) * 100)))
          }
        },
      }, {
        resumeFrom: spec.resumeFrom,
        onProgress: (p) => {
          latest = p
        },
      })
      setProgressPct(100)
      setResult(res)
      // The complete artefact: what this pass produced, plus what it kept.
      const mergedExtras = res.extras ?? priorOutputs.extras ?? null
      const mergedCondensed = res.condensed ?? priorOutputs.condensed ?? null
      try {
        const saved = await saveChronicle({
          campaign: input.campaign,
          sessionNumber: input.sessionNumber,
          provider: `${spec.provider}-reforge`,
          chronicle: res.chronicle,
          // Carry forward whatever this reforge did NOT redo. runReforge only
          // populates the outputs it was asked to produce, so a run that keeps
          // the condense and redoes only extras returns condensed: undefined —
          // saving that verbatim would drop a condense the user explicitly
          // chose to keep. The original entry is untouched either way, but the
          // new one has to be the complete artefact, not just the delta.
          extras: mergedExtras ?? undefined,
          condensed: mergedCondensed ?? undefined,
          groundedTranscript: input.groundedTranscript,
          dmQuestions: input.dmQuestions,
          dmAnswers: input.dmAnswers,
        })
        toast.success(
          spec.resumeFrom
            ? 'Reforge resumed and finished — merged with the work kept from the stopped run, and saved as a new entry in Saved Chronicles (original kept).'
            : 'Reforged — saved as a new entry in Saved Chronicles (original kept).',
        )
        // Promote the result to the main Chronicle view. Without this the
        // screen keeps showing the superseded extras, and the only place the
        // new ones exist is this panel — which the next tab switch discards.
        emitReforgeComplete({
          campaign: input.campaign,
          sessionNumber: input.sessionNumber,
          chronicle: res.chronicle,
          extras: mergedExtras,
          condensed: mergedCondensed,
          groundedTranscript: input.groundedTranscript ?? '',
          dmQuestions: input.dmQuestions,
          dmAnswers: input.dmAnswers,
          savedChronicleId: saved?.id,
        })
      } catch (err) {
        toast.warning(`Reforge done, but the library save failed: ${(err as Error).message}`)
      }
    } catch (err) {
      const aborted = (err as Error)?.name === 'AbortError'
      const message = (err as Error)?.message ?? String(err)
      // Keep whatever finished, so the next attempt resumes instead of paying
      // for it all again.
      const kept = hasResumableWork(latest)
      if (kept && latest) {
        saveStoppedReforge(
          {
            version: 1,
            savedAt: new Date().toISOString(),
            sourceId: spec.sourceId,
            campaign: input.campaign,
            sessionNumber: input.sessionNumber,
            config: runConfig,
            provider: spec.provider,
            modelLabel: spec.modelLabel,
            priorOutputs,
            progress: latest,
            stopReason: aborted ? 'Cancelled.' : message,
          },
          input,
        )
        setStopped(loadStoppedReforge())
      }
      const keptNote = kept ? ' The finished work is kept — resume it from the Reforge panel.' : ''
      if (aborted) toast.info(`Reforge cancelled.${keptNote}`)
      else {
        // Stays until dismissed: a Reforge runs long enough that nobody is
        // watching when it fails, and the default few seconds meant the
        // reason was gone before anyone saw it.
        toast.error(`Reforge failed: ${message}${keptNote}`, { duration: Infinity })
        // A reforge failure used to leave a toast and nothing else — the main
        // pipeline writes a bundle on a hard error, this path never did, so a
        // dismissed toast took the whole diagnosis with it. AbortError is
        // excluded for the same reason it is there: a cancellation is not a
        // fault to investigate.
        void requestBundle({
          trigger: 'hard_error',
          symbolHint: 'runReforge',
          errorMessage: `Reforge failed: ${(err as Error)?.message ?? String(err)}`,
          errorStack: (err as Error)?.stack,
        }).catch(() => {
          /* diagnosis is best-effort; never mask the original failure */
        })
      }
    } finally {
      setRunning(false)
      emitReforgeRunning(false)
      setProgressLabel('')
      abortRef.current = null
    }
  }

  // Feed the just-reforged result back in as the source and reopen the model
  // picker, so the user can iterate ("if they don't like it, reforge again").
  const reforgeAgain = () => {
    if (!result) return
    setOverrideInput({
      chronicle: result.chronicle,
      groundedTranscript: input?.groundedTranscript,
      dmQuestions: input?.dmQuestions ?? [],
      dmAnswers: input?.dmAnswers ?? {},
      kb,
      campaign: input?.campaign ?? 'Reforged chronicle',
      sessionNumber: input?.sessionNumber ?? 0,
    })
    // The current result becomes the next comparison baseline — including the
    // phases this pass deliberately kept, which runReforge returns as
    // undefined. Without the carry-forward, iterating twice would forget a
    // condense the user kept on the first pass.
    setPriorOutputs({
      extras: result.extras ?? priorOutputs.extras ?? null,
      condensed: result.condensed ?? priorOutputs.condensed ?? null,
    })
    setResult(null)
    setPickerOpen(true)
  }

  const reforgeAnother = () => {
    setResult(null)
    setOverrideInput(null)
    setBaseline(null)
  }

  // ── Results view ──────────────────────────────────────────────────────────
  if (result) {
    // What the run produced, plus what it was told to keep. runReforge only
    // returns the phases it was asked to redo, so these are the finished
    // artefact rather than the delta — and they match what was just saved.
    const shownExtras = result.extras ?? priorOutputs.extras ?? null
    const shownCondensed = result.condensed ?? priorOutputs.condensed ?? null
    const hasComparison =
      !!baseline && (baseline.condensed != null || baseline.extras != null || baseline.chronicle !== result.chronicle)
    return (
      <div className="space-y-3" data-reforge-panel>
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3">
          <p className="text-sm text-emerald-800 dark:text-emerald-200">
            <Check className="mr-1 inline h-4 w-4" />
            Reforged{modelLabel ? ` on ${modelLabel}` : ''}{' '}
            {result.chronicleRegenerated ? '(chronicle regenerated)' : '(chronicle kept)'} and saved as a new entry in
            Saved Chronicles. Your original is untouched.
          </p>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={reforgeAgain} title="Reforge this result again on a model of your choice">
              <Wand2 className="mr-1 h-3.5 w-3.5" /> Reforge again
            </Button>
            <Button variant="outline" size="sm" onClick={reforgeAnother}>
              Reforge another
            </Button>
          </div>
        </div>
        {hasComparison && baseline && (
          <ReforgeComparison
            original={{ chronicle: baseline.chronicle, extras: baseline.extras, condensed: baseline.condensed }}
            reforged={{ chronicle: result.chronicle, extras: shownExtras, condensed: shownCondensed }}
          />
        )}
        <ChronicleView
          campaign={input?.campaign ?? 'Reforged'}
          sessionNumber={input?.sessionNumber ?? 0}
          chronicle={result.chronicle}
          extras={shownExtras}
          condensed={shownCondensed}
          onReset={reforgeAnother}
          autoSaveVariant={resultVariant}
        />
      </div>
    )
  }

  // ── Main (collapsible) ──────────────────────────────────────────────────────
  return (
    <Card data-reforge-panel>
      {/* The whole header toggles the body, which is a large and easily-hit
          target. A run lives for minutes inside that body, so collapsing must
          never be the same as losing it: while one is in flight the header
          carries the state, the step and the bar itself. */}
      <CardHeader className="cursor-pointer" onClick={() => setOpen((o) => !o)}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            <div>
              <CardTitle className="flex items-center gap-2">
                <Wand2 className="h-4 w-4" />
                Reforge a Chronicle
                {running && (
                  <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-xs font-normal text-amber-700 dark:text-amber-400">
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                    Running
                  </span>
                )}
              </CardTitle>
              {!open && (
                <CardDescription>
                  {running
                    ? `${progressLabel || 'Working…'} · ${progressPct}% — open this panel to watch it or cancel.`
                    : 'Redo extras / condense — or rewrite the chronicle — on a model of your choice. Keeps your original.'}
                </CardDescription>
              )}
            </div>
          </div>
        </div>
      </CardHeader>

      {!open && running && (
        <div className="px-6 pb-4">
          <Progress value={progressPct} />
        </div>
      )}

      {/* A stopped run with finished work. Shown open or collapsed, and kept
          until resumed, discarded or superseded — never on a timer. */}
      {stopped && !running && (
        <div
          role="status"
          data-reforge-stopped
          className="mx-6 mb-4 space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
        >
          <p className="flex items-center gap-1.5 font-medium text-amber-800 dark:text-amber-200">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
            A Reforge of {stopped.record.campaign || 'Untitled'} — Session {stopped.record.sessionNumber} stopped
            before it finished.
          </p>
          <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{stopped.record.stopReason}</p>
          <p>
            {describeKeptWork(stopped.record.config, stopped.record.progress)} It carries on with the same models
            {stopped.record.modelLabel ? ` (${stopped.record.modelLabel})` : ''} and is saved as a new entry, as usual.
          </p>
          <p className="text-xs text-muted-foreground">
            Starting a different Reforge discards this.
            {stopped.record.sourceId ? '' : ' A pasted source is kept only until the page reloads.'}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void resumeStopped()}>
              <RotateCcw className="mr-1 h-3.5 w-3.5" /> Resume Reforge
            </Button>
            <Button size="sm" variant="outline" onClick={discardStopped}>
              Discard
            </Button>
          </div>
        </div>
      )}

      {open && (
        <CardContent className="space-y-6">
          <CardDescription>
            Take a chronicle Claude Code wrote and redo the later phases on a model you pick (Gemini, Claude, or
            OpenAI) — stronger quotes / jests / gore and a better condense, optionally rewriting the chronicle itself
            in a persona voice. The result is saved as a new library entry; your original is kept. Don't like it?
            Reforge it again.
          </CardDescription>

          {/* STEP 1 — source */}
          <section className="space-y-3">
            <h3 className="text-sm font-semibold">1 · Choose a chronicle</h3>
            <Segmented<SourceMode>
              value={mode}
              onChange={setMode}
              options={[
                { value: 'library', label: 'From library' },
                { value: 'upload', label: 'Paste / upload' },
              ]}
            />

            {mode === 'library' ? (
              <div className="space-y-2">
                <select
                  className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm"
                  value={selectedId}
                  onChange={(e) => void loadRecord(e.target.value)}
                >
                  <option value="">— pick a saved chronicle —</option>
                  {items.map((it) => (
                    <option key={it.id} value={it.id}>
                      {(it.campaign || 'Untitled')} — Session {it.sessionNumber} ({new Date(it.createdAt).toLocaleDateString()}
                      {it.provider ? `, ${it.provider}` : ''})
                    </option>
                  ))}
                </select>
                {items.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    No saved chronicles yet — finish a run, or switch to “Paste / upload”.
                  </p>
                )}
                {loadingRecord && <p className="text-xs text-muted-foreground">Loading…</p>}
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    className="w-48"
                    placeholder="Campaign name"
                    value={campaign}
                    onChange={(e) => setCampaign(e.target.value)}
                  />
                  <Input
                    type="number"
                    className="w-28"
                    placeholder="Session #"
                    value={sessionNumber || ''}
                    onChange={(e) => setSessionNumber(Number(e.target.value) || 0)}
                  />
                </div>
                <div>
                  <div className="mb-1 flex items-center justify-between">
                    <Label>Chronicle</Label>
                    <FileButton accept=".md,.txt" label="Load .md / .txt" onFile={onFile(setPastedChronicle)} />
                  </div>
                  <Textarea
                    className="min-h-28"
                    placeholder="Paste the chronicle prose here, or load a file…"
                    value={pastedChronicle}
                    onChange={(e) => setPastedChronicle(e.target.value)}
                  />
                </div>
                <div>
                  <div className="mb-1 flex items-center justify-between">
                    <Label className="text-muted-foreground">
                      Grounded transcript (optional — unlocks transcript-source extras + chronicle rewrite)
                    </Label>
                    <FileButton accept=".txt,.sbv,.md" label="Load .txt / .sbv" onFile={onFile(setPastedTranscript, true)} />
                  </div>
                  <Textarea
                    className="min-h-20"
                    placeholder="Optional — paste the grounded transcript for richer extras…"
                    value={pastedTranscript}
                    onChange={(e) => setPastedTranscript(e.target.value)}
                  />
                </div>
              </div>
            )}

            {input && (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <span className="text-xs text-muted-foreground">This source has:</span>
                <AvailChip ok label={`Chronicle (${input.chronicle.length.toLocaleString()} chars)`} />
                <AvailChip ok={hasTranscript} label="Grounded transcript" />
                <AvailChip ok={hasDmQa} label="DM Q&A" />
              </div>
            )}
          </section>

          {/* STEP 2 — outputs (only once a source is ready) */}
          {input && (
            <section className="space-y-4 border-t border-border pt-4">
              <h3 className="text-sm font-semibold">2 · What to produce</h3>

              {/* Chronicle decision */}
              <div className="space-y-1.5">
                <Label className="flex items-center gap-1.5">
                  <ScrollText className="h-3.5 w-3.5" /> Chronicle
                </Label>
                <Segmented
                  value={config.regenerateChronicle ? 'regen' : 'keep'}
                  onChange={(v) => setRegenerateChronicle(v === 'regen')}
                  options={[
                    { value: 'keep', label: 'Keep existing' },
                    {
                      value: 'regen',
                      label: 'Rewrite on Gemini',
                      disabled: !hasTranscript,
                      title: hasTranscript ? '' : 'Needs a grounded transcript',
                    },
                  ]}
                />
                <p className="text-xs text-muted-foreground">
                  {config.regenerateChronicle
                    ? 'Rewrites the chronicle from the grounded transcript — fixes player action-vs-dialogue and applies the persona voice.'
                    : hasTranscript
                      ? 'Uses your existing chronicle unchanged. Only the outputs below are regenerated.'
                      : 'Rewrite needs a grounded transcript — this source doesn’t have one, so the existing chronicle is kept.'}
                </p>
              </div>

              {/* Outputs */}
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-md border border-border p-3">
                  <label className="flex items-center gap-2 text-sm font-medium">
                    <input type="checkbox" checked={doExtras} onChange={(e) => setDoExtras(e.target.checked)} />
                    <MessageSquareQuote className="h-3.5 w-3.5" /> Extras (quotes / jests / gore)
                  </label>
                  {doExtras && (
                    <div className="mt-2 space-y-1.5 pl-6">
                      <Segmented
                        value={config.extrasSource}
                        onChange={(v) => setExtrasSource(v)}
                        disabled={!hasTranscript}
                        options={[
                          { value: 'transcript', label: 'From transcript', disabled: !hasTranscript, title: hasTranscript ? '' : 'Needs a grounded transcript' },
                          { value: 'chronicle', label: 'From chronicle' },
                        ]}
                      />
                      <p className="text-xs text-muted-foreground">
                        {config.extrasSource === 'transcript'
                          ? 'Most thorough — reads the full grounded transcript (verbatim dialogue). Higher token cost.'
                          : 'Cheaper — reads only the chronicle prose. May miss verbatim lines the narrative paraphrased.'}
                      </p>
                    </div>
                  )}
                </div>

                <div className="rounded-md border border-border p-3">
                  <label className="flex items-center gap-2 text-sm font-medium">
                    <input type="checkbox" checked={doCondense} onChange={(e) => setDoCondense(e.target.checked)} />
                    <FileText className="h-3.5 w-3.5" /> Condensed recap
                  </label>
                  <p className="mt-2 pl-6 text-xs text-muted-foreground">
                    A tightened retelling + catch-up bullets, from the {config.regenerateChronicle ? 'rewritten' : 'existing'} chronicle.
                  </p>
                  {doCondense && (
                    <div className="mt-1 pl-6">
                      <CondenseSlider
                        value={condensePercentage}
                        onChange={setCondensePercentage}
                        estimatedChronicleWords={countWords(input.chronicle)}
                        // Exact unless Phase 3 is about to rewrite the
                        // chronicle first, in which case the count on hand
                        // is the old one's — same ballpark, not a promise.
                        basis={config.regenerateChronicle ? 'estimate' : 'actual'}
                      />
                    </div>
                  )}
                </div>
              </div>

              {/* Voice */}
              <div className="flex flex-wrap items-center gap-4">
                <div className="flex items-center gap-2">
                  <Label htmlFor="reforge-persona">Voice</Label>
                  <select
                    id="reforge-persona"
                    className="rounded border border-border bg-background px-2 py-1 text-sm"
                    value={personaId}
                    onChange={(e) => setPersonaId(e.target.value)}
                  >
                    <option value="">Bard (default)</option>
                    {personas?.personas.map((p: Persona) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>
                <p className="text-xs text-muted-foreground">
                  You'll choose the provider &amp; model (Gemini / Claude / OpenAI) in the next step.
                </p>
              </div>

              {config.regenerateChronicle && (
                <p className="rounded-md border border-amber-500/30 bg-amber-50/60 p-2 text-xs text-amber-900 dark:bg-amber-950/20 dark:text-amber-100">
                  Rewriting the chronicle reads your Tome of Lore for context (canonical names, lore), so it costs more
                  tokens than redoing extras / condense alone. A bare grounded transcript carries less story context than
                  an existing chronicle — if your chronicle is already solid, “Keep existing” usually gives better results.
                </p>
              )}
            </section>
          )}

          {/* STEP 3 — review + run.
              `input` is derived from the chosen record, and choosing a
              different one clears it for as long as the fetch takes. That must
              not take a running reforge off the screen with it, so the section
              stands while a run is in flight whatever the source says. */}
          {(input || running) && (
            <section className="space-y-3 border-t border-border pt-4">
              <h3 className="text-sm font-semibold">3 · Review &amp; run</h3>
              {input && planSummary && !validationReason && (
                <p className="rounded-md bg-muted/50 p-3 text-sm">{planSummary}</p>
              )}
              {input && validationReason && (
                <p className="text-sm text-amber-700 dark:text-amber-300">{validationReason}</p>
              )}

              {running ? (
                <div className="space-y-2">
                  <Progress value={progressPct} />
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">{progressLabel}</span>
                    <Button variant="outline" size="sm" onClick={() => abortRef.current?.abort()}>
                      <X className="mr-1 h-4 w-4" /> Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <Button onClick={() => setPickerOpen(true)} disabled={!!validationReason}>
                  <Wand2 className="mr-1 h-4 w-4" /> Choose model &amp; reforge
                </Button>
              )}
            </section>
          )}
        </CardContent>
      )}

      <ReforgeModelPicker
        open={pickerOpen}
        // Grade the candidates against the work actually selected. A model that
        // wins Chronicle is not the one that wins Extras, so grading against
        // anything other than the chosen phases recommends the wrong model.
        phases={[
          ...(config.regenerateChronicle ? (['phase3'] as const) : []),
          ...(config.doExtras ? (['phase4'] as const) : []),
          ...(config.doCondense ? (['phase6'] as const) : []),
        ]}
        onCancel={() => setPickerOpen(false)}
        onConfirm={(selection) => {
          setPickerOpen(false)
          void run(selection)
        }}
      />
    </Card>
  )
}

function FileButton({ accept, label, onFile }: { accept: string; label: string; onFile: (f: File) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => ref.current?.click()}>
        <Upload className="mr-1 h-3.5 w-3.5" /> {label}
      </Button>
      <input
        ref={ref}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) onFile(f)
          e.target.value = ''
        }}
      />
    </>
  )
}
