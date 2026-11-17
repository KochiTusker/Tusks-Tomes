// What a pipeline run reports to the UI, and the adapters that turn a
// provider's retry and quota callbacks into those events.
import type { ProviderEvent, ProviderName } from '@/features/providers'
import { vlog } from '@/features/maintenance'
import type { PreGroundReport } from '@/features/corrections'
import type { CleanupReport } from './transcriptCleanup'
import type { PhaseId } from '@/features/pipeline/lib/types'

export type PipelineEvent =
  | {
      type: 'phase_start'
      phase: PhaseId
      totalChunks: number
      /** When the phase is resumed from a checkpoint, this is the
       *  absolute chunk index the loop is about to start at (matches
       *  the checkpoint's progress.chunkIndex). The UI primes its
       *  counter from this so the user doesn't briefly see "0 / N"
       *  before the resumed chunk completes. Omitted for fresh runs;
       *  the UI treats absence as 0. */
      startChunkIndex?: number
      /** The chunk size this phase split its source with, where it accepts a
       *  resume. A resume must pass it back as `chunkSizeChars` so the source
       *  is cut at the same boundaries — the default size follows the model
       *  and settings, which may not be what they were. */
      chunkSizeChars?: number
    }
  | { type: 'chunk_done'; phase: PhaseId; index: number; totalChunks: number; partial: string }
  | { type: 'countdown'; phase: PhaseId; msRemaining: number }
  | { type: 'phase_complete'; phase: PhaseId }
  | { type: 'pre_ground'; report: PreGroundReport }
  | { type: 'cleanup'; report: CleanupReport }
  | {
      type: 'quota_exhausted'
      phase: PhaseId
      provider: ProviderName
      quotaKind: 'rate_limit' | 'daily_quota'
      tier: 'free' | 'paid' | 'auto'
      model: string
      /** Short SHA-256 prefix of the active key (matches Settings → API Keys
       *  → Probe). Optional — async-computed at provider construction. */
      keyFingerprint?: string
      /** Approximate count of requests sent in the last 60s, from the
       *  provider's in-memory call history. */
      requestsInLastMinute?: number
      /** Provider's published per-minute cap for (tier, model). */
      rpmCap?: number
      /** Provider's published per-minute input-token cap for (tier, model). */
      tpmCap?: number
      /** True when an auto-tier singleton has already swapped to its
       *  fallback key in this run. The dialog uses this to disable
       *  "Switch to paid" — Paid is already exhausted, so swapping back is
       *  a no-op until refreshProviders() rebuilds the singleton. */
      permanentlyOnFallback?: boolean
    }
  | {
      type: 'auto_fallback'
      phase: PhaseId
      provider: ProviderName
      reason:
        | 'hard_zero_quota'
        | 'repeated_exhaustion'
        | 'free_transient_5xx'
        | 'free_prohibited_content'
        // Claude Code chunk looked like a refusal/empty; the explicit-content
        // failsafe redid it on Gemini (permissive). Fired AFTER the redo so it
        // can carry the texts for the post-run review modal.
        | 'claude_refusal'
      /** claude_refusal only — the grounded transcript span that was refused
       *  (the "what was said"), so the review modal can show the source. */
      transcriptExcerpt?: string
      /** claude_refusal only — what Claude returned (the refusal/blank). */
      refusedText?: string
      /** claude_refusal only — what Gemini wrote in (now in the output, and
       *  the exact string the review modal find-replaces when you edit it).
       *  Empty when the refusal was NOT repaired in-run. */
      replacementText?: string
      /** claude_refusal only — false when the in-run Gemini restore did not
       *  run / failed. Drives whether a persistent RefusalRecord is recorded
       *  and whether a marker was injected into the output. */
      repaired?: boolean
      /** claude_refusal + unrepaired — stable id, also embedded in the prose
       *  marker tag; links the event to the persisted RefusalRecord. */
      refusalId?: string
      /** claude_refusal + unrepaired — total chunks in the phase, so a later
       *  repair can rebuild the per-chunk prompt ("chunk i of N"). */
      totalChunks?: number
      /** claude_refusal + unrepaired — the EXACT sentinel injected into the
       *  prose output (Phase 3) as the splice anchor. Empty for Phase 1/2/4
       *  (no inline marker). */
      marker?: string
      /** claude_refusal + unrepaired — chunk-size target used to split this
       *  phase, so a repair can re-derive sibling spans deterministically. */
      chunkSizeChars?: number
      /** Set for chunk-level fallbacks (free_transient_5xx, free_prohibited_content):
       *  the chunk index that recovered via the Paid singleton, so the
       *  diagnostic stream can pinpoint exactly where the Free key failed. */
      chunkIndex?: number
      /** Set for chunk-level fallbacks: the model id reissued via Paid. */
      model?: string
    }
  | {
      /** Layer B chunk-fusion recovery succeeded — a PROHIBITED_CONTENT
       *  block on chunk i was rescued by re-issuing with chunk[i-1] joined
       *  in to dilute the trigger below the meta-filter's concentration
       *  threshold. Fires AFTER the original call and any Free→Paid
       *  escalation both failed; lets the UI toast "Chunk N rescued via
       *  fusion (lost no content)". */
      type: 'chunk_fusion_recovered'
      phase: PhaseId
      chunkIndex: number
      model?: string
    }
  // The pipeline auto-escalated a Free-tier dispatch to Paid because the
  // chunk's model is paid-only. Surfaced to the UI as a toast so the user
  // understands WHY their Free-tier run is touching Paid quota. Today only
  // fires for Gemini (the only provider with a Free/Paid distinction in
  // this codebase).
  | {
      type: 'tier_escalated'
      phase: PhaseId
      model: string
      fromTier: 'free'
      toTier: 'paid'
      reason: 'paid_only_model_on_free_tier'
    }
  // A chunk hit a retryable error (transient 5xx, network, or rate-limit) and
  // the provider is pausing before its next attempt. The UI shows a live
  // countdown so the user knows the pipeline isn't hung. Fires once at the
  // start of each wait — UI runs its own setInterval to tick down to zero.
  // The UI dismisses the banner on the next `chunk_done` for the same phase
  // (success) or on an unhandled pipeline error (retry exhausted).
  | {
      type: 'retry_waiting'
      phase: PhaseId
      attempt: number
      maxAttempts: number
      waitMs: number
    }
  // Phase 1's speaker-detach optimization re-attached brackets to the
  // grounded output and noticed the model dropped > 15% of markers.
  // Emit so the UI can warn the user and offer a one-click opt-out
  // for the next run.
  | {
      type: 'speaker_dropout'
      phase: PhaseId
      /** Fraction in [0, 1]. UI displays as a percentage. */
      dropoutRate: number
      /** Total source lines that had a speaker bracket — the denominator
       *  of dropoutRate. Useful for the toast copy: "11 of 250 lines lost
       *  their speaker attribution." */
      sourceLines: number
    }
  // Phase 2 audit skipped a chunk because Phase 1 produced grounded text
  // byte-identical to the raw input. UI can surface "saved N API calls"
  // diagnostic so the user sees the optimisation working.
  | {
      type: 'audit_skipped'
      phase: PhaseId
      skippedChunks: number
      totalChunks: number
    }

