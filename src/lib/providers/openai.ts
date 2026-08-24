// OpenAI provider using the Responses API.
//
// Prefix caching is automatic on OpenAI when repeated content >=1024 tokens —
// no annotations needed. We always emit the system prompt + cacheablePrefix
// as `instructions` and the chunk as `input`, so the prefix stays stable
// across chunks and cache hits accumulate. Token usage maps cleanly via
// `usage.input_tokens_details.cached_tokens`.

import OpenAI from 'openai'
import { EXHAUSTION_RETRY_MS, MAX_RETRIES, TRANSIENT_RETRY_MS } from '../constants'
import { getGuardrails } from '../guardrails'
import { RateLimitState } from '../rateLimit'
import { stripReasoningBlocks } from '../reasoning'
import type {
  GenerateOptions,
  GenerateRequest,
  GenerateResponse,
  LLMProvider,
  ProviderName,
  Usage,
} from './llm'

const TTRPG_FRAMING = [
  'This is a transcript from a tabletop role-playing game (D&D / TTRPG) session.',
  'Mature themes are expected: profanity, violence, dark humour, sexual references,',
  'gore. Preserve them verbatim — do not sanitise or paraphrase.',
].join(' ')

const SUGGESTED_MODELS = ['gpt-5', 'gpt-5-mini', 'gpt-5-nano']

// Pricing snapshot at write time (2026-05). USD per million tokens.
const PRICING: Record<string, { input: number; cachedInput: number; output: number }> = {
  'gpt-5': { input: 5, cachedInput: 0.5, output: 15 },
  'gpt-5-mini': { input: 0.3, cachedInput: 0.03, output: 1.2 },
  'gpt-5-nano': { input: 0.1, cachedInput: 0.01, output: 0.4 },
}

function isRateLimit(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { status?: number }).status === 429
}

function isTransient(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const status = (err as { status?: number }).status
  return status === 500 || status === 502 || status === 503
}

/** Extract `Retry-After` seconds from a 429 error. OpenAI SDK attaches
 *  response headers under `.headers`. Returns null when not present. */
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

export class OpenAIProvider implements LLMProvider {
  readonly name: ProviderName = 'openai'

  private client: OpenAI | null

  /** Rate-limit state populated from `x-ratelimit-*` response headers. */
  readonly rateLimit = new RateLimitState()

  constructor(args?: { apiKey?: string }) {
    const env = (import.meta as unknown as { env?: Record<string, string> }).env ?? {}
    const key = args?.apiKey ?? env.OPENAI_API_KEY ?? env.VITE_OPENAI_API_KEY
    this.client = key ? new OpenAI({ apiKey: key, dangerouslyAllowBrowser: true }) : null
  }

  hasKey(): boolean {
    return !!this.client
  }

  getNextDelayMs(estimatedInputTokens: number, extraMultiplier: number = 1): number {
    return this.rateLimit.delayBeforeNextCall(estimatedInputTokens, extraMultiplier)
  }

  async generate(req: GenerateRequest, opts: GenerateOptions = {}): Promise<GenerateResponse> {
    if (!this.client) {
      throw new Error(
        'No OpenAI API key configured. Set OPENAI_API_KEY in .env (Step 6 will replace this with the encrypted key store).'
      )
    }

    const userSystem = req.systemPrompt.trim()
    const cacheable = (req.cacheablePrefix ?? '').trim()
    // strictFraming ON drops the TTRPG framing so OpenAI sanitises per its
    // own defaults — the only safety lever the Responses API exposes.
    const strict = getGuardrails().strictFraming
    const framing = strict ? '' : TTRPG_FRAMING
    const instructions = [framing, userSystem, cacheable]
      .filter((s) => s.length > 0)
      .join('\n\n')

    let attempt = 0
    let lastErr: unknown
    while (attempt <= MAX_RETRIES) {
      if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      try {
        // `.withResponse()` exposes the raw Response so we can harvest
        // `x-ratelimit-*` headers for pacing.
        const { data: response, response: rawResponse } = await this.client.responses
          .create(
            {
              model: req.model,
              instructions,
              input: req.userPrompt,
              max_output_tokens: req.maxOutputTokens,
              ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
              store: false,
            },
            { signal: opts.signal as AbortSignal | undefined }
          )
          .withResponse()

        this.rateLimit.updateFromOpenAIHeaders(rawResponse.headers)
        this.rateLimit.noteCall()

        const text = (response.output_text ?? '').trim()
        if (!text) {
          throw new Error(
            [
              'OpenAI returned empty response.',
              `Model:           ${req.model}`,
              `Status:          ${response.status ?? '?'}`,
              `Input tokens:    ${response.usage?.input_tokens ?? '?'}`,
              `Output tokens:   ${response.usage?.output_tokens ?? '?'}`,
            ].join('\n')
          )
        }

        const u = response.usage
        const usage: Usage = {
          inputTokens: u?.input_tokens ?? 0,
          cachedInputTokens: u?.input_tokens_details?.cached_tokens ?? undefined,
          outputTokens: u?.output_tokens ?? 0,
        }
        return { text: stripReasoningBlocks(text), usage }
      } catch (err) {
        lastErr = err
        if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
        if (!isRateLimit(err) && !isTransient(err)) {
          throw wrapWithContext(err, opts.contextLabel)
        }
        // OpenAI 429s include Retry-After when the server knows how long
        // until reset. Honour it precisely; fall back to constants otherwise.
        const retryAfterSec = retryAfterFromError(err)
        if (retryAfterSec !== null) {
          this.rateLimit.noteRetryAfter(retryAfterSec)
        }
        attempt += 1
        if (attempt > MAX_RETRIES) break
        const wait =
          retryAfterSec !== null
            ? retryAfterSec * 1000
            : attempt === MAX_RETRIES
            ? EXHAUSTION_RETRY_MS
            : TRANSIENT_RETRY_MS
        opts.onRetry?.(attempt, wait)
        console.warn(`[openai] Retryable error (attempt ${attempt}/${MAX_RETRIES}); waiting ${wait}ms.`)
        await sleep(wait, opts.signal)
      }
    }
    throw wrapWithContext(lastErr, opts.contextLabel)
  }

  async listModels(): Promise<string[]> {
    return SUGGESTED_MODELS.slice()
  }

  estimateCost(usage: Usage, model: string): number {
    const rates = PRICING[model]
    if (!rates) return 0
    const cachedIn = usage.cachedInputTokens ?? 0
    const billedIn = Math.max(0, usage.inputTokens - cachedIn)
    return (
      (billedIn * rates.input + cachedIn * rates.cachedInput + usage.outputTokens * rates.output) /
      1_000_000
    )
  }
}
