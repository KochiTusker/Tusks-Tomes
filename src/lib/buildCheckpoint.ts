// Pure checkpoint-payload builder. Pulled out of RefinementTool's
// inline `writeCheckpoint` for K.1.3 / W1: when the writer awaits
// `getRouting()` mid-call, a `chunk_done` can land between the
// closure capture and the actual disk write. The pre-K.1.3 inline
// implementation closed over `state` at useCallback time, so the
// checkpoint reflected state from N renders ago — not the state at
// pause-click time.
//
// The fix is the snapshot pattern: the caller reads `stateRef.current`
// at the TOP of writeCheckpoint and passes the result into this pure
// builder. The builder has no closures of its own — what you pass in
// is what gets persisted.

import {
  CHECKPOINT_SCHEMA_VERSION,
  type CheckpointPhaseId,
  type Phase1InputSnapshot,
  type RunCheckpoint,
} from './runCheckpoint'
import type { RoutingDocument } from './routing'
import type { RefinementState } from '@/types'

/** A self-contained snapshot of the live React state at the moment the
 *  user clicked pause. Composed by writeCheckpoint via stateRef.current,
 *  campaignRef.current, etc. so no closure can capture a stale value. */
export interface CheckpointStateSnapshot {
  state: RefinementState
  campaign: string
  sessionNumber: number
}

export interface BuildCheckpointArgs {
  snapshot: CheckpointStateSnapshot
  runId: string
  routing: RoutingDocument
  pausedReason: 'user' | 'quota' | 'error'
  phaseNumeric: CheckpointPhaseId
  safetyMultiplier: number
  /** Optional — written only when present. Old checkpoints without
   *  this field still validate. */
  runFingerprint?: string | null
  /** Optional — Phase 1 prep snapshot for B2 boundary alignment. */
  inputSnapshot?: Phase1InputSnapshot | null
  /** ISO timestamp the run was first created. Defaults to
   *  state.updatedAt OR `now` if both are empty. Threaded through so
   *  tests can pin a deterministic value. */
  nowIso?: string
}

export function buildCheckpoint(args: BuildCheckpointArgs): RunCheckpoint {
  const now = args.nowIso ?? new Date().toISOString()
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    runId: args.runId,
    createdAt: args.snapshot.state.updatedAt || now,
    pausedAt: now,
    pausedReason: args.pausedReason,
    routing: args.routing,
    safetyMultiplier: args.safetyMultiplier,
    refinementState: {
      ...args.snapshot.state,
      campaign: args.snapshot.campaign,
      sessionNumber: args.snapshot.sessionNumber,
    },
    progress: {
      phase: args.phaseNumeric,
      chunkIndex: args.snapshot.state.currentChunkIndex,
      totalChunks: args.snapshot.state.totalChunks,
    },
    ...(args.runFingerprint ? { runFingerprint: args.runFingerprint } : {}),
    ...(args.inputSnapshot ? { inputSnapshot: args.inputSnapshot } : {}),
  }
}
