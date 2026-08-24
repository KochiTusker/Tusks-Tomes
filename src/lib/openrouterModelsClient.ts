// Browser-side client for the OpenRouter model catalogue.
//
// Mirrors aliasIndexClient.ts: memoised, fails soft, returns an empty result
// rather than throwing so the picker degrades to "nothing to show" instead of
// blanking the settings page.

export interface OpenRouterModelInfo {
  id: string
  name: string
  inputPerM: number
  outputPerM: number
  cachedInputPerM?: number
  contextLength: number
  maxCompletionTokens: number | null
  supportsStructuredOutputs: boolean
  isModerated: boolean
  isFree: boolean
  inputModalities: string[]
  outputModalities: string[]
  pricingTiers?: Array<{
    minPromptTokens: number
    inputPerM: number
    outputPerM: number
    cachedInputPerM?: number
  }>
  reasoning?: {
    mandatory: boolean
    defaultEnabled?: boolean
    supportedEfforts?: string[]
  }
  leaksReasoning?: boolean
}

export interface ProviderPolicy {
  name: string
  trains: boolean
  retains: boolean
  retentionDays: number | null
}

export interface CatalogueResult {
  fetchedAt: string | null
  models: OpenRouterModelInfo[]
  providerPolicies: ProviderPolicy[]
  error?: string
}

const EMPTY: CatalogueResult = { fetchedAt: null, models: [], providerPolicies: [] }

let cached: { at: number; result: CatalogueResult } | null = null
const CACHE_TTL_MS = 10 * 60_000

