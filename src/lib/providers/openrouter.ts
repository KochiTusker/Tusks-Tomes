// OpenRouter provider.
//
// OpenRouter is wire-compatible with the OpenAI SDK, so this is deliberately a
// close relative of openai.ts. Four things differ, and each one matters:
//
//  1. Chat Completions, not Responses. OpenRouter has no /v1/responses
//     endpoint, so we cannot reuse openai.ts's `responses.create` path.
//
//  2. Caching is explicit. OpenAI caches repeated prefixes automatically;
//     OpenRouter wants an Anthropic-style `cache_control` breakpoint, which it
//     then translates per upstream family. Our GenerateRequest already
//     separates `cacheablePrefix` from `userPrompt`, so the breakpoint lands
//     exactly where the pipeline already promised the prefix is byte-stable.
//
//  3. A privacy floor on every request. `zdr: true` + `data_collection: 'deny'`
//     restricts routing to upstreams that do not retain prompts. This is a
//     default, not a suggestion: a session transcript is other people's private
//     conversation and they did not agree to it being retained. Relaxing the
//     floor is what makes `:free` models reachable at all — as of 2026-08-18
//     none of the 15 free models runs on a zero-retention provider, and 7 of
//     them are NVIDIA-hosted, which may train on prompts.
//
//  4. Real cost, not estimated. Every response carries `usage.cost` with no
//     opt-in (the old `usage: {include: true}` parameter is deprecated and
//     inert). That is surfaced on Usage.costUsd so the UI can show what was
//     actually billed instead of what we guessed.

import OpenAI from 'openai'
import { EXHAUSTION_RETRY_MS, MAX_RETRIES, TRANSIENT_RETRY_MS } from '../constants'
import { getGuardrails } from '../guardrails'
import { OPENROUTER_FREE_LIMITS, RateLimitRegistry } from '../rateLimit'
import { stripAllReasoning } from '../reasoning'
import { clampMaxOutputTokens } from '../modelLimits'
import type {
  GenerateOptions,
  GenerateRequest,
  GenerateResponse,
  LLMProvider,
  ProviderName,
  Usage,
} from './llm'

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'

const TTRPG_FRAMING = [
  'This is a transcript from a tabletop role-playing game (D&D / TTRPG) session.',
  'Mature themes are expected: profanity, violence, dark humour, sexual references,',
  'gore. Preserve them verbatim — do not sanitise or paraphrase.',
].join(' ')

/** Shown in the model picker before a catalogue fetch has happened. Chosen for
 *  the pipeline's actual shape rather than for benchmark scores: all are
 *  unmoderated (the prose phases get refused otherwise), all support structured
 *  outputs (the audit and extras phases emit JSON), and all declare an output
 *  ceiling at or above our 32,768 default. */
const SUGGESTED_MODELS = [
  'openai/gpt-oss-120b',
  'deepseek/deepseek-v4-flash',
  'nvidia/nemotron-3.5-lightning',
  'google/gemini-2.5-flash',
  'google/gemini-2.5-pro',
]

/** Per-request routing preferences. Defaults enforce the privacy floor. */
export interface OpenRouterRouting {
  /** Restrict to zero-data-retention endpoints. */
  zdr?: boolean
  /** 'deny' excludes providers that store prompts. */
  dataCollection?: 'allow' | 'deny'
  /** Pin to specific upstream provider slugs. */
  only?: string[]
  sort?: 'price' | 'throughput' | 'latency'
}

export const DEFAULT_ROUTING: Required<Pick<OpenRouterRouting, 'zdr' | 'dataCollection' | 'sort'>> =
  {
    zdr: true,
    dataCollection: 'deny',
    sort: 'price',
  }

/** `:free` suffix marks the zero-cost variant, which carries the platform
 *  request caps. Paid variants of the same model have no such cap. */
export function isFreeVariant(modelId: string): boolean {
  return modelId.endsWith(':free')
}

function isRateLimit(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { status?: number }).status === 429
}

function isTransient(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const status = (err as { status?: number }).status
  return status === 500 || status === 502 || status === 503 || status === 520 || status === 524
}

function retryAfterFromError(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null
  const headers = (err as { headers?: unknown }).headers
  let raw: string | undefined
  if (headers instanceof Headers) {
    raw = headers.get('retry-after') ?? undefined
  } else if (headers && typeof headers === 'object') {
    raw =
      (headers as Record<string, string | undefined>)['retry-after'] ??
      (headers as Record<string, string | undefined>)['Retry-After']
  }
  if (!raw) return null
  const n = parseFloat(raw)
  return Number.isFinite(n) && n >= 0 ? n : null
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'))
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
  })
}

function wrapWithContext(err: unknown, contextLabel?: string): Error {
  const base = err instanceof Error ? err : new Error(String(err))
  if (!contextLabel) return base
  const wrapped = new Error(`[${contextLabel}]\n${base.message}`)
  ;(wrapped as Error & { cause?: unknown }).cause = base
  return wrapped
}

