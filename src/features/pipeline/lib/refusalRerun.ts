// The mechanics every "run this chunk again somewhere else" path shares: the
// in-run repair of a chunk the Claude Code CLI refused, and the Gemini free to
// paid retry after a blocked or failing chunk. What differs between them (which
// provider, the model, the label, what gets logged, what happens to the result)
// stays at the call site; only the steps they have in common live here.

import { computePacingDelay } from '@/features/providers'
import { sleepWithCountdown } from './countdown'
import { vlog } from '@/features/maintenance'
import type { GenerateRequest, GenerateResponse, LLMProvider, ProviderEvent } from '@/features/providers'
import type { PipelineEvent } from './pipelineEvents'
import type { PhaseId } from '@/features/pipeline/lib/types'

/** The parts of a chunked run a re-run needs: pacing and the provider hooks. */
export interface RerunContext {
  signal?: AbortSignal
  onCountdown?: (msRemaining: number) => void
  safetyMultiplier?: number | (() => number)
  onProviderEvent?: (event: ProviderEvent) => void
  onRetry?: (attempt: number, waitMs: number) => void
}

/**
 * Wait out `provider`'s own rate-limit pacing for `req` before calling it, so
 * a re-run honours the limits of the provider it moves to rather than the one
 * it left. Returns the delay that applied, 0 when none did.
 */
export async function paceBeforeRerun(
  ctx: RerunContext,
  provider: LLMProvider,
  req: GenerateRequest,
): Promise<number> {
  const delay = computePacingDelay({ req, provider, safetyMultiplier: ctx.safetyMultiplier })
  if (delay > 0) await sleepWithCountdown(delay, ctx.signal, ctx.onCountdown)
  return delay
}

/** One call on the re-run provider, carrying the run's abort signal and progress hooks. */
export function rerunOnProvider(
  ctx: RerunContext,
  provider: LLMProvider,
  req: GenerateRequest,
  contextLabel: string,
): Promise<GenerateResponse> {
  return provider.generate(req, {
    signal: ctx.signal,
    contextLabel,
    onProviderEvent: ctx.onProviderEvent,
    onRetry: ctx.onRetry,
  })
}

/**
 * Tell the UI a Gemini chunk is moving from the free key to the paid one. A
 * listener that throws must not take the run down with it, so the failure goes
 * to the diagnose ring (and the console) instead.
 */
export function announceTierFallback(
  onPipelineEvent: ((event: PipelineEvent) => void) | undefined,
  event: {
    phase: PhaseId
    reason: 'free_transient_5xx' | 'free_prohibited_content'
    chunkIndex: number
    model: string
  },
  failure: { site: string; warning: string },
): void {
  try {
    onPipelineEvent?.({
      type: 'auto_fallback',
      phase: event.phase,
      provider: 'gemini',
      reason: event.reason,
      chunkIndex: event.chunkIndex,
      model: event.model,
    })
  } catch (listenerErr) {
    vlog('pipeline', {
      type: 'listener_failed',
      site: failure.site,
      phase: event.phase,
      chunkIndex: event.chunkIndex,
      error: (listenerErr as Error).message ?? String(listenerErr),
    })
    console.warn(failure.warning, listenerErr)
  }
}
