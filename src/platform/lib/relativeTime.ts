// Short relative timestamps for "when was this last checked" labels.

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Anything at or before this is a "no value" sentinel rather than a real time.
 *  Several stores write `new Date(0)` for "never", and 1970 would otherwise
 *  render as "56 years ago". */
const SENTINEL_CEILING_MS = Date.UTC(1971, 0, 1)

/** Age after which a model list is worth re-checking. */
export const STALE_AFTER_MS = 7 * DAY

function parse(iso: string | null | undefined): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t) || t <= SENTINEL_CEILING_MS) return null
  return t
}

/** "never", "just now", "5 min ago", "3 h ago", "1 day ago". Future times
 *  (clock skew) read as "just now". */
export function formatAgo(iso: string | null | undefined, now: number = Date.now()): string {
  const t = parse(iso)
  if (t === null) return 'never'
  const age = now - t
  if (age < MINUTE) return 'just now'
  if (age < HOUR) return `${Math.floor(age / MINUTE)} min ago`
  if (age < DAY) return `${Math.floor(age / HOUR)} h ago`
  const days = Math.floor(age / DAY)
  return `${days} ${days === 1 ? 'day' : 'days'} ago`
}

/** True when the time is older than `maxAgeMs`. A missing time is not "stale",
 *  it is "never" and is worded separately. */
export function isStale(
  iso: string | null | undefined,
  now: number = Date.now(),
  maxAgeMs: number = STALE_AFTER_MS,
): boolean {
  const t = parse(iso)
  return t !== null && now - t > maxAgeMs
}

/** Absolute local date and time for a tooltip, or '' when there is no value. */
export function formatAbsolute(iso: string | null | undefined): string {
  const t = parse(iso)
  return t === null ? '' : new Date(t).toLocaleString()
}
