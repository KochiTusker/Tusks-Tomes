// The slice of a paused-run checkpoint both sides read: the phase ids and the
// summary `GET /api/runs` returns. The full checkpoint stays client-side.

export type CheckpointPhaseId = 1 | 2 | 3 | 4 | 6

/** Summary returned by `GET /api/runs`. Full state isn't pulled until the user
 *  clicks Resume on a specific entry. */
export type RunCheckpointSummary = {
  runId: string
  schemaVersion: number
  createdAt: string
  pausedAt: string
  pausedReason: 'user' | 'quota' | 'error'
  campaign: string
  sessionNumber: number
  progress: {
    phase: CheckpointPhaseId
    chunkIndex: number
    totalChunks: number
  }
}
