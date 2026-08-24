// Pre-flight budget check.
//
// A 3-hour session costs roughly 26 API calls. On OpenRouter's free tier that
// is either most of a day's allowance (50 requests before any credit purchase)
// or a rounding error (1000 after). The difference decides whether a run can
// finish, and it is knowable before the first call — the estimator already
// computes the chunk count per phase.
//
// Checking up front matters because the alternative is discovering it on call
// 13 of 26, halfway through a chronicle, where the only remedies left are to
// abandon the run or checkpoint it and come back tomorrow. Neither is a good
// surprise, and both were avoidable.
//
// Note what this deliberately does NOT do: it does not slow the pipeline down
// to fit. A daily cap is a count, not a rate — spacing calls further apart
// cannot make 26 requests fit inside 12. Pacing is RateLimitState's job and is
// entirely separate.

import type { RunCostEstimate } from './pricing'

export interface PreflightVerdict {
  /** True when the run is expected to finish inside the remaining budget. */
  ok: boolean
  /** Total API calls the run is expected to make. */
  callsNeeded: number
  /** Requests left today, or null when no cap applies (every paid model). */
  remaining: number | null
  /** How many calls short we are. Zero when ok. */
  shortfall: number
  /** ISO timestamp of the next budget reset (UTC midnight). */
  resetsAt: string
  /** One line suitable for showing to a person, or null when there is nothing
   *  to say. */
  message: string | null
}

/** Total API calls a run will make, summed across phases. */
export function callsForRun(estimate: RunCostEstimate): number {
  return estimate.perPhase.reduce((sum, p) => sum + p.chunks, 0)
}

/**
 * Will this run fit in what is left today?
 *
 * `remaining: null` means no known cap, which is the correct reading for paid
 * models — OpenRouter applies no platform request cap to those, only a credit
 * balance. Unknown must never be treated as zero.
 */
export function preflight(args: {
  callsNeeded: number
  remaining: number | null
  resetsAt: string
  /** Warn when a run would consume more than this share of what is left, even
   *  if it technically fits. Landing at zero remaining is rarely what someone
   *  wants when they have another session to process. */
  warnThreshold?: number
}): PreflightVerdict {
  const { callsNeeded, remaining, resetsAt } = args
  const warnThreshold = args.warnThreshold ?? 0.8

  if (remaining === null) {
    return { ok: true, callsNeeded, remaining: null, shortfall: 0, resetsAt, message: null }
  }

  const shortfall = Math.max(0, callsNeeded - remaining)
  if (shortfall > 0) {
    return {
      ok: false,
      callsNeeded,
      remaining,
      shortfall,
      resetsAt,
      message:
        `This run needs about ${callsNeeded} requests and ${remaining} are left on today's ` +
        `free-model allowance — ${shortfall} short. The allowance resets at ` +
        `${formatReset(resetsAt)}. Switch the routing to a paid model, or run it after the reset.`,
    }
  }

  const consumedShare = remaining > 0 ? callsNeeded / remaining : 1
  if (consumedShare >= warnThreshold) {
    return {
      ok: true,
      callsNeeded,
      remaining,
      shortfall: 0,
      resetsAt,
      message:
        `This run needs about ${callsNeeded} of the ${remaining} requests left on today's ` +
        `free-model allowance, which will leave ${remaining - callsNeeded}. Resets at ` +
        `${formatReset(resetsAt)}.`,
    }
  }

  return { ok: true, callsNeeded, remaining, shortfall: 0, resetsAt, message: null }
}

function formatReset(iso: string): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return 'the next UTC midnight'
  return `${new Date(ms).toISOString().replace('T', ' ').slice(0, 16)} UTC`
}
