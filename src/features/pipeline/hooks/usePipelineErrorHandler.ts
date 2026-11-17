import { useCallback, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { toast } from 'sonner'
import { extractSymbolFromError, requestBundle, shouldAutoCheckpointOnError } from '@/features/maintenance'
import type { PipelineStatus, RefinementState } from '@/features/pipeline/lib/types'
import type { RetryState } from '../components/RetryBanner'
import type { RefinementActions } from './useRefinementState'
import type { WriteCheckpoint } from './useCheckpointWriter'

export type PipelineErrorHandler = (
  err: unknown,
  opts?: { cancelMsg?: string; cancelStatus?: PipelineStatus; label?: string },
) => void

/** What happens when a run fails or is cancelled: the status and toast, an
 *  auto-pause checkpoint when there is work worth keeping, and a diagnosis
 *  bundle for anything that was not a cancel. */
export function usePipelineErrorHandler({
  actions,
  state,
  setRetryState,
  writeCheckpointRef,
}: {
  actions: RefinementActions
  state: RefinementState
  setRetryState: Dispatch<SetStateAction<RetryState | null>>
  writeCheckpointRef: RefObject<WriteCheckpoint | null>
}): PipelineErrorHandler {
  const handlePipelineError = useCallback(
    (err: unknown, opts?: { cancelMsg?: string; cancelStatus?: PipelineStatus; label?: string }) => {
      // The run either errored out (retry exhausted) or was aborted —
      // either way the banner is no longer meaningful.
      setRetryState(null)
      if ((err as Error).name === 'AbortError') {
        toast.info(opts?.cancelMsg ?? 'Refinement cancelled.')
        actions.setStatus(opts?.cancelStatus ?? 'idle')
        return
      }
      console.error(err)
      const msg = (err as Error).message
      actions.setError(msg)
      // Decide whether to auto-checkpoint. Returns 'daily_quota' for the
      // gemini.ts fast-fail marker, 'error' for any other mid-phase
      // failure with accumulated work, or null when there's nothing
      // worth preserving (e.g. failure before chunk 1 completes).
      // The principle: the user should NEVER lose in-progress work to
      // a transient or unattended-recovery failure. Checkpoint by
      // default; the Resume banner gives them a one-click retry.
      const checkpointReason = shouldAutoCheckpointOnError({
        err,
        currentPhase: state.currentPhase,
        currentChunkIndex: state.currentChunkIndex,
      })
      const isDailyQuota = checkpointReason === 'daily_quota'
      if (checkpointReason !== null) {
        const checkpointFn = writeCheckpointRef.current
        // Map the helper's reason into the checkpoint's persisted reason
        // set ('user' | 'quota' | 'error'). The helper distinguishes
        // 'daily_quota' for toast-copy branching above; on disk we collapse
        // it to 'quota' because the Resume banner only needs the broad
        // category.
        const persistedReason = checkpointReason === 'daily_quota' ? 'quota' : 'error'
        if (checkpointFn) {
          void checkpointFn(persistedReason).then((ok) => {
            if (ok) {
              if (isDailyQuota) {
                // Provider-specific quota copy. Claude Code exhaustion is a
                // subscription usage window (typically 5 h), not a daily
                // free-tier quota — telling the user to wait for midnight
                // UTC or buy a Gemini key would be wrong on both counts.
                const quotaMarked = err as Error & {
                  quotaProvider?: string
                  quotaResetsAt?: string | null
                }
                const phaseLabel = state.currentPhase?.replace('_', ' ') ?? 'this phase'
                if (quotaMarked.quotaProvider === 'claudeCode') {
                  const when = quotaMarked.quotaResetsAt
                    ? ` (expected around ${new Date(quotaMarked.quotaResetsAt).toLocaleTimeString()})`
                    : ''
                  toast.warning(
                    `Claude Code usage limit hit at ${phaseLabel} chunk ${state.currentChunkIndex}. ` +
                      `Run auto-paused — your progress is saved. ` +
                      `Resume from the banner when your usage window resets${when}.`,
                    { duration: 20_000 },
                  )
                } else {
                  toast.warning(
                    `Daily Free-tier quota hit at ${phaseLabel} chunk ${state.currentChunkIndex}. ` +
                      `Run auto-paused — your progress is saved. ` +
                      `Resume after midnight UTC, OR add a Paid Gemini key in Settings → API Keys.`,
                    { duration: 20_000 },
                  )
                }
              } else {
                // Generic recovery toast — applies to per-minute rate
                // limits, exhausted 5xx retries, network errors, any
                // mid-phase failure that left accumulated work. The user
                // sees the Resume banner regardless of what failed.
                toast.warning(
                  `${opts?.label ?? 'Pipeline'} failed at ${state.currentPhase?.replace('_', ' ') ?? 'this phase'} chunk ${state.currentChunkIndex} — run auto-paused. ` +
                    `Your progress is saved. Click Resume in the banner to retry, or fix the underlying issue first. ` +
                    `Error: ${msg.slice(0, 600)}`,
                  { duration: 20_000 },
                )
              }
            } else {
              // Checkpoint write failed — surface a softer error that
              // still tells the user where state lives. localStorage
              // mirror still has the in-progress run, just no Resume
              // banner backing it.
              toast.error(
                `${opts?.label ?? 'Pipeline'} failed and the checkpoint couldn't be written. ` +
                  `Your progress through chunk ${state.currentChunkIndex} is still in localStorage. ` +
                  `Error: ${msg.slice(0, 600)}`,
              )
            }
          })
        } else {
          // writeCheckpointRef not populated yet — extremely rare race
          // window before first phase fires. Fall back to the recovery
          // toast without the actual checkpoint write.
          toast.warning(
            `${opts?.label ?? 'Pipeline'} failed before the auto-pause system was ready. ` +
              `Refresh and click Resume in the banner if your in-progress state is there. ` +
              `Error: ${msg.slice(0, 600)}`,
            { duration: 20_000 },
          )
        }
      } else {
        // No accumulated work — failure before any chunk completed.
        // Plain error toast; nothing to checkpoint.
        // Surface full error detail (up to 600 chars) — the previous 200-char
        // limit cut off recovery hints from the gold-standard messages (e.g.
        // "Daily quota exhausted… resume tomorrow OR add Paid key"). Sonner
        // can render multi-line; phase+chunk on the first line ensures the
        // load-bearing context survives any later truncation.
        const phaseChunk = state.currentPhase
          ? ` [${state.currentPhase.replace('_', ' ')} chunk ${state.currentChunkIndex}]`
          : ''
        toast.error(`${opts?.label ?? 'Pipeline'}${phaseChunk} failed: ${msg.slice(0, 600)}`)
      }
      // Auto-build the diagnosis bundle so the user can paste
      // @.diagnose/latest.md into Claude Code without copy-pasting events.
      // Debounced in the client wrapper — repeated identical errors won't
      // produce duplicate bundles. Snapshot a minimal state shape; the
      // ring + probe cache + routing carry the rest of the context.
      const stack = (err as Error).stack
      const symbolHint = extractSymbolFromError(err) ?? undefined
      void requestBundle({
        trigger: 'hard_error',
        errorMessage: msg,
        errorStack: stack,
        symbolHint,
        currentState: {
          status: state.status,
          currentPhase: state.currentPhase,
          currentChunkIndex: state.currentChunkIndex,
          totalChunks: state.totalChunks,
          chronicle: state.chronicle,
          lastError: msg,
          outputSelection: state.outputSelection,
        },
      })
        .then((result) => {
          if (result.ok && !result.debounced && result.latestPath) {
            const sigSuffix = result.signaturesMatched
              ? ` (${result.signaturesMatched} soft-error${result.signaturesMatched === 1 ? '' : 's'} matched)`
              : ''
            // Only show diagnosis toast when NOT the daily-quota case —
            // that case has its own specific toast above with longer
            // duration so the user sees it on return.
            if (!isDailyQuota) {
              toast.message(
                `Diagnosis ready — paste @.diagnose/latest.md into Claude Code${sigSuffix}.`,
                { duration: 10_000 },
              )
            }
          }
        })
        .catch(() => {
          // Bundle build is diagnostic; never surface its failure as a
          // toast that overshadows the original error.
        })
    },
    [actions, state.status, state.currentPhase, state.currentChunkIndex, state.totalChunks, state.chronicle, state.outputSelection]
    // writeCheckpoint accessed via writeCheckpointRef (forward-ref) so
    // it's NOT in deps — its identity is stable via the ref.
  )
  return handlePipelineError
}
