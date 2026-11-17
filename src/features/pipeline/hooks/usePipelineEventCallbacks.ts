import { useMemo, type Dispatch, type SetStateAction } from 'react'
import { toast } from 'sonner'
import { vlog } from '@/features/maintenance'
import type { PipelineEvent } from '@/features/pipeline/lib/pipeline'
import { showCleanupToast, showPreGroundToast } from '@/features/pipeline/lib/pipelineToasts'
import { genRefusalId, type FallbackRecord, type RefusalRecord } from '@/features/pipeline/lib/refusalDetection'
import type { QuotaKind } from '../components/RateLimitDialog'
import type { RetryState } from '../components/RetryBanner'
import type { RefinementActions } from './useRefinementState'

/** What the rate-limit dialog shows while it is open. */
export type RateLimitDialogState = {
  quotaKind: QuotaKind
  phaseLabel: string
  // Verbose-dialog payload — every field is best-effort, the dialog
  // gracefully degrades when any is missing.
  provider: 'gemini' | 'local' | 'claudeCode' | 'codex' | 'openrouter'
  activeTier: 'free' | 'paid' | 'auto'
  model: string
  keyFingerprint?: string
  requestsInLastMinute?: number
  rpmCap?: number
  tpmCap?: number
  permanentlyOnFallback: boolean
}

/** The run's event handler: every PipelineEvent goes to the verbose log and
 *  becomes the state change, banner or toast the Chronicle tab shows. */
