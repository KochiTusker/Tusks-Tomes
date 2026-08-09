// "Pipeline session" helper — at the start of each refinement / SBV repair
// run, this resolves the document-level cloud key + per-phase overrides
// into a flat `phases` map. RefinementTool then passes each phase's resolved
// (provider, tier, model, target) tuple to the matching runPhaseN, so a
// single run can mix Claude / Gemini / OpenAI / Local across phases without
// the pipeline core needing to know anything about it.

import { getProfiles, type CloudProvider, type ProviderProfile } from './profiles'
import {
  getRouting,
  putRouting,
  type GeminiTier,
  type PhaseRouteEntry,
  type RoutingDocument,
} from './routing'
import {
  getAvailabilityCache,
  getProvidersSummary,
  type SlotAvailability,
} from './providerSettings'
import {
  fetchConfiguredCloudKeyOptions,
  optionFromRouting,
  type CloudKeyOption,
} from './cloudKeys'
import { isPaidOnlyGeminiModel, listGeminiModelAvailability } from './gemini'
import { classifyModelTier } from './modelTier'
import { chunkSizeFor, type ChunkPhase } from './chunking'
import { vlog } from './verboseLog'

type PhaseKey = 'phase1' | 'phase2' | 'phase3' | 'phase4' | 'phase6'

export type PhaseModels = {
  phase1: string
  phase2: string
  phase3: string
  phase4: string
  phase6: string
}

export type PhaseTarget =
  | { target: 'cloud' }
  | { target: 'local'; modelId: string; baseUrl?: string }

export type PhaseRouting = {
  phase1: PhaseTarget
  phase2: PhaseTarget
  phase3: PhaseTarget
  phase4: PhaseTarget
  phase6: PhaseTarget
}

/**
 * Per-phase resolved config. RefinementTool passes these straight to
 * runPhaseN's args (one phase = one set). `cloudProvider`/`geminiTier`
 * are undefined when the phase routes to a local model.
 */
export type ResolvedPhaseConfig = {
  cloudProvider?: CloudProvider
  geminiTier?: GeminiTier
  model: string
  phaseTarget: PhaseTarget
  /**
   * True when this phase's settings differ from the session default — the
   * UI surfaces a "performance may vary" note when a user explicitly
   * overrides a phase away from the default profile.
   */
  override: boolean
}

export type ResolvedPhases = {
  phase1: ResolvedPhaseConfig
  phase2: ResolvedPhaseConfig
  phase3: ResolvedPhaseConfig
  phase4: ResolvedPhaseConfig
  phase6: ResolvedPhaseConfig
}

export type ModelSubstitution = {
  phase: PhaseKey
  from: string
  to: string
  reason: string
  /** True when the substitute is a `-lite-` / experimental / `-latest`
   *  variant — i.e. we DID substitute but the pick is unlikely to be
   *  what the user actually wants. RefinementTool surfaces these as a
   *  loud toast instead of a quiet info one; the diagnose system flags
   *  them as a soft-error signature.
   *
   *  Optional + defaults to false so legacy callers / older saved
   *  sessions continue to work unchanged. */
  dubious?: boolean
}

