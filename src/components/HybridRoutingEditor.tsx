// Step 4 of the Settings flow: per-phase overrides that let a single run
// mix providers — e.g. Claude on phase 1, Gemini Paid on phase 3, OpenAI
// on phase 4, or just Gemini Free phase 1 + Gemini Paid phase 3 to optimise
// cost. Defaults to "match Model Profiles" for every phase; explicit picks
// surface a "performance may vary" override note.
//
// Collapsed by default. Works without the Local LLM add-on (cloud-only
// hybrid is fully supported); Local entries only appear when the add-on
// is loaded and probes have surfaced eligible models.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, PiggyBank, RotateCcw, Save, Sparkles, Workflow } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  getRouting,
  putRouting,
  type PhaseRouteEntry,
  type RoutingDocument,
} from '@/lib/routing'
import { validateRouting } from '@/lib/routingValidation'
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
import { getSystemInfo, type SystemInfo } from '@/lib/system'
import { recommendRouting, type Phase } from '@/lib/recommendations'
import {
  BUDGET_FAST_MODELS,
  GEMINI_SMART_BUDGET_SUMMARY,
  GEMINI_SMART_BUDGET_SAVING_PCT,
  buildBudgetModePerPhase,
  buildGeminiSmartBudgetPerPhase,
} from '@/lib/budgetMode'
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
  hasUnverified as listHasUnverified,
  optgroupLabel,
} from '@/lib/availableModels'
import { useAvailabilityCache } from '@/hooks/useAvailabilityCache'
import { RoutingPresetLadder } from './RoutingPresetLadder'
import { ModelProfileEditor } from './ModelProfileEditor'
import { safeGet, safeSet } from '@/lib/storage'
import { useAddons } from '@/contexts/AddonContext'
import { ACTIVE_PROVIDER_CHANGED_EVENT } from './ActiveProviderCard'

