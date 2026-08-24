// Per-provider rate-limit accounting.
//
// Each cloud LLMProvider owns a RateLimitState. The pipeline consults
// `delayBeforeNextCall(estimatedInputTokens)` between chunks to pace at
// the maximum safe rate for the provider's actual limits — not a single
// pessimistic constant. Limits are learned from response headers
// (Anthropic/OpenAI) or seeded statically (Gemini, since the SDK
// doesn't surface its rate-limit metadata).
//
// TPM (tokens per minute) is the binding constraint at typical chunk
// sizes, not RPM. The delay formula picks whichever floor is larger.

export type RateLimitSnapshot = {
  /** Maximum requests per minute as last seen / configured. */
  rpm?: number
  /** Maximum input tokens per minute as last seen / configured. */
  tpm?: number
  /** Remaining requests in the current window. */
  requestsRemaining?: number
  /** Remaining input tokens in the current window. */
  tokensRemaining?: number
  /** Approximate ms until the current window resets (best-effort). */
  resetMs?: number
}

/** 1.1 = headroom on TPM/RPM math; bursts can push us slightly over otherwise. */
const SAFETY_MULTIPLIER = 1.1

/**
 * Conservative default when no rate-limit metadata has been observed yet
 * (matches the legacy `INTER_CHUNK_DELAY_MS`). Used for the very first
 * call of a fresh run; subsequent calls use the learned snapshot.
 */
export const CONSERVATIVE_FLOOR_MS = 65_000

export class RateLimitState {
  private snapshot: RateLimitSnapshot = {}
  private lastCallAt = 0
  private retryAfterUntil = 0
  /** Timestamps of recent successful calls, pruned to the 60-second window
   *  by `recentCallCount()`. Used by the verbose `quota_exhausted` dialog to
   *  tell the user "you've made N requests in the last minute" — not load-
   *  bearing for pacing (that's `lastCallAt` + the snapshot's RPM/TPM math). */
  private callTimestamps: number[] = []

  /**
   * ms to wait before the next call given a token estimate. 0 = go now.
   *
   * `extraMultiplier` (default 1.0) is a per-run dial the user controls
   * via "Slow down" in the rate-limit dialog. 3.0 paces 3× more slowly
   * to keep a thrashing free-tier key under its actual per-minute limit
   * even when the static table is optimistic.
   */
  delayBeforeNextCall(estimatedInputTokens: number, extraMultiplier: number = 1): number {
    const now = Date.now()
    if (now < this.retryAfterUntil) return this.retryAfterUntil - now

    const { rpm, tpm } = this.snapshot
    if (!rpm && !tpm) {
      // No info yet — fall back to the legacy conservative default but only
      // after the first call (we don't want to wait 65s before the very
      // first request of a run).
      if (this.lastCallAt === 0) return 0
      const since = now - this.lastCallAt
      return Math.max(0, CONSERVATIVE_FLOOR_MS * extraMultiplier - since)
    }

    const combined = SAFETY_MULTIPLIER * extraMultiplier
    const rpmDelay = rpm ? (60_000 / rpm) * combined : 0
    const tpmDelay = tpm && estimatedInputTokens > 0
      ? (estimatedInputTokens / tpm) * 60_000 * combined
      : 0
    const requiredSpacing = Math.max(rpmDelay, tpmDelay)

    const since = now - this.lastCallAt
    return Math.max(0, requiredSpacing - since)
  }

  /** Call site marker: a request was just made. Anchors `delayBeforeNextCall`. */
  noteCall(): void {
    const now = Date.now()
    this.lastCallAt = now
    this.callTimestamps.push(now)
    // Prune the history opportunistically so the array doesn't grow without
    // bound on a long-running session. We only ever read the trailing 60s.
    if (this.callTimestamps.length > 1024) {
      const cutoff = now - 60_000
      this.callTimestamps = this.callTimestamps.filter((t) => t >= cutoff)
    }
  }

  /** Diagnostic: count of `noteCall()` invocations in the last `windowMs`.
   *  Default 60s. Used by the verbose rate-limit dialog. */
  recentCallCount(windowMs: number = 60_000): number {
    const cutoff = Date.now() - windowMs
    return this.callTimestamps.filter((t) => t >= cutoff).length
  }

  /** 429 backoff: wait `seconds` from now before issuing anything else. */
  noteRetryAfter(seconds: number): void {
    this.retryAfterUntil = Date.now() + seconds * 1000
  }