export type RunSession = {
  /** Document-level default provider. Phases inherit unless overridden. */
  provider: CloudProvider
  profile: ProviderProfile
  /** Document-level default model per phase (profile lookup). */
  models: PhaseModels
  /** Step 15: which phases route to local vs cloud. Cloud is the default. */
  routing: PhaseRouting
  /** Gemini-only document-level tier. Phases override individually if set. */
  geminiTier?: GeminiTier
  /**
   * Snapshot of Gemini model IDs that the Free-tier key cannot reach. Used
   * by the pipeline when `geminiTier === 'free'`: any phase whose model is
   * in this list dispatches to the Paid key instead, with a corresponding
   * "Will use Paid key" warning surfaced in the UI before the run starts.
   * Undefined when not applicable or when the availability diff failed.
   */
  geminiPaidOnlyModels?: string[]
  /**
   * Runtime substitutions buildSession applied to keep Free-tier runs honest.
   * Each entry says "phase N's saved model was paid-only on the active
   * Gemini key, so we swapped it for `to` from the probed list." The
   * Chronicle banner surfaces these so the user knows the run isn't using
   * the exact model they originally configured.
   */
  modelSubstitutions?: ModelSubstitution[]
  /**
   * Set when `listGeminiModelAvailability()` threw at session build time on
   * a Free-tier run. Used to surface a yellow toast at run start so the
   * user knows auto-escalation to Paid is OFF — if a phase later hits a
   * paid-only model, it'll error out instead of escalating silently.
   *
   * `consequence` distinguishes the two failure modes:
   *   'auto_escalation_disabled' — list failed to load; pipeline assumes
   *     every model is free-friendly; paid-only models will hit limit:0 mid-phase.
   *   'all_models_assumed_free' — same effect, different cause (e.g. probe
   *     returned an empty list). Kept as a distinct value so future code
   *     can branch on whether to retry the probe or not.
   */
  modelAvailabilityWarning?: {
    error: string
    consequence: 'auto_escalation_disabled' | 'all_models_assumed_free'
  }
  /**
   * Per-phase overrides currently in effect from `routing.perPhase` —
   * populated when any phase's resolved (provider, tier) differs from the
   * session-level defaults. Used by RefinementTool to surface the sticky
   * banner ("Phase 3 is pinned to Free even though your global selector is
   * Paid"). Empty array when there are no overrides.
   *
   * NOTE: only includes phases where the override changes the *effective*
   * dispatch target (provider or geminiTier). Model-only differences (eg
   * same provider+tier but a different model id) are tracked separately
   * via `modelSubstitutions` — those are usually intentional (per-phase
   * Flash/Pro picks) and don't need a tier-switch banner.
   */
  perPhaseOverrides?: Array<{
    phase: PhaseKey
    expected: { provider: CloudProvider; tier?: GeminiTier }
    resolved: { provider: CloudProvider; tier?: GeminiTier; model: string }
    reason: string
  }>
  /**
   * True when every resolved phase uses a fast-tier model (Flash, Haiku,
   * gpt-mini/nano). chunking.ts applies an additional 0.7x shrink so Flash
   * doesn't lose narrative continuity across chunk boundaries when no
   * flagship phase is around to anchor it. Computed once at run-start.
   */
  allPhasesFast?: boolean
  /** Flat per-phase resolution. Pass these directly to runPhaseN. */
  phases: ResolvedPhases
}

/** Return the distinct cloud-key options (Gemini Paid / Free / Claude / OpenAI). */
export async function listConfiguredCloudKeys(): Promise<CloudKeyOption[]> {
  return fetchConfiguredCloudKeyOptions()
}

/** Legacy helper — kept so existing call sites can ask "is any cloud key configured?". */
export async function listConfiguredCloudProviders(): Promise<CloudProvider[]> {
  const summary = await getProvidersSummary()
  return summary.configured.filter(
    (k): k is CloudProvider => k === 'gemini' || k === 'claude' || k === 'openai'
  )
}

function phaseTargetFromEntry(entry: PhaseRouteEntry | undefined): PhaseTarget {
  if (entry?.target === 'local' && entry.modelId) {
    return { target: 'local', modelId: entry.modelId, baseUrl: entry.baseUrl }
  }
  return { target: 'cloud' }
}

function modelForPhaseKey(profile: ProviderProfile, key: PhaseKey): string {
  switch (key) {
    case 'phase1':
      return profile.phase1Model
    case 'phase2':
      return profile.phase2Model
    case 'phase3':
      return profile.phase3Model
    case 'phase4':
      return profile.phase4Model
    case 'phase6':
      return profile.phase6Model ?? profile.phase3Model
  }
}

async function profileForProvider(provider: CloudProvider): Promise<ProviderProfile> {
  const doc = await getProfiles()
  return doc.profiles[provider]
}

