// Waits `ms`, optionally reporting the time remaining once a second so a
// pacing delay can show a countdown. Rejects with an AbortError when the
// signal fires.
export function sleepWithCountdown(
  ms: number,
  signal?: AbortSignal,
  onTick?: (remaining: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'))
    const start = Date.now()
    let interval: ReturnType<typeof setInterval> | null = null
    const cleanup = () => {
      if (interval) clearInterval(interval)
      signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = () => {
      cleanup()
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    if (onTick) {
      onTick(ms)
      interval = setInterval(() => {
        const remaining = Math.max(0, ms - (Date.now() - start))
        onTick(remaining)
        if (remaining <= 0 && interval) {
          clearInterval(interval)
          interval = null
        }
      }, 1000)
    }
    setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
  })
}
