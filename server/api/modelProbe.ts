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
import { readJson, writeJson, modelAvailabilityFile } from '../appData.js'
import { type ProviderKey } from '../crypto/keyStore.js'
import {
  classifyGeminiTier,
  TIER_PROBE_PRIORITY,
  type GeminiModelTier,
} from '../lib/geminiTier.js'
import { slog } from '../lib/slog.js'

/** Short hash of an API key, safe to show in the UI. Used to detect when
 *  two slots accidentally hold the same key value (probes returning the
 *  same result for paid + free is suspicious — equal fingerprints prove it).
 *  Six hex chars = 24 bits of identity: collision probability is ~1 in 16M
 *  per slot pair, far below the chance of the user actually pasting the
 *  same key twice. */
export function fingerprintKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 6)
}

/** Single per-model probe result. */
export type ProbeEntry = {
  id: string
  /** True iff the 1-token generateContent succeeded. */
  accessible: boolean
  /** Gemini capability tier, stamped at probe time so the picker can group
   *  the dropdown without re-deriving it client-side. Absent for Claude /
   *  OpenAI entries, whose ids carry no parseable tier. */
  tier?: GeminiModelTier
  /** Human-readable failure cause when accessible=false. Stable enough for
   *  the UI to switch on (e.g. "Free tier quota: 0" → grey out with
   *  "Paid only" chip). */
  reason?: string
  /** Round-trip latency for the probe call, ms. Diagnostic only. */
  latencyMs?: number
}

export type SlotAvailability = {
  /** ISO timestamp when this probe ran. UI can show "Probed 12 minutes ago". */
  fetchedAt: string
  /** Short SHA-256 prefix of the key that produced this probe. Lets the UI
   *  detect when two slots accidentally hold identical key strings (one
   *  cause of "probes returned the same result for paid and free"). */
  keyFingerprint?: string
  /** Every model id the key's /v1beta/models endpoint advertised (regardless
   *  of whether we probed it). Includes embedding / specialty models the
   *  text pipeline never uses but the Settings UI may want to show. */
  advertised: string[]
  /** Per-model probe outcome for the subset we actually tested. The picker
   *  uses `accessible: true` entries as the dropdown source. */
  probed: ProbeEntry[]
}

export type AvailabilityCache = Partial<Record<ProviderKey, SlotAvailability>>

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

/** Curated probe targets per provider — mirrors STATIC_PROVIDER_MODELS in
 *  src/lib/cloudKeys.ts. We keep two copies (one server-side, one client-
 *  side) because the server's modelProbe.ts can't import from src/ without
 *  pulling in Vite's path aliases. The two lists are intentionally
 *  identical and tested by a static guard below. If you update one, update
 *  the other. */
const CLAUDE_PROBE_TARGETS = [
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
  'claude-3-7-sonnet-latest',
  'claude-3-5-sonnet-latest',
  'claude-3-5-haiku-latest',
] as const

const OPENAI_PROBE_TARGETS = [
  'gpt-5',
  'gpt-5-mini',
  'gpt-4o',
  'gpt-4o-mini',
  'o3',
  'o3-mini',
  'o1',
] as const

/** Exported so the client-side `availableModelsFor` helper can use the
 *  same set when falling back to STATIC_PROVIDER_MODELS for an unprobed
 *  Claude/OpenAI key. Sole source of truth lives here. */
export const PROBE_TARGETS = {
  claude: CLAUDE_PROBE_TARGETS,
  openai: OPENAI_PROBE_TARGETS,
} as const

/** Map a Claude 4xx response body to a UI-stable reason string. */
function classifyClaudeFailure(status: number, body: string): string {
  if (status === 429) return 'Rate-limited (429) — try again later'
  if (status === 403) return 'Forbidden — key has no access to this model'
  if (status === 404) return 'Model not found on this key'
  if (status === 401) return 'Unauthorized — key invalid for this model'
  if (status === 400) {
    // Anthropic's typical "model not found" returns 400 with an
    // invalid_request_error type — surface as model-not-available.
    if (/model:\s*"?[^"]*"?\s*was not found/i.test(body) ||
        /invalid_request_error/i.test(body)) {
      return 'Model not available on this key'
    }
    return 'Bad request (model may have changed shape)'
  }
  return `HTTP ${status}`
}

async function probeOneClaudeModel(apiKey: string, id: string): Promise<ProbeEntry> {
  const t0 = Date.now()
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: id,
        max_tokens: 1,
        messages: [{ role: 'user', content: '.' }],
      }),
    })
    const latencyMs = Date.now() - t0
    if (res.ok) {
      await res.text().catch(() => '')
      return { id, accessible: true, latencyMs }
    }
    const body = await res.text().catch(() => '')
    return { id, accessible: false, reason: classifyClaudeFailure(res.status, body), latencyMs }
  } catch (err) {
    return {
      id,
      accessible: false,
      reason: `Network error: ${(err as Error).message}`,
      latencyMs: Date.now() - t0,
    }
  }
}

