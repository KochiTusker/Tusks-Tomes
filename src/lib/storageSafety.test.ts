/** @vitest-environment jsdom */
// Every persisted setting must share one failure mode: on a full store,
// the quota event fires (toast + backup offer) instead of a silent drop.
// Four modules used to write localStorage directly and lost that; these
// tests pin both halves of the fix — the event now fires, AND the on-disk
// format is unchanged, so values written before the change still read.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STORAGE_QUOTA_EVENT, safeSetRaw } from './storage'
import { getGuardrails, setGuardrails, DEFAULT_GUARDRAILS } from './guardrails'
import { getFailsafeTarget, setFailsafeTarget, FAILSAFE_TARGETS } from './claudeFailsafe'

function quotaError(): DOMException {
  return new DOMException('quota', 'QuotaExceededError')
}

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('quota failures surface the event', () => {
  let fired: string[]

  beforeEach(() => {
    fired = []
    window.addEventListener(STORAGE_QUOTA_EVENT, ((e: Event) => {
      fired.push((e as CustomEvent<{ key: string }>).detail.key)
    }) as EventListener)
  })

  it('safeSetRaw fires the quota event on a full store', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw quotaError()
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(safeSetRaw('some_flag', '1')).toBe(false)
    expect(fired).toContain('some_flag')
  })

  it('guardrails writes fire the quota event instead of silently dropping', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw quotaError()
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    setGuardrails({ ...DEFAULT_GUARDRAILS })
    expect(fired.length).toBeGreaterThan(0)
  })

  it('failsafe target writes fire the quota event', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw quotaError()
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    setFailsafeTarget(FAILSAFE_TARGETS[0].modelId)
    expect(fired.length).toBeGreaterThan(0)
  })
})

describe('on-disk formats are unchanged — old values still read', () => {
  it('guardrails written before the change (plain JSON) still read', () => {
    localStorage.setItem(
      'guardrails_settings',
      JSON.stringify({ ...DEFAULT_GUARDRAILS, harassment: false }),
    )
    expect(getGuardrails().harassment).toBe(false)
  })

  it('a raw (non-JSON) failsafe model id written before the change still reads', () => {
    const id = FAILSAFE_TARGETS[0].modelId
    // The old writer stored the BARE string, not JSON — no quotes.
    localStorage.setItem('claude_failsafe_model', id)
    expect(getFailsafeTarget().modelId).toBe(id)
  })

  it('round-trip: the new failsafe writer produces what the reader expects', () => {
    setFailsafeTarget(FAILSAFE_TARGETS[0].modelId)
    expect(localStorage.getItem('claude_failsafe_model')).toBe(FAILSAFE_TARGETS[0].modelId)
    expect(getFailsafeTarget().modelId).toBe(FAILSAFE_TARGETS[0].modelId)
  })
})
