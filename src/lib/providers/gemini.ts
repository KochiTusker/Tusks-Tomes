// Cloud Gemini provider. Wraps the existing cloud-Gemini behavior from
// src/lib/gemini.ts (paid/free key fallback, withRetry, permissive safety
// settings, empty-response diagnostics) behind the LLMProvider interface.
//
// Caching: as of section A of the optimisation batch, `createPrefixCache()`
// registers (systemPrompt + cacheablePrefix) with Google's CachedContent
// API at the start of each phase. Subsequent `generate()` calls within the
// phase reference the cache by handle via opts.cachedContentHandle and
// ship only req.userPrompt over the wire — saving 40-150 kB per chunk on
// a typical campaign KB. TTL is 60 minutes (covers a typical run); the
// pipeline calls `deletePrefixCache()` on phase end. If create() fails
// (prefix below the model's minimum cache size, or any transient error)
// the provider falls back to inline concatenation transparently — no
// chunk is ever blocked on a cache miss.

import {
  GoogleGenAI,
  HarmBlockThreshold,
  HarmCategory,
  type GenerateContentResponse,
} from '@google/genai'
import {
  EXHAUSTION_RETRY_MS,
  MAX_RETRIES,
  PRIMARY_MODEL,
  TRANSIENT_RETRY_MS,
} from '../constants'
import { GEMINI_STATIC_LIMITS, RateLimitState } from '../rateLimit'
import { stripReasoningBlocks } from '../reasoning'
import type {
  GenerateOptions,
  GenerateRequest,
  GenerateResponse,
  LLMProvider,
  ProviderEvent,
  ProviderName,
  Usage,
} from './llm'

import { getGuardrails } from '../guardrails'
import { vlog } from '../verboseLog'

/** Map the user's per-category guardrail toggles to Gemini safetySettings.
 *  Each toggle that is OFF (false — the default) forces BLOCK_NONE on that
 *  category. Each toggle that is ON is omitted from the list so Gemini's
 *  API default threshold (BLOCK_MEDIUM_AND_ABOVE) applies. When all four
 *  toggles are on, the returned array is empty, which the SDK treats the
 *  same as not sending safetySettings at all. */
function buildGeminiSafetySettings(): Array<{ category: HarmCategory; threshold: HarmBlockThreshold }> {
  const g = getGuardrails()
  const out: Array<{ category: HarmCategory; threshold: HarmBlockThreshold }> = []
  if (!g.harassment) {
    out.push({ category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE })
  }
  if (!g.hateSpeech) {
    out.push({ category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE })
  }
  if (!g.sexuallyExplicit) {
    out.push({ category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE })
  }
  if (!g.dangerousContent) {
    out.push({ category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE })
  }
  return out
}

/** Web-Crypto-based SHA-256 prefix. Works in both the browser (Vite client)
 *  and Node ≥ 19 (server tests). Matches server/api/modelProbe.ts:fingerprintKey
 *  output for the same input so the UI can cross-reference the Settings →
 *  API Keys probe row with the rate-limit dialog. */
async function sha256Prefix(text: string, chars: number): Promise<string> {
  const subtle = (globalThis.crypto as Crypto | undefined)?.subtle
  if (!subtle) {
    // Old Node / insecure-context browser. Caller catches and logs.
    throw new Error('crypto.subtle unavailable — cannot compute key fingerprint.')
  }
  const enc = new TextEncoder()
  const buf = await subtle.digest('SHA-256', enc.encode(text))
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, chars)
}

function isExhaustion(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err).toLowerCase()
  return (
    msg.includes('429') ||
    msg.includes('resource_exhausted') ||
    msg.includes('rate limit') ||
    msg.includes('quota') ||
    // Newer Google response shapes that bypass the generic "quota" keyword.
    // Match here so the exhaustion path runs instead of misclassifying as
    // transient. Mirrors the patterns enumerated in HARD_ZERO_QUOTA_PATTERNS.
    msg.includes('quotalimitreached') ||
    msg.includes('quota_limit_reached') ||
    msg.includes('quotavalue')
  )
}

/** Patterns that signal the Google project's quota for the requested model is
 *  effectively zero — i.e. the key has no access to this model at all, not
 *  just "you're going too fast right now". Used by `isHardZeroQuota` to flip
 *  `useFallback` in auto-tier mode the first time the paid key reports zero
 *  rather than waiting for two consecutive 429s.
 *
 *  Each entry has a label so the error-wrap message can say *which* pattern
 *  fired — useful when a new Google response shape lands and we need to know
 *  which detection caught it (or didn't).
 */
export const HARD_ZERO_QUOTA_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
  // Original detection — the classic "limit: 0" string in the JSON-stringified error.
  { label: 'limit:0', re: /limit:\s*0/i },
  // Newer Google response shape: explicit `quotaValue: "0"` field.
  { label: 'quotaValue:0', re: /quota[_ ]?value:\s*"?0"?/i },
  // The string field name Google sets when a model isn't reachable for the project.
  { label: 'quotaLimitReached', re: /quota[_ ]?limit[_ ]?reached/i },
  // Daily quota exceeded — different from the hourly per-minute case.
  { label: 'daily-quota-exceeded', re: /daily\s+quota\s+exceeded/i },
  // Sometimes Google prefixes with the metric name AND a 0 value.
  { label: 'generateContentRequestsPerDay:0', re: /generatecontentrequestsperday[^0-9]*:\s*0/i },
  // RESOURCE_EXHAUSTED with an explicit zero quota.
  { label: 'RESOURCE_EXHAUSTED+zero', re: /resource_exhausted[\s\S]*?(?:limit|value|quota)[^0-9]*:\s*0/i },
]