/**
 * Phases the hybrid routing editor exposes as per-row overrides. Includes
 * `phase6` (Condense) so users can budget that step independently — the
 * recommendation system (`recommendRouting`) only knows phases 1-4, so we
 * skip phase6 in `applyRecommendations`.
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
 * what they're about to save (the Smart Budget display bug).
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
  const { isLoaded } = useAddons()
  const localLlmLoaded = isLoaded('local-llm-addon')

  const [routing, setRouting] = useState<RoutingDocument | null>(null)
  const [profiles, setProfiles] = useState<ProfilesDocument | null>(null)
  const [providers, setProviders] = useState<ProvidersSummary | null>(null)
  const [activeOption, setActiveOption] = useState<CloudKeyOption | null>(null)
  const [probes, setProbes] = useState<ProbeResult[]>([])
  const [backends, setBackends] = useState<LocalBackendInfo[]>([])
  const [specs, setSpecs] = useState<SystemInfo | null>(null)
  // Probe-driven dropdown source. Auto-refreshes when any key is probed,
  // saved, deleted, or the Active Provider flips. The previous direct
  // `listGeminiModelAvailability()` + `STATIC_PROVIDER_MODELS` paths are
  // replaced — see `availableModelsFor` for the precedence chain.
  const { cache: availabilityCache } = useAvailabilityCache()

  // Advanced-routing tickbox. OFF (default) shows the guided preset ladder;
  // ON reveals the per-phase model pickers below. Pure UI preference —
  // persisted client-side, never part of routing.json (the server's strict
  // validator owns that file's schema).
  const [advancedRouting, setAdvancedRoutingState] = useState<boolean>(() =>
    safeGet('routing_advanced_mode', false),
  )
  const setAdvancedRouting = (next: boolean) => {
    setAdvancedRoutingState(next)
    safeSet('routing_advanced_mode', next)
  }
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  const loadAll = useCallback(async () => {
    try {
      const [r, p, prov, profs, b, s] = await Promise.all([
        getRouting(),
        getProbeResults().catch(() => [] as ProbeResult[]),
        getProvidersSummary().catch(() => null),
        getProfiles().catch(() => null),
        detectLocalBackends().catch(() => [] as LocalBackendInfo[]),
        getSystemInfo().catch(() => null),
      ])
      setRouting(r)
      setProbes(p)
      setProviders(prov)
      setProfiles(profs)
      setBackends(b)
      setSpecs(s)
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

  /** Build the optgroups for the per-phase dropdown. Cloud groups come from
   *  `availableModelsFor(option, cache)` so every entry reflects either the
   *  probe-certified "accessible" list (gold standard) or the provider's
   *  advertised list with an `(unverified)` flag. STATIC_PROVIDER_MODELS is
   *  the last-resort fallback for Claude/OpenAI when no probe has run.
   *  Cloud groups first, then Local. */
  const dropdownGroups = useMemo<DropdownGroup[]>(() => {
    const groups: DropdownGroup[] = []
    for (const option of cloudKeyOptions) {
      const models = availableModelsFor(option, availabilityCache)
      groups.push({
        label: optgroupLabel(option, availabilityCache),
        options: models.map((m) => ({
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
    if (localLlmLoaded) {
      // Local optgroup — populated from probe results. Phase-eligibility
      // filtering is done per row below since each phase has different
      // capability needs.
      groups.push({
        label: 'Local (add-on)',
        options: [], // filled in per-row
      })
    }
    return groups
  }, [cloudKeyOptions, availabilityCache, localLlmLoaded])

  /** True iff any cloud option in the current dropdown is unverified.
   *  Drives the inline "Run Probe in Settings → API Keys" hint. */
  const dropdownHasUnverified = useMemo(() => {
    return cloudKeyOptions.some((option) =>
      listHasUnverified(availableModelsFor(option, availabilityCache)),
    )
  }, [cloudKeyOptions, availabilityCache])

  const recommendations = useMemo(() => {
    const detectedModels = backends.flatMap((backend) =>
      backend.reachable
        ? backend.models.map((modelId) => ({ modelId, baseUrl: backend.baseUrl }))
        : []
    )
    return recommendRouting({ probes, detectedModels, specs })
  }, [probes, backends, specs])

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

  function applyRecommendations() {
    if (!routing) return
    const perPhase: NonNullable<RoutingDocument['perPhase']> = {}
    for (const { key } of PHASE_LABELS) {
      // recommendRouting only knows phases 1-4; phase 6 has no recommendation,
      // so it stays at the default (inherit phase 3 model).
      if (key === 'phase6') continue
      const rec = recommendations[key]
      if (rec.kind === 'local') {
        perPhase[key] = { target: 'local', modelId: rec.modelId }
      }
      // Cloud recommendations are left as default (no override).
    }
    setRouting({
      version: 3,
      lastSelectedProvider: routing.lastSelectedProvider,
      geminiTier: routing.geminiTier,
      perPhase,
    })
    setDirty(true)
    toast.message('Recommendations applied — review and Save to commit.')
  }

  /** Stage a preset-ladder recipe. Deliberately does NOT auto-save:
   *  the recipe lands in the same dirty-state review flow as manual
   *  edits, and the Save button commits it. */
  function applyPreset(
    perPhase: NonNullable<RoutingDocument['perPhase']>,
    presetLabel: string,
  ) {
    if (!routing) return
    setRouting({
      version: 3,
      lastSelectedProvider: routing.lastSelectedProvider,
      geminiTier: routing.geminiTier,
      perPhase,
    })
    setDirty(true)
    toast.message(`${presetLabel} staged - review and Save to commit.`)
  }

  function applyBudgetMode() {
    if (!routing || !activeOption) return
    const perPhase = buildBudgetModePerPhase(activeOption.provider, routing.geminiTier)
    setRouting({
      version: 3,
      lastSelectedProvider: routing.lastSelectedProvider,
      geminiTier: routing.geminiTier,
      perPhase,
    })
    setDirty(true)
    toast.message(
      `Budget mode: every phase routed to ${BUDGET_FAST_MODELS[activeOption.provider]}. Review and Save to commit.`,
    )
  }

  /**
   * Apply the Gemini Smart Budget recommendation — Free Flash for
   * grounding/audit, Paid Pro for chronicle, Paid Flash-Lite for
   * extras/condense. Projected ~75% cheaper than Paid-Pro-everywhere;
   * accuracy of this exact split is not yet empirically validated
   * (T4.3 deferred). See GEMINI_SMART_BUDGET_SUMMARY for caveats.
   */
  function applyGeminiSmartBudget() {
    if (!routing || !activeOption || activeOption.provider !== 'gemini') return
    const perPhase = buildGeminiSmartBudgetPerPhase(activeOption.provider)
    if (!perPhase) return
    setRouting({
      version: 3,
      lastSelectedProvider: routing.lastSelectedProvider,
      // Smart Budget pins each phase explicitly; leave the global tier
      // alone so it still reflects the user's preference (e.g. 'paid').
      // The perPhase entries override it for each routed phase.
      geminiTier: routing.geminiTier,
      perPhase,
    })
    setDirty(true)
    toast.success(
      'Gemini Smart Budget applied: Free Flash for grounding, Paid Flash for audit (dilutes mature-content filter), Paid Pro for chronicle, Paid Flash-Lite for extras + condense. Save to commit.',
      { duration: 8_000 },
    )
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
      if (warnings && warnings.length > 0) {
        toast.warning('Hybrid routing saved with warnings.', {
          description: warnings.join(' '),
          duration: 10_000,
        })
      } else {
        toast.success('Hybrid routing saved.')
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
        Hybrid routing
        <span className="text-xs font-normal normal-case text-muted-foreground">
          — Mix providers / models / Gemini tiers per phase.
        </span>
      </summary>
      <div className="mt-4 space-y-4">
        <label className="flex cursor-pointer items-start gap-3 rounded-md border bg-card p-3 hover:bg-muted/30">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 shrink-0"
            checked={advancedRouting}
            onChange={(e) => setAdvancedRouting(e.target.checked)}
          />
          <div className="space-y-1 text-sm">
            <div className="font-medium">Advanced routing</div>
            <div className="text-xs text-muted-foreground">
              Pick individual providers and models for each phase. Leave off for
              guided presets ranked by cost saving - the legacy preset buttons
              (Smart Budget, Budget mode) remain available in advanced view.
            </div>
          </div>
        </label>

        {!advancedRouting && (
          <>
            <RoutingPresetLadder
              providers={providers}
              activeProvider={activeOption?.provider ?? routing?.lastSelectedProvider ?? null}
              currentPerPhase={routing?.perPhase ?? null}
              onApply={applyPreset}
            />
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
                {saving ? 'Saving...' : 'Save'}
              </Button>
            </div>
          </>
        )}

        {advancedRouting && (
        <div className="flex items-start justify-between gap-4">
          <p className="text-xs text-muted-foreground">
            Each phase defaults to your Active Provider's Model Profile. Pick a
            different option to override a single phase — useful for running
            cheaper models on simpler phases or splitting between Gemini Free
            and Paid to lower costs. {localLlmLoaded ? 'Local models appear in the dropdown when probed eligible.' : 'Install the Local LLMs add-on to route phases to Ollama / LM Studio / Unsloth.'}
          </p>
          {activeOption?.provider === 'gemini' && hasPaidGemini && hasFreeGemini && (
            <div className="mt-2 rounded-md border border-primary/30 bg-primary/5 p-2 text-xs">
              <p className="font-medium text-primary">💡 Recommended for Gemini users with both keys:</p>
              <p className="mt-1 text-muted-foreground">
                Click <strong>Smart Budget</strong> above to apply the recommended hybrid configuration —
                Free Flash for Phase 1 grounding ($0), <strong>Paid Flash</strong> for Phase 2 audit (bigger
                chunks dilute Gemini's PROHIBITED_CONTENT meta-filter — see{' '}
                <code className="rounded bg-muted px-1">.diagnose/brody-bisect-*.json</code>), Paid Pro for
                Phase 3 chronicle (the quality phase), Paid Flash-Lite for Phase 4 + 6 extras/condense.
                <strong> Projected ~72 % cheaper</strong> than Paid Pro on every phase. Blocked chunks
                still get rescued by the Layer B chunk-fusion fallback (no content lost).
              </p>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {localLlmLoaded && (
              <Button variant="outline" size="sm" onClick={applyRecommendations}>
                <Sparkles className="mr-2 h-4 w-4" />
                Apply recommendations
              </Button>
            )}
            {/* Smart Budget — Gemini-only preset, recommended when both
                Paid + Free Gemini keys are configured. Cost projection
                is extrapolated; see GEMINI_SMART_BUDGET_SUMMARY for the
                accuracy caveat. */}
            {activeOption?.provider === 'gemini' && hasPaidGemini && hasFreeGemini && (
              <Button
                variant="default"
                size="sm"
                onClick={applyGeminiSmartBudget}
                title={`${GEMINI_SMART_BUDGET_SUMMARY} Roughly ${GEMINI_SMART_BUDGET_SAVING_PCT}% cheaper than All-Pro.`}
              >
                <Sparkles className="mr-2 h-4 w-4" />
                Smart Budget (legacy)
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={!activeOption}
              onClick={applyBudgetMode}
              title={
                activeOption
                  ? `Route every phase to ${BUDGET_FAST_MODELS[activeOption.provider]} for lower cost. Quality may vary on long-form prose phases. (For Gemini, prefer "Smart Budget" if you have both Paid + Free keys — it preserves chronicle quality.)`
                  : 'Pick an active provider first'
              }
            >
              <PiggyBank className="mr-2 h-4 w-4" />
              Budget mode
            </Button>
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
        </div>

        )}

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

        {advancedRouting && noKeysConfigured && (
          <p className="text-xs text-destructive">
            No cloud API key configured. Add one in the API Keys card above to
            enable per-phase overrides.
          </p>
        )}

        {advancedRouting && routing && profile && cloudKeyOptions.length > 0 && dropdownHasUnverified && (
          <div className="rounded border border-amber-500/40 bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
            <strong>Some model entries are unverified.</strong> The dropdowns
            below include models the provider's catalog advertises but that
            haven't been confirmed accessible with your key yet. Run{' '}
            <strong>Probe</strong> on each row in the <em>API Keys</em> card
            above to filter the dropdown down to only models that actually
            work with your key.
          </div>
        )}

        {/* Per-phase DEFAULTS. Sits directly above the per-phase overrides
            so the relationship is visible: profiles set the default, the
            rows below override it for a single phase. */}
        {advancedRouting && <ModelProfileEditor />}

        {advancedRouting && routing && profile && cloudKeyOptions.length > 0 && (
          <div className="space-y-3">
            {PHASE_LABELS.map((row) => {
              const entry = routing.perPhase?.[row.key]
              const value = entryToValue(entry, activeOption, profile, row.key, cloudKeyOptions)
              const isOverride = value !== DEFAULT_VALUE

              // Phase 6 isn't represented in the probe-eligibility table or
              // the recommendations map. Reuse phase 3's eligibility (both
              // produce long-form prose) and skip the recommendation hint.
              const eligibilityPhase = row.key === 'phase6' ? 'phase3' : row.key
              const localOptionsForPhase = localLlmLoaded
                ? probes
                    .filter((p) => p.eligible[eligibilityPhase])
                    .map((p) => ({
                      value: encodeLocalValue(p),
                      label: `${p.modelId} (${p.backend})`,
                    }))
                : []

              const rec = row.key === 'phase6' ? null : recommendations[row.key]
              return (
                <div key={row.key} className="space-y-1">
                  <div className="grid grid-cols-1 gap-2 md:grid-cols-[1fr_2fr]">
                    <Label htmlFor={`route-${row.key}`} className="self-center">
                      {row.label}
                    </Label>
                    <select
                      id={`route-${row.key}`}
                      value={value}
                      onChange={(e) => handleChange(row.key, e.target.value)}
                      className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm"
                    >
                      <option value={DEFAULT_VALUE}>
                        Default (match Model Profile —{' '}
                        {activeOption?.short ?? 'no key'} ·{' '}
                        {defaultModelFor(profile, row.key)})
                      </option>
                      {dropdownGroups.map((group) =>
                        group.label === 'Local (add-on)' ? (
                          localOptionsForPhase.length > 0 ? (
                            <optgroup key={group.label} label={group.label}>
                              {localOptionsForPhase.map((opt) => (
                                <option key={opt.value} value={opt.value}>
                                  {opt.label}
                                </option>
                              ))}
                            </optgroup>
                          ) : null
                        ) : (
                          <optgroup key={group.label} label={group.label}>
                            {group.options.map((opt) => (
                              <option key={opt.value} value={opt.value}>
                                {opt.label}
                                {opt.paid ? ' (paid)' : ''}
                              </option>
                            ))}
                          </optgroup>
                        )
                      )}
                    </select>
                  </div>
                  {isOverride && (
                    <p className="ml-0 text-xs text-amber-600 dark:text-amber-400 md:ml-[calc(33.333%+0.5rem)]">
                      Override: performance may vary — this replaces the
                      default Model Profile for {row.label.toLowerCase()}.
                    </p>
                  )}
                  {!isOverride && rec && rec.kind === 'local' && localLlmLoaded && (
                    <p className="ml-0 text-xs text-muted-foreground md:ml-[calc(33.333%+0.5rem)]">
                      Recommendation:{' '}
                      <span className="text-green-600 dark:text-green-400">
                        Local ({rec.modelId})
                      </span>{' '}
                      — {rec.reason}
                    </p>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </details>
  )
}
