// Single source of truth for "is this model id one the server recognises,
// and can we say so with confidence?"
//
// This file exists because the answer used to be duplicated. routing.ts and
// profiles.ts each carried their own KNOWN_MODELS copy with a comment telling
// the next editor to update both, and neither of them consulted the model
// probe — the one component that actually calls the provider and finds out.
// The result was a warning that fired on ids the probe had already verified
// were reachable, which trains users to ignore warnings.
//
// The precedence is now: the probe decides, the static list is only a
// fallback for the case where no probe has ever run for that key slot.
//
//   1. Probed + accessible   → accepted, no warning. Ground truth.
//   2. Probed + inaccessible → WARNED. This case was previously invisible:
//                              a model the probe proved unreachable would
//                              pass validation whenever it happened to be
//                              in the static list.
//   3. Advertised, unprobed  → accepted, no warning. The provider's own
//                              catalog listed it for this key.
//   4. No probe data at all  → fall back to the static list + tier
//                              heuristic below.
//
// Adding a newly-released model no longer requires editing this file. Run the
// probe and it will be accepted on evidence. The static list only has to stay
// good enough to cover a fresh install that has not probed yet.

import { readAvailabilityCache, type AvailabilityCache } from '../api/modelProbe.js'
import { classifyGeminiTier } from './geminiTier.js'

export { classifyGeminiTier, GEMINI_TIER_LABELS, type GeminiModelTier } from './geminiTier.js'

export type CloudProvider = 'gemini' | 'claude' | 'openai' | 'claudeCode' | 'codex' | 'openrouter'
export type GeminiTier = 'paid' | 'free' | 'auto'

/** Static fallback catalog. Only consulted when the probe cache has nothing
 *  for the relevant key slot — i.e. a fresh install, or a key the user has
 *  never pressed Probe on. Drift here is tolerable by design; the probe path
 *  is what carries the guarantee. */
export const KNOWN_MODELS: Record<CloudProvider, ReadonlySet<string>> = {
  gemini: new Set([
    // Floating aliases — always resolve to the newest model in the tier.
    // Pricing is per TIER not per generation, so tracking latest is free.
    'gemini-pro-latest',
    'gemini-flash-latest',
    'gemini-flash-lite-latest',
    // Pinned ids (verified present on the ListModels API 2026-08).
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.1-pro-preview',
    'gemini-3-pro-preview',
    'gemini-3-pro',
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite',
  ]),
  // OpenRouter model ids are namespaced (`vendor/model`), and the live
  // catalogue at /api/v1/models is the real source — this is only what the
  // picker falls back to before the first fetch. Kept deliberately short:
  // every entry is unmoderated, supports structured outputs, and declares an
  // output ceiling at or above MAX_OUTPUT_TOKENS.
  openrouter: new Set([
    'openai/gpt-oss-120b',
    'deepseek/deepseek-v4-flash',
    'nvidia/nemotron-3.5-lightning',
    'google/gemini-2.5-flash',
    'google/gemini-2.5-pro',
  ]),
  claude: new Set([
    'claude-opus-4-7',
    'claude-opus-4-1',
    'claude-sonnet-4-6',
    'claude-sonnet-4-5',
    'claude-haiku-4-5',
    'claude-haiku-4-5-20251001',
  ]),
  openai: new Set([
    'gpt-5',
    'gpt-5-mini',
    'gpt-5-nano',
  ]),
  claudeCode: new Set([
    'sonnet',
    'opus',
    'haiku',
    'claude-opus-4-8',
    'claude-sonnet-4-6',
    'claude-haiku-4-5',
  ]),
  codex: new Set([
    'default',
    'gpt-5-codex',
    'gpt-5',
    'gpt-5-mini',
    'o3',
  ]),
}

/** Static-list check with a tier heuristic for Gemini.
 *
 *  The pinned list WILL drift — Google ships new ids continuously, and the app
 *  deliberately routes to floating `-latest` aliases. Warning on every
 *  unrecognised id trained users to ignore the warning, so Gemini ids that
 *  clearly name a tier are accepted even when unpinned. Other providers keep
 *  strict matching: their ids don't carry a parseable tier. */
export function isKnownModel(provider: CloudProvider, modelId: string): boolean {
  if (KNOWN_MODELS[provider].has(modelId)) return true
  if (provider === 'gemini') return classifyGeminiTier(modelId) !== 'other'
  return false
}

