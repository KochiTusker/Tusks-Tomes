// OpenRouter model catalogue — fetch, normalise, cache.
//
// OpenRouter publishes its whole model list at /api/v1/models with no auth, so
// unlike every other provider we can know a model's price, context window,
// output ceiling, moderation status and capability set BEFORE calling it. That
// one document is the input to:
//
//   - cost estimation      (live rates, instead of a static table that drifts)
//   - chunk sizing         (context_length varies 8k..1M across the catalogue)
//   - output clamping      (max_completion_tokens is below our default on some
//                           models, which makes the request itself invalid)
//   - the model picker     (moderation + structured-output support decide which
//                           phases a model is actually fit for)
//   - privacy disclosure   (which upstream serves it, and on what data policy)
//
// Prices in the raw feed are USD per token as decimal STRINGS. Everything here
// converts to USD per MILLION tokens to match src/lib/pricing.ts.
//
// NOTE: do NOT reuse this shape for speech-to-text pricing. On the STT models
// the pricing.prompt field is not unit-normalised across providers — the same
// whisper-large-v3 is quoted per-second on DeepInfra, per-minute on Together
// and per-hour on Groq. STT cost must be read from the usage.cost field the
// transcription response returns, never precomputed from this table.

import { readJson, writeJson, openrouterCatalogueFile } from '../appData.js'

export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'

/** How long a cached catalogue stays fresh. Prices move rarely, and a stale
 *  price only skews an estimate, so a long TTL is cheap insurance against
 *  hammering a public endpoint on every app start. */
export const CATALOGUE_TTL_MS = 24 * 60 * 60 * 1000

export interface OpenRouterModel {
  id: string
  name: string
  /** USD per million input tokens. */
  inputPerM: number
  /** USD per million output tokens. */
  outputPerM: number
  /** USD per million cached-read input tokens, when the model supports it. */
  cachedInputPerM?: number
  contextLength: number
  /** Advertised output ceiling. Null when the upstream does not declare one. */
  maxCompletionTokens: number | null
  /** Supports response_format / structured_outputs — required by the phases
   *  that emit JSON (audit, extras). */
  supportsStructuredOutputs: boolean
  /** Upstream applies a prompt-level moderation filter. Matters for the prose
   *  phases, where mature table content gets refused. */
  isModerated: boolean
  /** A :free variant — zero cost, but platform request caps and (today,
   *  universally) a serving provider that retains prompts. */
  isFree: boolean
  inputModalities: string[]
  outputModalities: string[]
  /** Prompt-length pricing tiers, cheapest threshold first. Some models
   *  double or triple their rate above a token threshold; see priceAt(). */
  pricingTiers?: PricingTier[]
  /** Reasoning-token behaviour. `mandatory` means the model always spends
   *  reasoning tokens — they are billed as output whether or not they are
   *  shown, and on some models they land in the reply body itself. */
  reasoning?: {
    mandatory: boolean
    defaultEnabled?: boolean
    supportedEfforts?: string[]
  }
  /** Set when this model has been observed writing its reasoning into the
   *  reply rather than a separate field. Measured, not inferred — see
   *  MEASURED_REASONING_LEAK. */
  leaksReasoning?: boolean
}

/** One prompt-length pricing band. */
export interface PricingTier {
  minPromptTokens: number
  inputPerM: number
  outputPerM: number
  cachedInputPerM?: number
}

/**
 * Models observed writing chain-of-thought into `message.content` rather than
 * the separate `reasoning` field, probed against the live API on 2026-08-18.
 *
 * This is not the same thing as `reasoning.mandatory`. Plenty of models always
 * reason and are perfectly clean about it — Gemini 2.5 Pro is mandatory-
 * reasoning and never leaks. What matters for a chronicle is only whether the
 * deliberation ends up in the prose, and that has to be measured.
 *
 * On the two below, neither `reasoning: {exclude: true}` nor
 * `reasoning: {effort: 'low'}` reliably suppressed it, and the app's
 * stripReasoningBlocks() only removes TAGGED blocks — these emit untagged
 * prose ("Here's a thinking process: ..."), so nothing downstream catches it.
 */
export const MEASURED_REASONING_LEAK = new Set<string>([
  'nvidia/nemotron-3.5-lightning:free',
  'nvidia/nemotron-3.5-lightning',
  'nvidia/nemotron-3-nano-30b-a3b:free',
])