/** Block reasons Google applies SERVER-SIDE regardless of the user's
 *  `safetySettings`. Setting BLOCK_NONE on the four `HARM_CATEGORY_*`
 *  thresholds has no effect on these — they're separate filters. The
 *  pipeline's soft-skip path uses this set to decide whether to mark an
 *  empty-response error with `isProhibitedContent: true` so Phase 2 + 4
 *  can recover by emitting an empty JSON output instead of failing. */
export const UNCONFIGURABLE_BLOCK_REASONS = new Set<string>([
  'PROHIBITED_CONTENT',
  'BLOCKLIST',
  'SPII',
])

/** True when a GenerateContentResponse-shaped object indicates the
 *  prompt or candidate was blocked by an unconfigurable filter. Pure —
 *  reads only the response shape we care about. Returns the matched
 *  reason string so callers can include it in vlog/error metadata. */
export function detectProhibitedContentBlock(response: {
  promptFeedback?: { blockReason?: string | null } | null
  candidates?: Array<{ finishReason?: string | null } | undefined | null> | null
}): { matched: boolean; reason?: string } {
  const pfReason = response.promptFeedback?.blockReason
  if (typeof pfReason === 'string' && UNCONFIGURABLE_BLOCK_REASONS.has(pfReason)) {
    return { matched: true, reason: pfReason }
  }
  const candidate = response.candidates?.[0]
  const finishReason = candidate?.finishReason
  if (typeof finishReason === 'string' && UNCONFIGURABLE_BLOCK_REASONS.has(finishReason)) {
    return { matched: true, reason: finishReason }
  }
  return { matched: false }
}

/** True when the error message matches any hard-zero-quota pattern. Also
 *  returns the matching pattern's label so callers can log which one fired —
 *  helpful diagnostic when a new Google response shape needs to be added. */
export function detectHardZeroQuota(err: unknown): { matched: boolean; pattern?: string } {
  const msg = String((err as Error)?.message ?? err)
  for (const { label, re } of HARD_ZERO_QUOTA_PATTERNS) {
    if (re.test(msg)) return { matched: true, pattern: label }
  }
  return { matched: false }
}

function isHardZeroQuota(err: unknown): boolean {
  return detectHardZeroQuota(err).matched
}

export type ExhaustionKind = 'rate_limit' | 'daily_quota' | 'transient'

/**
 * Classify a Gemini error into a quota bucket so the UI can advise the user
 * sensibly. Per-day quotas mean "won't recover until midnight UTC" — pause +
 * resume tomorrow is the only sane option. Per-minute quotas just need a
 * longer wait, or a switch to a different key.
 *
 * The shape detection looks at field names Gemini surfaces in the error
 * body: `quotaId`, `quotaMetric`, and `quotaDimensions` — per-day quotas
 * contain a `PerDay` substring; per-minute contain `PerMinute`.
 *
 * Generic exhaustion without a qualifier defaults to 'rate_limit' (the
 * safer assumption — if it's actually daily, the dialog re-opens after the
 * next chunk fails).
 */
export function classifyExhaustion(err: unknown): ExhaustionKind {
  const msg = String((err as Error)?.message ?? err)
  if (/per[\s_-]?day/i.test(msg)) return 'daily_quota'
  if (/per[\s_-]?minute/i.test(msg)) return 'rate_limit'
  const lower = msg.toLowerCase()
  if (
    lower.includes('429') ||
    lower.includes('resource_exhausted') ||
    lower.includes('rate limit') ||
    lower.includes('quota')
  ) {
    return 'rate_limit'
  }
  return 'transient'
}

/**
 * True for transient server/transport errors that Google says to retry —
 * 503 (UNAVAILABLE, model demand spike), 502 (bad gateway, transient
 * proxy), 504 (gateway timeout), 500 INTERNAL (sometimes a stuck node).
 * Also catches fetch-level network errors (ECONNRESET, ETIMEDOUT) that
 * undici surfaces with no HTTP status.
 *
 * Excludes 429 / quota / RESOURCE_EXHAUSTED (those go through the
 * separate exhaustion path with its own pacing) and 4xx auth/validation
 * errors (those won't be fixed by retrying).
 */
export function isTransientServerError(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err).toLowerCase()
  if (msg.includes('429')) return false // exhaustion path handles this
  if (
    msg.includes('"code":503') ||
    msg.includes('status: 503') ||
    msg.includes('unavailable')
  ) return true
  if (
    msg.includes('"code":502') ||
    msg.includes('status: 502') ||
    msg.includes('bad gateway')
  ) return true
  if (
    msg.includes('"code":504') ||
    msg.includes('status: 504') ||
    msg.includes('gateway timeout') ||
    msg.includes('deadline_exceeded')
  ) return true
  if (
    msg.includes('"code":500') ||
    /status:\s*500\b/.test(msg) ||
    msg.includes('internal_error')
  ) return true
  // Transport-level errors surfaced by undici / node fetch with no HTTP
  // status. ECONNRESET / ETIMEDOUT / ENOTFOUND are all worth retrying.
  if (
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('enotfound') ||
    msg.includes('socket hang up') ||
    msg.includes('fetch failed') ||
    msg.includes('network error')
  ) return true
  return false
}

/** Exponential backoff schedule for transient 5xx retries. The numbers are
 *  optimised for "the model is hot — give it a moment to cool" rather than
 *  "wait for a per-minute quota window to roll over". Reaching the final
 *  entry means we've spent ~75s waiting; if Google's still 503 by then
 *  the user is better off cancelling and trying later. */
