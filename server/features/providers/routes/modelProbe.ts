// Per-key model probe — actively tests which models a given Gemini key can
// actually call, not just which ones Google's /v1beta/models endpoint
// advertises to it. Result is cached per slot at
// {configDir}/model-availability.json so the UI and the run-time profile
// loader can refuse paid-only models on free keys (and vice versa) without
// burning the user's quota every time they open Settings.
//
// The discrepancy this exists to bridge: Google's /v1beta/models returns
// the SAME catalog of model IDs to free-tier and billing-enabled keys in
// many cases (e.g. gemini-2.5-pro is advertised to both). The actual
// access restriction kicks in at generateContent time as a 429 with
// `limit: 0` for the free-tier metric. We probe with a 1-token call to
// expose that truth eagerly.

import { createHash } from 'node:crypto'
import { readJson, writeJson, modelAvailabilityFile } from '../../../platform/appData.js'
import { type ProviderKey } from '../services/crypto/keyStore.js'
import { classifyGeminiTier, TIER_PROBE_PRIORITY } from '../../../../shared/models/geminiTier.js'
import { slog } from '../../../platform/slog.js'
import type {
  AvailabilityCache as SharedAvailabilityCache,
  ProbeEntry,
  SlotAvailability,
} from '../../../../shared/contracts/modelProbe.js'

/** Short hash of an API key, safe to show in the UI. Used to detect when
 *  two slots accidentally hold the same key value (probes returning the
 *  same result for paid + free is suspicious — equal fingerprints prove it).
 *  Six hex chars = 24 bits of identity: collision probability is ~1 in 16M
 *  per slot pair, far below the chance of the user actually pasting the
 *  same key twice. */
export function fingerprintKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 6)
}

export type { SlotAvailability }
export type AvailabilityCache = SharedAvailabilityCache<ProviderKey>

export async function readAvailabilityCache(): Promise<AvailabilityCache> {
  return readJson<AvailabilityCache>(modelAvailabilityFile(), {})
}

async function writeAvailabilityCache(next: AvailabilityCache): Promise<void> {
  await writeJson(modelAvailabilityFile(), next)
}

export async function updateSlotAvailability(
  slot: ProviderKey,
  value: SlotAvailability,
): Promise<void> {
  const cache = await readAvailabilityCache()
  cache[slot] = value
  await writeAvailabilityCache(cache)
}

/** Invalidate a single slot's cached probe. Called when the key behind that
 *  slot changes (setKey/clearKey) — the old availability data is meaningless
 *  for a new key. */
export async function invalidateSlot(slot: ProviderKey): Promise<void> {
  const cache = await readAvailabilityCache()
  if (cache[slot]) {
    delete cache[slot]
    await writeAvailabilityCache(cache)
  }
}

type GeminiListedModel = {
  name?: string
  supportedGenerationMethods?: string[]
}

/** Probe eligibility. `generateContent` support is the only gate.
 *
 *  This used to additionally require the id to classify as pro or flash,
 *  which quietly made the app forward-INcompatible: a Gemini family named
 *  outside that vocabulary was advertised by ListModels, skipped by the
 *  probe, and then dropped by the picker (which returns early as soon as any
 *  probed model is accessible, so it never reached the advertised-only
 *  fallback). A new model family would have been invisible with no warning.
 *
 *  The `generateContent` filter alone already excludes the specialty families
 *  that motivated the old gate — embedding, tts, imagen and veo models do not
 *  advertise it — so dropping the tier restriction costs little quota and
 *  buys automatic support for names we have not seen. */
