// Halt-button cancel orchestrator. Extracted from RefinementTool's
// inline `cancel()` so the ordering invariants (abort fires BEFORE the
// checkpoint write resolves) can be unit-tested without mounting the
// whole component.
//
// Pre-K.1.3 / W1, the inline implementation was:
//
//   const cancel = async () => {
//     try { await writeCheckpointRef.current('user') } catch {}
//     abortRef.current?.abort()
//   }
//
// That ordering opens a race: between the user-click and writeCheckpoint
// finishing its `await getRouting()` round-trip, the in-flight chunk can
// post a `chunk_done` that mutates state — yet the closure already
// captured at useCallback time (or, more visibly, the still-running
// chunk silently completes after the user thought they'd halted). The
// checkpoint can then record `chunkIndex: N+1` while `partialOutput`
// only reflects chunks 0..N-1 the closure saw.
//
// The fix is two-fold:
//   1. Abort FIRST so no further `chunk_done` can land mid-write.
//   2. Snapshot state at call time (via stateRef.current inside
//      writeCheckpoint) so the persisted checkpoint reflects a single
//      coherent moment, not a closure from N renders ago.
//
// This module owns invariant #1. The state-snapshot piece lives in
// [src/lib/buildCheckpoint.ts] so writeCheckpoint can compose the two.

export interface CancelFlowDeps {
  /** Reference to the in-flight pipeline run's AbortController. */
  abortRef: { current: AbortController | null }
  /** The writeCheckpoint callback. May be null during the very first
   *  render window before useEffect populates the forward-ref. */
  writeCheckpoint: ((reason: 'user') => Promise<boolean>) | null
}

/** Halt the in-flight pipeline run. Aborts first, then writes the
 *  checkpoint. Checkpoint-write failures are swallowed (best-effort —
 *  losing the checkpoint is bad, but blocking the abort is worse). */
export async function cancelRun(deps: CancelFlowDeps): Promise<void> {
  // Invariant: abort fires BEFORE writeCheckpoint resolves. Without
  // this, an in-flight chunk can post chunk_done mid-write and leave
  // the checkpoint internally inconsistent.
  deps.abortRef.current?.abort()
  if (!deps.writeCheckpoint) return
  try {
    await deps.writeCheckpoint('user')
  } catch {
    // Checkpoint-write failures are non-fatal at the cancel layer.
    // The caller's pipeline error handler will surface the abort and
    // log the checkpoint failure separately.
  }
}