export interface OpenRouterCatalogue {
  fetchedAt: string
  models: OpenRouterModel[]
}

/** Raw feed row. Only the fields we consume are described. */
interface RawModel {
  id?: unknown
  name?: unknown
  context_length?: unknown
  pricing?: {
    prompt?: unknown
    completion?: unknown
    input_cache_read?: unknown
    overrides?: unknown
  }
  top_provider?: {
    max_completion_tokens?: unknown
    is_moderated?: unknown
  }
  reasoning?: {
    mandatory?: unknown
    default_enabled?: unknown
    supported_efforts?: unknown
  }
  architecture?: {
    input_modalities?: unknown
    output_modalities?: unknown
  }
  supported_parameters?: unknown
}

/** Per-token decimal string -> USD per million tokens. Returns null when the
 *  field is absent or unparseable so callers can distinguish free (0) from
 *  unknown (null). */
function perMillion(raw: unknown): number | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null
  const n = typeof raw === 'number' ? raw : Number.parseFloat(raw)
  if (!Number.isFinite(n)) return null
  return n * 1_000_000
}

function stringArray(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []
}

/**
 * Pure normalisation of the raw feed. Split out from the fetch so it can be
 * unit-tested against a fixture without network access — the shape of this
 * feed is the thing most likely to shift under us.
 *
 * Rows missing an id or a usable price are dropped rather than defaulted: a
 * model we cannot price is one we must not silently quote a cost for. The
 * openrouter/auto router rows go the same way — they report a sentinel
 * negative price because the real model is only chosen per call.
 */
export function normaliseCatalogue(raw: unknown): OpenRouterModel[] {
  const rows = (raw as { data?: unknown })?.data
  if (!Array.isArray(rows)) return []

  const out: OpenRouterModel[] = []
  for (const row of rows as RawModel[]) {
    if (!row || typeof row.id !== 'string' || !row.id) continue

    const inputPerM = perMillion(row.pricing?.prompt)
    const outputPerM = perMillion(row.pricing?.completion)
    if (inputPerM === null || outputPerM === null) continue
    if (inputPerM < 0 || outputPerM < 0) continue

    const cached = perMillion(row.pricing?.input_cache_read)
    const tiers = normalisePricingTiers(row.pricing?.overrides)
    const params = stringArray(row.supported_parameters)
    const maxOut = row.top_provider?.max_completion_tokens
    const ctx = row.context_length

    out.push({
      id: row.id,
      name: typeof row.name === 'string' ? row.name : row.id,
      inputPerM,
      outputPerM,
      ...(cached !== null && cached >= 0 ? { cachedInputPerM: cached } : {}),
      contextLength: typeof ctx === 'number' && Number.isFinite(ctx) ? ctx : 0,
      maxCompletionTokens:
        typeof maxOut === 'number' && Number.isFinite(maxOut) && maxOut > 0 ? maxOut : null,
      supportsStructuredOutputs:
        params.includes('structured_outputs') || params.includes('response_format'),
      isModerated: row.top_provider?.is_moderated === true,
      isFree: inputPerM === 0 && outputPerM === 0,
      inputModalities: stringArray(row.architecture?.input_modalities),
      outputModalities: stringArray(row.architecture?.output_modalities),
      ...(tiers.length > 0 ? { pricingTiers: tiers } : {}),
      ...(row.reasoning
        ? {
            reasoning: {
              mandatory: row.reasoning.mandatory === true,
              ...(typeof row.reasoning.default_enabled === 'boolean'
                ? { defaultEnabled: row.reasoning.default_enabled }
                : {}),
              ...(Array.isArray(row.reasoning.supported_efforts)
                ? { supportedEfforts: stringArray(row.reasoning.supported_efforts) }
                : {}),
            },
          }
        : {}),
      ...(MEASURED_REASONING_LEAK.has(row.id) ? { leaksReasoning: true } : {}),
    })
  }
  return out
}

export function isCatalogueFresh(
  cat: OpenRouterCatalogue | null,
  now: number = Date.now(),
  ttlMs: number = CATALOGUE_TTL_MS,
): boolean {
  if (!cat || !cat.fetchedAt || cat.models.length === 0) return false
  const fetched = Date.parse(cat.fetchedAt)
  if (!Number.isFinite(fetched)) return false
  // A clock that has moved backwards must not make a cache immortal.
  const age = now - fetched
  return age >= 0 && age < ttlMs
}

