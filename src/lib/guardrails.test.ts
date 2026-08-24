// Tests run under the node env. Provide a minimal localStorage shim so
// getGuardrails / setGuardrails can round-trip without pulling in jsdom.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

class MemoryStorage {
  private store = new Map<string, string>()
  getItem(k: string): string | null { return this.store.has(k) ? this.store.get(k)! : null }
  setItem(k: string, v: string): void { this.store.set(k, v) }
  removeItem(k: string): void { this.store.delete(k) }
  clear(): void { this.store.clear() }
  get length(): number { return this.store.size }
  key(i: number): string | null { return Array.from(this.store.keys())[i] ?? null }
}

;(globalThis as unknown as { localStorage: Storage }).localStorage = new MemoryStorage() as unknown as Storage

import {
  DEFAULT_GUARDRAILS,
  GUARDRAIL_KEYS,
  countActiveGuardrails,
  getGuardrails,
  setGuardrails,
} from './guardrails'

const LS_KEY = 'guardrails_settings'

describe('guardrails settings', () => {
  beforeEach(() => {
    localStorage.clear()
  })
  afterEach(() => {
    localStorage.clear()
  })

  it('defaults to all OFF when no value is stored', () => {
    const g = getGuardrails()
    for (const k of GUARDRAIL_KEYS) {
      expect(g[k]).toBe(false)
    }
    expect(countActiveGuardrails(g)).toBe(0)
  })

  it('round-trips through setGuardrails / getGuardrails', () => {
    setGuardrails({ ...DEFAULT_GUARDRAILS, harassment: true, strictFraming: true })
    const g = getGuardrails()
    expect(g.harassment).toBe(true)
    expect(g.strictFraming).toBe(true)
    expect(g.hateSpeech).toBe(false)
    expect(countActiveGuardrails(g)).toBe(2)
  })

  it('falls back to defaults on corrupt localStorage', () => {
    localStorage.setItem(LS_KEY, '{not valid json')
    const g = getGuardrails()
    expect(g).toEqual(DEFAULT_GUARDRAILS)
  })

  it('coerces unknown values to false (defensive)', () => {
    localStorage.setItem(LS_KEY, JSON.stringify({ harassment: 'yes', hateSpeech: 1, sexuallyExplicit: null }))
    const g = getGuardrails()
    expect(g.harassment).toBe(false)
    expect(g.hateSpeech).toBe(false)
    expect(g.sexuallyExplicit).toBe(false)
  })
})