/**
 * Resolve one phase against the document-level defaults. Inherits the
 * session's provider / tier / model unless `entry` overrides explicitly.
 * Returns `override = true` when the resolved values differ from defaults.
 */
async function resolvePhase(
  key: PhaseKey,
  entry: PhaseRouteEntry | undefined,
  defaults: {
    provider: CloudProvider
    profile: ProviderProfile
    geminiTier?: GeminiTier
  }
): Promise<ResolvedPhaseConfig> {
  const defaultModel = modelForPhaseKey(defaults.profile, key)

  if (entry?.target === 'local' && entry.modelId) {
    return {
      cloudProvider: undefined,
      geminiTier: undefined,
      model: entry.modelId,
      phaseTarget: { target: 'local', modelId: entry.modelId, baseUrl: entry.baseUrl },
      override: true,
    }
  }

  if (entry?.target === 'cloud') {
    const resolvedProvider = entry.cloudProvider ?? defaults.provider
    const resolvedTier =
      entry.geminiTier ??
      (resolvedProvider === 'gemini' ? defaults.geminiTier : undefined)
    // If this phase is overriding to a different provider, look up THAT
    // provider's profile for the default model; otherwise stay on defaults.
    let resolvedModel = entry.modelId
    if (!resolvedModel) {
      if (resolvedProvider === defaults.provider) {
        resolvedModel = defaultModel
      } else {
        const otherProfile = await profileForProvider(resolvedProvider)
        resolvedModel = modelForPhaseKey(otherProfile, key)
      }
    }
    const override =
      resolvedProvider !== defaults.provider ||
      (resolvedProvider === 'gemini' && resolvedTier !== defaults.geminiTier) ||
      resolvedModel !== defaultModel
    return {
      cloudProvider: resolvedProvider,
      geminiTier: resolvedProvider === 'gemini' ? resolvedTier : undefined,
      model: resolvedModel,
      phaseTarget: { target: 'cloud' },
      override,
    }
  }

  // No entry — pure inheritance.
  return {
    cloudProvider: defaults.provider,
    geminiTier:
      defaults.provider === 'gemini' ? defaults.geminiTier : undefined,
    model: defaultModel,
    phaseTarget: { target: 'cloud' },
    override: false,
  }
}

