// A one-second tick that knows how far the server's clock is from ours.
//
// The live-transcription endpoint stamps every response with the server's
// idea of "now" alongside the timestamps it reports. On a single machine
// the two clocks agree; on a LAN install they can differ by minutes, and
// "last update 4 minutes ago" computed against the wrong clock would show
// a healthy run as stalled (or hide a stalled one). So the component
// records when each response landed, and every "how long ago" goes
// through this hook's offset rather than through Date.now() directly.

import { useEffect, useState } from 'react'
import { clockOffsetMs } from '@/features/transcription/lib/transcriptionLiveness'

export type ServerClockSample = {
  serverNow?: number | null
  /** Client clock when the response carrying `serverNow` arrived. */
  receivedAt: number
}

export type ServerClock = {
  /** Client clock, refreshed every `tickMs` while `ticking`. */
  now: number
  /** Client clock minus server clock; add to a server timestamp to place it on ours. */
  offset: number
  /** Milliseconds since a server-clock timestamp; null when there is no timestamp. */
  sinceMs: (serverTs: number | null | undefined) => number | null
}

export function useServerClock(
  sample: ServerClockSample | null,
  ticking: boolean,
  tickMs = 1000,
): ServerClock {
  const [now, setNow] = useState<number>(() => Date.now())

  useEffect(() => {
    if (!ticking) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), tickMs)
    return () => clearInterval(id)
  }, [ticking, tickMs])

  const offset = sample ? clockOffsetMs(sample.serverNow, sample.receivedAt) : 0

  return {
    now,
    offset,
    sinceMs: (serverTs) => {
      if (typeof serverTs !== 'number' || !Number.isFinite(serverTs)) return null
      return Math.max(0, now - (serverTs + offset))
    },
  }
}