function shouldProbeModel(m: GeminiListedModel): boolean {
  const id = (m.name ?? '').replace(/^models\//, '')
  if (!id) return false
  return (m.supportedGenerationMethods ?? []).includes('generateContent')
}

/** Map a 4xx response body to a stable, UI-friendly reason. Returning the
 *  raw Google error text would leak account / quota details and changes
 *  format between API versions. */
function classifyProbeFailure(status: number, body: string): string {
  if (status === 429) {
    if (/"limit":\s*0/.test(body) || /generate_content_free_tier_/.test(body)) {
      return 'Free tier quota: 0 (paid-only)'
    }
    return 'Rate-limited (429) — try again later'
  }
  if (status === 403) return 'Forbidden — billing not enabled or model restricted'
  if (status === 404) return 'Model not found on this key'
  if (status === 400) return 'Bad request (model may have changed shape)'
  return `HTTP ${status}`
}

async function probeOneGeminiModel(
  apiKey: string,
  id: string,
): Promise<ProbeEntry> {
  const tier = classifyGeminiTier(id)
  const t0 = Date.now()
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        id,
      )}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: 'ping' }] }],
          generationConfig: { maxOutputTokens: 1, temperature: 0 },
        }),
      },
    )
    const latencyMs = Date.now() - t0
    if (res.ok) {
      // Drain the response so the socket can be reused. We don't care
      // about the actual content — accessibility is the only signal.
      await res.text().catch(() => '')
      return { id, accessible: true, tier, latencyMs }
    }
    const body = await res.text().catch(() => '')
    return {
      id,
      accessible: false,
      tier,
      reason: classifyProbeFailure(res.status, body),
      latencyMs,
    }
  } catch (err) {
    return {
      id,
      accessible: false,
      tier,
      reason: `Network error: ${(err as Error).message}`,
      latencyMs: Date.now() - t0,
    }
  }
}

/** Small fixed-concurrency batch executor. Gemini's free-tier RPM (5/min on
 *  most 2.5 models) means parallel batches faster than ~4 risk self-throttling
 *  the probe. */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let cursor = 0
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const i = cursor++
      out[i] = await fn(items[i], i)
    }
  }
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker(),
  )
  await Promise.all(workers)
  return out
}

/** Maximum models tested per Gemini probe. For free-tier keys each probe
 *  consumes one of the per-day RPD, so the cap bounds the cost if Google ever
 *  ships a much larger catalog. Truncation is logged, never silent. */
const PROBE_BUDGET = 30

/**
 * Run the full probe for a Gemini key. Returns the SlotAvailability shape
 * — caller is responsible for persisting it.
 *
 * Every model advertising `generateContent` is tested, ordered by tier so the
 * budget is spent on the tiers the pipeline routes to first. Each result
 * carries its tier so the picker can group without re-deriving.
 */
export async function probeGeminiKey(apiKey: string): Promise<SlotAvailability> {
  const listRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(
      apiKey,
    )}&pageSize=200`,
  )
  if (!listRes.ok) {
    const body = await listRes.text().catch(() => '')
    throw new Error(
      `ListModels failed: HTTP ${listRes.status}. ${body.slice(0, 300)}`,
    )
  }
  const listJson = (await listRes.json()) as { models?: GeminiListedModel[] }
  const models = listJson.models ?? []
  const advertised = models
    .map((m) => (m.name ?? '').replace(/^models\//, ''))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))

  const eligible = models
    .filter(shouldProbeModel)
    .map((m) => (m.name ?? '').replace(/^models\//, ''))

  // Order by tier before truncating. The cap exists to bound cost if Google
  // ever ships a much larger catalog, but an arbitrary slice would drop
  // whichever ids happened to sort last — potentially the Pro model the user
  // routes Phase 3 through. Priority order keeps the tiers the pipeline
  // actually uses inside the budget and spends what's left on 'other'.
  const ordered = [...eligible].sort((a, b) => {
    const byTier =
      TIER_PROBE_PRIORITY[classifyGeminiTier(a)] - TIER_PROBE_PRIORITY[classifyGeminiTier(b)]
    return byTier !== 0 ? byTier : a.localeCompare(b)
  })
  const targets = ordered.slice(0, PROBE_BUDGET)

  // Never truncate silently: a dropdown missing a model the key can reach is
  // indistinguishable from one the key cannot, unless we say so.
  if (ordered.length > targets.length) {
    slog('modelProbe', {
      event: 'geminiProbe_truncated',
      eligible: ordered.length,
      probed: targets.length,
      skipped: ordered.slice(PROBE_BUDGET),
    })
  }

  const probed = await mapWithConcurrency(targets, 4, (id) =>
    probeOneGeminiModel(apiKey, id),
  )
  probed.sort((a, b) => a.id.localeCompare(b.id))

  return {
    fetchedAt: new Date().toISOString(),
    keyFingerprint: fingerprintKey(apiKey),
    advertised,
    probed,
  }
}