const TRANSIENT_5XX_BACKOFF_MS = [3_000, 8_000, 20_000, 45_000]

/** Window for the daily-quota heuristic. 5 minutes of repeated exhaustion
 *  on a free key very strongly suggests the daily bucket is empty rather
 *  than a transient per-minute spike. */
const DAILY_QUOTA_HEURISTIC_WINDOW_MS = 5 * 60 * 1000
const DAILY_QUOTA_HEURISTIC_THRESHOLD = 3

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

export function wrapWithContext(err: unknown, contextLabel?: string): Error {
  const base = err instanceof Error ? err : new Error(String(err))
  if (!contextLabel) return base
  const wrapped = new Error(`[${contextLabel}]\n${base.message}`)
  ;(wrapped as Error & { cause?: unknown }).cause = base
  // Preserve diagnostic flags set on the original error
  // (isProhibitedContent / prohibitedBlockReason / isDailyQuotaExhaustion
  // and any other downstream introspection markers). Without this copy
  // the pipeline's soft-skip path at pipeline.ts:420 sees
  // `.isProhibitedContent === undefined` on the wrapped error and
  // re-throws — turning a recoverable safety-block into a run-killing
  // failure on Phase 2 audit / Phase 4 extras.
  for (const key of Object.getOwnPropertyNames(base)) {
    if (key === 'name' || key === 'message' || key === 'stack' || key === 'cause') continue
    try {
      ;(wrapped as unknown as Record<string, unknown>)[key] =
        (base as unknown as Record<string, unknown>)[key]
    } catch (assignErr) {
      // K.2.4 / W3 — non-configurable property. Pre-K.2.4 this caught
      // the error silently and disappeared. Surface to the diagnose
      // ring so a future debugging session reading `.diagnose/latest.md`
      // can see WHICH property failed to propagate and decide whether
      // it matters (e.g. `isProhibitedContent` failing to copy would
      // turn a soft-skip into a run-killing throw).
      vlog('gemini', {
        event: 'wrap_property_skipped',
        key,
        baseErrorName: base.name,
        contextLabel,
        skipReason: String((assignErr as Error)?.message ?? assignErr).slice(0, 120),
      })
    }
  }
  return wrapped
}

function describeSafetyRatings(
  ratings:
    | Array<{ category?: string; probability?: string; severity?: string; blocked?: boolean }>
    | undefined
): string {
  if (!ratings?.length) return '  (none reported)'
  return ratings
    .map((r) => {
      const parts: string[] = [`  - ${r.category ?? '?'}`]
      if (r.probability) parts.push(`probability=${r.probability}`)
      if (r.severity) parts.push(`severity=${r.severity}`)
      if (r.blocked) parts.push('BLOCKED')
      return parts.join(' ')
    })
    .join('\n')
}

function hintForFinishReason(
  reason: string | undefined,
  blockedCategories: string[],
  maxOutputTokens: number
): string {
  switch (reason) {
    case 'MAX_TOKENS':
      return [
        `Output hit MAX_TOKENS — the model wanted to write more than ${maxOutputTokens}`,
        'tokens but was cut off. Fix: lower the chunk size, or raise MAX_OUTPUT_TOKENS.',
      ].join(' ')
    case 'SAFETY':
      return [
        `Safety filter blocked the response${
          blockedCategories.length ? ` (${blockedCategories.join(', ')})` : ''
        }.`,
        'The chunk likely contains mature content beyond the current threshold.',
        'Fix: set safetyMode="permissive" or rephrase the prompt.',
      ].join(' ')
    case 'RECITATION':
      return 'Output flagged as too close to training data. Try retrying or skipping this chunk.'
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
      return `Output blocked by ${reason} filter. Cannot be relaxed via safety settings.`
    case 'STOP':
      return 'Model finished cleanly but produced no text — unusual. Try retrying.'
    default:
      return reason
        ? `Unknown finish reason "${reason}". Check the full response in devtools console.`
        : 'No finish reason returned. Check upstream API status.'
  }
}

function formatEmptyResponseError(args: {
  response: GenerateContentResponse
  model: string
  promptLength: number
  prompt: string
  maxOutputTokens: number
}): string {
  const { response, model, promptLength, prompt, maxOutputTokens } = args
  const lines: string[] = []
  lines.push('Gemini returned empty response.')
  lines.push('')
  lines.push('--- Diagnostic context ---')
  lines.push(`Model:           ${model}`)
  lines.push(`Max output:      ${maxOutputTokens} tokens`)
  lines.push(`Prompt length:   ${promptLength.toLocaleString()} chars`)

  const usage = response.usageMetadata
  if (usage) {
    lines.push(
      `Token usage:     input=${usage.promptTokenCount ?? '?'}` +
        ` output=${usage.candidatesTokenCount ?? '?'}` +
        ` total=${usage.totalTokenCount ?? '?'}`
    )
  }

  const pf = response.promptFeedback
  if (pf?.blockReason) {
    lines.push('')
    lines.push('--- Prompt was blocked ---')
    lines.push(`Reason:          ${pf.blockReason}`)
    if (pf.blockReasonMessage) lines.push(`Message:         ${pf.blockReasonMessage}`)
    lines.push('Prompt safety ratings:')
    lines.push(describeSafetyRatings(pf.safetyRatings))
  }

  const candidate = response.candidates?.[0]
  const blockedCategories: string[] = []
  if (candidate) {
    lines.push('')
    lines.push('--- Candidate ---')
    lines.push(`Finish reason:   ${candidate.finishReason ?? '(none)'}`)
    if (candidate.finishMessage) lines.push(`Finish message:  ${candidate.finishMessage}`)
    lines.push(`Token count:     ${candidate.tokenCount ?? '?'}`)
    if (candidate.safetyRatings?.length) {
      lines.push('Candidate safety ratings:')
      lines.push(describeSafetyRatings(candidate.safetyRatings))
      for (const r of candidate.safetyRatings) {
        if (r.blocked && r.category) blockedCategories.push(r.category)
      }
    }
  }

  lines.push('')
  lines.push('--- Likely cause & fix ---')
  if (pf?.blockReason) {
    lines.push(
      `Prompt itself was blocked (${pf.blockReason}). Reduce KB / transcript content` +
        ' that may have triggered the safety filter.'
    )
  } else {
    lines.push(hintForFinishReason(candidate?.finishReason, blockedCategories, maxOutputTokens))
  }

  lines.push('')
  lines.push('--- Prompt preview (first 300 chars) ---')
  lines.push(prompt.slice(0, 300) + (prompt.length > 300 ? '…' : ''))

  return lines.join('\n')
}