export async function buildSession(
  provider: CloudProvider,
  opts?: {
    geminiTier?: GeminiTier
    /** When set, an explicit RoutingDocument to resolve per-phase entries
     *  against instead of the saved one. Used by resume so the original
     *  paused-run routing produces an originalSession (for chunk-size
     *  computation) without depending on whatever the user has saved
     *  right now. Default = read from disk via getRouting(). */
    routingOverride?: RoutingDocument
    /** When true, do NOT persist `(provider, tier)` as the new
     *  `lastSelectedProvider`. Used by resume's originalSession path so
     *  building a checkpoint-shaped session is a read-only operation that
     *  can't overwrite the user's current Active Provider choice. */
    dryRun?: boolean
  }
): Promise<RunSession> {
  const profilesDoc = await getProfiles()
  const profile = profilesDoc.profiles[provider]
  const models: PhaseModels = {
    phase1: profile.phase1Model,
    phase2: profile.phase2Model,
    phase3: profile.phase3Model,
    phase4: profile.phase4Model,
    // Phase 6 defaults to the Phase 3 model unless the profile has an
    // explicit phase6Model — both phases produce long-form prose so the
    // same model usually works well.
    phase6: profile.phase6Model ?? profile.phase3Model,
  }
  // Record selection for the next run's default — including the user's
  // free/paid tier choice for Gemini.
  const routing = opts?.routingOverride ?? (await getRouting())
  const tier = opts?.geminiTier ?? routing.geminiTier ?? 'auto'
  const patched: RoutingDocument = {
    ...routing,
    lastSelectedProvider: provider,
    geminiTier: provider === 'gemini' ? tier : routing.geminiTier,
  }
  if (
    !opts?.dryRun &&
    (routing.lastSelectedProvider !== patched.lastSelectedProvider ||
      routing.geminiTier !== patched.geminiTier)
  ) {
    await putRouting(patched)
  }

  const defaults = { provider, profile, geminiTier: tier }
  const perPhase = routing.perPhase ?? {}
  const phases: ResolvedPhases = {
    phase1: await resolvePhase('phase1', perPhase.phase1, defaults),
    phase2: await resolvePhase('phase2', perPhase.phase2, defaults),
    phase3: await resolvePhase('phase3', perPhase.phase3, defaults),
    phase4: await resolvePhase('phase4', perPhase.phase4, defaults),
    phase6: await resolvePhase('phase6', perPhase.phase6, defaults),
  }

  const phaseRouting: PhaseRouting = {
    phase1: phases.phase1.phaseTarget,
    phase2: phases.phase2.phaseTarget,
    phase3: phases.phase3.phaseTarget,
    phase4: phases.phase4.phaseTarget,
    phase6: phases.phase6.phaseTarget,
  }

  // Surface per-phase overrides that change the dispatch target (provider
  // or geminiTier) compared to the session defaults. The user usually
  // doesn't realize a stale routing.perPhase entry is overriding their
  // most recent global selector — the RefinementTool sticky banner makes
  // it visible. Skip local-routed phases (those overrides are intentional
  // and have their own UI affordance via the Hybrid Routing editor).
  const perPhaseOverrides: NonNullable<RunSession['perPhaseOverrides']> = []
  for (const key of ['phase1', 'phase2', 'phase3', 'phase4', 'phase6'] as const) {
    const ph = phases[key]
    if (ph.phaseTarget.target === 'local') continue
    if (!ph.cloudProvider) continue
    const expectedTier = defaults.provider === 'gemini' ? defaults.geminiTier : undefined
    const tierDiffers =
      ph.cloudProvider === 'gemini' &&
      (ph.geminiTier ?? 'auto') !== (expectedTier ?? 'auto')
    const providerDiffers = ph.cloudProvider !== defaults.provider
    if (tierDiffers || providerDiffers) {
      const reasonParts: string[] = []
      if (providerDiffers) {
        reasonParts.push(`provider pinned to ${ph.cloudProvider} (defaults: ${defaults.provider})`)
      }
      if (tierDiffers) {
        reasonParts.push(
          `tier pinned to ${ph.geminiTier ?? 'auto'} (defaults: ${expectedTier ?? 'auto'})`,
        )
      }
      perPhaseOverrides.push({
        phase: key,
        expected: { provider: defaults.provider, tier: expectedTier },
        resolved: {
          provider: ph.cloudProvider,
          tier: ph.geminiTier,
          model: ph.model,
        },
        reason: reasonParts.join('; '),
      })
    }
  }

  // When Gemini is the active provider and the user is on the Free tier,
  // snapshot which models the Free key can't reach so the pipeline can
  // dispatch the Paid singleton per-phase for any escalation. Best-effort:
  // a failure here just leaves the list undefined and the pipeline behaves
  // as if every model is free-available.
  let geminiPaidOnlyModels: string[] | undefined
  let modelAvailabilityWarning: RunSession['modelAvailabilityWarning']
  const anyGeminiFreePhase =
    (provider === 'gemini' && tier === 'free') ||
    Object.values(phases).some(
      (p) => p.cloudProvider === 'gemini' && p.geminiTier === 'free'
    )
  if (anyGeminiFreePhase) {
    try {
      const availability = await listGeminiModelAvailability()
      geminiPaidOnlyModels = availability
        .filter((m) => m.billingRequired)
        .map((m) => m.id)
      vlog('sessions', {
        event: 'model_availability_probed',
        totalModels: availability.length,
        paidOnlyCount: geminiPaidOnlyModels.length,
        paidOnly: geminiPaidOnlyModels,
      })
      // Distinguish "the probe ran but returned no paid-only models" from
      // "the probe ran and listed models". The second case is normal; the
      // first is suspicious — almost every account has SOMETHING paid-only.
      if (availability.length === 0) {
        modelAvailabilityWarning = {
          error: 'listGeminiModelAvailability returned an empty list',
          consequence: 'all_models_assumed_free',
        }
        vlog('sessions', { event: 'modelAvailabilityWarning', warning: modelAvailabilityWarning })
        console.warn(
          '[sessions] Gemini model availability list is empty — auto-escalation ' +
            'to Paid for paid-only models will not fire this run. Probe both ' +
            'Gemini slots in Settings → API Keys to repopulate.',
        )
      }
    } catch (err) {
      // Replace the previous silent catch with a verbose warning. We let
      // the build proceed (the user might have only free-friendly models
      // in their profile, in which case escalation isn't needed), but the
      // warning surfaces in the UI so the user knows to expect a verbose
      // mid-phase error if escalation IS needed.
      const message = (err as Error)?.message ?? String(err)
      modelAvailabilityWarning = {
        error: `listGeminiModelAvailability threw: ${message}`,
        consequence: 'auto_escalation_disabled',
      }
      vlog('sessions', { event: 'modelAvailabilityWarning', warning: modelAvailabilityWarning })
      console.warn(
        `[sessions] Failed to load Gemini model availability — auto-escalation ` +
          `to Paid for paid-only models is OFF for this run. Error: ${message}`,
      )
      geminiPaidOnlyModels = undefined
    }
  }

  // Defence-in-depth: if any Gemini Free phase resolved to a paid-only
  // model (profile not yet sanitized, per-phase override, manual edit of
  // profiles.json), replace it with a probed-accessible alternative right
  // now. ActiveProviderCard's tier-switch handler should already have
  // caught this on the saved profile — this catches everything else.
  const modelSubstitutions: ModelSubstitution[] = []
  if (anyGeminiFreePhase) {
    const cache = await getAvailabilityCache().catch(
      () => ({} as Awaited<ReturnType<typeof getAvailabilityCache>>),
    )
    const freeAvail: SlotAvailability | undefined = cache.geminiFallback
    for (const key of ['phase1', 'phase2', 'phase3', 'phase4', 'phase6'] as const) {
      const ph = phases[key]
      if (ph.cloudProvider !== 'gemini') continue
      if (ph.geminiTier === 'paid') continue
      const id = ph.model
      const substitution = pickGeminiSubstitution(id, freeAvail)
      if (substitution) {
        ph.model = substitution.to
        // Keep the document-level `models` mirror in sync for any UI that
        // reads it without traversing `phases`.
        models[key] = substitution.to
        modelSubstitutions.push({ phase: key, ...substitution })
        // Log substitution into the diagnostic ring so a soft-error
        // signature can flag it and the diagnose bundle picks it up.
        // The `dubious` field is critical — a lite/experimental/latest
        // substitution should fire louder UX than a sensible swap (e.g.
        // gemini-2.5-flash → gemini-2.5-flash-001).
        vlog('sessions', {
          event: 'model_substitution',
          phase: key,
          from: substitution.from,
          to: substitution.to,
          reason: substitution.reason,
          dubious: substitution.dubious ?? false,
        })
      }
    }
  }

  // "All-fast" detection — true iff every cloud phase resolves to a
  // fast-tier model. Local-routed phases are excluded from the check; the
  // local sizing table is already conservative and doesn't need shrinking.
  // When every cloud phase is fast, chunking.ts applies the extra shrink.
  const cloudPhases = Object.values(phases).filter(
    (p) => p.phaseTarget.target === 'cloud' && p.cloudProvider !== undefined,
  )
  const allPhasesFast =
    cloudPhases.length > 0 &&
    cloudPhases.every(
      (p) => classifyModelTier(p.model, p.cloudProvider!) === 'fast',
    )

  const result: RunSession = {
    provider,
    profile,
    models,
    routing: phaseRouting,
    geminiTier: provider === 'gemini' ? tier : undefined,
    geminiPaidOnlyModels,
    modelSubstitutions: modelSubstitutions.length > 0 ? modelSubstitutions : undefined,
    modelAvailabilityWarning,
    perPhaseOverrides: perPhaseOverrides.length > 0 ? perPhaseOverrides : undefined,
    allPhasesFast,
    phases,
  }
  vlog('sessions', {
    event: 'buildSession_resolved',
    provider,
    tier: result.geminiTier,
    dryRun: opts?.dryRun ?? false,
    perPhaseOverridesCount: perPhaseOverrides.length,
    modelSubstitutionsCount: modelSubstitutions.length,
    hasAvailabilityWarning: !!modelAvailabilityWarning,
    allPhasesFast,
  })
  return result
}

