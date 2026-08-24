// On-disk checkpoint shape for the pause/resume feature (Workstream C).
//
// When a user pauses a long-running pipeline — manually or via the rate-
// limit dialog — we serialise the whole runtime state so they can close
// the app, wait for their free-tier quota to reset, then resume from the
// exact chunk they stopped at. Persisted to {configDir}/runs/{runId}.json
// via the /api/runs/* endpoints; the client wrapper lives at
// src/lib/runStorage.ts.

import type { RefinementState } from '@/types'
import type { RoutingDocument } from './routing'

/** Bumped when the on-disk schema changes. Loaders refuse to resume a
 *  checkpoint with a mismatching schemaVersion and surface "export your
 *  partial output instead" UI.
 *
 *  v2: Phase 1 now strips `[Speaker (Player)]` brackets before chunking
 *  (see src/lib/speakerDetach.ts). The chunker is character-count
 *  driven, so removing ~25 chars per line shifts every chunk boundary —
 *  a v1 priorPartial built under the bracketed input wouldn't realign
 *  on resume. v2 checkpoints contain priorPartial that was assembled
 *  AFTER speaker reattachment (brackets restored on the output), and
 *  progress indices that match the post-detach chunking. v1 checkpoints
 *  are still readable on disk but the resume loader at runStorage.ts
 *  refuses to dispatch them — the user must export the partial output
 *  and start a fresh run. */
export const CHECKPOINT_SCHEMA_VERSION = 2

export type CheckpointPhaseId = 1 | 2 | 3 | 4 | 6

/** Snapshot of the Phase 1 prep-stage output, captured at the first
 *  `chunk_done` and persisted into the checkpoint so a resume after a
 *  glossary edit re-uses the original chunk boundaries rather than re-
 *  running cleanupTranscript → preGround → detachSpeakers against the
 *  live glossary. See [src/lib/pipeline.ts] `runPhase1` for the source
 *  of truth on what fields get captured and how the resume path consumes
 *  them. Optional — older checkpoints (pre-K.1.2) don't carry it; their
 *  resume falls back to the live-glossary prep path (same drift bug as
 *  before, kept for backwards-compat with existing on-disk runs). */
export type Phase1InputSnapshot = {
  /** Pre-chunked grounding input — exactly what `chunkText()` produced. */
  phase1Chunks: string[]
  /** The character count chunkText was asked to target. Informational. */
  chunkSizeChars: number
  /** Was Phase 1's speaker-detach optimisation active? Controls whether
   *  the resume calls `reattachSpeakers()` on the model output. */
  detachAttached: boolean
  /** Marker-index → original-speaker-bracket map captured at pause time.
   *  Stored as a plain object (JSON-safe). Reconstituted into a Map on
   *  resume so `reattachSpeakers()` can re-prepend the brackets. */
  speakersByMarker: Record<string, string>
}

export type RunCheckpoint = {
  schemaVersion: typeof CHECKPOINT_SCHEMA_VERSION
  /** UUID — generated client-side at pause time, used as the on-disk filename. */
  runId: string
  /** ISO timestamp the run was first created (kept across resumes). */
  createdAt: string
  /** ISO timestamp of the most recent pause. Updated on every save. */
  pausedAt: string
  /** Why the run was paused — drives copy in the Resume banner. */
  pausedReason: 'user' | 'quota' | 'error'
  /** Snapshot of the routing the run started under so resume re-uses the
   *  same models / providers even if the user has since changed defaults. */
  routing: RoutingDocument
  /** Per-run "slow down" dial. 1.0 = natural pacing; 3.0 = three times
   *  slower (set by the rate-limit dialog's "slow down" option). */
  safetyMultiplier: number
  /** Full RefinementState — grounded transcript, dmQuestions/Answers,
   *  chronicle so far, extras, condensed (when present). */
  refinementState: RefinementState
  /** Where the loop got to. `chunkIndex` is the NEXT chunk to process. */
  progress: {
    phase: CheckpointPhaseId
    chunkIndex: number
    totalChunks: number
  }
  /** K.1.2 / B2 fix — content hash of inputs that, if changed between
   *  pause and resume, would invalidate the saved chunk boundaries.
   *  Currently covers rawTranscript + glossary content. The resume path
   *  compares this to a fresh fingerprint and surfaces a warning toast
   *  when the values differ ("glossary changed since pause — resume on
   *  saved snapshot"). Optional — older v2 checkpoints lack it and skip
   *  the comparison. */
  runFingerprint?: string
  /** K.1.2 / B2 fix — Phase 1 prep snapshot. See {@link Phase1InputSnapshot}.
   *  Optional — only present when the pause happened AFTER at least one
   *  chunk completed (the snapshot is captured at first `chunk_done`).
   *  Pre-first-chunk pauses fall back to re-running prep from
   *  rawTranscript, which is invariant across glossary edits. */
  inputSnapshot?: Phase1InputSnapshot
}

/** Summary returned by `GET /api/runs` — full state isn't pulled until
 *  the user clicks Resume on a specific entry. */
export type RunCheckpointSummary = {
  runId: string
  schemaVersion: number
  createdAt: string
  pausedAt: string
  pausedReason: 'user' | 'quota' | 'error'
  campaign: string
  sessionNumber: number
  progress: RunCheckpoint['progress']
}

/** Build a `RunCheckpointSummary` from a full checkpoint — used both
 *  client- and server-side so the shape stays in lockstep. */
export function summarise(checkpoint: RunCheckpoint): RunCheckpointSummary {
  return {
    runId: checkpoint.runId,
    schemaVersion: checkpoint.schemaVersion,
    createdAt: checkpoint.createdAt,
    pausedAt: checkpoint.pausedAt,
    pausedReason: checkpoint.pausedReason,
    campaign: checkpoint.refinementState.campaign,
    sessionNumber: checkpoint.refinementState.sessionNumber,
    progress: checkpoint.progress,
  }
}

/** Type guard for incoming JSON. We trust our own writer, but defend
 *  against schema drift / hand-edited files. */
export function isValidCheckpoint(value: unknown): value is RunCheckpoint {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (v.schemaVersion !== CHECKPOINT_SCHEMA_VERSION) return false
  if (typeof v.runId !== 'string' || !v.runId) return false
  if (typeof v.createdAt !== 'string' || !v.createdAt) return false
  if (typeof v.pausedAt !== 'string' || !v.pausedAt) return false
  if (v.pausedReason !== 'user' && v.pausedReason !== 'quota' && v.pausedReason !== 'error') return false
  if (typeof v.safetyMultiplier !== 'number' || !Number.isFinite(v.safetyMultiplier)) return false
  if (!v.routing || typeof v.routing !== 'object') return false
  if (!v.refinementState || typeof v.refinementState !== 'object') return false
  if (!v.progress || typeof v.progress !== 'object') return false
  const prog = v.progress as Record<string, unknown>
  if (![1, 2, 3, 4, 6].includes(prog.phase as number)) return false
  if (typeof prog.chunkIndex !== 'number') return false
  if (typeof prog.totalChunks !== 'number') return false
  return true
}