  /** Seed static limits (Gemini tiers, where headers aren't exposed). */
  setStatic(rpm: number, tpm: number): void {
    this.snapshot.rpm = rpm
    this.snapshot.tpm = tpm
  }

  /** Parse Anthropic rate-limit headers from a Claude API response. */
  updateFromClaudeHeaders(headers: Headers | Record<string, string | null | undefined>): void {
    const get = (name: string): string | null | undefined =>
      headers instanceof Headers ? headers.get(name) : headers[name]

    const reqLimit = parseIntOrUndef(get('anthropic-ratelimit-requests-limit'))
    const tokLimit = parseIntOrUndef(get('anthropic-ratelimit-tokens-limit') ?? get('anthropic-ratelimit-input-tokens-limit'))
    const reqRem = parseIntOrUndef(get('anthropic-ratelimit-requests-remaining'))
    const tokRem = parseIntOrUndef(get('anthropic-ratelimit-tokens-remaining') ?? get('anthropic-ratelimit-input-tokens-remaining'))
    const resetIso = get('anthropic-ratelimit-tokens-reset') ?? get('anthropic-ratelimit-input-tokens-reset')

    if (reqLimit !== undefined) this.snapshot.rpm = reqLimit
    if (tokLimit !== undefined) this.snapshot.tpm = tokLimit
    if (reqRem !== undefined) this.snapshot.requestsRemaining = reqRem
    if (tokRem !== undefined) this.snapshot.tokensRemaining = tokRem
    if (resetIso) {
      const at = Date.parse(resetIso)
      if (!Number.isNaN(at)) this.snapshot.resetMs = at - Date.now()
    }
  }

  /** Parse OpenAI rate-limit headers (Responses + Chat Completions APIs share names). */
  updateFromOpenAIHeaders(headers: Headers | Record<string, string | null | undefined>): void {
    const get = (name: string): string | null | undefined =>
      headers instanceof Headers ? headers.get(name) : headers[name]

    const reqLimit = parseIntOrUndef(get('x-ratelimit-limit-requests'))
    const tokLimit = parseIntOrUndef(get('x-ratelimit-limit-tokens'))
    const reqRem = parseIntOrUndef(get('x-ratelimit-remaining-requests'))
    const tokRem = parseIntOrUndef(get('x-ratelimit-remaining-tokens'))
    const resetReq = get('x-ratelimit-reset-requests')
    const resetTok = get('x-ratelimit-reset-tokens')

    if (reqLimit !== undefined) this.snapshot.rpm = reqLimit
    if (tokLimit !== undefined) this.snapshot.tpm = tokLimit
    if (reqRem !== undefined) this.snapshot.requestsRemaining = reqRem
    if (tokRem !== undefined) this.snapshot.tokensRemaining = tokRem

    // OpenAI emits reset values like "6m0s", "30s", "1.5s". Parse the larger
    // of the two so the snapshot doesn't underestimate.
    const resetSec = Math.max(parseDurationSeconds(resetReq), parseDurationSeconds(resetTok))
    if (resetSec > 0) this.snapshot.resetMs = resetSec * 1000
  }

  /**
   * Parse OpenRouter rate-limit headers.
   *
   * OpenRouter emits the UNSUFFIXED forms — `X-RateLimit-Limit`,
   * `-Remaining`, `-Reset` — not OpenAI's `-requests` / `-tokens` pair. Running
   * these through updateFromOpenAIHeaders() finds nothing and silently leaves
   * the snapshot empty, which drops pacing to the 65s CONSERVATIVE_FLOOR_MS
   * between every chunk. Hence a separate parser.
   *
   * The headers describe REQUESTS only; OpenRouter publishes no token budget,
   * so `tpm` is deliberately left untouched rather than guessed.
   *
   * `X-RateLimit-Reset` is a unix epoch. It arrives in milliseconds; values
   * small enough to be seconds are promoted, so a future change of unit
   * degrades to a slightly conservative delay rather than a negative one.
   */
  updateFromOpenRouterHeaders(headers: Headers | Record<string, string | null | undefined>): void {
    const get = (name: string): string | null | undefined =>
      headers instanceof Headers ? headers.get(name) : (headers[name] ?? headers[name.toLowerCase()])

    const limit = parseIntOrUndef(get('x-ratelimit-limit'))
    const remaining = parseIntOrUndef(get('x-ratelimit-remaining'))
    const reset = parseIntOrUndef(get('x-ratelimit-reset'))

    if (limit !== undefined) this.snapshot.rpm = limit
    if (remaining !== undefined) this.snapshot.requestsRemaining = remaining

    if (reset !== undefined && reset > 0) {
      const resetMs = reset < 1e11 ? reset * 1000 : reset
      const deltaMs = resetMs - Date.now()
      if (deltaMs > 0) this.snapshot.resetMs = deltaMs
    }
  }