/**
 * Tier preference at construction time.
 *
 *   'paid' — only use the billing-enabled key (`primaryKey`). 429s from a
 *             billing-enabled project usually reflect minute-level TPM
 *             ceilings; we retry with backoff but never fall back to the
 *             free key (the user wants billing-enabled answers).
 *   'free' — only use the free-tier key (`fallbackKey`). 429s from the
 *            free tier mean the daily allowance is gone; no point falling
 *            back because there's no other free key.
 *   'auto' — legacy behavior: prefer the paid key, swap to the free key
 *            when the paid key reports `limit: 0` or after two consecutive
 *            quota exhaustions in a row.
 */
export type GeminiTier = 'paid' | 'free' | 'auto'

export class GeminiProvider implements LLMProvider {
  readonly name: ProviderName = 'gemini'

  private paidKey: string | undefined
  private freeKey: string | null
  private tier: GeminiTier

  private paidClient: GoogleGenAI | null
  private freeClient: GoogleGenAI | null

  private consecutiveExhaustions = 0
  private useFallback = false
  /** Timestamps of recent exhaustion errors — used by the daily-quota
   *  heuristic. Pruned to the last DAILY_QUOTA_HEURISTIC_WINDOW_MS. */
  private recentExhaustionTimes: number[] = []

  /** Short SHA-256 prefixes of the two keys, populated asynchronously by
   *  `computeKeyFingerprints()` invoked from the constructor. The async path
   *  means a `quota_exhausted` event firing before computation finishes (eg
   *  the very first call) may report `undefined`; that's acceptable — the
   *  verbose dialog falls back to omitting the fingerprint line. Matches the
   *  6-char prefix Settings → API Keys → Probe displays so users can cross-
   *  reference. */
  private paidKeyFingerprint: string | undefined
  private freeKeyFingerprint: string | undefined
  /** Resolves when both `computeKeyFingerprints` async digests complete.
   *  Production code doesn't await this — fingerprints are best-effort
   *  diagnostic. Tests await it so assertions on `activeKeyFingerprint()`
   *  aren't racy under the parallel test runner. */
  readonly fingerprintsReady: Promise<void>

  /** Rate-limit accounting. Seeded from static tier limits because the
   *  Gemini SDK doesn't expose rate-limit headers on responses. The Pro
   *  defaults are the more conservative pick — if the user is actually
   *  on Flash, we under-utilise slightly but never 429. */
  readonly rateLimit = new RateLimitState()

  constructor(args?: {
    primaryKey?: string
    fallbackKey?: string | null
    tier?: GeminiTier
  }) {
    // Until Step 6 lands the encrypted key store, fall back to env vars so
    // existing setups keep working.
    const env = (import.meta as unknown as { env?: Record<string, string> }).env ?? {}
    const primary = args?.primaryKey ?? env.PAID_GEMINI_API_KEY ?? env.VITE_GEMINI_API_KEY
    let fallback: string | null
    if (args && 'fallbackKey' in args) {
      fallback = args.fallbackKey ?? null
    } else {
      const paid = env.PAID_GEMINI_API_KEY
      const free = env.VITE_GEMINI_API_KEY
      fallback = paid && free && paid !== free ? free : null
    }

    this.paidKey = primary
    this.freeKey = fallback
    this.tier = args?.tier ?? 'auto'
    this.paidClient = primary ? new GoogleGenAI({ apiKey: primary }) : null
    this.freeClient = fallback ? new GoogleGenAI({ apiKey: fallback }) : null
    // 'free' tier locks the dispatcher to the fallback client.
    if (this.tier === 'free') this.useFallback = true

    // Fire-and-forget fingerprint computation. Web Crypto is async but the
    // constructor isn't — we let the computation race the first request. If
    // a quota_exhausted event fires before the hash lands, the dialog just
    // omits the fingerprint line (and re-reads on the next event, by which
    // point the hash will be cached). The returned Promise is exposed as
    // `fingerprintsReady` for tests that need deterministic ordering.
    this.fingerprintsReady = this.computeKeyFingerprints()

    // Seed rate-limit state from the static tier table. Pick the Pro row
    // (more conservative) by default — the active model can vary per phase
    // and we'd rather under-utilise than 429.
    const limits =
      this.tier === 'free' || this.useFallback
        ? GEMINI_STATIC_LIMITS.freePro
        : GEMINI_STATIC_LIMITS.paidPro
    this.rateLimit.setStatic(limits.rpm, limits.tpm)
  }

