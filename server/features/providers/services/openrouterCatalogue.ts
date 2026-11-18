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
// converts to USD per MILLION tokens to match src/features/providers/lib/pricing.ts.
//
// NOTE: do NOT reuse this shape for speech-to-text pricing. On the STT models
// the pricing.prompt field is not unit-normalised across providers — the same
// whisper-large-v3 is quoted per-second on DeepInfra, per-minute on Together
// and per-hour on Groq. STT cost must be read from the usage.cost field the
// transcription response returns, never precomputed from this table.

import { readJson, writeJson, openrouterCatalogueFile } from '../../../platform/appData.js'
import type { CatalogueStatus } from '../../../../shared/contracts/openrouterModels.js'

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

/** A list that was fetched but could not be written to disk. It is newer than
 *  the file, so readers use it for the rest of this process. */
let unsaved: OpenRouterCatalogue | null = null

export async function readCachedCatalogue(): Promise<OpenRouterCatalogue | null> {
  const raw = await readJson<OpenRouterCatalogue | null>(openrouterCatalogueFile(), null)
  const saved = raw && Array.isArray(raw.models) ? raw : null
  if (unsaved && (!saved || unsaved.fetchedAt > saved.fetchedAt)) return unsaved
  return saved
}

export async function writeCachedCatalogue(cat: OpenRouterCatalogue): Promise<void> {
  await writeJson(openrouterCatalogueFile(), cat)
}

/** First wait after a failed refresh; each further failure doubles it, up to
 *  the TTL, so an offline machine is not asked to reach OpenRouter on every
 *  page load. */
export const BACKOFF_BASE_MS = 60 * 60 * 1000

/** Wait before the next automatic attempt after `failures` consecutive misses. */
export function backoffDelayMs(failures: number): number {
  if (failures <= 0) return 0
  return Math.min(CATALOGUE_TTL_MS, BACKOFF_BASE_MS * 2 ** (failures - 1))
}

/** Tracks consecutive failures of one upstream and when an automatic attempt
 *  may next be made. An explicit refresh ignores the wait but still feeds it. */
export class RefreshBackoff {
  private failures = 0
  private nextAt = 0
  private lastAttempt = 0
  private lastErr: string | null = null

  allows(now: number = Date.now()): boolean {
    return now >= this.nextAt
  }
  succeeded(now: number = Date.now()): void {
    this.failures = 0
    this.nextAt = 0
    this.lastAttempt = now
    this.lastErr = null
  }
  failed(message: string, now: number = Date.now()): void {
    this.failures += 1
    this.nextAt = now + backoffDelayMs(this.failures)
    this.lastAttempt = now
    this.lastErr = message
  }
  get lastAttemptAt(): string | null {
    return this.lastAttempt > 0 ? new Date(this.lastAttempt).toISOString() : null
  }
  get lastError(): string | null {
    return this.lastErr
  }
  /** True while the most recent attempt failed, i.e. what we hold is stale. */
  get failing(): boolean {
    return this.failures > 0
  }
}

const catalogueBackoff = new RefreshBackoff()
let inFlight: Promise<OpenRouterCatalogue> | null = null

export const CATALOGUE_SOURCE = 'openrouter.ai'

/** What the status reports when the last check failed. The raw error stays in
 *  the server log: this route can be read from the LAN, and an error from the
 *  file system names a path in the user's profile. */
export const LAST_CHECK_FAILED = 'The last check for a newer list did not complete.'

export function catalogueStatus(
  cached: OpenRouterCatalogue | null,
  autoUpdate: boolean,
  now: number = Date.now(),
): CatalogueStatus {
  return {
    source: CATALOGUE_SOURCE,
    autoUpdate,
    stale: catalogueBackoff.failing || (cached !== null && !isCatalogueFresh(cached, now)),
    lastAttemptAt: catalogueBackoff.lastAttemptAt,
    lastError: catalogueBackoff.lastError ? LAST_CHECK_FAILED : null,
  }
}

