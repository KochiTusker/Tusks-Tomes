/** @vitest-environment jsdom */
//
// K.3.5 — safeSet quota event firing test.
//
// `safeSet` is the wrapper every client persistence call routes through.
// When `localStorage.setItem` throws QuotaExceededError, the wrapper must:
//
//   1. Return false (call site gets a failure signal).
//   2. Dispatch a CustomEvent of type STORAGE_QUOTA_EVENT with the
//      offending key + approximate bytes in detail.
//
// The UI listens for that event to surface a toast and offer
// "Download as JSON" so the user doesn't lose state.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { safeGet, safeRemove, safeSet, STORAGE_QUOTA_EVENT } from './storage'

describe('safeSet — quota event firing', () => {
  let originalSetItem: typeof Storage.prototype.setItem

  beforeEach(() => {
    originalSetItem = Storage.prototype.setItem
    localStorage.clear()
  })

  afterEach(() => {
    Storage.prototype.setItem = originalSetItem
    localStorage.clear()
  })

  it('returns true on a successful write', () => {
    expect(safeSet('test-key', { a: 1 })).toBe(true)
    expect(safeGet('test-key', null)).toEqual({ a: 1 })
  })

  it('returns false AND dispatches STORAGE_QUOTA_EVENT when setItem throws QuotaExceededError', () => {
    const quotaErr = new DOMException('Quota exceeded', 'QuotaExceededError')
    Storage.prototype.setItem = vi.fn(() => {
      throw quotaErr
    }) as typeof Storage.prototype.setItem

    const fired: CustomEvent[] = []
    const handler = (e: Event) => fired.push(e as CustomEvent)
    window.addEventListener(STORAGE_QUOTA_EVENT, handler)

    const result = safeSet('big-key', { payload: 'x'.repeat(10) })
    expect(result).toBe(false)
    expect(fired).toHaveLength(1)

    const detail = fired[0].detail as { key: string; bytes: number; error: unknown }
    expect(detail.key).toBe('big-key')
    expect(detail.bytes).toBeGreaterThan(0)
    // The error gets passed through verbatim so the listener can inspect it.
    expect(detail.error).toBe(quotaErr)

    window.removeEventListener(STORAGE_QUOTA_EVENT, handler)
  })

  it('bytes field reflects the approximate UTF-16 size (length × 2)', () => {
    Storage.prototype.setItem = vi.fn(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError')
    }) as typeof Storage.prototype.setItem

    const fired: CustomEvent[] = []
    const handler = (e: Event) => fired.push(e as CustomEvent)
    window.addEventListener(STORAGE_QUOTA_EVENT, handler)

    const value = 'a'.repeat(100)
    const expectedJsonLength = JSON.stringify(value).length // includes quotes
    safeSet('test', value)

    const detail = fired[0].detail as { bytes: number }
    expect(detail.bytes).toBe(expectedJsonLength * 2)

    window.removeEventListener(STORAGE_QUOTA_EVENT, handler)
  })

  it('returns false WITHOUT dispatching STORAGE_QUOTA_EVENT when serialization fails (not a quota issue)', () => {
    // A value that JSON.stringify can't serialize (circular reference).
    const circular: { self?: unknown } = {}
    circular.self = circular

    const fired: Event[] = []
    const handler = (e: Event) => fired.push(e)
    window.addEventListener(STORAGE_QUOTA_EVENT, handler)

    const result = safeSet('circular-key', circular)
    expect(result).toBe(false)
    // No quota event — the failure was at the JSON.stringify layer.
    expect(fired).toHaveLength(0)

    window.removeEventListener(STORAGE_QUOTA_EVENT, handler)
  })

  it('event detail is reachable via CustomEvent.detail on a real DOM event listener', () => {
    Storage.prototype.setItem = vi.fn(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError')
    }) as typeof Storage.prototype.setItem

    let receivedKey = ''
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { key: string }
      receivedKey = detail.key
    }
    window.addEventListener(STORAGE_QUOTA_EVENT, handler)

    safeSet('a-specific-key', 'value')
    expect(receivedKey).toBe('a-specific-key')

    window.removeEventListener(STORAGE_QUOTA_EVENT, handler)
  })

  it('safeGet returns the fallback when the key is absent', () => {
    expect(safeGet('does-not-exist', { fallback: true })).toEqual({ fallback: true })
  })

  it('safeGet returns the fallback when the stored value is malformed JSON', () => {
    localStorage.setItem('malformed', '{not json')
    expect(safeGet('malformed', 'default')).toBe('default')
  })

  it('safeRemove deletes the key', () => {
    safeSet('to-remove', 'value')
    safeRemove('to-remove')
    expect(localStorage.getItem('to-remove')).toBeNull()
  })

  it('safeRemove does not throw when the key is missing', () => {
    expect(() => safeRemove('never-set')).not.toThrow()
  })

  it('STORAGE_QUOTA_EVENT constant matches the documented name', () => {
    // Lock-down: the UI subscribes via this literal; renaming silently
    // would break the toast-on-quota flow.
    expect(STORAGE_QUOTA_EVENT).toBe('sbts:storage-quota')
  })
})

