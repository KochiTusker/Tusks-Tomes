// Anthropic Claude provider. Uses the official @anthropic-ai/sdk and is wired
// to use prompt caching (cache_control: ephemeral) on the system block —
// that's where the bulk of the prompt lives (system prompt template + KB +
// contextual hints), and it's identical across chunks within a phase.
//
// Mature content: Claude has no toggleable safety thresholds. The system
// prompt establishes TTRPG framing so the model preserves profanity, violence,
// and dark humour verbatim instead of sanitising.

import Anthropic from '@anthropic-ai/sdk'
import type { RateLimitError } from '@anthropic-ai/sdk'
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

// Pricing snapshot at write time (2026-05). USD per million tokens. Update as
// rates change. Used by estimateCost(); not load-bearing for routing.
const PRICING: Record<string, { input: number; cachedInput: number; output: number }> = {
  'claude-opus-4-7': { input: 15, cachedInput: 1.5, output: 75 },
  'claude-sonnet-4-6': { input: 3, cachedInput: 0.3, output: 15 },
  'claude-haiku-4-5-20251001': { input: 0.8, cachedInput: 0.08, output: 4 },
}

const SUGGESTED_MODELS = [
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
]

function isRateLimit(err: unknown): err is RateLimitError {
  return (
    !!err &&
    typeof err === 'object' &&
    'status' in err &&
    (err as { status?: unknown }).status === 429
  )
}

function isTransient(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const status = (err as { status?: unknown }).status
  return status === 500 || status === 502 || status === 503 || status === 529
}

/** Extract `Retry-After` seconds from a 429 error. Anthropic SDK attaches
 *  response headers under `.headers`. Returns null when not present or
 *  unparseable. */
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

type ContentBlock = { type: string; text?: string }

function extractText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('')
}

export class ClaudeProvider implements LLMProvider {
  readonly name: ProviderName = 'claude'

  private client: Anthropic | null
  private apiKey: string | undefined

  /** Rate-limit state — populated from response headers each call. The
   *  first call of a run goes immediately; subsequent calls pace based
   *  on what the API last reported. */
  readonly rateLimit = new RateLimitState()

  constructor(args?: { apiKey?: string }) {
    const env = (import.meta as unknown as { env?: Record<string, string> }).env ?? {}
    const key = args?.apiKey ?? env.ANTHROPIC_API_KEY ?? env.VITE_ANTHROPIC_API_KEY
    this.apiKey = key
    // dangerouslyAllowBrowser: this SDK fronts a browser fetch via Vite's dev
    // server; the user's machine is the only client. Step 6 will move keys
    // into the encrypted server-side store and stop sending them to the
    // browser entirely. Until then, we opt-in explicitly.
    this.client = key ? new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true }) : null
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
        'No Anthropic API key configured. Set ANTHROPIC_API_KEY in .env (Step 6 will replace this with the encrypted key store).'
      )
    }

    const cacheable = (req.cacheablePrefix ?? '').trim()
    const userSystemPrompt = req.systemPrompt.trim()
    // When the user has turned strictFraming ON, drop the TTRPG framing so
    // Claude falls back to its own sanitising defaults — this is the only
    // safety lever the Anthropic API exposes to us.
    const strict = getGuardrails().strictFraming
    const baseSystem = strict
      ? (userSystemPrompt || ' ')
      : userSystemPrompt
        ? `${TTRPG_FRAMING}\n\n${userSystemPrompt}`
        : TTRPG_FRAMING

    // Claude's caching is opt-in per system block. We always put the framing
    // + user-supplied system prompt as the first block (cheap, not worth
    // caching alone), and — when there's a cacheable prefix (KB, glossary)
    // — emit it as a second block marked ephemeral.
    const systemBlocks: Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }> = [
      { type: 'text', text: baseSystem },
    ]
    if (cacheable) {
      systemBlocks.push({
        type: 'text',
        text: cacheable,
        cache_control: { type: 'ephemeral' },
      })
    }

    let attempt = 0
    let lastErr: unknown
    while (attempt <= MAX_RETRIES) {
      if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      try {
        // `.withResponse()` returns the parsed body and the raw Response so
        // we can harvest `anthropic-ratelimit-*` headers for pacing.
        const { data: response, response: rawResponse } = await this.client.messages
          .create(
            {
              model: req.model,
              max_tokens: req.maxOutputTokens,
              ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
              system: systemBlocks,
              messages: [{ role: 'user', content: req.userPrompt }],
            },
            { signal: opts.signal }
          )
          .withResponse()

        this.rateLimit.updateFromClaudeHeaders(rawResponse.headers)
        this.rateLimit.noteCall()

        const text = extractText(response.content as ContentBlock[]).trim()
        if (!text) {
          throw new Error(
            [
              'Claude returned empty response.',
              `Model:           ${req.model}`,
              `Stop reason:     ${response.stop_reason ?? '?'}`,
              `Input tokens:    ${response.usage.input_tokens}`,
              `Output tokens:   ${response.usage.output_tokens}`,
            ].join('\n')
          )
        }

        const usage: Usage = {
          inputTokens:
            response.usage.input_tokens +
            (response.usage.cache_creation_input_tokens ?? 0) +
            (response.usage.cache_read_input_tokens ?? 0),
          cachedInputTokens: response.usage.cache_read_input_tokens ?? undefined,
          outputTokens: response.usage.output_tokens,
        }
        return { text: stripReasoningBlocks(text), usage }
      } catch (err) {
        lastErr = err
        if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
        if (!isRateLimit(err) && !isTransient(err)) {
          throw wrapWithContext(err, opts.contextLabel)
        }
        // Anthropic 429s send Retry-After (seconds). Honour exactly that;
        // fall back to our static constants only if the header is missing.
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
        console.warn(`[claude] Retryable error (attempt ${attempt}/${MAX_RETRIES}); waiting ${wait}ms.`)
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
