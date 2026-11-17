import { useCallback, useEffect, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { toast } from 'sonner'
import { getRouting } from '@/features/routing'
import { buildCheckpoint } from '@/features/pipeline/lib/buildCheckpoint'
import { saveRun } from '@/features/pipeline/lib/runStorage'
import type { CheckpointPhaseId, Phase1InputSnapshot } from '@/features/pipeline/lib/runCheckpoint'
import type { PhaseId, RefinementState } from '@/features/pipeline/lib/types'

export type WriteCheckpoint = (reason: 'user' | 'quota' | 'error') => Promise<boolean>

/** Writes the live run to an on-disk checkpoint (the Pause choice, Halt, and
 *  an error's auto-pause), and keeps `writeCheckpointRef` pointing at it for
 *  the error handler, which is declared earlier in the component. */
export function useCheckpointWriter({
  stateRef,
  campaignRef,
  sessionNumberRef,
  runFingerprintRef,
  phase1InputSnapshotRef,
  safetyMultiplierRef,
  currentRunIdRef,
  setResumeBannerKey,
  writeCheckpointRef,
}: {
  stateRef: RefObject<RefinementState>
  campaignRef: RefObject<string>
  sessionNumberRef: RefObject<number>
  runFingerprintRef: RefObject<string | null>
  phase1InputSnapshotRef: RefObject<Phase1InputSnapshot | null>
  safetyMultiplierRef: RefObject<number>
  currentRunIdRef: RefObject<string | null>
  setResumeBannerKey: Dispatch<SetStateAction<number>>
  writeCheckpointRef: RefObject<WriteCheckpoint | null>
}): WriteCheckpoint {
  /** Map the internal PhaseId enum to the checkpoint's numeric phase id. */
  const phaseIdToNumber = (p: PhaseId | null): CheckpointPhaseId | null => {
    switch (p) {
      case 'phase1_ground': return 1
      case 'phase2_audit': return 2
      case 'phase3_chronicle': return 3
      case 'phase4_extras': return 4
      case 'phase6_condense': return 6
      default: return null
    }
  }

  /** Build a RunCheckpoint from the live state and persist it. Called by
   *  the rate-limit dialog's Pause option AND the Halt cancel() above.
   *
   *  K.1.3 / W1 — state is read from refs at the TOP of the function
   *  rather than via the useCallback closure. Without this, a chunk_done
   *  landing during the `await getRouting()` window would mutate state
   *  to N+1 while this callback still saw N, producing a checkpoint with
   *  inconsistent (chunkIndex, partialOutput). The deps list is empty
   *  because every value the body reads comes from a ref — the callback
   *  never needs to re-bind.
   *
   *  Resolves to true on success. */
  const writeCheckpoint = useCallback(
    async (reason: 'user' | 'quota' | 'error'): Promise<boolean> => {
      // Snapshot EVERYTHING at the top so an interleaving chunk_done
      // can't fracture the checkpoint mid-build. Object spreads make
      // state a frozen-from-this-moment value — subsequent mutations
      // to the React store don't reach into this captured shape.
      const snapshotState = stateRef.current
      const snapshotCampaign = campaignRef.current
      const snapshotSessionNumber = sessionNumberRef.current
      const snapshotFingerprint = runFingerprintRef.current
      const snapshotInputSnapshot = phase1InputSnapshotRef.current
      const snapshotSafetyMultiplier = safetyMultiplierRef.current

      const phaseNumeric = phaseIdToNumber(snapshotState.currentPhase)
      if (!phaseNumeric) {
        toast.error('Cannot pause: no active phase to save.')
        return false
      }
      const runId =
        currentRunIdRef.current ?? `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      currentRunIdRef.current = runId
      let routing
      try {
        routing = await getRouting()
      } catch {
        // Falling back to a minimal stub keeps the resume usable — the
        // user can re-pick the routing manually if needed.
        routing = { version: 3 as const, lastSelectedProvider: null }
      }
      const checkpoint = buildCheckpoint({
        snapshot: {
          state: snapshotState,
          campaign: snapshotCampaign,
          sessionNumber: snapshotSessionNumber,
        },
        runId,
        routing,
        pausedReason: reason,
        phaseNumeric,
        safetyMultiplier: snapshotSafetyMultiplier,
        runFingerprint: snapshotFingerprint,
        inputSnapshot: snapshotInputSnapshot,
      })
      const result = await saveRun(checkpoint)
      if (!result.ok) {
        toast.error(result.message)
        return false
      }
      setResumeBannerKey((k) => k + 1)
      return true
    },
    [],
  )

  // Populate the forward-reference ref for handlePipelineError. Mounted
  // here (instead of inline at the writeCheckpoint declaration) so the
  // dependency array stays clean and React's exhaustive-deps lint
  // doesn't complain about a missing dep on the callback.
  useEffect(() => {
    writeCheckpointRef.current = writeCheckpoint
  }, [writeCheckpoint])
  return writeCheckpoint
}