/** Resolves once any refresh already under way has settled. Tests only. */
export async function settleCatalogueRefresh(): Promise<void> {
  await inFlight?.catch(() => undefined)
}

function refreshCatalogue(timeoutMs: number): Promise<OpenRouterCatalogue> {
  // Concurrent callers share one request rather than each hitting the endpoint.
  if (inFlight) return inFlight
  const run = (async () => {
    try {
      const res = await fetch(OPENROUTER_MODELS_URL, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const models = normaliseCatalogue(await res.json())
      if (models.length === 0) throw new Error('catalogue parsed to zero models')
      const next: OpenRouterCatalogue = { fetchedAt: new Date().toISOString(), models }
      try {
        await writeCachedCatalogue(next)
      } catch (err) {
        // The list itself is good: keep it in memory and hand it back.
        // Recording the failed save in the back-off spaces out the next
        // attempt, rather than refetching on every request while the file
        // cannot be written.
        unsaved = next
        catalogueBackoff.failed(`could not save the model list: ${(err as Error)?.message ?? String(err)}`)
        return next
      }
      unsaved = null
      catalogueBackoff.succeeded()
      return next
    } catch (err) {
      catalogueBackoff.failed((err as Error)?.message ?? String(err))
      throw err
    }
  })()
  inFlight = run
  const clear = () => {
    if (inFlight === run) inFlight = null
  }
  run.then(clear, clear)
  return run
}

/**
 * Return the catalogue.
 *
 * - `force` (the explicit re-check) always asks OpenRouter, whatever the
 *   automatic-update setting or back-off say.
 * - Otherwise, with `autoUpdate` off the saved copy is returned as it is,
 *   however old, and OpenRouter is never contacted.
 * - With `autoUpdate` on, a fresh copy is returned as is. A stale copy is
 *   returned straight away and refreshed in the background, so the caller
 *   never waits on the network while it has something to serve. With no copy
 *   at all the caller does wait, since there is nothing to show.
 * - A failed refresh keeps the last good copy and pushes the next automatic
 *   attempt back (1 h, doubling, capped at the TTL). With no copy to fall
 *   back on, the error is thrown.
 */
export async function getCatalogue(
  opts: { force?: boolean; autoUpdate?: boolean } = {},
): Promise<OpenRouterCatalogue> {
  const cached = await readCachedCatalogue()
  const hasCopy = cached !== null && cached.models.length > 0
  const autoUpdate = opts.autoUpdate !== false

  if (!opts.force) {
    if (hasCopy && isCatalogueFresh(cached)) return cached as OpenRouterCatalogue
    if (!autoUpdate) {
      if (hasCopy) return cached as OpenRouterCatalogue
      throw new Error('No saved model list yet, and automatic updates are off. Use Check to fetch it.')
    }
    if (!catalogueBackoff.allows()) {
      if (hasCopy) return cached as OpenRouterCatalogue
      // The raw error stays in the log; it can name a path in the profile.
      throw new Error(LAST_CHECK_FAILED)
    }
    if (hasCopy) {
      refreshCatalogue(AUTO_TIMEOUT_MS).catch((err) =>
        console.warn(
          '[openrouter] catalogue refresh failed, serving cached copy:',
          (err as Error)?.message ?? err,
        ),
      )
      return cached as OpenRouterCatalogue
    }
  }

  try {
    return await refreshCatalogue(opts.force ? FORCE_TIMEOUT_MS : AUTO_TIMEOUT_MS)
  } catch (err) {
    if (hasCopy) {
      console.warn(
        '[openrouter] catalogue refresh failed, serving cached copy:',
        (err as Error)?.message ?? err,
      )
      return cached as OpenRouterCatalogue
    }
    throw err
  }
}

const AUTO_TIMEOUT_MS = 10_000
const FORCE_TIMEOUT_MS = 20_000

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