  /** Async fingerprint computation kicked off from the constructor. Uses
   *  globalThis.crypto.subtle (available in modern browsers + Node 19+).
   *  Catches and swallows any error — fingerprints are diagnostic only and
   *  the singleton remains fully usable without them. */
  private async computeKeyFingerprints(): Promise<void> {
    try {
      if (this.paidKey) this.paidKeyFingerprint = await sha256Prefix(this.paidKey, 6)
      if (this.freeKey) this.freeKeyFingerprint = await sha256Prefix(this.freeKey, 6)
    } catch (err) {
      // Best-effort — the dialog tolerates undefined fingerprints. Log so a
      // truly broken crypto.subtle (eg insecure context) is at least visible.
      console.warn('[gemini] key fingerprint computation failed:', err)
    }
  }

  /** Returns the fingerprint of whichever key would dispatch the next call,
   *  given the current `tier` + `useFallback` state. Returns undefined when
   *  the async hash hasn't landed yet (very first call of a session) or when
   *  there's no active key. */
  private activeKeyFingerprint(): string | undefined {
    const onFree = this.tier === 'free' || (this.tier === 'auto' && this.useFallback)
    return onFree ? this.freeKeyFingerprint : this.paidKeyFingerprint
  }

  /** True when this auto-tier singleton has already swapped to the Free key
   *  via `useFallback`. The verbose RateLimitDialog uses this to grey out
   *  the "Switch to paid" button — the run already exhausted Paid, so
   *  swapping back is a no-op.  False for tier-locked singletons (which
   *  can't swap in the first place) and for fresh auto-tier singletons. */
  isPermanentlyOnFallback(): boolean {
    return this.tier === 'auto' && this.useFallback
  }

  getNextDelayMs(estimatedInputTokens: number, extraMultiplier: number = 1): number {
    return this.rateLimit.delayBeforeNextCall(estimatedInputTokens, extraMultiplier)
  }

  hasKey(): boolean {
    if (this.tier === 'paid') return !!this.paidClient
    if (this.tier === 'free') return !!this.freeClient
    return !!(this.paidClient || this.freeClient)
  }

  private activeClient(): GoogleGenAI {
    // For 'paid' / 'free' tier locks, always pick the locked key. For 'auto',
    // honour the soft fallback flipped on 429/limit:0.
    let client: GoogleGenAI | null
    if (this.tier === 'paid') {
      client = this.paidClient
    } else if (this.tier === 'free') {
      client = this.freeClient
    } else {
      client = this.useFallback
        ? (this.freeClient ?? this.paidClient)
        : (this.paidClient ?? this.freeClient)
    }
    if (!client) {
      const which =
        this.tier === 'paid'
          ? 'paid Gemini key'
          : this.tier === 'free'
          ? 'free Gemini key'
          : 'Gemini key'
      throw new Error(
        `No ${which} configured. Add one in Settings → API Keys, then pick the matching tier in the run-start modal.`
      )
    }
    return client
  }

  private canSwapToFallback(): boolean {
    // Soft swap only applies in 'auto' tier.
    return this.tier === 'auto' && !this.useFallback && this.freeClient !== null
  }

  private emitProviderEvent(opts: GenerateOptions | undefined, event: ProviderEvent): void {
    try {
      opts?.onProviderEvent?.(event)
    } catch (e) {
      // The pipeline's listener is best-effort; never let a bad listener
      // crash a chunk we'd otherwise retry.
      console.warn('[gemini] provider-event listener threw:', e)
    }
  }

  /**
   * Pick the static rate-limit row that matches the currently-active key
   * (paid vs free) AND the model id being called (Pro vs Flash).
   * Flash has substantially higher RPM/TPM than Pro on both tiers — using
   * the Pro row for Flash calls leaves a lot of throughput on the table.
   */
  staticLimitsFor(model: string): { rpm: number; tpm: number } {
    const onFreeKey = this.tier === 'free' || this.useFallback
    const isFlash = /flash/i.test(model || '')
    if (onFreeKey) {
      return isFlash ? GEMINI_STATIC_LIMITS.freeFlash : GEMINI_STATIC_LIMITS.freePro
    }
    return isFlash ? GEMINI_STATIC_LIMITS.paidFlash : GEMINI_STATIC_LIMITS.paidPro
  }

  /** Which key is currently active. Reported in `quota_exhausted` events. */
  private activeTier(): 'free' | 'paid' | 'auto' {
    if (this.tier === 'free' || this.useFallback) return 'free'
    if (this.tier === 'paid') return 'paid'
    return 'auto'
  }

  /**
   * Clear the recent-exhaustion history. Called from the success branch
   * of generate() so a single successful call invalidates any stale
   * "this key is hammered" signal — K.2.2 / W5 fix. Pre-K.2.2 the
   * heuristic could carry an hours-old triple-hit forward indefinitely
   * and false-positive a single fresh rate-limit as 'daily_quota',
   * triggering the wrong UI dialog branch.
   *
   * Public so tests can exercise the reset semantics in isolation
   * (without standing up a full SDK mock for generate()).
   */
  resetExhaustionHistory(): void {
    this.recentExhaustionTimes = []
  }

