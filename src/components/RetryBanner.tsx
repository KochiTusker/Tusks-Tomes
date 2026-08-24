// Non-blocking banner shown while a pipeline phase is sleeping between
// retry attempts. The provider has hit a transient error (503 model
// demand spike, network blip, rate-limit) and is pausing for `waitMs`
// before its next attempt. Without this banner the UI would look hung;
// with it the user sees a live countdown and knows the run is alive.
//
// State is set by RefinementTool's PipelineEvent handler on
// `retry_waiting`, and cleared on the next `chunk_done` for the same
// phase (success) or on an unhandled pipeline error (retry exhausted).

import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { PhaseId } from '@/types'

export type RetryState = {
  phase: PhaseId
  attempt: number
  maxAttempts: number
  /** Wall-clock millisecond timestamp when the retry will resume.
   *  Computed once from `Date.now() + waitMs` so the countdown stays
   *  accurate even if React skips a tick under load. */
  resumeAt: number
}

function phaseLabel(phase: PhaseId): string {
  switch (phase) {
    case 'phase1_ground':
      return 'Grounding'
    case 'phase2_audit':
      return 'Audit'
    case 'phase3_chronicle':
      return 'Chronicle'
    case 'phase4_extras':
      return 'Extras'
    case 'phase5_polish':
      return 'Polish'
    case 'phase6_condense':
      return 'Condense'
    default:
      return phase
  }
}

export function RetryBanner({ state }: { state: RetryState }) {
  const [secondsLeft, setSecondsLeft] = useState(
    Math.max(0, Math.ceil((state.resumeAt - Date.now()) / 1000)),
  )

  useEffect(() => {
    // Re-key the countdown when a new retry starts (resumeAt changes).
    setSecondsLeft(Math.max(0, Math.ceil((state.resumeAt - Date.now()) / 1000)))
    const id = setInterval(() => {
      const remainingMs = state.resumeAt - Date.now()
      setSecondsLeft(Math.max(0, Math.ceil(remainingMs / 1000)))
      if (remainingMs <= 0) clearInterval(id)
    }, 500)
    return () => clearInterval(id)
  }, [state.resumeAt])

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200"
    >
      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
      <span>
        <strong>{phaseLabel(state.phase)}</strong> hit a transient error.
        Retrying in <strong>{secondsLeft}s</strong> (attempt {state.attempt}/
        {state.maxAttempts}). The pipeline is not hung — Gemini, Claude, and
        OpenAI all return 5xx / rate-limit responses occasionally and the
        provider waits a few seconds before trying again.
      </span>
    </div>
  )
}
