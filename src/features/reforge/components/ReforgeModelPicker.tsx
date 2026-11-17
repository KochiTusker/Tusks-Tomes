// Reforge model picker — a modal that asks which provider + model to reforge
// on before the run starts. Sources its provider list from the configured
// cloud keys, and its per-provider model list from the OpenRouter catalogue
// plus the same probe-availability cache the routing + profile editors use, so
// the surfaces never disagree about what's accessible.
//
// One row PER PHASE. A model is good at a phase, not in general — the measured
// ranking inverts between Chronicle and Extras — so a single model applied to
// everything selected guarantees at least one phase is not running the model
// that won it. With one phase selected this collapses to exactly one row, which
// is the shape it had before.
//
// Claude Code is intentionally excluded: reforge exists to redo work that the
// Claude Code subscription refused or underperformed on, so reforging back
// onto it defeats the purpose. (The API-key Claude provider is still offered.)
//
// The chosen model also drives chunk sizing downstream — a fast-tier id
// (Gemini Flash-Lite, Claude Haiku, OpenAI -mini/-nano) classifies as `:fast`
// and automatically gets the smaller chunk row, so the model has room to both
// hold the context and emit a full-length output.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Wand2 } from 'lucide-react'
import { Button } from '@/platform/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/platform/ui/dialog'
import { Label } from '@/platform/ui/label'
import {
  useAvailabilityCache,
  fetchConfiguredCloudKeyOptions,
  type CloudKeyOption,
  availableModelsFor,
  groupModels,
  hasUnverified,
  classifyModelTier,
  getOpenRouterCatalogue,
  isTextPipelineModel,
  type OpenRouterModelInfo,
  isHiddenFromRouting,
  SMALL_MODEL_CEILING_B,
  useShowAllModels,
  FreeModelsNote,
} from '@/features/providers'
import {
  MEASURED_GRADES,
  MEASURED_MODEL_IDS,
  PHASE_LABELS,
  judgePhase,
  type Grade,
} from '@/features/routing'
import type { AvailabilityCache, GeminiTier, CloudProvider } from '@/features/providers'
import type { ReforgePhase } from '@/features/reforge/lib/reforge'

export type ReforgeModelChoice = {
  provider: CloudProvider
  model: string
  /** Only meaningful when provider === 'gemini'. */
  geminiTier: GeminiTier
  /** For the run summary / label. */
  label: string
}

export type ReforgeModelSelection = {
  /** Applied to any phase without its own entry, and used for the run label. */
  primary: ReforgeModelChoice
  /** One entry per phase the dialog was asked about. */
  perPhase: Partial<Record<ReforgePhase, ReforgeModelChoice>>
}

type Props = {
  open: boolean
  onCancel: () => void
  onConfirm: (selection: ReforgeModelSelection) => void
  /** Phases this reforge will actually run, in pipeline order. One row each.
   *  Empty is treated as a single unlabelled row. */
  phases?: ReforgePhase[]
}

/** Best (lowest) letter wins when ranking candidates. Untested sorts last but
 *  is NOT treated as bad — see the grading notes in phaseGrades.ts. */
const GRADE_RANK: Record<Grade, number> = { A: 0, B: 1, C: 2, D: 3, F: 4, untested: 5 }

const TIER_NOTE: Record<string, string> = {
  fast: 'Fast tier — cheaper and quicker; chunking auto-shrinks so it keeps context and still writes full-length output.',
  flagship: 'Flagship tier — the strongest quality / largest chunks.',
  frontier: 'Frontier tier — top quality (slower, pricier).',
}

