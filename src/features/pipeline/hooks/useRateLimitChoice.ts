import { useCallback, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { toast } from 'sonner'
import { refreshProviders } from '@/features/providers'
import { getRouting, putRouting } from '@/features/routing'
import { vlog } from '@/features/maintenance'
import { emitActiveProviderChanged } from '@/platform/lib/appEvents'
import { fallbackToPaid } from '@/features/pipeline/lib/fallbackFlow'
import type { RateLimitChoice } from '../components/RateLimitDialog'
import type { RateLimitDialogState } from './usePipelineEventCallbacks'
import type { WriteCheckpoint } from './useCheckpointWriter'

/** What each rate-limit dialog choice does to a running chronicle: stop and
 *  export, slow the pacing, pause to disk, or move the run to the Paid key. */
export function useRateLimitChoice({
  setRateLimitDialog,
  abortRef,
  exportPartial,
  safetyMultiplierRef,
  writeCheckpoint,
  settleInFlight,
}: {
  setRateLimitDialog: Dispatch<SetStateAction<RateLimitDialogState | null>>
  abortRef: RefObject<AbortController | null>
  exportPartial: () => void
  safetyMultiplierRef: RefObject<number>
  writeCheckpoint: WriteCheckpoint
  settleInFlight: (timeoutMs: number) => Promise<boolean>
}): (choice: RateLimitChoice) => void {
  // Handles the user's choice from the rate-limit dialog. Routes to the
  // appropriate side-effect — abort + export / dial the multiplier mid-run
  // / pause to disk / explicit fallback. Dialog closes either way.
  const handleRateLimitChoice = useCallback((choice: RateLimitChoice) => {
    setRateLimitDialog(null)
    switch (choice.kind) {
      case 'stop':
        abortRef.current?.abort()
        exportPartial()
        toast.message('Stopped. Downloaded the partial output as Markdown.')
        break
      case 'slowdown':
        safetyMultiplierRef.current = choice.multiplier
        toast.info(`Pacing now ${choice.multiplier}× slower for the rest of this run.`)
        break
      case 'pause':
        // Save the full state to disk, then abort. The Resume banner picks
        // it up next time the Chronicle tab mounts (or right now once the
        // banner re-fetches).
        void writeCheckpoint('quota').then((ok) => {
          if (ok) {
            abortRef.current?.abort()
            toast.success('Run paused — resume from the banner when the quota resets.')
          }
        })
        break
      case 'fallback':
        // Race-window-tightened fallback sequence:
        //   1. Abort the in-flight chunk loop. This signals the AbortController
        //      but the SDK call already in flight may still complete (and
        //      potentially re-fire quota_exhausted on the OLD singleton/tier).
        //   2. Wait up to 5s for the in-flight call to settle. We listen for
        //      `running=false` via a polling promise. If the SDK call hangs
        //      past the timeout, we give up and proceed anyway — better to
        //      take the race than block the user indefinitely.
        //   3. Delegate the routing-mutation sequence to fallbackToPaid
        //      (src/features/pipeline/lib/fallbackFlow.ts). K.1.4 / W2 fix: that helper
        //      snapshots the original routing and rolls it back if
        //      writeCheckpoint fails, so a checkpoint-write failure no
        //      longer leaves the user silently on Paid on disk.
        //   4. emitActiveProviderChanged — refreshes ActiveProviderCard etc.
        //
        // The user sees: "Switched to Gemini Paid and paused (provider state
        // refreshed) — click Resume in the banner to continue."
        ;(async () => {
          vlog('fallback', { event: 'sequence_start' })
          vlog('fallback', { event: 'step1_abort' })
          abortRef.current?.abort()
          vlog('fallback', { event: 'step2_settle_wait', timeoutMs: 5000 })
          const settled = await settleInFlight(5_000)
          vlog('fallback', { event: 'step2_settle_done', settled })
          const result = await fallbackToPaid({
            getRouting,
            putRouting,
            refreshProviders,
            writeCheckpoint: (reason) => writeCheckpoint(reason),
            log: (event, payload) => vlog('fallback', { event, ...(payload ?? {}) }),
          })
          if (result.kind === 'ok') {
            vlog('fallback', { event: 'sequence_done' })
            emitActiveProviderChanged()
            toast.success(
              'Switched to Gemini Paid and refreshed provider singletons. ' +
                'Click Resume in the banner to continue on the paid key — the next chunk will dispatch fresh.',
            )
          } else if (result.kind === 'rolled_back') {
            // Forward step failed AFTER putRouting; fallbackToPaid
            // attempted to restore the original routing. Surface the
            // outcome so the user knows where they stand.
            vlog('fallback', { event: 'sequence_rolled_back', error: result.error.message })
            emitActiveProviderChanged()
            if (result.rollbackError) {
              // Rollback ALSO failed — the user's routing is in an
              // undefined state. Tell them to fix it manually.
              console.error('[fallback] forward and rollback both failed:', result.error, result.rollbackError)
              toast.error(
                `Fallback failed (${result.error.message}) and the rollback ALSO failed (${result.rollbackError.message}). ` +
                  `Open Settings → Active Provider and pick a tier manually before retrying.`,
              )
            } else {
              toast.error(
                `Fallback failed: ${result.error.message}. ` +
                  `Routing was restored to its previous state — your in-flight run is paused but still on the original tier.`,
              )
            }
          } else {
            // forward_failed_no_mutation — getRouting itself failed; nothing was touched.
            vlog('fallback', { event: 'sequence_no_mutation', error: result.error.message })
            console.error('[fallback] could not read routing:', result.error)
            toast.error(
              `Could not read routing: ${result.error.message}. Open Settings → Active Provider to switch tier manually.`,
            )
          }
        })()
        break
    }
  }, [exportPartial, writeCheckpoint, settleInFlight])
  return handleRateLimitChoice
}
