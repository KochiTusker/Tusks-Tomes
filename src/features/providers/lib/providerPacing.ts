// Per-provider pacing helper. Extracted from chunkedGenerate's inline
// "delay = provider.getNextDelayMs(...); sleep(delay)" pattern so the
// same logic can be reused on the Free→Paid escalation paths without
// duplicating the prompt-size estimation + safety-multiplier resolution.
//
// K.2.1 / B3: pre-K.2.1, the prohibited_content + transient-5xx
// escalation branches at pipeline.ts:506 and 756 called
// paidProvider.generate immediately, never consulting
// paidProvider.getNextDelayMs(). When the user just exhausted their
// Free quota and we escalate to Paid mid-loop, that bypass can trip
// the Paid singleton's per-minute cap right out of the gate — paid
// gets a synchronous burst with no spacing.
//
// This helper centralises the pace-then-call pattern so any future
// escalation site picks it up automatically. Pure orchestration; the
// caller owns the AbortSignal + UI countdown.

import { estimateTokensFromChars } from './rateLimit'
import type { GenerateRequest } from './providers/llm'

export interface PacingProvider {
  /** Optional — providers without rate-limit awareness skip pacing. */
  getNextDelayMs?: (
    estimatedInputTokens: number,
    multiplier?: number,
    modelId?: string,
  ) => number
}

export interface PaceBeforeNextCallArgs {
  /** Request being sent; used only for prompt-size estimation. */
  req: GenerateRequest
  /** The provider whose rate-limit state should be honoured. */
  provider: PacingProvider
  /** Per-run "slow down" dial (1.0 = natural pacing). */
  safetyMultiplier?: number | (() => number)
  /** Skip pacing entirely — used by callers that already paid the
   *  delay (e.g. local providers that have no rate limit). */
  skip?: boolean
}

/** Compute the wait time the provider's RateLimitState demands before
 *  the next call. Returns 0 when pacing isn't needed (no
 *  getNextDelayMs / skip=true / provider returned 0). */
export function computePacingDelay(args: PaceBeforeNextCallArgs): number {
  if (args.skip) return 0
  if (!args.provider.getNextDelayMs) return 0
  const promptChars =
    (args.req.systemPrompt?.length ?? 0) +
    (args.req.cacheablePrefix?.length ?? 0) +
    (args.req.userPrompt?.length ?? 0)
  const estimatedInputTokens = estimateTokensFromChars(promptChars)
  const mult =
    typeof args.safetyMultiplier === 'function'
      ? args.safetyMultiplier()
      : args.safetyMultiplier ?? 1
  const delay = args.provider.getNextDelayMs(estimatedInputTokens, mult, args.req.model)
  // Guard against providers returning negative or NaN — treat as zero.
  return Number.isFinite(delay) && delay > 0 ? delay : 0
}