  /**
   * Classify an exhaustion using the shape-based classifier AND the
   * recent-exhaustion history. If 3+ exhaustions land within 5 minutes the
   * heuristic upgrades the classification to 'daily_quota' even when the
   * error body lacks a `PerDay` qualifier — the only thing that explains
   * sustained 429s on a single key is the daily bucket draining.
   */
  classifyWithHeuristic(err: unknown, now: number = Date.now()): ExhaustionKind {
    const base = classifyExhaustion(err)
    if (base === 'transient') return base
    // Prune + record.
    const cutoff = now - DAILY_QUOTA_HEURISTIC_WINDOW_MS
    this.recentExhaustionTimes = this.recentExhaustionTimes.filter((t) => t >= cutoff)
    this.recentExhaustionTimes.push(now)
    if (
      base === 'rate_limit' &&
      this.recentExhaustionTimes.length >= DAILY_QUOTA_HEURISTIC_THRESHOLD
    ) {
      return 'daily_quota'
    }
    return base
  }

  async generate(req: GenerateRequest, opts: GenerateOptions = {}): Promise<GenerateResponse> {
    // When the caller provides a cached-content handle, skip shipping the
    // system + cacheablePrefix bytes inline — Google has them server-side
    // and the request references them by handle. Falls back to today's
    // inline concatenation when no handle is provided.
    const usingCache = !!opts.cachedContentHandle
    const composedPrompt = usingCache
      ? req.userPrompt
      : [req.systemPrompt, req.cacheablePrefix, req.userPrompt]
          .filter((s) => s && s.length > 0)
          .join('\n\n')

    // Re-seed the rate-limit row from the active (key, model) pair. setStatic
    // only overwrites RPM/TPM; lastCallAt / retryAfterUntil are preserved.
    const limits = this.staticLimitsFor(req.model)
    this.rateLimit.setStatic(limits.rpm, limits.tpm)

    let attempt = 0
    let lastErr: unknown
    while (attempt <= MAX_RETRIES) {
      if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      try {
        let response: GenerateContentResponse
        try {
          const safetySettings = buildGeminiSafetySettings()
          response = await this.activeClient().models.generateContent({
            model: req.model,
            contents: composedPrompt,
            config: {
              maxOutputTokens: req.maxOutputTokens,
              ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
              // Empty array == no override == Gemini's API defaults.
              ...(safetySettings.length > 0 ? { safetySettings } : {}),
              ...(usingCache ? { cachedContent: opts.cachedContentHandle } : {}),
              // thinkingBudget: 0 → DISABLED (cheaper). undefined → SDK
              // default (model decides, usually AUTOMATIC). > 0 → explicit
              // cap. See GenerateRequest.thinkingBudget for the contract.
              ...(req.thinkingBudget !== undefined
                ? { thinkingConfig: { thinkingBudget: req.thinkingBudget } }
                : {}),
            },
          })
        } catch (sdkErr) {
          if (isExhaustion(sdkErr)) throw sdkErr
          const msg = (sdkErr as Error)?.message ?? String(sdkErr)
          throw new Error(
            [
              'Gemini API call failed.',
              '',
              '--- Diagnostic context ---',
              `Model:         ${req.model}`,
              `Prompt length: ${composedPrompt.length.toLocaleString()} chars`,
              '',
              '--- Original error ---',
              msg,
            ].join('\n')
          )
        }

        const text = response.text ?? ''
        if (!text.trim()) {
          console.error('[gemini] Empty response — full SDK response:', response)
          // Detect unconfigurable safety blocks (PROHIBITED_CONTENT / BLOCKLIST /
          // SPII). These cannot be relaxed via safetySettings — they're server-
          // side filters Google applies regardless of category thresholds. Mark
          // the thrown error so chunkedGenerate's soft-skip path can recognise
          // it for the JSON-output phases (audit + extras) where a blocked
          // chunk is recoverable as an empty array.
          const blockDetection = detectProhibitedContentBlock(response)
          const blockErr = new Error(
            formatEmptyResponseError({
              response,
              model: req.model,
              promptLength: composedPrompt.length,
              prompt: composedPrompt,
              maxOutputTokens: req.maxOutputTokens,
            })
          )
          if (blockDetection.matched) {
            ;(blockErr as Error & {
              isProhibitedContent?: boolean
              prohibitedBlockReason?: string
            }).isProhibitedContent = true
            ;(blockErr as Error & { prohibitedBlockReason?: string }).prohibitedBlockReason =
              blockDetection.reason
          }
          throw blockErr
        }

        const usageMeta = response.usageMetadata
        const usage: Usage = {
          inputTokens: usageMeta?.promptTokenCount ?? 0,
          cachedInputTokens: usageMeta?.cachedContentTokenCount ?? undefined,
          outputTokens: usageMeta?.candidatesTokenCount ?? 0,
        }
        this.consecutiveExhaustions = 0
        // K.2.2 / W5 — clear the heuristic's stale exhaustion history.
        // A successful call proves the key isn't actually hammered any
        // more; without this reset, a triple-hit from hours ago would
        // false-positive the next single rate-limit as 'daily_quota'.
        this.resetExhaustionHistory()
        this.rateLimit.noteCall()
        return { text: stripReasoningBlocks(text), usage }
      } catch (err) {
        lastErr = err
        if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError')

        // Transient server-side errors (503 spike, 502, 504, transport).
        // Google's own guidance for 503 is "spikes are usually temporary,
        // try again later" — exactly what a retry loop is for. Use a
        // separate exponential backoff schedule from the quota path:
        // 3s → 8s → 20s → 45s (the model usually recovers in ≤ 20s).
        if (!isExhaustion(err) && isTransientServerError(err)) {
          attempt += 1
          if (attempt > MAX_RETRIES) {
            // After exhausted retries, wrap with full context so the toast
            // shows phase + chunk + retry count + the original provider
            // error. Previously this just called wrapWithContext(err, label)
            // and the user saw "Phase 1 chunk 5 failed: 503 Service
            // Unavailable" with no hint that we'd already tried 4 times.
            const original = (err as Error)?.message ?? String(err)
            const enrichedMessage =
              `${opts.contextLabel ?? 'Gemini call'} — ${MAX_RETRIES} retries exhausted ` +
              `after transient 5xx (Google's servers are likely overloaded). ` +
              `Last error: ${original.slice(0, 300)}`
            const enriched = new Error(enrichedMessage)
            // Preserve diagnostic flags + original cause so downstream
            // soft-skip / recovery logic still has full visibility.
            ;(enriched as Error & { cause?: unknown }).cause = err
            throw wrapWithContext(enriched, opts.contextLabel)
          }
          const idx = Math.min(attempt - 1, TRANSIENT_5XX_BACKOFF_MS.length - 1)
          const wait = TRANSIENT_5XX_BACKOFF_MS[idx]
          opts.onRetry?.(attempt, wait)
          console.warn(
            `[gemini] Transient server error (attempt ${attempt}/${MAX_RETRIES}); waiting ${wait}ms. ` +
              `Error: ${String((err as Error)?.message ?? err).slice(0, 200)}`,
          )
          await sleep(wait, opts.signal)
          continue
        }

        if (!isExhaustion(err)) {
          throw wrapWithContext(err, opts.contextLabel)
        }

        const hardZero = detectHardZeroQuota(err)
        if (hardZero.matched) {
          vlog('gemini', {
            event: 'hard_zero_detected',
            pattern: hardZero.pattern,
            model: req.model,
            tier: this.tier,
            currentlyOnFallback: this.useFallback,
            canSwap: this.canSwapToFallback(),
            errorPreview: String((err as Error)?.message ?? err).slice(0, 200),
          })
          if (this.canSwapToFallback()) {
            this.useFallback = true
            // Tier just flipped to free — re-seed RPM/TPM accordingly,
            // picking the right Pro/Flash row for the active model.
            const freeLimits = this.staticLimitsFor(req.model)
            this.rateLimit.setStatic(freeLimits.rpm, freeLimits.tpm)
            vlog('gemini', {
              event: 'useFallback_flipped',
              reason: 'hard_zero_quota',
              model: req.model,
              newLimits: freeLimits,
            })
            this.emitProviderEvent(opts, {
              kind: 'auto_fallback',
              provider: 'gemini',
              reason: 'hard_zero_quota',
            })
            console.warn(
              `[gemini] Hard zero quota detected (pattern: ${hardZero.pattern}). ` +
                `Quota is 0 for "${req.model}" on the preferred key. Switching to fallback. ` +
                `Original error: ${String((err as Error)?.message ?? err).slice(0, 200)}`,
            )
            continue
          }
          throw wrapWithContext(
            new Error(
              `Quota is 0 for "${req.model}" (detected via pattern: ${hardZero.pattern}). ` +
                `Enable billing/Gemini access on the project, or pick a model your key supports. ` +
                `If you're on the Paid tier and this fires, your billing-enabled project likely doesn't have Gemini API access — visit https://aistudio.google.com/apikey to verify. ` +
                `Original: ${(err as Error).message}`
            ),
            opts.contextLabel
          )
        }

        this.consecutiveExhaustions += 1
        // Classify the exhaustion (rate_limit vs daily_quota) and surface it
        // to the pipeline so the UI can open the rate-limit dialog. The
        // call still retries below — the event is advisory.
        const quotaKind = this.classifyWithHeuristic(err)
        vlog('gemini', {
          event: 'exhaustion_classified',
          model: req.model,
          tier: this.activeTier(),
          quotaKind,
          consecutiveExhaustions: this.consecutiveExhaustions,
          requestsInLastMinute: this.rateLimit.recentCallCount(60_000),
          errorPreview: String((err as Error)?.message ?? err).slice(0, 200),
        })
        if (quotaKind !== 'transient') {
          // Verbose payload — the UI dialog uses every one of these to
          // produce specific advice ("you've made 47 requests in the last
          // 60s against a 10 RPM cap on Free Flash, fingerprint ABC123").
          // All optional — see ProviderEvent in llm.ts.
          const limits = this.staticLimitsFor(req.model)
          this.emitProviderEvent(opts, {
            kind: 'quota_exhausted',
            provider: 'gemini',
            quotaKind,
            tier: this.activeTier(),
            model: req.model,
            keyFingerprint: this.activeKeyFingerprint(),
            requestsInLastMinute: this.rateLimit.recentCallCount(60_000),
            rpmCap: limits.rpm,
            tpmCap: limits.tpm,
            permanentlyOnFallback: this.isPermanentlyOnFallback(),
          })
        }
        // Fast-fail on daily_quota when there's no fallback. The daily
        // bucket won't refill until midnight UTC — burning 4 retry
        // attempts × 65s = ~4.5 min waiting only to fail anyway makes
        // the run die 4 minutes after the user walked away. Throw
        // immediately with a marker so handlePipelineError can write a
        // checkpoint and the user can resume after the reset.
        //
        // We still attempt a fallback swap for auto-tier singletons
        // BEFORE bailing (the canSwapToFallback path below). The bail
        // only fires when there's truly no recovery path.
        if (quotaKind === 'daily_quota' && !this.canSwapToFallback()) {
          vlog('gemini', {
            event: 'daily_quota_fastfail',
            tier: this.activeTier(),
            model: req.model,
            reason: 'no fallback available — daily bucket empty, retries pointless',
          })
          const fastFailErr = new Error(
            `Daily quota exhausted on Gemini ${this.activeTier()} for model "${req.model}". ` +
              `Free-tier daily limits reset at midnight UTC. ` +
              `Add a Paid Gemini key in Settings → API Keys to keep running today, ` +
              `OR resume tomorrow (your progress through chunk ${opts.contextLabel ?? '?'} is auto-saved). ` +
              `Original: ${(err as Error).message?.slice(0, 200)}`,
          )
          // Annotate so handlePipelineError can detect this specific case
          // and auto-checkpoint instead of treating it as a generic error.
          ;(fastFailErr as Error & { isDailyQuotaExhaustion?: boolean }).isDailyQuotaExhaustion = true
          throw wrapWithContext(fastFailErr, opts.contextLabel)
        }
        if (this.canSwapToFallback() && this.consecutiveExhaustions >= 2) {
          this.useFallback = true
          const freeLimits = this.staticLimitsFor(req.model)
          this.rateLimit.setStatic(freeLimits.rpm, freeLimits.tpm)
          vlog('gemini', {
            event: 'useFallback_flipped',
            reason: 'repeated_exhaustion',
            consecutiveExhaustions: this.consecutiveExhaustions,
            model: req.model,
            newLimits: freeLimits,
          })
          this.emitProviderEvent(opts, {
            kind: 'auto_fallback',
            provider: 'gemini',
            reason: 'repeated_exhaustion',
          })
          console.warn('[gemini] Switching to fallback key after repeated exhaustion.')
          continue
        }

        attempt += 1
        if (attempt > MAX_RETRIES) break
        const isFinal = attempt === MAX_RETRIES
        const wait = isFinal ? EXHAUSTION_RETRY_MS : TRANSIENT_RETRY_MS
        opts.onRetry?.(attempt, wait)
        console.warn(`[gemini] Rate-limited (attempt ${attempt}/${MAX_RETRIES}); waiting ${wait}ms.`)
        await sleep(wait, opts.signal)
      }
    }
    throw wrapWithContext(lastErr, opts.contextLabel)
  }

