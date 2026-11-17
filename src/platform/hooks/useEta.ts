import { useEffect, useRef, useState } from 'react'

type UseEtaArgs = {
  /** 0-based count of completed chunks in the current phase. */
  currentIndex: number
  /** Total chunks for the current phase. */
  totalChunks: number
  /** Stable identifier for the current phase. Changing this resets the timer. */
  phaseKey: string
  /** When false, the hook stops ticking and returns null ETA. */
  active: boolean
}

type UseEtaResult = {
  /** Estimated milliseconds remaining in this phase. Null when not yet computable. */
  etaMs: number | null
  /** 0–100. */
  percent: number
  /** Milliseconds elapsed since this phase started in this session. */
  elapsedMs: number
}

/**
 * Estimates time-to-finish for the current phase by linear extrapolation from
 * observed elapsed time and progress fraction. Resets per phase. Survives a
 * page reload but loses the elapsed-time history (so the first chunk after a
 * reload mid-phase produces no ETA — it's recomputed fresh).
 */
export function useEta({ currentIndex, totalChunks, phaseKey, active }: UseEtaArgs): UseEtaResult {
  const startsRef = useRef<Map<string, number>>(new Map())
  const [now, setNow] = useState<number>(() => Date.now())

  // Record phase start time on first observation (idempotent).
  if (active && !startsRef.current.has(phaseKey)) {
    startsRef.current.set(phaseKey, Date.now())
  }

  // Tick every second so the displayed ETA counts down smoothly.
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [active])

  const percent = totalChunks > 0 ? Math.min(100, (currentIndex / totalChunks) * 100) : 0
  const start = startsRef.current.get(phaseKey)
  const elapsedMs = active && start ? now - start : 0

  if (!active || !start || currentIndex === 0 || totalChunks === 0) {
    return { etaMs: null, percent, elapsedMs }
  }

  const fractionDone = currentIndex / totalChunks
  const totalEstimated = elapsedMs / fractionDone
  const etaMs = Math.max(0, totalEstimated - elapsedMs)

  return { etaMs, percent, elapsedMs }
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return '< 1s'
  const totalSec = Math.ceil(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}