// v1.1.0 pre-flight WARNING event — fires BEFORE setItem so the UI can
// persist the payload to a server-side disk checkpoint before the next
// write actually triggers a quota exception. Closes the user-visible
// failure mode "long session + big KB + tab close mid-run → progress
// gone, no Resume banner."
describe('safeSet — STORAGE_QUOTA_WARNING_EVENT pre-flight', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('does NOT fire the warning when total usage is well below the threshold', async () => {
    const { STORAGE_QUOTA_WARNING_EVENT } = await import('./storage')
    const fired: Event[] = []
    const handler = (e: Event) => fired.push(e)
    window.addEventListener(STORAGE_QUOTA_WARNING_EVENT, handler)

    safeSet('small', { a: 1 })

    expect(fired).toHaveLength(0)
    window.removeEventListener(STORAGE_QUOTA_WARNING_EVENT, handler)
  })

  it('fires the warning when projected total usage crosses the 90% threshold', async () => {
    const { STORAGE_QUOTA_WARNING_EVENT, QUOTA_WARNING_THRESHOLD_BYTES } = await import('./storage')

    // Plant ~4.4 MB of existing content (under the 4.5 MB warning threshold)
    // so the new write tips us over.
    const padding = 'x'.repeat(2_400_000) // ~4.8 MB at 2 bytes/char — crosses the 4.5 MB warning threshold
    localStorage.setItem('padding', padding)

    const fired: CustomEvent[] = []
    const handler = (e: Event) => fired.push(e as CustomEvent)
    window.addEventListener(STORAGE_QUOTA_WARNING_EVENT, handler)

    // The new write itself is small; the warning fires because PROJECTED
    // total usage (existing padding + this) crosses the threshold.
    safeSet('triggering-write', { mid_run_state: 'progress' })

    expect(fired).toHaveLength(1)
    const detail = fired[0].detail as {
      key: string
      bytes: number
      projectedTotalBytes: number
      serialized: string
    }
    expect(detail.key).toBe('triggering-write')
    expect(detail.projectedTotalBytes).toBeGreaterThanOrEqual(QUOTA_WARNING_THRESHOLD_BYTES)
    expect(detail.serialized).toContain('mid_run_state')

    window.removeEventListener(STORAGE_QUOTA_WARNING_EVENT, handler)
  })

  it('warning detail includes the full serialized payload so the listener can persist it elsewhere', async () => {
    const { STORAGE_QUOTA_WARNING_EVENT } = await import('./storage')

    const padding = 'x'.repeat(2_400_000) // ~4.8 MB at 2 bytes/char
    localStorage.setItem('padding', padding)

    let receivedSerialized = ''
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { serialized: string }
      receivedSerialized = detail.serialized
    }
    window.addEventListener(STORAGE_QUOTA_WARNING_EVENT, handler)

    const payload = { uniqueMarker: 'PRESERVE_THIS_77', nested: { count: 12 } }
    safeSet('chunk_done_save', payload)

    // The listener got the exact bytes the caller tried to persist —
    // ready for forwarding to a server-side checkpoint.
    expect(JSON.parse(receivedSerialized)).toEqual(payload)

    window.removeEventListener(STORAGE_QUOTA_WARNING_EVENT, handler)
  })

  it('fires both WARNING and FAILURE events when setItem also throws', async () => {
    const { STORAGE_QUOTA_WARNING_EVENT } = await import('./storage')

    const padding = 'x'.repeat(2_400_000) // ~4.8 MB at 2 bytes/char
    localStorage.setItem('padding', padding)

    // Force the setItem AFTER the warning probe to throw.
    const realSetItem = Storage.prototype.setItem.bind(Storage.prototype)
    Storage.prototype.setItem = vi.fn((key: string, value: string) => {
      if (key === 'padding') {
        realSetItem(key, value)
        return
      }
      throw new DOMException('Quota exceeded', 'QuotaExceededError')
    }) as typeof Storage.prototype.setItem

    const warnings: Event[] = []
    const failures: Event[] = []
    window.addEventListener(STORAGE_QUOTA_WARNING_EVENT, (e) => warnings.push(e))
    window.addEventListener(STORAGE_QUOTA_EVENT, (e) => failures.push(e))

    const ok = safeSet('over-the-edge', { huge: 'x'.repeat(100) })

    expect(ok).toBe(false)
    expect(warnings).toHaveLength(1)
    expect(failures).toHaveLength(1)

    Storage.prototype.setItem = realSetItem as typeof Storage.prototype.setItem
  })

  it('failure-event detail now also includes the serialized payload (v1.1.0)', () => {
    Storage.prototype.setItem = vi.fn(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError')
    }) as typeof Storage.prototype.setItem

    const fired: CustomEvent[] = []
    window.addEventListener(STORAGE_QUOTA_EVENT, (e) => fired.push(e as CustomEvent))

    safeSet('failing-key', { recoverable: true })

    const detail = fired[0].detail as { serialized?: string }
    expect(detail.serialized).toBeDefined()
    expect(JSON.parse(detail.serialized!)).toEqual({ recoverable: true })
  })
})
