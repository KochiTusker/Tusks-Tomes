// Quota-safe localStorage helpers. On QuotaExceededError, fire a
// CustomEvent so the UI can surface a toast + offer download-as-JSON.
//
// v1.1.0 — adds a pre-flight WARNING that fires BEFORE attempting the
// write when projected total localStorage usage would push past 90% of
// a typical 5 MB browser quota. The UI listens and can pre-emptively
// write a server-side disk checkpoint so the user's mid-run progress
// survives even if the next setItem call fails. Both warning + failure
// events include the serialized payload so the listener can persist it
// elsewhere without re-fetching from state.

export const STORAGE_QUOTA_EVENT = 'sbts:storage-quota'
export const STORAGE_QUOTA_WARNING_EVENT = 'sbts:storage-quota-warning'

/** Approximate browser localStorage quota (5 MB is typical for Chrome /
 *  Firefox / Safari desktop). The warning threshold is 90% of this so
 *  the UI has time to pre-emptively persist before the actual quota
 *  exception fires on the next write. */
export const QUOTA_TOTAL_BYTES = 5 * 1024 * 1024
export const QUOTA_WARNING_THRESHOLD_BYTES = Math.round(QUOTA_TOTAL_BYTES * 0.9)

export type QuotaWarningDetail = {
  key: string
  /** Approximate size of the value about to be written, in bytes. */
  bytes: number
  /** Approximate total localStorage usage AFTER this write, in bytes. */
  projectedTotalBytes: number
  /** The serialized payload — supplied so the listener can fall back to
   *  a disk-side write (server checkpoint) without re-fetching state. */
  serialized: string
}

export type QuotaErrorDetail = {
  key: string
  bytes: number
  error: unknown
  /** v1.1.0 — same serialized payload as the warning event so the
   *  listener has a recovery target. */
  serialized?: string
}

function approximateSize(value: string): number {
  // UTF-16 in localStorage: 2 bytes per code unit (close enough for warnings).
  return value.length * 2
}

/** Walk localStorage and sum approximate UTF-16 bytes across every key.
 *  Cheap on small KB / configs; bounded by the quota itself so the worst
 *  case is ~5 MB of walking. Called once per safeSet — acceptable
 *  overhead for the warning's value. */
function estimateTotalUsageBytes(): number {
  let total = 0
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k) continue
      const v = localStorage.getItem(k) ?? ''
      total += approximateSize(k) + approximateSize(v)
    }
  } catch {
    // localStorage access could throw in some edge environments (private
    // mode, ITP). Returning 0 means we won't fire the warning but the
    // subsequent setItem will fail and the existing QUOTA_EVENT path
    // still surfaces the issue.
    return 0
  }
  return total
}

export function safeGet<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function safeSet(key: string, value: unknown): boolean {
  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch (err) {
    console.error(`[storage] Failed to serialize value for key "${key}":`, err)
    return false
  }
  const newBytes = approximateSize(serialized)

  // Pre-flight quota check. Estimate total usage AFTER this write — if
  // we're inside the warning band, fire the warning event with the
  // serialized payload so the UI can pre-emptively persist to disk.
  if (typeof window !== 'undefined') {
    try {
      const existingBytes = approximateSize(localStorage.getItem(key) ?? '')
      const projectedTotal = estimateTotalUsageBytes() - existingBytes + newBytes
      if (projectedTotal >= QUOTA_WARNING_THRESHOLD_BYTES) {
        const warningDetail: QuotaWarningDetail = {
          key,
          bytes: newBytes,
          projectedTotalBytes: projectedTotal,
          serialized,
        }
        window.dispatchEvent(new CustomEvent(STORAGE_QUOTA_WARNING_EVENT, { detail: warningDetail }))
      }
    } catch {
      // Warning is best-effort; never block the underlying setItem on it.
    }
  }

  try {
    localStorage.setItem(key, serialized)
    return true
  } catch (err) {
    const detail: QuotaErrorDetail = {
      key,
      bytes: newBytes,
      error: err,
      serialized,
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(STORAGE_QUOTA_EVENT, { detail }))
    }
    console.error(`[storage] Quota exceeded saving "${key}" (~${detail.bytes} bytes)`, err)
    return false
  }
}

export function safeRemove(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch (err) {
    console.error(`[storage] Failed to remove "${key}":`, err)
  }
}

export function dumpAllAsJson(): string {
  const out: Record<string, unknown> = {}
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (!k) continue
    try {
      out[k] = JSON.parse(localStorage.getItem(k) ?? 'null')
    } catch {
      out[k] = localStorage.getItem(k)
    }
  }
  return JSON.stringify(out, null, 2)
}
