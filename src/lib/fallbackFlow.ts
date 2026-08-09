// "Switch to Gemini Paid" fallback orchestrator. Extracted from
// RefinementTool's inline `handleRateLimitChoice('fallback')` for
// K.1.4 / W2: the pre-fix sequence persisted the routing-to-Paid
// mutation to disk and rebuilt the provider singletons BEFORE
// writeCheckpoint ran. If the checkpoint write then failed, the user's
// on-disk routing was already on Paid with no rollback, and the next
// session would silently dispatch to Paid against the user's intent.
//
// The fix: snapshot the original routing first, then perform the
// mutations inside a try block. On any failure, attempt a best-effort
// putRouting(originalRouting) + refreshProviders() to restore the
// pre-fallback state — and surface a clear error so the user knows
// what happened.
//
// This module owns the sequencing + rollback contract. The actual
// vlog + toast wiring stays in the React component because those
// behaviours are user-visible side effects, not orchestration.

import type { RoutingDocument } from './routing'

/** Snapshot of one rollback attempt — surfaced to the caller so the UI
 *  can toast the appropriate message ("rolled back" vs "rollback also
 *  failed, switch routing manually"). */
export type FallbackResult =
  | { kind: 'ok' }
  | { kind: 'rolled_back'; error: Error; rollbackError: Error | null }
  | { kind: 'forward_failed_no_mutation'; error: Error }

export interface FallbackDeps {
  /** Read the current routing document. Throws if /api/routing is
   *  unreachable; the orchestrator surfaces this as
   *  forward_failed_no_mutation. */
  getRouting: () => Promise<RoutingDocument>
  /** Persist a routing document. The orchestrator calls this at most
   *  twice — once to switch to Paid, optionally once more to roll back
   *  to the snapshotted original on failure. */
  putRouting: (next: RoutingDocument) => Promise<unknown>
  /** Rebuild the provider singletons so the new routing takes effect.
   *  Pure side-effect on the in-memory provider registry. */
  refreshProviders: () => Promise<unknown> | unknown
  /** Capture the pause-time checkpoint for the user to resume from. */
  writeCheckpoint: (reason: 'quota') => Promise<boolean>
  /** Optional vlog forwarder — pure observer. The orchestrator calls
   *  this at each step boundary so the diagnose-bundle can replay
   *  exactly what happened. Errors thrown by the listener are
   *  swallowed to keep the orchestration honest. */
  log?: (event: string, payload?: Record<string, unknown>) => void
}

const noopLog: NonNullable<FallbackDeps['log']> = () => {}

/** Sequence the user's "switch to Gemini Paid" request with rollback
 *  protection. Returns a FallbackResult so the caller can branch its
 *  UI surface (toast copy etc.) without re-deriving what happened. */
export async function fallbackToPaid(deps: FallbackDeps): Promise<FallbackResult> {
  const log = (event: string, payload?: Record<string, unknown>) => {
    try {
      ;(deps.log ?? noopLog)(event, payload)
    } catch {
      // listener errors must never break the orchestration
    }
  }

  // Step 1 — snapshot the original routing BEFORE any mutation. If this
  // read itself fails, we haven't touched anything yet, so there's
  // nothing to roll back; bubble out cleanly with forward_failed_no_mutation.
  log('snapshot_start')
  let originalRouting: RoutingDocument
  try {
    originalRouting = await deps.getRouting()
  } catch (err) {
    log('snapshot_failed', { error: String(err) })
    return { kind: 'forward_failed_no_mutation', error: err as Error }
  }
  log('snapshot_done', { lastSelectedProvider: originalRouting.lastSelectedProvider })

  const nextRouting: RoutingDocument = {
    ...originalRouting,
    lastSelectedProvider: 'gemini',
    geminiTier: 'paid',
  }

  // Step 2 — forward mutations, all guarded by a single try so any
  // failure triggers the rollback path. Order: putRouting first
  // (smallest blast radius), then refreshProviders (in-memory), then
  // writeCheckpoint (largest — writes a file the user will see in the
  // resume banner). If writeCheckpoint fails after putRouting +
  // refreshProviders succeeded, we still need to undo BOTH (the next
  // session would otherwise honour the paid routing on disk without
  // a matching checkpoint).
  try {
    log('forward_putRouting_start', { next: nextRouting })
    await deps.putRouting(nextRouting)
    log('forward_putRouting_done')
    log('forward_refreshProviders_start')
    await deps.refreshProviders()
    log('forward_refreshProviders_done')
    log('forward_writeCheckpoint_start')
    const ok = await deps.writeCheckpoint('quota')
    log('forward_writeCheckpoint_done', { ok })
    if (!ok) {
      throw new Error('writeCheckpoint returned false (saveRun failed)')
    }
    log('done_ok')
    return { kind: 'ok' }
  } catch (err) {
    // Roll back the disk mutation. Best-effort — if this also fails,
    // we surface both errors so the user knows to fix routing manually.
    log('rollback_start', { error: String(err) })
    let rollbackError: Error | null = null
    try {
      await deps.putRouting(originalRouting)
      // Rebuild providers AGAIN so the in-memory singletons match the
      // restored on-disk routing. Without this, the in-memory state
      // would still reflect the (failed) Paid switch.
      await deps.refreshProviders()
      log('rollback_done')
    } catch (rbErr) {
      rollbackError = rbErr as Error
      log('rollback_failed', { error: String(rbErr) })
    }
    return { kind: 'rolled_back', error: err as Error, rollbackError }
  }
}
