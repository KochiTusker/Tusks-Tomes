// Shared dropdown-source helper. Picks the right model list for a given
// CloudKeyOption from the probe-availability cache, with two graceful
// fallbacks if the probe data is missing or empty. Used by both
// HybridRoutingEditor and ModelProfileEditor so the two surfaces never
// drift.
//
// Source-of-truth chain (best → worst):
//   1. `slot.probed[].filter(p => p.accessible)` — the gold standard.
//      These are models we actively verified can be called with the
//      current key. UI tags them as verified.
//   2. `slot.advertised[]` — the provider's /models endpoint said the
//      key has access. Not yet probed. UI tags them as unverified +
//      shows a "Run Probe in Settings → API Keys" hint.
//   3. `STATIC_PROVIDER_MODELS[provider]` — last-resort hardcoded list
//      for Claude/OpenAI when neither probe nor /models has been called.
//      UI tags them as unverified.
//
// Why a single function: the audit (`Explore` agent, prior turn) found
// that HybridRoutingEditor and ModelProfileEditor today implement the
// "what models do I show in this dropdown?" decision independently.
// Centralising prevents the two surfaces from disagreeing about
// accessibility.

import type {
  SlotAvailability,
  AvailabilityCache,
  AvailabilitySlot,
  GeminiModelTier,
} from '@/lib/providerSettings'
import { STATIC_PROVIDER_MODELS } from '@/lib/cloudKeys'
import type { CloudKeyOption } from '@/lib/cloudKeys'

/** A single dropdown option with provenance info. Components use `verified`
 *  to decide whether to render an `(unverified)` suffix and whether to show
 *  the "Run Probe" hint under the dropdown. */
export type AvailableModel = {
  id: string
  /** True iff this id came from `probed[].accessible === true`. False for
   *  advertised-only entries or the static fallback. */
  verified: boolean
  /** Gemini capability tier, used to split the dropdown into tier headings.
   *  Undefined for non-Gemini providers, whose ids carry no parseable tier. */
  tier?: GeminiModelTier
  /** Optional probe-cache fields surfaced for tooltips / debug. */
  reason?: string
  latencyMs?: number
}

/** Mirrors server/lib/geminiTier.ts:classifyGeminiTier. Used as the fallback
 *  when a cache entry predates tier stamping, and for the advertised-only /
 *  static paths which never carry a tier.
 *
 *  Order is load-bearing: every flash-lite id also contains 'flash', so
 *  'lite' must be tested first or the cheapest tier collapses into Flash. */
export function classifyGeminiTier(modelId: string): GeminiModelTier {
  const m = (modelId || '').toLowerCase()
  if (!m) return 'other'
  if (m.includes('lite')) return 'flash-lite'
  if (m.includes('flash')) return 'flash'
  if (m.includes('pro')) return 'pro'
  return 'other'
}

/** Display order + headings for the Gemini tier subgroups. 'other' sits last
 *  and is deliberately still shown: a family Google ships under a name we
 *  don't recognise must appear as "Uncategorised", never vanish. */
export const GEMINI_TIER_ORDER: GeminiModelTier[] = ['pro', 'flash', 'flash-lite', 'other']

export const GEMINI_TIER_LABELS: Record<GeminiModelTier, string> = {
  pro: 'Pro Tier',
  flash: 'Flash Tier',
  'flash-lite': 'Flash Lite Tier',
  other: 'Uncategorised',
}

/** Compute the dropdown's option list for a given (provider × tier) slot.
 *  Pure function — no side effects, no fetching. Consumes the cache the
 *  caller pulled via `useAvailabilityCache()`. */
