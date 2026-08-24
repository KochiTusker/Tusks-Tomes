// Step 4 of the Settings flow: per-phase overrides that let a single run
// mix providers — e.g. Claude on phase 1, Gemini Paid on phase 3, OpenAI
// on phase 4, or just Gemini Free phase 1 + Gemini Paid phase 3 to optimise
// cost. Defaults to the active provider's per-phase models; explicit picks
// surface a "performance may vary" override note.
//
// Collapsed by default. Works without the Local LLM add-on (cloud-only
// hybrid is fully supported); Local entries only appear when the add-on
// is loaded and probes have surfaced eligible models.

import { PhaseModelPicker } from './PhaseModelPicker'
import { PhaseRoutingRow } from './PhaseRoutingRow'
import { buildPhaseOptions, type PhaseOption } from '@/lib/phaseOptions'
import { MEASURED_GRADES } from '@/lib/phaseGrades'
import { getOpenRouterCatalogue, isTextPipelineModel } from '@/lib/openrouterModelsClient'
import type { OpenRouterModelInfo } from '@/lib/openrouterModelsClient'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, RotateCcw, Save, Workflow } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  getRouting,
  putRouting,
  type PhaseRouteEntry,
  type RoutingDocument,
} from '@/lib/routing'
import { validateRouting } from '@/lib/routingValidation'
import { stageRoutingFromPreset, type PresetPrimary } from '@/lib/routingStage'
import {
  getProfiles,
  type CloudProvider,
  type ProfilesDocument,
  type ProviderProfile,
} from '@/lib/profiles'
import {
  detectLocalBackends,
  getProbeResults,
  subscribeLocalLLM,
  type LocalBackendInfo,
  type ProbeResult,
} from '@/lib/localLLM'
import { type Phase } from '@/lib/recommendations'
import {
  getProvidersSummary,
  subscribeProviders,
  type ProvidersSummary,
} from '@/lib/providerSettings'
import {
  listConfiguredCloudKeyOptions,
  optionFromRouting,
  type CloudKeyOption,
} from '@/lib/cloudKeys'
import {
  availableModelsFor,
  groupModels,
  hasUnverified as listHasUnverified,
  optgroupLabel,
} from '@/lib/availableModels'
import { useAvailabilityCache } from '@/hooks/useAvailabilityCache'
import { RoutingPresetLadder } from './RoutingPresetLadder'
import { PhaseThinking } from './PhaseThinking'
import { ACTIVE_PROVIDER_CHANGED_EVENT, emitActiveProviderChanged } from '@/lib/appEvents'

/**
 * Phases the hybrid routing editor exposes as per-row overrides. Includes
 * `phase6` (Condense) so users can budget that step independently of the
 * Phase 3 model it would otherwise inherit.
 */
type RoutablePhase = Phase | 'phase6'
const PHASE_LABELS: Array<{ key: RoutablePhase; label: string }> = [
  { key: 'phase1', label: 'Phase 1 — Grounding' },
  { key: 'phase2', label: 'Phase 2 — Audit' },
  { key: 'phase3', label: 'Phase 3 — Chronicle' },
  { key: 'phase4', label: 'Phase 4 — Extras' },
  { key: 'phase6', label: 'Phase 6 — Condense' },
]

const DEFAULT_VALUE = '__default__'
const LOCAL_PREFIX = 'local::'
const CLOUD_PREFIX = 'cloud::'

/**
 * Encode a (provider, model) tuple as the value of a <select> option.
 * Keeps the dropdown a single control instead of needing two cascading
 * selects.
 */
function encodeCloudValue(option: CloudKeyOption, modelId: string): string {
  return `${CLOUD_PREFIX}${option.id}::${modelId}`
}

function encodeLocalValue(probe: ProbeResult): string {
  return `${LOCAL_PREFIX}${probe.baseUrl}::${probe.modelId}`
}

type DecodedSelection =
  | { kind: 'default' }
  | {
      kind: 'cloud'
      option: CloudKeyOption
      modelId: string
    }
  | { kind: 'local'; baseUrl: string; modelId: string }