export async function getOpenRouterCatalogue(opts?: {
  force?: boolean
}): Promise<CatalogueResult> {
  if (!opts?.force && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.result
  try {
    const res = await fetch(`/api/openrouter/models${opts?.force ? '?refresh=1' : ''}`)
    if (!res.ok) {
      const result = { ...EMPTY, error: `HTTP ${res.status}` }
      cached = { at: Date.now(), result }
      return result
    }
    const body = (await res.json()) as CatalogueResult & { ok?: boolean }
    const result: CatalogueResult = {
      fetchedAt: body.fetchedAt ?? null,
      models: Array.isArray(body.models) ? body.models : [],
      providerPolicies: Array.isArray(body.providerPolicies) ? body.providerPolicies : [],
      ...(body.ok === false && body.error ? { error: body.error } : {}),
    }
    cached = { at: Date.now(), result }
    return result
  } catch (err) {
    const result = { ...EMPTY, error: (err as Error)?.message ?? String(err) }
    cached = { at: Date.now(), result }
    return result
  }
}

/**
 * The rate that applies at a given prompt length.
 *
 * Mirrors the server-side priceAt(). Kept in both places because the server
 * needs it for estimates and the picker needs it to show what a phase will
 * actually cost — and 61 of 413 models raise their rate above a threshold.
 */
export function priceAtPromptTokens(
  model: OpenRouterModelInfo,
  promptTokens: number,
): { inputPerM: number; outputPerM: number; tiered: boolean } {
  const base = { inputPerM: model.inputPerM, outputPerM: model.outputPerM, tiered: false }
  if (!model.pricingTiers?.length) return base
  let applied: (typeof model.pricingTiers)[number] | null = null
  for (const t of model.pricingTiers) if (promptTokens >= t.minPromptTokens) applied = t
  if (!applied) return base
  return { inputPerM: applied.inputPerM, outputPerM: applied.outputPerM, tiered: true }
}

/** Format a per-million rate for display. Free reads as "free", not "$0.000". */
export function formatRate(perM: number): string {
  if (perM === 0) return 'free'
  if (perM < 0.01) return `$${perM.toFixed(4)}`
  if (perM < 1) return `$${perM.toFixed(3)}`
  return `$${perM.toFixed(2)}`
}

export function formatTokens(n: number | null): string {
  if (n === null || !Number.isFinite(n) || n <= 0) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

/**
 * Is this a model the text pipeline can actually use?
 *
 * The catalogue is full of image generators, speech models, video models and
 * embedding endpoints. None of them can run a phase, and offering them in a
 * model picker is worse than noise — a plausible-looking id that fails at run
 * time. Filtering is by declared modality rather than by name, with a name
 * check only as a backstop for rows whose modality metadata is thin.
 */
export function isTextPipelineModel(m: OpenRouterModelInfo): boolean {
  // Must be able to produce text, and must not be producing anything else —
  // an image-output model that also emits a caption is not a prose model.
  if (!m.outputModalities.includes('text')) return false
  if (m.outputModalities.some((o) => o !== 'text')) return false

  // Must accept text. Extra input modalities are fine and often useful; a
  // vision model that also reads text can still ground a transcript.
  if (m.inputModalities.length > 0 && !m.inputModalities.includes('text')) return false

  // Backstop for rows with sparse modality data. These substrings only appear
  // in ids of media or embedding endpoints.
  if (/(^|[/-])(tts|stt|whisper|asr|embed|embedding|rerank|moderation)([/-]|$)/i.test(m.id)) {
    return false
  }
  if (/(transcribe|transcription)/i.test(m.id)) {
    return false
  }
  if (/(image|video|audio|voice|speech|diffusion|lyria|chirp|parakeet|voxtral)/i.test(m.id)) {
    return false
  }

  // A model with no context window cannot take a chunk.
  if (m.contextLength <= 0) return false

  return true
}

/**
 * Models measured writing up graphic table content without refusing or
 * softening it.
 *
 * Probed against the live API on 2026-08-18 with two passages of the kind a
 * real session produces: a combat kill with gore and swearing, and then a
 * harder one with prolonged torture and crude sexual banter. Each model was
 * asked for narrative prose and for a JSON extraction of the violent moments.
 *
 * The result was uniform and worth recording precisely because it contradicts
 * the obvious assumption: **not one model refused either passage**, and that
 * includes every model carrying a platform moderation filter. Anthropic and
 * OpenAI models wrote up the torture scene as readily as the unmoderated ones.
 *
 * So `isModerated` did not predict refusal for this material. The flag marks
 * that a filter exists, not that it fires on tabletop fiction. Anyone choosing
 * a model for the prose phases should know the filter is unlikely to be what
 * spoils their chronicle — output length and drift are the real risks.
 *
 * This is one measurement at one intensity, not a guarantee. A table that
 * routinely produces more extreme material than the above should test its own.
 */
export const MATURE_CONTENT_MEASURED_OK = new Set<string>([
  'nvidia/nemotron-3.5-lightning',
  'nvidia/nemotron-3-nano-30b-a3b',
  'nvidia/nemotron-3-ultra-550b-a55b',
  'mistralai/mistral-nemo',
  'mistralai/mistral-small-3.2-24b-instruct',
  'mistralai/mistral-large-2512',
  'x-ai/grok-4.20',
  'moonshotai/kimi-k2.6',
  'deepseek/deepseek-v4-flash',
  'qwen/qwen3-235b-a22b-2507',
  'z-ai/glm-4.7',
  'google/gemini-2.5-flash',
  'openai/gpt-oss-120b',
  'anthropic/claude-haiku-4.5',
  // Measured 2026-08-19 on a deliberately graphic passage, three ways: the
  // direct API with all four harm categories at BLOCK_NONE, the direct API
  // with NO safety settings at all, and the same model through OpenRouter.
  // All three returned the passage intact — every violent detail, every
  // expletive, finish reason STOP, nothing flagged. Whatever separates the
  // direct route from the OpenRouter one, content filtering is not it.
  '~google/gemini-pro-latest',
  '~google/gemini-flash-latest',
  'google/gemini-3.1-pro-preview',
  // Measured 2026-08-19. These four are the models the shipped presets and the
  // refusal-repair list actually route to, and until this run their behaviour
  // on graphic content was assumed from a sibling rather than checked. All
  // four kept every violent detail and both expletives.
  'deepseek/deepseek-v4-pro',
  'z-ai/glm-5.2',
  'minimax/minimax-m3',
  'qwen/qwen3-30b-a3b-instruct-2507',
])

/**
 * Models reached OUTSIDE the OpenRouter catalogue that are known to carry
 * mature content — currently the direct Gemini key.
 *
 * The pipeline sends safetyMode 'permissive' on every prose chunk
 * (pipeline.ts:368,428), which maps to BLOCK_NONE across all four harm
 * categories. That was measured rather than assumed, and it matters because
 * a user reading the catalogue card would otherwise conclude their own Gemini
 * key is the one route that might sanitise their session.
 */
export const MATURE_CONTENT_NATIVE_OK = new Set<string>([
  'gemini-pro-latest',
  'gemini-flash-latest',
  'gemini-flash-lite-latest',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
])

/** True when a model has been measured carrying mature content, by either id
 *  shape — catalogue-namespaced or provider-native. */
export function handlesMatureContent(modelId: string): boolean {
  return MATURE_CONTENT_MEASURED_OK.has(modelId) || MATURE_CONTENT_NATIVE_OK.has(modelId)
}