export async function readCachedCatalogue(): Promise<OpenRouterCatalogue | null> {
  const cached = await readJson<OpenRouterCatalogue | null>(openrouterCatalogueFile(), null)
  if (!cached || !Array.isArray(cached.models)) return null
  return cached
}

export async function writeCachedCatalogue(cat: OpenRouterCatalogue): Promise<void> {
  await writeJson(openrouterCatalogueFile(), cat)
}

/**
 * Return the catalogue, fetching only when the cache is missing or stale.
 *
 * A failed fetch falls back to the stale cache rather than throwing: an
 * out-of-date price is a far better outcome than a model picker that cannot
 * render because OpenRouter had a bad minute.
 */
export async function getCatalogue(opts: { force?: boolean } = {}): Promise<OpenRouterCatalogue> {
  const cached = await readCachedCatalogue()
  if (!opts.force && isCatalogueFresh(cached)) return cached as OpenRouterCatalogue

  try {
    const res = await fetch(OPENROUTER_MODELS_URL, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const models = normaliseCatalogue(await res.json())
    if (models.length === 0) throw new Error('catalogue parsed to zero models')
    const next: OpenRouterCatalogue = { fetchedAt: new Date().toISOString(), models }
    await writeCachedCatalogue(next)
    return next
  } catch (err) {
    if (cached && cached.models.length > 0) {
      console.warn(
        '[openrouter] catalogue refresh failed, serving cached copy:',
        (err as Error)?.message ?? err,
      )
      return cached
    }
    throw err
  }
}

/**
 * Parse prompt-length pricing bands.
 *
 * 61 of 413 catalogue models carry these. They matter a great deal here
 * because Condense ships the whole knowledge base — a 2 MB vault is ~557k
 * prompt tokens, far past every published threshold — so quoting the base rate
 * for that phase can understate the real charge by 2x or more.
 *
 * Time-of-day bands (`utc_start` / `utc_end`, used for off-peak discounts) are
 * deliberately ignored: they would make an estimate depend on when the user
 * happens to press the button, which is worse than quoting the standard rate.
 */
export function normalisePricingTiers(raw: unknown): PricingTier[] {
  if (!Array.isArray(raw)) return []
  const out: PricingTier[] = []
  for (const row of raw as Array<Record<string, unknown>>) {
    const min = row?.min_prompt_tokens
    if (typeof min !== 'number' || !Number.isFinite(min) || min <= 0) continue
    const input = perMillion(row.prompt)
    const output = perMillion(row.completion)
    if (input === null || output === null || input < 0 || output < 0) continue
    const cached = perMillion(row.input_cache_read)
    out.push({
      minPromptTokens: min,
      inputPerM: input,
      outputPerM: output,
      ...(cached !== null && cached >= 0 ? { cachedInputPerM: cached } : {}),
    })
  }
  return out.sort((a, b) => a.minPromptTokens - b.minPromptTokens)
}

/**
 * The rate that actually applies at a given prompt length.
 *
 * Falls back to the base rate when no band matches, which is the correct
 * reading — bands only ever raise the price above a threshold.
 */
export function priceAt(
  model: OpenRouterModel,
  promptTokens: number,
): { inputPerM: number; outputPerM: number; cachedInputPerM?: number; tiered: boolean } {
  const base = {
    inputPerM: model.inputPerM,
    outputPerM: model.outputPerM,
    ...(model.cachedInputPerM !== undefined ? { cachedInputPerM: model.cachedInputPerM } : {}),
    tiered: false,
  }
  if (!model.pricingTiers || model.pricingTiers.length === 0) return base
  let applied: PricingTier | null = null
  for (const tier of model.pricingTiers) {
    if (promptTokens >= tier.minPromptTokens) applied = tier
  }
  if (!applied) return base
  return {
    inputPerM: applied.inputPerM,
    outputPerM: applied.outputPerM,
    ...(applied.cachedInputPerM !== undefined ? { cachedInputPerM: applied.cachedInputPerM } : {}),
    tiered: true,
  }
}

/** Look up one model. Returns null rather than throwing — callers decide
 *  whether an unknown model is fatal or merely unpriced. */
export function findModel(cat: OpenRouterCatalogue | null, id: string): OpenRouterModel | null {
  if (!cat) return null
  return cat.models.find((m) => m.id === id) ?? null
}
