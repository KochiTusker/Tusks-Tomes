// Client wrapper for the /api/diagnose/* endpoints. Provides:
//   - `requestBundle()` — POSTs to /bundle with browser ring + current
//     state snapshot, 30s debounce so rapid-fire errors don't generate
//     12 bundles.
//   - `listRecentBundles()` — GET /recent for the DiagnosticsCard
//     history list.
//   - `extractSymbolFromError()` — best-effort symbol extraction from
//     a JS Error stack trace, mirroring the server-side helper. Lets
//     the client send a `symbolHint` without round-tripping.

import { dumpRecentEvents } from './verboseLog'

type BundleSignature = { id: string; severity: 'critical' | 'warning' | 'info' }

export type RequestBundleResult = {
  ok: boolean
  latestPath?: string
  bundlePath?: string
  signaturesMatched?: number
  signatures?: BundleSignature[]
  error?: string
  /** True when this call was debounced — no fresh bundle was built. */
  debounced?: boolean
}

export type RecentBundle = {
  filename: string
  path: string
  size: number
  modifiedAt: string
}

/** Debounce window for bundle builds. A burst of identical errors should
 *  produce one bundle, not one per error. 30s matches the cadence the
 *  user can realistically read + investigate a bundle. */
const DEBOUNCE_MS = 30_000

let lastBuildAt = 0

/** Reset the debounce timer. Used by tests + the explicit "Build now"
 *  button (which bypasses debounce). */
export function resetDebounce(): void {
  lastBuildAt = 0
}

export type RequestBundleInput = {
  trigger: 'hard_error' | 'soft_match' | 'manual'
  /** Optional best-effort symbol — usually extracted from the throw site. */
  symbolHint?: string
  errorMessage?: string
  errorStack?: string
  /** Snapshot of the live RefinementState — taken AT CALL TIME so the
   *  bundle reflects the moment the error happened. */
  currentState?: Record<string, unknown>
  /** Skip the debounce — used for the explicit "Build now" button. */
  force?: boolean
}

export async function requestBundle(input: RequestBundleInput): Promise<RequestBundleResult> {
  if (typeof window === 'undefined') {
    return { ok: false, error: 'window unavailable (SSR context)' }
  }
  // Debounce — except for manual / force triggers.
  const now = Date.now()
  if (!input.force && now - lastBuildAt < DEBOUNCE_MS) {
    return { ok: true, debounced: true }
  }
  lastBuildAt = now

  // Snapshot the browser ring — newest 80 entries, all categories.
  const browserRing = dumpRecentEvents({ count: 80 })

  try {
    const res = await fetch('/api/diagnose/bundle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        trigger: input.trigger,
        browserRing,
        symbolHint: input.symbolHint,
        errorMessage: input.errorMessage,
        errorStack: input.errorStack,
        currentState: input.currentState,
      }),
      // Keep the call alive across navigation so a beforeunload-time
      // bundle still lands.
      keepalive: true,
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { ok: false, error: `HTTP ${res.status}: ${body.slice(0, 300)}` }
    }
    return (await res.json()) as RequestBundleResult
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/** Convenience wrapper for the DiagnosticsCard "Recent bundles" list. */
export async function listRecentBundles(): Promise<RecentBundle[]> {
  try {
    const res = await fetch('/api/diagnose/recent')
    if (!res.ok) return []
    const body = (await res.json()) as { bundles?: RecentBundle[] }
    return body.bundles ?? []
  } catch {
    return []
  }
}

/** Decide whether handlePipelineError should auto-write a checkpoint
 *  before surfacing the error. Pure function — extracted from
 *  RefinementTool so the policy is unit-testable.
 *
 *  Returns the checkpoint reason ('daily_quota' or 'error') when the
 *  caller should checkpoint, or null when it shouldn't.
 *
 *  The principle: any error mid-phase that has accumulated work
 *  (chunk_done events landed) should auto-pause. The user gets a
 *  Resume banner instead of having to manually re-export their
 *  partial output. AbortError is excluded — that's an explicit user
 *  cancel, not a recoverable failure.
 *
 *  Distinguishes daily-quota from general errors so the caller can
 *  surface different recovery copy ("resume after midnight UTC" vs.
 *  "fix the issue and click Resume"). */
export function shouldAutoCheckpointOnError(args: {
  err: unknown
  currentPhase: string | null
  currentChunkIndex: number
}): 'daily_quota' | 'error' | null {
  const e = args.err as Error & { isDailyQuotaExhaustion?: boolean }
  // Explicit user cancel — never auto-checkpoint.
  if (e?.name === 'AbortError') return null
  // Daily-quota marker from gemini.ts fast-fail path — auto-checkpoint
  // unconditionally so the user can resume after the bucket refills.
  // We don't require currentChunkIndex > 0 here because daily quota
  // can hit on the very first chunk of a phase and that's still worth
  // a checkpoint (the run can resume from chunk 0 next day).
  if (e?.isDailyQuotaExhaustion === true) return 'daily_quota'
  // General recovery: there's accumulated work worth saving.
  // currentChunkIndex > 0 means at least one chunk completed; the
  // partial accumulator (priorPartial / priorExtras / chronicle so
  // far) is the load-bearing thing the checkpoint preserves.
  if (args.currentPhase !== null && args.currentChunkIndex > 0) {
    return 'error'
  }
  // Pre-first-chunk failure — nothing to save. Fall through to the
  // plain error toast.
  return null
}

/** Best-effort symbol extraction from a JS Error.stack. Mirrors the
 *  server-side helper so we can hand a hint without round-trip. */
export function extractSymbolFromError(err: unknown): string | null {
  const stack = (err as { stack?: string } | null)?.stack
  if (!stack) return null
  const re = /\bat\s+([A-Za-z_$][\w.$]*)\s*\(/g
  for (let m = re.exec(stack); m !== null; m = re.exec(stack)) {
    const name = m[1]
    if (
      name === 'Object' ||
      name === 'process' ||
      name.startsWith('Promise') ||
      name.length < 3
    ) continue
    return name
  }
  return null
}