function decodeValue(
  value: string,
  options: CloudKeyOption[]
): DecodedSelection | null {
  if (value === DEFAULT_VALUE) return { kind: 'default' }
  if (value.startsWith(LOCAL_PREFIX)) {
    const rest = value.slice(LOCAL_PREFIX.length)
    const idx = rest.indexOf('::')
    if (idx < 0) return null
    return {
      kind: 'local',
      baseUrl: rest.slice(0, idx),
      modelId: rest.slice(idx + 2),
    }
  }
  if (value.startsWith(CLOUD_PREFIX)) {
    const rest = value.slice(CLOUD_PREFIX.length)
    const idx = rest.indexOf('::')
    if (idx < 0) return null
    const id = rest.slice(0, idx)
    const modelId = rest.slice(idx + 2)
    const option = options.find((o) => o.id === id)
    if (!option) return null
    return { kind: 'cloud', option, modelId }
  }
  return null
}

function modelKey(phase: RoutablePhase): keyof ProviderProfile {
  switch (phase) {
    case 'phase1':
      return 'phase1Model'
    case 'phase2':
      return 'phase2Model'
    case 'phase3':
      return 'phase3Model'
    case 'phase4':
      return 'phase4Model'
    case 'phase6':
      return 'phase6Model'
  }
}

function defaultModelFor(profile: ProviderProfile, phase: RoutablePhase): string {
  if (phase === 'phase6') {
    // Phase 6 is optional in the profile — fall back to phase 3's model.
    return (profile.phase6Model ?? profile.phase3Model) as string
  }
  return profile[modelKey(phase)] as string
}

/**
 * Resolve a stored PhaseRouteEntry to the matching CloudKeyOption.id used
 * by the dropdown's encoded option values. Crucial for Gemini, where the
 * same `cloudProvider: 'gemini'` resolves to either `gemini-paid` or
 * `gemini-free` depending on the entry's `geminiTier`. Without this, the
 * dropdown value (encoded with the bare provider name) wouldn't match any
 * option (encoded with the tier-aware id), and the browser would silently
 * select the first option — `__default__` — leaving the user unable to see
 * what they're about to save (a display bug the tier-aware ids fixed).
 */
function optionIdForEntry(
  entry: PhaseRouteEntry,
  options: CloudKeyOption[],
  fallback: CloudKeyOption,
): string {
  if (entry.target !== 'cloud') return fallback.id
  const provider = entry.cloudProvider ?? fallback.provider
  const match = options.find((o) => {
    if (o.provider !== provider) return false
    if (provider !== 'gemini') return true
    const wantTier = entry.geminiTier === 'free' ? 'free' : 'paid'
    return o.geminiTier === wantTier
  })
  return (match ?? fallback).id
}

/**
 * Translate the stored routing entry back to the <select> value. Empty /
 * absent → default. Cloud entries map to encodeCloudValue (with the
 * inherited provider + model substituted when fields are absent). Local
 * entries map to encodeLocalValue.
 */
function entryToValue(
  entry: PhaseRouteEntry | undefined,
  activeOption: CloudKeyOption | null,
  profile: ProviderProfile | null,
  phase: RoutablePhase,
  cloudKeyOptions: CloudKeyOption[],
): string {
  if (!entry) return DEFAULT_VALUE
  if (entry.target === 'local') {
    return `${LOCAL_PREFIX}${entry.baseUrl ?? ''}::${entry.modelId}`
  }
  if (entry.target === 'cloud') {
    const hasProviderOverride = !!entry.cloudProvider
    const hasModelOverride = !!entry.modelId
    if (!hasProviderOverride && !hasModelOverride) return DEFAULT_VALUE
    if (!activeOption || !profile) return DEFAULT_VALUE
    const optionId = optionIdForEntry(entry, cloudKeyOptions, activeOption)
    return `${CLOUD_PREFIX}${optionId}::${
      entry.modelId ?? defaultModelFor(profile, phase)
    }`
  }
  return DEFAULT_VALUE
}

/**
 * The HybridRoutingEditor's optgroup composition. Returned as a flat list
 * of groups so the JSX stays readable.
 */
type DropdownGroup = {
  label: string
  options: Array<{ value: string; label: string; paid?: boolean; verified?: boolean }>
}