/** OpenRouter's usage block, which is a superset of OpenAI's. */
interface OpenRouterUsage {
  prompt_tokens?: number
  completion_tokens?: number
  cost?: number
  prompt_tokens_details?: {
    cached_tokens?: number
    cache_write_tokens?: number
  }
}

/**
 * Build the message array, marking the cacheable prefix with a breakpoint.
 *
 * Exported for tests: getting the breakpoint placement wrong is silent — the
 * request still succeeds, it just never hits cache, and the only symptom is a
 * bill several times larger than expected.
 */
export function buildMessages(args: {
  framing: string
  systemPrompt: string
  cacheablePrefix: string
  userPrompt: string
}): unknown[] {
  const stable = [args.framing, args.systemPrompt, args.cacheablePrefix]
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join('\n\n')

  const messages: unknown[] = []
  if (stable.length > 0) {
    messages.push({
      role: 'system',
      // Content is an array so the breakpoint can sit on the block. A plain
      // string cannot carry cache_control, so the prefix would be re-billed in
      // full on every chunk.
      content: [{ type: 'text', text: stable, cache_control: { type: 'ephemeral' } }],
    })
  }
  messages.push({ role: 'user', content: args.userPrompt })
  return messages
}

/** Translate our routing preferences into OpenRouter's `provider` block. */
export function buildProviderBlock(routing?: OpenRouterRouting): Record<string, unknown> {
  const merged = { ...DEFAULT_ROUTING, ...(routing ?? {}) }
  const block: Record<string, unknown> = {
    zdr: merged.zdr,
    data_collection: merged.dataCollection,
    sort: merged.sort,
  }
  if (routing?.only && routing.only.length > 0) block.only = routing.only
  return block
}

export class OpenRouterProvider implements LLMProvider {
  readonly name: ProviderName = 'openrouter'

  private client: OpenAI | null

  /**
   * One rate-limit bucket per model, plus an account-wide gate.
   *
   * Per-model matters more here than anywhere else in the codebase: a single
   * OpenRouter key can address a 20 RPM free variant and an uncapped paid model
   * in the same run, and a shared anchor would pace the fast one as though it
   * were the slow one.
   */
  readonly rateLimit = new RateLimitRegistry()

  /** Model id -> advertised output ceiling, seeded from the catalogue. Used to
   *  clamp max_tokens so a 16k-ceiling model gets a valid request instead of a
   *  400. 81 of 407 catalogue models sat below our 32,768 default on
   *  2026-08-18, so this is the common case, not an edge case. */
  private outputCeilings = new Map<string, number>()

  private routing: OpenRouterRouting

  constructor(args?: { apiKey?: string; routing?: OpenRouterRouting }) {
    const env = (import.meta as unknown as { env?: Record<string, string> }).env ?? {}
    const key = args?.apiKey ?? env.OPENROUTER_API_KEY ?? env.VITE_OPENROUTER_API_KEY
    this.routing = args?.routing ?? {}
    this.client = key
      ? new OpenAI({
          apiKey: key,
          baseURL: OPENROUTER_BASE_URL,
          dangerouslyAllowBrowser: true,
        })
      : null
  }

  hasKey(): boolean {
    return !!this.client
  }

  /** Seed advertised output ceilings from the catalogue. */
  setOutputCeilings(ceilings: Map<string, number>): void {
    this.outputCeilings = ceilings
  }

  setRouting(routing: OpenRouterRouting): void {
    this.routing = routing
  }

  /**
   * Seed the platform caps for a model.
   *
   * `:free` variants are capped at 20 requests/minute account-wide. Paid models
   * carry no platform request cap at all, so they are left unseeded and pace
   * purely from observed response headers — which is what lets them run at full
   * speed rather than at a guessed floor.
   */
  seedLimitsFor(modelId: string): void {
    if (isFreeVariant(modelId)) {
      // No published token budget, so TPM is left effectively unbounded and
      // RPM does the work.
      this.rateLimit.setStatic(modelId, OPENROUTER_FREE_LIMITS.rpm, Number.MAX_SAFE_INTEGER)
    }
  }

  /** Set the daily request budget from GET /api/v1/key's `is_free_tier`. */
  setDailyBudget(isFreeTier: boolean): void {
    this.rateLimit.daily.setCap(
      isFreeTier ? OPENROUTER_FREE_LIMITS.rpdNoCredits : OPENROUTER_FREE_LIMITS.rpdWithCredits,
    )
  }

  getNextDelayMs(
    estimatedInputTokens: number,
    extraMultiplier: number = 1,
    modelId?: string,
  ): number {
    const id = modelId ?? '(unknown)'
    this.seedLimitsFor(id)
    return this.rateLimit.delayBeforeNextCall(id, estimatedInputTokens, extraMultiplier)
  }