export function ReforgeModelPicker({ open, onCancel, onConfirm, phases }: Props) {
  const { cache } = useAvailabilityCache()
  const [options, setOptions] = useState<CloudKeyOption[]>([])
  const [orModels, setOrModels] = useState<OpenRouterModelInfo[]>([])
  // Shared with the routing rows and the catalogue browser in Settings.
  const [showAllModels, setShowAllModels] = useShowAllModels()
  /** Per-row selection, keyed by phase. Rows are independent by design. */
  const [sel, setSel] = useState<Record<string, { optId: string; model: string }>>({})
  // Default ON: a 400-entry catalogue sorted by nothing is not a choice, it is
  // a search problem. Starting from what has been measured makes the default
  // path the informed one, and the toggle is right there for the rest.
  const [testedOnly, setTestedOnly] = useState(true)

  /** Rows to render. An empty `phases` still yields one row so the dialog is
   *  usable when the caller has nothing to say about phases. */
  const rows: Array<ReforgePhase | null> = useMemo(
    () => (phases && phases.length ? phases : [null]),
    [phases],
  )

  // Load the configured providers when the dialog opens. Exclude the
  // subscription CLIs — see the header note.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void fetchConfiguredCloudKeyOptions()
      .then((opts) => {
        if (cancelled) return
        const usable = opts.filter((o) => o.provider !== 'claudeCode' && o.provider !== 'codex')
        setOptions(usable)
      })
      .catch(() => {
        if (!cancelled) setOptions([])
      })
    return () => {
      cancelled = true
    }
  }, [open])

  // OpenRouter publishes its whole catalogue without auth. Without this fetch
  // the dropdown falls all the way back to STATIC_PROVIDER_MODELS — five
  // hardcoded ids whose own comment calls them a pre-fetch placeholder — so
  // every graded OpenRouter model was unreachable from this dialog.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void getOpenRouterCatalogue()
      .then((r) => {
        if (!cancelled) setOrModels(r.models.filter(isTextPipelineModel))
      })
      .catch(() => {
        /* offline: the availability-cache path still applies */
      })
    return () => {
      cancelled = true
    }
  }, [open])

  /** Grade for one model on one phase.
   *
   *  judgePhase needs a catalogue record to run its structural checks, which
   *  native provider ids (gemini-pro-latest and friends) do not have. Their
   *  measurements are still in the table, so read those directly rather than
   *  reporting a graded model as untested purely for want of a catalogue row. */
  const gradeFor = useCallback(
    (modelId: string, phase: ReforgePhase | null): Grade => {
      if (!phase) return 'untested'
      const info = orModels.find((m) => m.id === modelId)
      if (info) return judgePhase(info, phase).grade
      return MEASURED_GRADES[`${modelId}::${phase}`]?.grade ?? 'untested'
    },
    [orModels],
  )

  const setRow = useCallback((key: string, patch: Partial<{ optId: string; model: string }>) => {
    setSel((prev) => {
      const cur = prev[key] ?? { optId: '', model: '' }
      return { ...prev, [key]: { ...cur, ...patch } }
    })
  }, [])

  // Seed every row to the first provider once the options land. Kept separate
  // from the fetch so a re-open with cached options still initialises.
  useEffect(() => {
    if (!options.length) return
    const preferred = options.find((o) => o.id === 'gemini-paid') ?? options[0]
    setSel((prev) => {
      const next = { ...prev }
      for (const p of rows) {
        const key = p ?? '_'
        if (!next[key]?.optId) next[key] = { optId: preferred.id, model: next[key]?.model ?? '' }
      }
      return next
    })
  }, [options, rows])

  const confirm = () => {
    const perPhase: Partial<Record<ReforgePhase, ReforgeModelChoice>> = {}
    let primary: ReforgeModelChoice | null = null
    for (const p of rows) {
      const key = p ?? '_'
      const row = sel[key]
      const opt = options.find((o) => o.id === row?.optId)
      if (!opt || !row?.model) return
      const choice: ReforgeModelChoice = {
        provider: opt.provider,
        model: row.model,
        geminiTier: opt.geminiTier ?? 'auto',
        label: `${opt.short} · ${row.model}`,
      }
      if (p) perPhase[p] = choice
      if (!primary) primary = choice
    }
    if (!primary) return
    onConfirm({ primary, perPhase })
  }

  const ready = rows.every((p) => {
    const row = sel[p ?? '_']
    return !!row?.optId && !!row?.model
  })

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wand2 className="h-4 w-4" />
            {rows.length > 1 ? 'Choose a model per phase' : 'Choose a reforge model'}
          </DialogTitle>
          <DialogDescription>
            {rows.length > 1
              ? 'Each phase runs on its own model. Grades are for that phase specifically — the best chronicle model is not the best extras model.'
              : "Pick the provider and model to reforge on. Only providers you've configured an API key for appear here."}
          </DialogDescription>
        </DialogHeader>

        {options.length === 0 ? (
          <p className="text-sm text-amber-700 dark:text-amber-300">
            No cloud API keys configured. Add a Gemini or OpenRouter key in
            Settings → API Keys to reforge.
          </p>
        ) : (
          <div className="space-y-4">
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={testedOnly}
                onChange={(e) => setTestedOnly(e.target.checked)}
              />
              Show only models graded by the maintainer
            </label>

            <label
              className="flex items-center gap-2 text-xs text-muted-foreground"
              title={`Offers free models, models measured below the reference, and models whose id declares fewer than ${SMALL_MODEL_CEILING_B}B parameters.`}
            >
              <input
                type="checkbox"
                checked={showAllModels}
                onChange={(e) => setShowAllModels(e.target.checked)}
              />
              Show free, small and lower-performing models
            </label>

            {showAllModels && options.some((o) => o.provider === 'openrouter') && <FreeModelsNote />}

            {rows.map((phase) => {
              const key = phase ?? '_'
              const row = sel[key]
              const opt = options.find((o) => o.id === row?.optId) ?? null
              return (
                <PhaseRow
                  key={key}
                  phase={phase}
                  showHeading={rows.length > 1}
                  options={options}
                  option={opt}
                  cache={cache}
                  orModels={orModels}
                  testedOnly={testedOnly}
                  showAllModels={showAllModels}
                  gradeFor={gradeFor}
                  model={row?.model ?? ''}
                  onProvider={(id) => setRow(key, { optId: id, model: '' })}
                  onModel={(id) => setRow(key, { model: id })}
                />
              )
            })}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={confirm} disabled={!ready}>
            <Wand2 className="mr-1 h-4 w-4" /> Reforge
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** One phase's provider + model pair. Owns its own model list so each row can
 *  sit on a different provider without the others re-deriving. */
function PhaseRow(props: {
  phase: ReforgePhase | null
  showHeading: boolean
  options: CloudKeyOption[]
  option: CloudKeyOption | null
  cache: AvailabilityCache
  orModels: OpenRouterModelInfo[]
  testedOnly: boolean
  showAllModels: boolean
  gradeFor: (modelId: string, phase: ReforgePhase | null) => Grade
  model: string
  onProvider: (id: string) => void
  onModel: (id: string) => void
}) {
  const { option, cache, orModels, testedOnly, showAllModels, gradeFor, phase } = props

  const models = useMemo(() => {
    if (!option) return []
    const fromCache = availableModelsFor(option, cache)
    if (option.provider !== 'openrouter' || orModels.length === 0) return fromCache
    // Probe results still win on provenance: a model the key was verified
    // against keeps its verified tag, everything else in the catalogue is
    // offered as unverified rather than withheld.
    const verified = new Set(fromCache.filter((m) => m.verified).map((m) => m.id))
    // Whatever is already selected stays listed even when hidden by default,
    // so toggling the box off cannot silently drop the row's own choice.
    const offered = showAllModels
      ? orModels
      : orModels.filter((m) => !isHiddenFromRouting(m) || m.id === props.model)
    return offered.map((m) => ({ id: m.id, verified: verified.has(m.id) }))
  }, [option, cache, orModels, showAllModels, props.model])

  const testedCount = useMemo(
    () => models.filter((m) => MEASURED_MODEL_IDS.has(m.id)).length,
    [models],
  )

  const visible = useMemo(() => {
    // Narrowing never drops the row's current choice — the rule the show-all
    // tick already follows. Someone who unticked, chose an ungraded model and
    // ticked again has not changed their mind about the model.
    const narrowed =
      testedOnly && testedCount > 0
        ? models.filter((m) => MEASURED_MODEL_IDS.has(m.id) || m.id === props.model)
        : models
    return [...narrowed].sort((a, b) => {
      const ga = gradeFor(a.id, phase)
      const gb = gradeFor(b.id, phase)
      if (GRADE_RANK[ga] !== GRADE_RANK[gb]) return GRADE_RANK[ga] - GRADE_RANK[gb]
      const ta = MEASURED_MODEL_IDS.has(a.id)
      const tb = MEASURED_MODEL_IDS.has(b.id)
      if (ta !== tb) return ta ? -1 : 1
      if (a.verified !== b.verified) return a.verified ? -1 : 1
      return a.id.localeCompare(b.id)
    })
  }, [models, testedOnly, testedCount, gradeFor, phase, props.model])

  const groups = useMemo(
    () => (option ? groupModels(option, visible, option.label) : []),
    [option, visible],
  )

  // Keep the selection valid as the provider or filter changes. `visible` is
  // sorted best-grade-first, so [0] is the strongest candidate for THIS phase
  // rather than whatever happened to sort first.
  const { model, onModel } = props
  useEffect(() => {
    if (!visible.length) {
      if (model) onModel('')
      return
    }
    if (!visible.some((m) => m.id === model)) onModel(visible[0].id)
  }, [visible, model, onModel])

  const tier = option && model ? classifyModelTier(model, option.provider) : null
  const selId = `reforge-${phase ?? 'single'}`

  return (
    <fieldset className={props.showHeading ? 'rounded-md border border-border p-3' : ''}>
      {props.showHeading && phase && (
        <legend className="mb-2 px-1 text-sm font-medium">{PHASE_LABELS[phase]}</legend>
      )}
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor={`${selId}-provider`}>Provider</Label>
          <select
            id={`${selId}-provider`}
            className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm"
            value={option?.id ?? ''}
            onChange={(e) => props.onProvider(e.target.value)}
          >
            {props.options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor={`${selId}-model`}>Model</Label>
            <span className="text-[11px] text-muted-foreground">
              {visible.length} shown{testedCount > 0 ? ` · ${testedCount} graded` : ''}
            </span>
          </div>
          {visible.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {testedOnly
                ? 'No graded models for this provider — untick the filter above to see the full list.'
                : 'No models found. Run a probe in Settings → API Keys, then reopen this picker.'}
            </p>
          ) : (
            <select
              id={`${selId}-model`}
              className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm"
              value={model}
              onChange={(e) => onModel(e.target.value)}
            >
              {groups.map((group) => (
                <optgroup key={group.label} label={group.label}>
                  {group.models.map((m) => {
                    const g = gradeFor(m.id, phase)
                    return (
                      <option key={m.id} value={m.id}>
                        {m.id}
                        {g !== 'untested' ? ` — ${g}` : ''}
                        {m.verified ? '' : ' (unverified)'}
                      </option>
                    )
                  })}
                </optgroup>
              ))}
            </select>
          )}
          {option && hasUnverified(visible) && (
            <p className="text-xs text-muted-foreground">
              Unverified models haven't been probe-checked — run a probe in
              Settings → API Keys to confirm access.
            </p>
          )}
          {tier && TIER_NOTE[tier] && (
            <p className="text-xs text-muted-foreground">{TIER_NOTE[tier]}</p>
          )}
        </div>
      </div>
    </fieldset>
  )
}
