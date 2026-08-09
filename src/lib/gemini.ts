// Back-compat shim. The cloud-Gemini generation logic moved to
// `src/lib/providers/gemini.ts` in Step 3 of the roadmap. This file is kept
// only to preserve the small surface that UI components still rely on
// (`hasApiKey`, `listAvailableModels`). New code should import from
// `src/lib/providers` and call `provider.generate(...)`.

import { PRIMARY_MODEL } from './constants'
import { getProvider } from './providers'
import { GeminiProvider } from './providers/gemini'
import { isLocalProvider } from './providers/settings'

/**
 * Whether the active provider can attempt a call. For Gemini, an API key
 * must be configured in the keystore. For local providers, we assume yes —
 * the user is expected to have started their local server, and we'll
 * surface a clear error at call time if it's not reachable.
 *
 * Note: this is a synchronous lookup against the cached provider singleton.
 * `ensureProvidersInitialized()` is invoked eagerly from `src/main.tsx`, so
 * by the time any UI component checks `hasApiKey()` post-mount the key (if
 * any) has been decrypted and slotted in.
 */
export function hasApiKey(): boolean {
  if (isLocalProvider()) return true
  return (getProvider('gemini') as GeminiProvider).hasKey()
}

export type AvailableModel = {
  id: string
  displayName: string
  supportsGenerate: boolean
  tier: 'pro' | 'flash' | 'other'
}

function classifyTier(id: string): 'pro' | 'flash' | 'other' {
  const lower = id.toLowerCase()
  if (lower.includes('flash')) return 'flash'
  if (lower.includes('pro')) return 'pro'
  return 'other'
}

async function fetchGeminiKeyForTier(
  tier: 'paid' | 'free' | 'auto'
): Promise<string | null> {
  const res = await fetch('/api/provider-keys')
  if (!res.ok) return null
  const bundle = (await res.json()) as { gemini?: string; geminiFallback?: string }
  if (tier === 'paid') return bundle.gemini ?? null
  if (tier === 'free') return bundle.geminiFallback ?? null
  return bundle.gemini ?? bundle.geminiFallback ?? null
}

async function fetchActiveGeminiKey(): Promise<string | null> {
  return fetchGeminiKeyForTier('auto')
}

/**
 * List the models a specific tier's key can see via Google's ListModels
 * REST endpoint. Returns `null` if no key is configured for that tier so
 * the caller can distinguish "tier unconfigured" from "tier configured
 * but ListModels returned an empty set".
 */