function geminiFamily(id: string): 'pro' | 'flash' | 'other' {
  const lower = id.toLowerCase()
  if (lower.includes('flash')) return 'flash'
  if (lower.includes('pro')) return 'pro'
  return 'other'
}

/**
 * Decide whether `id` needs substituting for a Gemini Free / Auto phase, and
 * pick a replacement when it does. Returns null when no swap is needed OR
 * when no viable replacement exists (in which case the original id rides
 * through to the run — the pipeline will surface a 429 with a clear
 * message, the same one the user already sees today).
 */
/** Score a Gemini model id for the auto-substitution picker. LOWER is
 *  better — sort ascending and take pool[0]. The intent is "pick the
 *  best stand-in for the user's configured model" given the user already
 *  chose something specific; we want a same-family substitute that
 *  matches their quality intent, not the lexically-last entry.
 *
 *  Penalties (each adds to the score):
 *   - `-lite-` variants: large penalty. Lite has noticeably more
 *     aggressive safety filters and lower output quality. If the user
 *     picked `gemini-2.5-flash`, swapping to `gemini-flash-lite-latest`
 *     is almost always wrong — they should be told instead.
 *   - `experimental` / `preview` / `exp-` markers: medium penalty. These
 *     can be unstable or get retired without notice.
 *   - `-latest` aliases: small penalty. Aliases drift over time; dated
 *     versions (e.g. `gemini-2.5-flash` itself) are more predictable.
 *
 *  Tiebreaker: lexically-larger wins, so within equal-scored siblings
 *  the newer-numbered version wins (e.g. `gemini-2.5-flash` beats
 *  `gemini-2.0-flash`).
 *
 *  The threshold for "this substitution is dubious" lives in the
 *  caller — anything scored ≥ LITE_PENALTY means we still substituted
 *  but the caller surfaces a warning. */