/**
 * Probe a Claude (Anthropic) key. Mirrors `probeGeminiKey` shape so the
 * client-side dropdown wiring can read all four slots uniformly.
 *
 * Anthropic doesn't expose a public /v1/models endpoint that lists every
 * model the key can reach (it requires an enterprise account). So the
 * `advertised` list is populated FROM the curated probe targets — any
 * model that returns success or a billing-style 4xx is added. This means
 * the advertised list is effectively the probe success set, which is
 * fine for the dropdown's purposes (the user picks from this list and
 * everything they see has been verified).
 */
export async function probeClaudeKey(apiKey: string): Promise<SlotAvailability> {
  const probed = await mapWithConcurrency(
    [...CLAUDE_PROBE_TARGETS],
    3, // Anthropic Tier-1 RPM is conservative; 3 in flight is comfortable.
    (id) => probeOneClaudeModel(apiKey, id),
  )
  probed.sort((a, b) => a.id.localeCompare(b.id))
  // The "advertised" list for Anthropic = every target we asked about,
  // since /v1/models isn't reliably available. Same alphabetical order.
  const advertised = [...probed].map((p) => p.id).sort((a, b) => a.localeCompare(b))
  return {
    fetchedAt: new Date().toISOString(),
    keyFingerprint: fingerprintKey(apiKey),
    advertised,
    probed,
  }
}

/** Map an OpenAI 4xx response body to a UI-stable reason string. */
function classifyOpenAIFailure(status: number, body: string): string {
  if (status === 429) return 'Rate-limited (429) — try again later'
  if (status === 403) return 'Forbidden — billing not enabled or model restricted'
  if (status === 404) return 'Model not found on this key'
  if (status === 401) return 'Unauthorized — key invalid for this model'
  if (status === 400) {
    if (/model.*does not exist/i.test(body) || /model_not_found/i.test(body)) {
      return 'Model not available on this key'
    }
    if (/must be verified/i.test(body)) return 'Model requires organization verification'
    return 'Bad request (model may have changed shape)'
  }
  return `HTTP ${status}`
}

async function probeOneOpenAIModel(apiKey: string, id: string): Promise<ProbeEntry> {
  const t0 = Date.now()
  try {
    // Use chat completions — universally supported across model families
    // including the o1/o3 reasoning lineup. The newer /v1/responses
    // endpoint isn't on every account, so chat.completions is safer.
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: id,
        max_tokens: 1,
        messages: [{ role: 'user', content: '.' }],
      }),
    })
    const latencyMs = Date.now() - t0
    if (res.ok) {
      await res.text().catch(() => '')
      return { id, accessible: true, latencyMs }
    }
    const body = await res.text().catch(() => '')
    return { id, accessible: false, reason: classifyOpenAIFailure(res.status, body), latencyMs }
  } catch (err) {
    return {
      id,
      accessible: false,
      reason: `Network error: ${(err as Error).message}`,
      latencyMs: Date.now() - t0,
    }
  }
}

/**
 * Probe an OpenAI key. Same shape contract as Gemini/Claude. Uses
 * /v1/models for the advertised list (OpenAI does expose this publicly
 * to any valid key) and /v1/chat/completions per target for accessibility.
 */
export async function probeOpenAIKey(apiKey: string): Promise<SlotAvailability> {
  // Fetch advertised list first. Soft-fail to the probe-target set if
  // /v1/models is unavailable — the dropdown still works.
  let advertised: string[] = []
  try {
    const listRes = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (listRes.ok) {
      const listJson = (await listRes.json()) as { data?: Array<{ id: string }> }
      advertised = (listJson.data ?? [])
        .map((m) => m.id)
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b))
    } else {
      // Non-2xx — fall back. Don't throw; the per-model probes are the
      // load-bearing accessibility signal anyway.
      advertised = [...OPENAI_PROBE_TARGETS].sort((a, b) => a.localeCompare(b))
    }
  } catch {
    advertised = [...OPENAI_PROBE_TARGETS].sort((a, b) => a.localeCompare(b))
  }

  const probed = await mapWithConcurrency(
    [...OPENAI_PROBE_TARGETS],
    3,
    (id) => probeOneOpenAIModel(apiKey, id),
  )
  probed.sort((a, b) => a.id.localeCompare(b.id))

  return {
    fetchedAt: new Date().toISOString(),
    keyFingerprint: fingerprintKey(apiKey),
    advertised,
    probed,
  }
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