  /** For diagnostics / tests. */
  snapshotForDebug(): RateLimitSnapshot {
    return { ...this.snapshot }
  }
}

function parseIntOrUndef(v: string | null | undefined): number | undefined {
  if (v == null) return undefined
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? n : undefined
}

function parseDurationSeconds(v: string | null | undefined): number {
  if (!v) return 0
  // "1m30s", "30s", "1.5s", "100ms"
  let total = 0
  const matches = v.matchAll(/(\d+(?:\.\d+)?)\s*(ms|s|m|h)/g)
  for (const [, n, unit] of matches) {
    const num = parseFloat(n)
    if (!Number.isFinite(num)) continue
    if (unit === 'ms') total += num / 1000
    else if (unit === 's') total += num
    else if (unit === 'm') total += num * 60
    else if (unit === 'h') total += num * 3600
  }
  return total
}

/** Static rate-limit assumptions for Gemini (whose SDK doesn't surface
 *  headers). Picked conservatively from the published 2026 numbers — we'd
 *  rather under-utilise a tier than 429 the user. */
export const GEMINI_STATIC_LIMITS = {
  // Paid tier (PAID_GEMINI_API_KEY). Conservative against Tier 1 paid.
  paidPro: { rpm: 150, tpm: 2_000_000 },
  paidFlash: { rpm: 1000, tpm: 4_000_000 },
  // Free tier (VITE_GEMINI_API_KEY).
  freePro: { rpm: 2, tpm: 32_000 },
  freeFlash: { rpm: 10, tpm: 250_000 },
} as const

/** Estimate token count from a chars-of-prompt count. Good enough for budgeting. */
export function estimateTokensFromChars(chars: number): number {
  // English ASCII roughly 4 chars/token; structured prompts trend a little
  // higher, so 3.5 is a safer rounding for budgeting purposes.
  return Math.ceil(chars / 3.5)
}

// ────────────────────────────────────────────────────────────────────
// Per-model rate limiting
// ────────────────────────────────────────────────────────────────────

/**
 * A daily REQUEST budget.
 *
 * OpenRouter caps free-variant models at 20 requests/minute and either 50 or
 * 1000 requests/day depending on whether the account has ever bought credits
 * (`is_free_tier` on GET /api/v1/key). The per-minute cap is a rate and is
 * handled by RateLimitState. The per-day cap is NOT a rate — it is a count,
 * and no amount of slowing down creates more of it.
 *
 * That distinction matters: spacing calls further apart cannot make a 50-call
 * run fit inside 12 remaining requests. So this type does not feed pacing at
 * all. It answers one question — "will this run finish?" — early enough to do
 * something about it, instead of failing on call 13 of 50.
 */
export class DailyBudget {
  private cap: number | null = null
  private used = 0
  private windowStartedAt = 0

  /** @param cap requests permitted per UTC day, or null for no known cap. */
  constructor(cap: number | null = null) {
    this.cap = cap
    this.windowStartedAt = utcDayStart(Date.now())
  }

  setCap(cap: number | null): void {
    this.cap = cap
  }

  /** Seed from an authoritative count (e.g. a usage figure from the API). */
  setUsed(used: number): void {
    this.rollIfNewDay()
    this.used = Math.max(0, used)
  }

  noteCall(): void {
    this.rollIfNewDay()
    this.used += 1
  }

  /** Requests left today, or null when no cap is known. */
  remaining(): number | null {
    if (this.cap === null) return null
    this.rollIfNewDay()
    return Math.max(0, this.cap - this.used)
  }

  /**
   * Would a run of `callsNeeded` requests finish inside today's budget?
   *
   * `fits: true` with `remaining: null` means "no known cap", which is the
   * answer for every paid model — OpenRouter applies no platform request cap
   * to those, only a credit balance.
   */
  planFits(callsNeeded: number): {
    fits: boolean
    remaining: number | null
    shortfall: number
    resetsAt: string
  } {
    const remaining = this.remaining()
    const resetsAt = new Date(utcDayStart(Date.now()) + DAY_MS).toISOString()
    if (remaining === null) return { fits: true, remaining: null, shortfall: 0, resetsAt }
    return {
      fits: callsNeeded <= remaining,
      remaining,
      shortfall: Math.max(0, callsNeeded - remaining),
      resetsAt,
    }
  }