  /**
   * Register the (system prompt + cacheablePrefix) of `req` as a Gemini
   * CachedContent so subsequent generate() calls within the phase can
   * pass the returned handle via opts.cachedContentHandle and ship only
   * the user prompt. Returns null when:
   *
   *   - No cacheable bytes were supplied (req.systemPrompt + cacheablePrefix
   *     is empty/short — caching it would buy nothing).
   *   - The prefix is below the model's minimum-cacheable-tokens threshold.
   *     Google's API responds 400 INVALID_ARGUMENT for this and we treat it
   *     as "fine, just ship inline" rather than blocking the run.
   *   - Any transient error from caches.create — same fallback.
   *
   * 60-minute TTL covers a typical chronicle run (Phase 1 + 2 of a 49-chunk
   * session takes ~30-50 min wall-clock). deletePrefixCache cleans up
   * proactively on phase end; if the process crashes mid-phase the cache
   * expires on its own.
   */
  async createPrefixCache(req: GenerateRequest): Promise<string | null> {
    const cacheable = [req.systemPrompt, req.cacheablePrefix]
      .filter((s): s is string => !!s && s.length > 0)
      .join('\n\n')
    if (!cacheable) return null
    // Rough lower bound: skip a create call when there's almost certainly
    // not enough content to meet the API's minimum. ~4 chars/token, so
    // < 4000 chars means < ~1000 tokens — below every current model's
    // minimum (gemini-2.5-flash: 1024, gemini-2.5-pro: 4096). Saves one
    // round trip per phase when the KB is tiny.
    if (cacheable.length < 4000) return null

    const client = this.activeClient()
    try {
      const cache = await client.caches.create({
        model: req.model,
        config: {
          // 60-minute TTL as a "now + TTL" Duration string per the SDK spec.
          ttl: `${60 * 60}s`,
          contents: cacheable,
          displayName: `tusks-tomes:${new Date().toISOString().slice(0, 19)}`,
        },
      })
      if (!cache.name) return null
      return cache.name
    } catch (err) {
      // Below-minimum prefixes 400; we treat any failure as a fallback
      // signal and let generate() ship inline next call. Logged so the
      // user can see the path was tried.
      console.warn(
        `[gemini cache] create failed (${(err as Error).message?.slice(0, 200)}) — ` +
          'falling back to inline prefix for this phase.',
      )
      return null
    }
  }