export function availableModelsFor(
  option: CloudKeyOption,
  cache: AvailabilityCache,
): AvailableModel[] {
  const slot: SlotAvailability | undefined = cache[option.slot as AvailabilitySlot]

  // 1. Probe-driven path — only `accessible: true` entries pass. This is
  // the load-bearing path: if the user probed and a model came back
  // inaccessible, we DON'T want it in the dropdown.
  const isGemini = option.provider === 'gemini'
  const withTier = (id: string, tier?: GeminiModelTier): GeminiModelTier | undefined =>
    isGemini ? (tier ?? classifyGeminiTier(id)) : undefined

  if (slot?.probed && slot.probed.length > 0) {
    const accessible = slot.probed
      .filter((p) => p.accessible)
      .map<AvailableModel>((p) => ({
        id: p.id,
        verified: true,
        tier: withTier(p.id, p.tier),
        reason: p.reason,
        latencyMs: p.latencyMs,
      }))
    if (accessible.length > 0) return dedupedSort(accessible)
  }

  // 2. Advertised-but-unprobed — the provider's /models listed these but
  // we haven't actively verified them. UI flags as unverified.
  if (slot?.advertised && slot.advertised.length > 0) {
    return dedupedSort(
      slot.advertised.map<AvailableModel>((id) => ({
        id,
        verified: false,
        tier: withTier(id),
      })),
    )
  }

  // 3. Last-resort static fallback. For Gemini, listGeminiModelAvailability
  // (used historically) returns the public /v1beta/models catalog with no
  // auth — so this branch only matters when even that fetch failed. For
  // Claude/OpenAI, this is STATIC_PROVIDER_MODELS — the curated list of
  // models the app actually targets.
  if (option.provider === 'gemini') {
    // No static fallback for Gemini today; the dropdown shows empty
    // and the unverified-hint surfaces. The user must Probe.
    return []
  }
  const staticList = STATIC_PROVIDER_MODELS[option.provider] ?? []
  return dedupedSort(staticList.map((id) => ({ id, verified: false })))
}

/** Sort by id + drop duplicates. Both inputs (probed + advertised) are
 *  already sorted server-side, but we defend against a future change. */
function dedupedSort(models: AvailableModel[]): AvailableModel[] {
  const seen = new Set<string>()
  const out: AvailableModel[] = []
  for (const m of models) {
    if (seen.has(m.id)) continue
    seen.add(m.id)
    out.push(m)
  }
  out.sort((a, b) => a.id.localeCompare(b.id))
  return out
}

/** A dropdown heading and the models under it. */
export type ModelGroup = {
  /** Heading text. For Gemini this is `"<slot label> — <tier label>"`; for
   *  other providers it's the slot label alone. */
  label: string
  tier?: GeminiModelTier
  models: AvailableModel[]
}

/** Split a model list into display groups.
 *
 *  Gemini splits into Pro / Flash / Flash Lite / Uncategorised, in that order,
 *  with empty tiers omitted. Every other provider stays a single flat group —
 *  their ids carry no tier to sort on, and inventing one would be guesswork.
 *
 *  Grouping is presentation only: `availableModelsFor` has already decided
 *  what is offerable. Nothing is filtered out here, so a model in an
 *  unrecognised family surfaces under "Uncategorised" rather than being
 *  dropped. */
export function groupModels(
  option: CloudKeyOption,
  models: AvailableModel[],
  baseLabel: string,
): ModelGroup[] {
  if (option.provider !== 'gemini') {
    return models.length > 0 ? [{ label: baseLabel, models }] : []
  }
  const groups: ModelGroup[] = []
  for (const tier of GEMINI_TIER_ORDER) {
    const inTier = models.filter((m) => (m.tier ?? classifyGeminiTier(m.id)) === tier)
    if (inTier.length === 0) continue
    groups.push({
      label: `${baseLabel} — ${GEMINI_TIER_LABELS[tier]}`,
      tier,
      models: inTier,
    })
  }
  return groups
}

/** Helper to format the optgroup label with optional fingerprint suffix.
 *  e.g. `Gemini Paid (abc123)` or `Claude (xyz789)` or just `OpenAI` when
 *  no probe has populated a fingerprint yet. */
export function optgroupLabel(option: CloudKeyOption, cache: AvailabilityCache): string {
  const slot = cache[option.slot as AvailabilitySlot]
  const fp = slot?.keyFingerprint
  return fp ? `${option.label} (${fp})` : option.label
}

/** Returns true if the list contains any unverified entries. Used by the
 *  caller to decide whether to show the "Run Probe" hint under the dropdown. */
export function hasUnverified(models: AvailableModel[]): boolean {
  return models.some((m) => !m.verified)
}