  async generate(req: GenerateRequest, opts: GenerateOptions = {}): Promise<GenerateResponse> {
    if (!this.client) {
      throw new Error('No OpenRouter API key configured. Add one in Settings → Providers.')
    }

    const strict = getGuardrails().strictFraming
    const messages = buildMessages({
      framing: strict ? '' : TTRPG_FRAMING,
      systemPrompt: req.systemPrompt ?? '',
      cacheablePrefix: req.cacheablePrefix ?? '',
      userPrompt: req.userPrompt,
    })

    const ceiling = this.outputCeilings.get(req.model) ?? null
    const { tokens: maxTokens } = clampMaxOutputTokens(req.maxOutputTokens, ceiling)

    // The OpenAI SDK's params type has no `provider` field — it is
    // OpenRouter-specific — so the body is assembled loosely and cast at the
    // call. Casting the body rather than the client keeps the rest of the call
    // type-checked.
    const body = {
      model: req.model,
      messages,
      max_tokens: maxTokens,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.responseFormat === 'json' ? { response_format: { type: 'json_object' } } : {}),
      provider: buildProviderBlock(this.routing),
    }

    let attempt = 0
    let lastErr: unknown
    while (attempt <= MAX_RETRIES) {
      if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      try {
        const { data: response, response: rawResponse } = await this.client.chat.completions
          .create(body as never, { signal: opts.signal as AbortSignal | undefined })
          .withResponse()

        this.rateLimit.updateFromOpenRouterHeaders(req.model, rawResponse.headers)
        this.rateLimit.noteCall(req.model)

        const choice = response.choices?.[0]
        const text = (choice?.message?.content ?? '').trim()
        if (!text) {
          throw new Error(
            [
              'OpenRouter returned empty response.',
              `Model:         ${req.model}`,
              `Finish reason: ${choice?.finish_reason ?? '?'}`,
              `Input tokens:  ${response.usage?.prompt_tokens ?? '?'}`,
              `Output tokens: ${response.usage?.completion_tokens ?? '?'}`,
              choice?.finish_reason === 'length'
                ? `Hit the output ceiling (${maxTokens} tokens). Pick a model with a larger ceiling, or reduce the chunk size for this phase.`
                : 'An empty body with a non-length finish reason usually means the upstream refused the prompt. Try an unmoderated model for the prose phases.',
            ].join('\n'),
          )
        }

        const u = response.usage as OpenRouterUsage | undefined
        const usage: Usage = {
          inputTokens: u?.prompt_tokens ?? 0,
          cachedInputTokens: u?.prompt_tokens_details?.cached_tokens ?? undefined,
          outputTokens: u?.completion_tokens ?? 0,
          ...(typeof u?.cost === 'number' ? { costUsd: u.cost } : {}),
        }
        // Two passes. The tagged stripper handles <think> blocks; the
        // untagged one catches models that write deliberation as plain prose,
        // which nothing downstream would otherwise remove. responseFormat
        // tells us which shape to anchor the cut on.
        const cleaned = stripAllReasoning(text, {
          expectedShape: req.responseFormat === 'json' ? 'json' : 'speaker-tagged',
        })
        if (cleaned.stripped) {
          console.warn(
            `[openrouter] ${req.model} wrote untagged reasoning into its reply; removed before use.`,
          )
        }
        return { text: cleaned.text, usage }
      } catch (err) {
        lastErr = err
        if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
        if (!isRateLimit(err) && !isTransient(err)) {
          throw wrapWithContext(err, opts.contextLabel)
        }
        const retryAfterSec = retryAfterFromError(err)
        // Account-wide: a 429 from OpenRouter is a statement about the key, so
        // switching model must not escape the wait.
        if (retryAfterSec !== null) this.rateLimit.noteRetryAfter(retryAfterSec)
        attempt += 1
        if (attempt > MAX_RETRIES) break
        const wait =
          retryAfterSec !== null
            ? retryAfterSec * 1000
            : attempt === MAX_RETRIES
              ? EXHAUSTION_RETRY_MS
              : TRANSIENT_RETRY_MS
        opts.onRetry?.(attempt, wait)
        console.warn(
          `[openrouter] Retryable error (attempt ${attempt}/${MAX_RETRIES}); waiting ${wait}ms.`,
        )
        await sleep(wait, opts.signal)
      }
    }
    throw wrapWithContext(lastErr, opts.contextLabel)
  }

  async listModels(): Promise<string[]> {
    return SUGGESTED_MODELS.slice()
  }

  /**
   * Cost for a call.
   *
   * Unlike every other provider this is not a guess: OpenRouter reports the
   * actual charge on the response and we carried it through on Usage.costUsd.
   * Falling back to 0 rather than a rate-table estimate is deliberate — the
   * catalogue lives server-side, and a wrong number here would be harder to
   * notice than a zero.
   */
  estimateCost(usage: Usage): number {
    return usage.costUsd ?? 0
  }
}