  /** Tear down a cache created by `createPrefixCache`. Best-effort —
   *  failures are swallowed since the cache expires on its own via TTL. */
  async deletePrefixCache(handle: string): Promise<void> {
    try {
      await this.activeClient().caches.delete({ name: handle })
    } catch (err) {
      console.warn(`[gemini cache] delete failed for ${handle}:`, (err as Error).message)
    }
  }

  async listModels(): Promise<string[]> {
    const key =
      this.tier === 'paid'
        ? this.paidKey
        : this.tier === 'free'
        ? this.freeKey ?? undefined
        : this.useFallback
        ? (this.freeKey ?? this.paidKey)
        : (this.paidKey ?? this.freeKey ?? undefined)
    if (!key) return [PRIMARY_MODEL]
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(
      key
    )}&pageSize=200`
    try {
      const res = await fetch(url)
      if (!res.ok) return [PRIMARY_MODEL]
      type ApiModel = { name?: string; supportedGenerationMethods?: string[] }
      const json = (await res.json()) as { models?: ApiModel[] }
      const ids = (json.models ?? [])
        .filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
        .map((m) => (m.name ?? '').replace(/^models\//, ''))
        .filter(Boolean)
      return ids.length ? ids.sort() : [PRIMARY_MODEL]
    } catch {
      return [PRIMARY_MODEL]
    }
  }
}
