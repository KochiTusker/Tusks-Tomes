// Mechanism shared by the cloud providers' retry loops.

/** Resolves after `ms`; rejects with an AbortError when `signal` fires first. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'))
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
  })
}

export interface WrapWithContextOptions {
  /**
   * Copy the original error's own diagnostic flags (for example
   * `isProhibitedContent`) onto the wrapped error, so a caller that inspects
   * them still sees them. Off by default: only a provider whose callers read
   * such flags turns it on.
   */
  carryFlags?: boolean
  /** Called for each flag that could not be copied (a non-configurable property). */
  onFlagSkipped?: (info: { key: string; baseErrorName: string; reason: string }) => void
}

/**
 * Prefix an error's message with `[contextLabel]` and keep the original as
 * `cause`. With no label the error is returned untouched.
 */
export function wrapWithContext(
  err: unknown,
  contextLabel?: string,
  options: WrapWithContextOptions = {},
): Error {
  const base = err instanceof Error ? err : new Error(String(err))
  if (!contextLabel) return base
  const wrapped = new Error(`[${contextLabel}]\n${base.message}`)
  ;(wrapped as Error & { cause?: unknown }).cause = base
  if (!options.carryFlags) return wrapped
  // Without this copy the pipeline's soft-skip path sees
  // `.isProhibitedContent === undefined` on the wrapped error and re-throws,
  // turning a recoverable safety block into a run-killing failure.
  for (const key of Object.getOwnPropertyNames(base)) {
    if (key === 'name' || key === 'message' || key === 'stack' || key === 'cause') continue
    try {
      ;(wrapped as unknown as Record<string, unknown>)[key] =
        (base as unknown as Record<string, unknown>)[key]
    } catch (assignErr) {
      options.onFlagSkipped?.({
        key,
        baseErrorName: base.name,
        reason: String((assignErr as Error)?.message ?? assignErr).slice(0, 120),
      })
    }
  }
  return wrapped
}