export async function listAvailableModelsForTier(
  tier: 'paid' | 'free'
): Promise<AvailableModel[] | null> {
  const key = await fetchGeminiKeyForTier(tier)
  if (!key) return null
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(
    key
  )}&pageSize=200`
  const res = await fetch(url)
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`ListModels (${tier}) failed: HTTP ${res.status}. ${body.slice(0, 400)}`)
  }
  type ApiModel = { name?: string; displayName?: string; supportedGenerationMethods?: string[] }
  const json = (await res.json()) as { models?: ApiModel[] }
  return (json.models ?? [])
    .map((m) => {
      const id = (m.name ?? '').replace(/^models\//, '')
      return {
        id,
        displayName: m.displayName ?? id,
        supportsGenerate: (m.supportedGenerationMethods ?? []).includes('generateContent'),
        tier: classifyTier(id),
      }
    })
    .filter((m) => m.id)
    .sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * Pattern-based heuristic for "is this model paid-only".
 *
 * Google's `ListModels` REST endpoint returns the same catalog of model IDs
 * for free-tier and billing-enabled keys in many cases — the actual access
 * restriction kicks in only when you call `generateContent`, by which time
 * the user has already burned a phase. The pure-diff approach
 * (`listAvailableModelsForTier('paid')` vs `'free'`) therefore frequently
 * comes back empty, leaving the UI with no paid-only signal at all.
 *
 * As a defensive supplement we maintain this hand-curated list of model
 * families that are paid-only as of writing. Anything matching one of
 * these patterns is treated as paid-only regardless of what the diff says.
 * Free-tier-available models (the gemini-2.x family, gemma-* baselines)
 * deliberately don't match anything below.
 */
const PAID_ONLY_PATTERNS: RegExp[] = [
  // gemini-3.x — the entire 3.x family currently requires billing.
  /^gemini-3(\.\d+)?-/i,
  // Deep Research preview models.
  /^deep-research-/i,
  // Lyria audio models.
  /^lyria-/i,
  // Specialty / preview alias that points to a paid model.
  /^gemini-pro-latest$/i,
  // Computer-use preview.
  /^gemini-2\.5-computer-use/i,
  // gemini-2.5 PRO (GA + previews). Google moved this to billing-only on
  // the free tier in 2026 — empirically returns `quota: 0, limit: 0` for
  // `generate_content_free_tier_requests`. /v1beta/models still advertises
  // it to free keys, so the heuristic has to be the gate.
  /^gemini-2\.5-pro(-|$)/i,
  // Robotics models.
  /^gemini-robotics-/i,
  // Nano Banana pro variants (image-generation tier).
  /^nano-banana-pro/i,
]

export function isPaidOnlyGeminiModel(modelId: string): boolean {
  return PAID_ONLY_PATTERNS.some((re) => re.test(modelId))
}

/**
 * Diff the free-tier list against the paid-tier list to flag models that
 * only exist when a billing-enabled key is in play. Also OR in the pattern
 * heuristic so the chip appears even when Google's catalog endpoint claims
 * the free key can see paid-only models it actually can't call.
 */
export type GeminiModelAvailability = {
  id: string
  displayName: string
  supportsGenerate: boolean
  tier: 'pro' | 'flash' | 'other'
  /** True when the free-tier key cannot reach this model. */
  billingRequired: boolean
}

async function fetchAvailabilityCache(): Promise<{
  gemini?: { probed: Array<{ id: string; accessible: boolean }> }
  geminiFallback?: { probed: Array<{ id: string; accessible: boolean }> }
} | null> {
  try {
    const res = await fetch('/api/providers/availability')
    if (!res.ok) return null
    return (await res.json()) as Awaited<ReturnType<typeof fetchAvailabilityCache>>
  } catch {
    return null
  }
}

/**
 * Truth table for `billingRequired`, ordered by trust:
 *   1. The user probed the free key and the model came back inaccessible
 *      → billingRequired = true (the ground-truth signal).
 *   2. The user probed the free key and the model came back accessible
 *      → billingRequired = false (overrides the heuristic — Google may
 *      have opened up access since the pattern was last reviewed).
 *   3. No probe data → fall back to PAID_ONLY_PATTERNS OR the paid-vs-free
 *      catalog diff. The heuristic is conservative so unprobed keys
 *      default to "treat as paid-only" if any signal points that way.
 */
export async function listGeminiModelAvailability(): Promise<GeminiModelAvailability[]> {
  const [paid, free, cache] = await Promise.all([
    listAvailableModelsForTier('paid').catch(() => null),
    listAvailableModelsForTier('free').catch(() => null),
    fetchAvailabilityCache(),
  ])
  const freeIds = new Set((free ?? []).map((m) => m.id))
  const freeProbed = new Map<string, boolean>()
  for (const entry of cache?.geminiFallback?.probed ?? []) {
    freeProbed.set(entry.id, entry.accessible)
  }
  const source = paid ?? free ?? []
  return source.map((m) => {
    const probed = freeProbed.get(m.id)
    if (probed !== undefined) {
      // Authoritative — the user's actual free key told us.
      return { ...m, billingRequired: !probed }
    }
    const heuristic = isPaidOnlyGeminiModel(m.id)
    const diff = free !== null ? !freeIds.has(m.id) : false
    return { ...m, billingRequired: heuristic || diff }
  })
}

/**
 * Frontend helper for the "Check available models" button. Hits Google's
 * ListModels REST endpoint directly (the SDK in this version doesn't expose
 * it), since the result is for display, not for routing. Reads the active
 * key from the same /api/provider-keys endpoint the provider registry uses,
 * so the legacy diagnostics panel stays in sync with the Settings tab's
 * encrypted keystore.
 */
export async function listAvailableModels(): Promise<AvailableModel[]> {
  const key = await fetchActiveGeminiKey()
  if (!key) {
    throw new Error(
      'No Gemini API key configured. Add one in Settings → API Keys, then reopen this dialog.'
    )
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(
    key
  )}&pageSize=200`
  const res = await fetch(url)
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`ListModels failed: HTTP ${res.status}. ${body.slice(0, 400)}`)
  }
  type ApiModel = {
    name?: string
    displayName?: string
    supportedGenerationMethods?: string[]
  }
  const json = (await res.json()) as { models?: ApiModel[] }
  const models = json.models ?? []
  return models
    .map((m) => {
      const id = (m.name ?? '').replace(/^models\//, '')
      return {
        id,
        displayName: m.displayName ?? id,
        supportsGenerate: (m.supportedGenerationMethods ?? []).includes('generateContent'),
        tier: classifyTier(id),
      }
    })
    .filter((m) => m.id)
    .sort((a, b) => a.id.localeCompare(b.id))
}

// Re-export for any holdouts still doing PRIMARY_MODEL imports.
export { PRIMARY_MODEL }