export function HybridRoutingEditor() {
  // Which phase, if any, currently has the full OpenRouter browser open. Only
  // one at a time: the panel is tall, and two open at once buries the phase
  // rows between them.
  const [pickerPhase, setPickerPhase] = useState<RoutablePhase | null>(null)
  // Local models appear when a probe has actually found some — detection,
  // not an add-on gate. `probes` is loaded (and re-subscribed) below.

  const [routing, setRouting] = useState<RoutingDocument | null>(null)
  const [profiles, setProfiles] = useState<ProfilesDocument | null>(null)
  const [providers, setProviders] = useState<ProvidersSummary | null>(null)
  const [activeOption, setActiveOption] = useState<CloudKeyOption | null>(null)
  const [probes, setProbes] = useState<ProbeResult[]>([])
  const [backends, setBackends] = useState<LocalBackendInfo[]>([])
  // Probe-driven dropdown source. Auto-refreshes when any key is probed,
  // saved, deleted, or the Active Provider flips. The previous direct
  // `listGeminiModelAvailability()` + `STATIC_PROVIDER_MODELS` paths are
  // replaced — see `availableModelsFor` for the precedence chain.
  const { cache: availabilityCache } = useAvailabilityCache()

  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  const loadAll = useCallback(async () => {
    try {
      const [r, p, prov, profs, b] = await Promise.all([
        getRouting(),
        getProbeResults().catch(() => [] as ProbeResult[]),
        getProvidersSummary().catch(() => null),
        getProfiles().catch(() => null),
        detectLocalBackends().catch(() => [] as LocalBackendInfo[]),
      ])
      setRouting(r)
      setProbes(p)
      setProviders(prov)
      setProfiles(profs)
      setBackends(b)
      const opts = listConfiguredCloudKeyOptions(prov)
      const match = optionFromRouting(opts, r.lastSelectedProvider, r.geminiTier)
      setActiveOption(match ?? opts[0] ?? null)
    } catch (err) {
      toast.error(`Failed to load routing: ${(err as Error).message}`)
    }
  }, [])

  useEffect(() => {
    void loadAll()
  }, [loadAll])

  // Gemini model availability used to live here in its own useEffect via
  // listGeminiModelAvailability / listAvailableModelsForTier. Replaced
  // with useAvailabilityCache() above — same source-of-truth as
  // sessions.ts:geminiPaidOnlyModels, automatically refreshed on probe.

  useEffect(() => {
    return subscribeLocalLLM(() => {
      Promise.all([
        getProbeResults().catch(() => probes),
        detectLocalBackends().catch(() => backends),
      ]).then(([p, b]) => {
        setProbes(p)
        setBackends(b)
      })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const unsub = subscribeProviders(() => void loadAll())
    const onActive = () => void loadAll()
    window.addEventListener(ACTIVE_PROVIDER_CHANGED_EVENT, onActive)
    return () => {
      unsub()
      window.removeEventListener(ACTIVE_PROVIDER_CHANGED_EVENT, onActive)
    }
  }, [loadAll])

  const cloudKeyOptions = useMemo<CloudKeyOption[]>(
    () => listConfiguredCloudKeyOptions(providers),
    [providers]
  )

  const openrouterConfigured = useMemo(
    () => cloudKeyOptions.some((o) => o.provider === 'openrouter'),
    [cloudKeyOptions],
  )

  // The OpenRouter catalogue is public and key-less, so it loads regardless of
  // whether a key is configured — but its models are only OFFERED when one is,
  // since picking a model you cannot call is not a choice.
  const [orModels, setOrModels] = useState<OpenRouterModelInfo[]>([])
  useEffect(() => {
    if (!openrouterConfigured) {
      setOrModels([])
      return
    }
    let alive = true
    getOpenRouterCatalogue().then((r) => {
      if (alive) setOrModels(r.models.filter(isTextPipelineModel))
    })
    return () => {
      alive = false
    }
  }, [openrouterConfigured])

  const optionsFor = useMemo(() => {
    const cache = new Map<RoutablePhase, PhaseOption[]>()
    return (phase: RoutablePhase): PhaseOption[] => {
      const hit = cache.get(phase)
      if (hit) return hit
      const built = buildPhaseOptions({
        phase,
        cloudKeyOptions,
        availability: availabilityCache,
        openRouterModels: orModels,
        localProbes: probes.map((p) => ({
          modelId: p.modelId,
          backend: p.backend,
          baseUrl: p.baseUrl,
          eligible: p.eligible as unknown as Record<string, boolean>,
        })),
        measuredGrades: MEASURED_GRADES,
      })
      cache.set(phase, built)
      return built
    }
  }, [cloudKeyOptions, availabilityCache, orModels, probes])

  /** Build the optgroups for the per-phase dropdown. Cloud groups come from
   *  `availableModelsFor(option, cache)` so every entry reflects either the
   *  probe-certified "accessible" list (gold standard) or the provider's
   *  advertised list with an `(unverified)` flag. STATIC_PROVIDER_MODELS is
   *  the last-resort fallback for Claude/OpenAI when no probe has run.
   *  Gemini options split further into Pro / Flash / Flash Lite /
   *  Uncategorised via `groupModels`. Cloud groups first, then Local. */
  const dropdownGroups = useMemo<DropdownGroup[]>(() => {
    const groups: DropdownGroup[] = []
    for (const option of cloudKeyOptions) {
      const models = availableModelsFor(option, availabilityCache)
      const baseLabel = optgroupLabel(option, availabilityCache)
      for (const group of groupModels(option, models, baseLabel)) {
        groups.push({
          label: group.label,
          options: group.models.map((m) => ({
            value: encodeCloudValue(option, m.id),
            // Append (unverified) suffix when the entry came from the
            // advertised-only or static-fallback paths so the user knows
            // the dropdown is making an educated guess.
            label: m.verified ? m.id : `${m.id} (unverified)`,
            verified: m.verified,
            // Legacy 'paid' flag — kept as a soft signal for the Gemini
            // Free row's downstream UI. Today's accessible-only filter
            // means a Free option that actually appears IS accessible by
            // definition, so paid stays false here.
            paid: false,
          })),
        })
      }
    }
    if (probes.length > 0) {
      // Local optgroup — populated from probe results. Phase-eligibility
      // filtering is done per row below since each phase has different
      // capability needs.
      groups.push({
        label: 'Local runners',
        options: [], // filled in per-row
      })
    }
    return groups
  }, [cloudKeyOptions, availabilityCache, probes])

  /** True iff any cloud option in the current dropdown is unverified.
   *  Drives the inline "Run Probe in Settings → API Keys" hint. */
  const dropdownHasUnverified = useMemo(() => {
    return cloudKeyOptions.some((option) =>
      listHasUnverified(availableModelsFor(option, availabilityCache)),
    )
  }, [cloudKeyOptions, availabilityCache])

  function setEntry(phase: RoutablePhase, entry: PhaseRouteEntry | undefined) {
    if (!routing) return
    const nextPerPhase = { ...(routing.perPhase ?? {}) }
    if (entry === undefined) {
      delete nextPerPhase[phase]
    } else {
      nextPerPhase[phase] = entry
    }
    setRouting({
      ...routing,
      version: 3,
      perPhase: nextPerPhase,
    })
    setDirty(true)
  }

  function handleChange(phase: RoutablePhase, value: string) {
    const decoded = decodeValue(value, cloudKeyOptions)
    if (!decoded) return
    if (decoded.kind === 'default') {
      setEntry(phase, undefined)
      return
    }
    if (decoded.kind === 'local') {
      setEntry(phase, {
        target: 'local',
        modelId: decoded.modelId,
        baseUrl: decoded.baseUrl,
      })
      return
    }
    // Cloud override — store provider, tier (gemini only), and model.
    const opt = decoded.option
    setEntry(phase, {
      target: 'cloud',
      cloudProvider: opt.provider,
      geminiTier: opt.provider === 'gemini' ? opt.geminiTier ?? 'auto' : undefined,
      modelId: decoded.modelId,
    })
  }

  /** Stage a preset-ladder recipe. Deliberately does NOT auto-save:
   *  the recipe lands in the same dirty-state review flow as manual
   *  edits, and the Save button commits it. The staging helper writes
   *  lastSelectedProvider from the plan's primary — it must never be
   *  left null by an apply (run start and resume both read it). */
  function applyPreset(
    perPhase: NonNullable<RoutingDocument['perPhase']>,
    presetLabel: string,
    primary: PresetPrimary,
  ) {
    setRouting(stageRoutingFromPreset(routing, perPhase, primary))
    setDirty(true)
    toast.message(`${presetLabel} staged — review and Save to commit.`)
  }

  function clearOverrides() {
    if (!routing) return
    setRouting({
      version: 3,
      lastSelectedProvider: routing.lastSelectedProvider,
      geminiTier: routing.geminiTier,
      perPhase: {},
    })
    setDirty(true)
    toast.message('Per-phase overrides cleared. Save to commit.')
  }

  async function save() {
    if (!routing) return
    setSaving(true)
    try {
      const saved = await putRouting(routing)
      // Strip the warnings field before storing — RoutingDocument's
      // shape doesn't include it and downstream consumers shouldn't see it.
      const { warnings, ...doc } = saved
      setRouting(doc)
      setDirty(false)
      // The effective per-phase routing just changed — every surface that
      // shows "what will run" (the phase rail, the models link, the
      // availability cache) refreshes off this event.
      emitActiveProviderChanged()
      if (warnings && warnings.length > 0) {
        toast.warning('Routing saved with warnings.', {
          description: warnings.join(' '),
          duration: 10_000,
        })
      } else {
        toast.success('Routing saved.')
      }
    } catch (err) {
      toast.error(`Save failed: ${(err as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  const profile = activeOption && profiles ? profiles.profiles[activeOption.provider] : null
  const noKeysConfigured = providers !== null && cloudKeyOptions.length === 0

  // Stage 2 — live validation of the current routing draft. Recomputes
  // whenever the user edits anything. hasErrors gates the Save button.
  const validation = useMemo(() => validateRouting(routing), [routing])

  // Auto-expand for two cases where the user will probably want to see
  // the editor:
  //   1. They already have per-phase overrides saved — keeping it
  //      collapsed would hide their own config behind a disclosure.
  //   2. Both Paid AND Free Gemini keys are configured — that pairing is
  //      the canonical mix-and-match use case (cheap Free Flash for
  //      grounding, Paid Pro for chronicle), so the user is almost
  //      certainly here to wire it up. Anything else stays collapsed so
  //      the Settings tab doesn't grow another 600px of dropdowns for
  //      users who don't need them.
  const hasPaidGemini = providers?.configured?.includes('gemini') ?? false
  const hasFreeGemini = providers?.configured?.includes('geminiFallback') ?? false
  const hasPerPhaseOverrides =
    !!routing?.perPhase && Object.keys(routing.perPhase).length > 0
  const autoExpand = hasPerPhaseOverrides || (hasPaidGemini && hasFreeGemini)
  return (
    <details
      id="hybrid-routing"
      open={autoExpand}
      className="rounded-md border border-border bg-card/40 p-4"
    >
      <summary className="flex cursor-pointer items-center gap-2 font-display text-sm uppercase tracking-wider">
        <Workflow className="h-4 w-4" />
        Plan &amp; routing
        <span className="text-xs font-normal normal-case text-muted-foreground">
          — Pick a plan, or set each phase's model yourself.
        </span>
      </summary>
      <div className="mt-4 space-y-4">
        <RoutingPresetLadder
          providers={providers}
          activeProvider={activeOption?.provider ?? routing?.lastSelectedProvider ?? null}
          currentPerPhase={routing?.perPhase ?? null}
          onApply={applyPreset}
        />

        {/* One toolbar, one Save. Applying a rung or editing a phase both
            land in the same dirty-state review; there is no second commit
            path to lose an edit in. */}
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!routing?.perPhase || Object.keys(routing.perPhase).length === 0}
            onClick={clearOverrides}
            title="Reset every phase back to its default routing"
          >
            <RotateCcw className="mr-2 h-4 w-4" />
            Clear overrides
          </Button>
          <Button
            variant="default"
            size="sm"
            disabled={!dirty || saving || validation.hasErrors}
            onClick={save}
            title={validation.hasErrors ? 'Fix the errors below before saving.' : undefined}
          >
            <Save className="mr-2 h-4 w-4" />
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>

        {/* Stage 2 — live validation warnings. Renders above the per-phase rows
            so user sees them as they edit. Errors block Save; warnings are
            informational. */}
        {!validation.clean && (
          <div className="space-y-2">
            {validation.findings.map((f, i) => {
              const isErr = f.severity === 'error'
              return (
                <div
                  key={i}
                  className={`flex items-start gap-2 rounded-md border p-3 text-xs ${
                    isErr
                      ? 'border-destructive/40 bg-destructive/5 text-destructive'
                      : 'border-amber-500/40 bg-amber-50 text-amber-900 dark:bg-amber-950/30 dark:text-amber-100'
                  }`}
                >
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <div className="space-y-1">
                    <div className="font-medium">{f.title}</div>
                    <div className="opacity-90">{f.detail}</div>
                    {f.remedy && <div className="italic opacity-80">→ {f.remedy}</div>}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {noKeysConfigured && (
          <p className="text-xs text-destructive">
            No cloud API key configured. Add one in the API Keys card above to
            enable per-phase overrides.
          </p>
        )}

        {/* Depth two: the per-phase rows, one disclosure away — never a
            separate mode. The expert control sits directly beneath the
            plans that summarise it, so expanding adds to the page instead
            of replacing it. */}
        {routing && profile && cloudKeyOptions.length > 0 && (
        <details className="rounded-md border border-border/70 bg-card/30 p-3" open={hasPerPhaseOverrides}>
          <summary className="cursor-pointer text-sm font-medium">
            Customise phases
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              — override the model for a single phase; the plans above set the rest.
            </span>
          </summary>
          <div className="reveal-on-open mt-3 space-y-3">
          <p className="text-xs text-muted-foreground">
            Each phase defaults to the model your active provider would run.
            Pick a different option to override a single phase — useful for
            running cheaper models on simpler phases, or splitting between
            Gemini Free and Paid to lower costs. {probes.length > 0 ? 'Local models appear in the dropdown when probed eligible.' : 'Start Ollama, LM Studio or Unsloth and probe it in the Local LLMs panel to route phases to a local model.'}
          </p>

        {dropdownHasUnverified && (
          <div className="rounded border border-amber-500/40 bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
            <strong>Some model entries are unverified.</strong> The dropdowns
            below include models the provider's catalog advertises but that
            haven't been confirmed accessible with your key yet. Run{' '}
            <strong>Probe</strong> on each row in the <em>API Keys</em> card
            above to filter the dropdown down to only models that actually
            work with your key.
          </div>
        )}

        {(
          <div className="space-y-2">
            {PHASE_LABELS.map((row) => {
              const entry = routing.perPhase?.[row.key]
              const isOverride = entry !== undefined
              const opts = optionsFor(row.key)

              // What is ACTUALLY going to run: the override if there is one,
              // otherwise the active provider's profile model for this phase.
              const effectiveModelId =
                entry?.modelId ??
                (entry?.target === 'local' ? entry.modelId : defaultModelFor(profile, row.key))
              const effectiveProviderLabel =
                entry?.target === 'local'
                  ? 'Local'
                  : entry?.cloudProvider
                    ? (cloudKeyOptions.find((o) => o.provider === entry.cloudProvider)?.short ??
                       entry.cloudProvider)
                    : (activeOption?.short ?? 'no key')
              const effective = opts.find((o) => o.modelId === effectiveModelId)

              return (
                <PhaseRoutingRow
                  key={row.key}
                  phase={row.key}
                  effectiveModelId={effectiveModelId}
                  effectiveProviderLabel={effectiveProviderLabel}
                  effective={effective}
                  overridden={isOverride}
                  open={pickerPhase === row.key}
                  onToggle={() =>
                    setPickerPhase((cur) => (cur === row.key ? null : row.key))
                  }
                  onReset={() => setEntry(row.key, undefined)}
                >
                  <PhaseModelPicker
                    phase={row.key}
                    options={opts}
                    value={effective?.key ?? null}
                    onSelect={(o) => {
                      setEntry(
                        row.key,
                        o.provider === 'local'
                          ? { target: 'local', modelId: o.modelId, baseUrl: o.baseUrl }
                          : {
                              target: 'cloud',
                              cloudProvider: o.provider,
                              geminiTier:
                                o.provider === 'gemini'
                                  ? (cloudKeyOptions.find((c) => c.id.startsWith('gemini') && c.provider === 'gemini')
                                      ?.geminiTier ?? 'auto')
                                  : undefined,
                              modelId: o.modelId,
                            },
                      )
                      setPickerPhase(null)
                    }}
                    onCancel={() => setPickerPhase(null)}
                  />
                </PhaseRoutingRow>
              )
            })}
          </div>
        )}
          {/* Reasoning is a property of a phase; it lives beside the rows
              that pick the phase's model, not in a separate tuning card. */}
          <PhaseThinking />
          </div>
        </details>
        )}
      </div>
    </details>
  )
}
