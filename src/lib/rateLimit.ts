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