export type PipelineCallbacks = {
  onEvent: (e: PipelineEvent) => void
  signal?: AbortSignal
}

/** Translate provider-level `onRetry` callbacks into a `retry_waiting`
 *  PipelineEvent so the UI can show a non-blocking countdown banner. The
 *  provider invokes this once per retry, before sleeping for `waitMs`. */
export function retryWaitingForwarder(
  phase: PhaseId,
  callbacks: PipelineCallbacks,
): (attempt: number, waitMs: number) => void {
  return (attempt, waitMs) => {
    vlog('pipeline', { event: 'retry_waiting', phase, attempt, waitMs })
    callbacks.onEvent({
      type: 'retry_waiting',
      phase,
      attempt,
      // MAX_RETRIES is the provider-level constant; mirrored here to keep
      // the UI honest about how many more attempts are left. If a future
      // provider uses a different cap, this would need plumbing — for now
      // every cloud provider shares MAX_RETRIES = 4 from src/lib/constants.
      maxAttempts: 4,
      waitMs,
    })
  }
}

/** Translate provider-level events into pipeline events tagged with the
 *  active phase. Used by every runPhaseN's chunkedGenerate call. */
export function providerEventForwarder(
  phase: PhaseId,
  callbacks: PipelineCallbacks,
): (event: ProviderEvent) => void {
  return (event) => {
    vlog('provider', { phase, event })
    if (event.kind === 'quota_exhausted') {
      callbacks.onEvent({
        type: 'quota_exhausted',
        phase,
        provider: event.provider,
        quotaKind: event.quotaKind,
        tier: event.tier,
        model: event.model,
        keyFingerprint: event.keyFingerprint,
        requestsInLastMinute: event.requestsInLastMinute,
        rpmCap: event.rpmCap,
        tpmCap: event.tpmCap,
        permanentlyOnFallback: event.permanentlyOnFallback,
      })
    } else if (event.kind === 'auto_fallback') {
      callbacks.onEvent({
        type: 'auto_fallback',
        phase,
        provider: event.provider,
        reason: event.reason,
      })
    }
  }
}