const LITE_PENALTY = 100
const EXPERIMENTAL_PENALTY = 30
const LATEST_PENALTY = 5

function scoreCandidate(id: string): number {
  const lower = id.toLowerCase()
  let s = 0
  if (lower.includes('lite')) s += LITE_PENALTY
  if (lower.includes('experimental') || lower.includes('preview') || /\bexp\b/.test(lower)) {
    s += EXPERIMENTAL_PENALTY
  }
  // Match `-latest` AND `-<timestamp>-latest` shapes. We don't penalise
  // dated versions like `gemini-2.5-flash-001`.
  if (lower.endsWith('-latest') || /-latest$/.test(lower)) s += LATEST_PENALTY
  return s
}

/** Exported so tests + the soft-error signature can score candidates
 *  without duplicating the rule set. */
export function _scoreGeminiCandidateForTests(id: string): number {
  return scoreCandidate(id)
}

function pickGeminiSubstitution(
  id: string,
  freeAvail: SlotAvailability | undefined,
): { from: string; to: string; reason: string; dubious: boolean } | null {
  let needs = false
  let reason = ''
  if (freeAvail) {
    const entry = freeAvail.probed.find((p) => p.id === id)
    if (entry && !entry.accessible) {
      needs = true
      reason = entry.reason ?? 'probed inaccessible'
    } else if (!entry && isPaidOnlyGeminiModel(id)) {
      needs = true
      reason = 'paid-only by heuristic (unprobed model)'
    }
  } else if (isPaidOnlyGeminiModel(id)) {
    needs = true
    reason = 'paid-only by heuristic'
  }
  if (!needs) return null
  if (!freeAvail) return null
  const accessible = freeAvail.probed.filter((p) => p.accessible).map((p) => p.id)
  if (accessible.length === 0) return null
  const wantFamily = geminiFamily(id)
  const sameFamily = accessible.filter((x) => geminiFamily(x) === wantFamily)
  const pool = sameFamily.length > 0 ? sameFamily : accessible
  // Ascending by score (lower is better); tiebreaker keeps lex-descending
  // so newer-dated versions win within an equal-score group.
  pool.sort((a, b) => {
    const sa = scoreCandidate(a)
    const sb = scoreCandidate(b)
    if (sa !== sb) return sa - sb
    return b.localeCompare(a)
  })
  const pick = pool[0]
  if (!pick || pick === id) return null
  // Mark substitutions to a penalised variant as "dubious" so the caller
  // can surface a louder warning. Threshold ≥ LATEST_PENALTY catches
  // anything that picked an alias/lite/experimental despite a better
  // dated alternative existing.
  const dubious = scoreCandidate(pick) >= LITE_PENALTY
  return { from: id, to: pick, reason, dubious }
}