/** Keystore slot names the probe cache is keyed on. `claudeCode` and `codex`
 *  are virtual providers with no stored key and no probe, so they have no
 *  slot and always fall through to the static list. */
export type AvailabilitySlot = 'gemini' | 'geminiFallback' | 'claude' | 'openai' | 'openrouter'

/** Which cache slot(s) speak for a given (provider, tier) pair.
 *
 *  Gemini is the only provider with two slots. Tier 'auto' means the pipeline
 *  may dispatch to either key, so a model accessible on EITHER is acceptable —
 *  returning both slots and accepting the best answer matches what the
 *  provider will actually do at run time. */
export function slotsFor(provider: CloudProvider, tier?: GeminiTier): AvailabilitySlot[] {
  if (provider === 'gemini') {
    if (tier === 'paid') return ['gemini']
    if (tier === 'free') return ['geminiFallback']
    return ['gemini', 'geminiFallback']
  }
  if (provider === 'claude') return ['claude']
  if (provider === 'openai') return ['openai']
  if (provider === 'openrouter') return ['openrouter']
  return []
}

export type AcceptanceSource = 'probe-accessible' | 'probe-inaccessible' | 'advertised' | 'static'

export type Acceptance = {
  /** False only when the probe actively proved the model unreachable. */
  ok: boolean
  source: AcceptanceSource
  /** Populated when `source === 'probe-inaccessible'` — the classified
   *  failure the probe recorded, e.g. "Free tier quota: 0 (paid-only)". */
  reason?: string
}

/** Decide whether a model id should be accepted without a warning, given the
 *  probe cache. Pure — the caller supplies the cache so a single PUT can
 *  validate many phases against one read. */
export function acceptModel(
  provider: CloudProvider,
  tier: GeminiTier | undefined,
  modelId: string,
  cache: AvailabilityCache,
): Acceptance {
  const slots = slotsFor(provider, tier)

  // A model accessible on any candidate slot is acceptable. Check all slots
  // for an accessible hit before concluding "inaccessible" — otherwise a
  // paid-only model would be reported unreachable on an 'auto' route just
  // because the free slot was probed first and failed.
  let inaccessible: Acceptance | null = null
  let advertised = false

  for (const slot of slots) {
    const entry = cache[slot as keyof typeof cache]
    if (!entry) continue
    const hit = entry.probed?.find((p) => p.id === modelId)
    if (hit?.accessible) return { ok: true, source: 'probe-accessible' }
    if (hit && !inaccessible) {
      inaccessible = { ok: false, source: 'probe-inaccessible', reason: hit.reason }
    }
    if (entry.advertised?.includes(modelId)) advertised = true
  }

  if (inaccessible) return inaccessible
  if (advertised) return { ok: true, source: 'advertised' }
  return isKnownModel(provider, modelId)
    ? { ok: true, source: 'static' }
    : { ok: false, source: 'static' }
}

/** Build the user-facing warning for a rejected model. Split out so routing
 *  and profiles produce identical wording for identical situations. */
export function warningFor(
  field: string,
  provider: CloudProvider,
  modelId: string,
  verdict: Acceptance,
): string {
  if (verdict.source === 'probe-inaccessible') {
    const why = verdict.reason ? ` (${verdict.reason})` : ''
    return (
      `${field} '${modelId}' was tested against your ${provider} key and could not be reached${why}. ` +
      `Pipeline runs will fail at the LLM call. Pick a model the probe marked accessible, ` +
      `or re-run the probe in Settings → API Keys if this is stale.`
    )
  }
  const sample = [...KNOWN_MODELS[provider]].slice(0, 4).join(', ')
  return (
    `${field} '${modelId}' is not in the known-models list for ${provider}, and no probe has ` +
    `verified it on your key. Pipeline runs may fail at the LLM call if this is a typo. ` +
    `Run the probe in Settings → API Keys to check it for real. Known IDs include: ${sample}.`
  )
}

/** Convenience wrapper for callers that don't already hold a cache. Soft-fails
 *  to an empty cache: an unreadable availability file must degrade to
 *  "fall back to the static list", never to a 500 on a config write. */
export async function loadAvailabilityCache(): Promise<AvailabilityCache> {
  return readAvailabilityCache().catch(() => ({}) as AvailabilityCache)
}