  private rollIfNewDay(): void {
    const today = utcDayStart(Date.now())
    if (today !== this.windowStartedAt) {
      this.windowStartedAt = today
      this.used = 0
    }
  }
}

const DAY_MS = 24 * 60 * 60 * 1000

function utcDayStart(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS
}

/**
 * One RateLimitState per model, plus an account-wide gate.
 *
 * Every provider today holds a single RateLimitState shared by every model it
 * serves (gemini.ts:489, openai.ts:95, claude.ts:120). That is fine while a run
 * uses one model, and wrong as soon as it does not: under a mixed preset a
 * 2 RPM Pro call sets `lastCallAt`, and the next Flash call — which has its own
 * far larger budget — is spaced against that anchor. Gemini compounds it by
 * re-seeding RPM/TPM from the current model INSIDE generate(), after
 * getNextDelayMs() has already been consulted, so each call is priced on the
 * previous chunk's row.
 *
 * Splitting the state per model fixes both. The wrapper shape is deliberate:
 * RateLimitState is left untouched, so its existing tests keep their meaning,
 * and the two things that genuinely ARE account-wide — a 429 Retry-After, and
 * the daily request budget — stay shared rather than being duplicated per
 * model where they would each be enforced too weakly.
 */
export class RateLimitRegistry {
  private states = new Map<string, RateLimitState>()
  private accountRetryAfterUntil = 0
  readonly daily: DailyBudget

  constructor(opts: { dailyCap?: number | null } = {}) {
    this.daily = new DailyBudget(opts.dailyCap ?? null)
  }

  /** The bucket for one model, created on first touch. */
  forModel(modelId: string): RateLimitState {
    const key = modelId || '(unknown)'
    let state = this.states.get(key)
    if (!state) {
      state = new RateLimitState()
      this.states.set(key, state)
    }
    return state
  }

  /** Seed a model's static limits, e.g. from a per-tier table. */
  setStatic(modelId: string, rpm: number, tpm: number): void {
    this.forModel(modelId).setStatic(rpm, tpm)
  }

  /**
   * Spacing before the next call to `modelId`.
   *
   * Takes the larger of the model's own requirement and any account-wide
   * Retry-After still in force — a 429 is usually a statement about the key,
   * not about one model, so it must not be escapable by switching models.
   */
  delayBeforeNextCall(modelId: string, estimatedInputTokens: number, extraMultiplier = 1): number {
    const accountGate = Math.max(0, this.accountRetryAfterUntil - Date.now())
    const modelDelay = this.forModel(modelId).delayBeforeNextCall(
      estimatedInputTokens,
      extraMultiplier,
    )
    return Math.max(accountGate, modelDelay)
  }

  noteCall(modelId: string): void {
    this.forModel(modelId).noteCall()
    this.daily.noteCall()
  }

  /** Record a 429 Retry-After. Applies account-wide, for the reason above. */
  noteRetryAfter(seconds: number): void {
    this.accountRetryAfterUntil = Math.max(
      this.accountRetryAfterUntil,
      Date.now() + seconds * 1000,
    )
  }

  updateFromOpenRouterHeaders(
    modelId: string,
    headers: Headers | Record<string, string | null | undefined>,
  ): void {
    this.forModel(modelId).updateFromOpenRouterHeaders(headers)
  }

  updateFromOpenAIHeaders(
    modelId: string,
    headers: Headers | Record<string, string | null | undefined>,
  ): void {
    this.forModel(modelId).updateFromOpenAIHeaders(headers)
  }

  /** Calls made to one model in the trailing window — powers the "N requests
   *  in the last minute" line in the rate-limit dialog. */
  recentCallCount(modelId: string, windowMs = 60_000): number {
    return this.forModel(modelId).recentCallCount(windowMs)
  }

  /** Which models this registry has seen. Diagnostics only. */
  knownModels(): string[] {
    return [...this.states.keys()]
  }
}

/** Platform request caps for OpenRouter `:free` model variants.
 *  Paid models have no platform-level request cap — only a credit balance. */
export const OPENROUTER_FREE_LIMITS = {
  rpm: 20,
  /** Before the account has ever purchased credits. */
  rpdNoCredits: 50,
  /** After a lifetime purchase of at least $10. */
  rpdWithCredits: 1000,
} as const