export function usePipelineEventCallbacks({
  actions,
  setRetryState,
  setRateLimitDialog,
  setFallbacks,
}: {
  actions: RefinementActions
  setRetryState: Dispatch<SetStateAction<RetryState | null>>
  setRateLimitDialog: Dispatch<SetStateAction<RateLimitDialogState | null>>
  setFallbacks: Dispatch<SetStateAction<FallbackRecord[]>>
}) {
  const callbacks = useMemo(
    () => ({
      onEvent: (e: PipelineEvent) => {
        // Mirror every PipelineEvent into the verbose ring buffer so
        // window.__tusk.dumpRecentEvents() shows the full event timeline
        // even when no diagnostic toast fired. Cheap when verbose is off
        // (just a push to the bounded ring).
        vlog('pipeline', e)
        switch (e.type) {
          case 'phase_start':
            // Forward the optional resumed startChunkIndex so the UI
            // counter primes correctly instead of briefly showing
            // "chunk 1/N" while the loop is actually working on chunk N.
            actions.startPhase(e.phase, e.totalChunks, e.startChunkIndex ?? 0)
            break
          case 'chunk_done':
            actions.onChunkDone(e.index, e.partial)
            // A successful chunk means any pending retry resolved — drop
            // the banner so it doesn't linger past its useful life.
            setRetryState(null)
            break
          case 'countdown':
            actions.onCountdown(e.msRemaining)
            break
          case 'retry_waiting':
            // Provider hit a transient error and is pausing. Show the
            // countdown banner so the UI doesn't look hung.
            setRetryState({
              phase: e.phase,
              attempt: e.attempt,
              maxAttempts: e.maxAttempts,
              resumeAt: Date.now() + e.waitMs,
            })
            break
          case 'phase_complete':
            // handled by per-phase completion in runAll
            break
          case 'cleanup':
            showCleanupToast(e.report)
            break
          case 'pre_ground':
            showPreGroundToast(e.report)
            break
          case 'quota_exhausted':
            // Surface the dialog. The chunk loop continues retrying
            // internally; the user's choice either lets it keep going
            // (slow down / fallback) or aborts (stop / pause).
            // Carries the verbose payload (key fingerprint, recent-call
            // count, RPM/TPM caps, permanent-fallback flag) so the dialog
            // can produce specific advice instead of a generic message.
            setRateLimitDialog({
              quotaKind: e.quotaKind,
              phaseLabel: `${e.phase.replace('_', ' ')} — ${e.provider} ${e.tier}`,
              provider: e.provider,
              activeTier: e.tier,
              model: e.model,
              keyFingerprint: e.keyFingerprint,
              requestsInLastMinute: e.requestsInLastMinute,
              rpmCap: e.rpmCap,
              tpmCap: e.tpmCap,
              permanentlyOnFallback: e.permanentlyOnFallback ?? false,
            })
            break
          case 'auto_fallback':
            if (e.reason === 'claude_refusal') {
              // Claude Code refused/blanked a chunk. Always surface it in the
              // post-run review modal; ALSO persist a repairable RefusalRecord
              // when it was NOT auto-repaired in-run.
              setFallbacks((prev) => [
                ...prev,
                {
                  phase: e.phase,
                  chunkIndex: e.chunkIndex ?? 0,
                  transcriptExcerpt: e.transcriptExcerpt ?? '',
                  refusedText: e.refusedText ?? '',
                  replacementText: e.replacementText ?? '',
                },
              ])
              if (e.repaired) {
                toast.warning(
                  `Claude Code looked like it refused chunk ${(e.chunkIndex ?? 0) + 1} — ` +
                    `the failsafe redid it on Gemini. Review & ground it from the chronicle when the run finishes.`,
                )
              } else {
                // Unrepaired: marked in the document + recorded for targeted
                // repair. Persist via a ref-backed accumulator (avoids the
                // stale-closure race when multiple refusals fire in a row).
                const rec: RefusalRecord = {
                  id: e.refusalId ?? genRefusalId(),
                  phase: e.phase,
                  chunkIndex: e.chunkIndex ?? 0,
                  totalChunks: e.totalChunks ?? 0,
                  sourceSpan: e.transcriptExcerpt ?? '',
                  refusedText: e.refusedText ?? '',
                  marker: e.marker ?? '',
                  chunkSizeChars: e.chunkSizeChars,
                  repaired: false,
                  createdAt: new Date().toISOString(),
                }
                actions.appendRefusal(rec)
                toast.warning(
                  `Claude Code refused chunk ${(e.chunkIndex ?? 0) + 1} and it wasn't auto-repaired — ` +
                    `marked it in the output. Use “Review & Repair Refusals” after the run to restore it.`,
                )
              }
              break
            }
            toast.info(
              e.reason === 'hard_zero_quota'
                ? 'Switched to the fallback Gemini key (zero quota on the primary).'
                : e.reason === 'repeated_exhaustion'
                  ? 'Switched to the fallback Gemini key after repeated rate-limiting.'
                  : e.reason === 'free_prohibited_content'
                    ? `Free Gemini blocked chunk ${(e.chunkIndex ?? 0) + 1} as PROHIBITED_CONTENT; retrying on the Paid key.`
                    : `Free Gemini ${e.model ?? ''} was overloaded on chunk ${(e.chunkIndex ?? 0) + 1}; recovered via the Paid key.`,
            )
            break
          case 'chunk_fusion_recovered':
            // Layer B fusion fallback rescued the chunk by joining it with
            // chunk i-1 to dilute the meta-filter trigger. No content was
            // lost — let the user know rather than have them wonder if
            // something silently soft-skipped.
            toast.success(
              `Chunk ${e.chunkIndex + 1} hit a content filter — recovered by ` +
                `merging with the previous chunk's context. No data lost.`,
            )
            break
          case 'audit_skipped':
            // Diagnostic toast — surfaces the Phase 2 optimisation when it
            // actually fires. The user sees "saved N calls" rather than
            // wondering why Phase 2 was fast.
            toast.info(
              `Phase 2 audit skipped ${e.skippedChunks}/${e.totalChunks} chunks ` +
                `(grounded text was identical to raw — no clarifications to ask).`,
            )
            break
          case 'speaker_dropout':
            // Phase 1's speaker-detach optimisation lost > 15% of markers.
            // Surface so the user can opt out of detach on the next run if
            // attribution quality suffered.
            toast.warning(
              `Speaker attribution: ${(e.dropoutRate * 100).toFixed(0)}% of ` +
                `${e.sourceLines} lines lost their bracket during grounding. ` +
                `Consider running again without the speaker-detach optimisation if ` +
                `the chronicle attributes dialogue incorrectly.`,
            )
            break
          case 'tier_escalated':
            // The pipeline auto-escalated a Free-tier dispatch to Paid for
            // a paid-only model. Surface so the user understands why their
            // Free-tier run is touching Paid budget for this phase.
            toast.info(
              `${e.phase.replace('_', ' ')}: model "${e.model}" requires the Paid tier — ` +
                `this phase will dispatch to the Paid Gemini singleton for its chunks.`,
            )
            break
        }
      },
    }),
    [actions]
  )
  return callbacks
}