/**
 * Compute the chunk size (chars) that a given session would have used for
 * the given phase. Pure helper — no side effects. Used by the Resume path
 * to compute the ORIGINAL paused-run's chunk size from the checkpoint's
 * routing so chunk boundaries align even when the user switches provider
 * or tier between Pause and Resume.
 *
 * Maps PhaseKey ('phase1' / 'phase3' / 'phase4' / 'phase6') to the
 * chunking module's ChunkPhase ('p1' / 'p3' / 'p4' / 'p6') and reads the
 * resolved per-phase model + tier off the session.
 */
const PHASE_KEY_TO_CHUNK_PHASE: Record<'phase1' | 'phase3' | 'phase4' | 'phase6', ChunkPhase> = {
  phase1: 'p1',
  phase3: 'p3',
  phase4: 'p4',
  phase6: 'p6',
}

export function chunkSizeForSessionPhase(
  session: RunSession,
  phaseKey: 'phase1' | 'phase3' | 'phase4' | 'phase6',
): number {
  const phase = session.phases[phaseKey]
  const cloudProvider = phase.cloudProvider
  const modelTier =
    cloudProvider && phase.model
      ? classifyModelTier(phase.model, cloudProvider)
      : undefined
  return chunkSizeFor({
    phase: PHASE_KEY_TO_CHUNK_PHASE[phaseKey],
    isLocal: phase.phaseTarget.target === 'local',
    cloudProvider,
    geminiTier: phase.geminiTier,
    modelTier,
    allPhasesFast: session.allPhasesFast,
  })
}

/**
 * Resolve the provider + models for a run with no UI involvement. With the
 * new Settings-driven flow this always returns a session when at least one
 * cloud key is configured — the ActiveProviderCard in Settings is now the
 * single source of truth, so the run-start modal is gone.
 */
export async function autoResolveSession(): Promise<RunSession | null> {
  const options = await listConfiguredCloudKeys()
  if (options.length === 0) return null
  if (options.length === 1) {
    const only = options[0]
    return buildSession(only.provider, { geminiTier: only.geminiTier })
  }
  const routing = await getRouting()
  const previous = optionFromRouting(options, routing.lastSelectedProvider, routing.geminiTier)
  if (previous) {
    return buildSession(previous.provider, { geminiTier: previous.geminiTier })
  }
  // Multiple keys configured but no prior selection — fall back to the
  // first option so a fresh user can still hit Run. The Chronicle banner
  // tells them what's active and points to Settings to change.
  const first = options[0]
  return buildSession(first.provider, { geminiTier: first.geminiTier })
}
