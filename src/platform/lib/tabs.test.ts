// Every tab value that has EVER been dispatchable must still land
// somewhere sensible — the merge must not strand a dispatcher.

import { describe, expect, it } from 'vitest'
import { resolveTabValue, TAB_VALUES } from './tabs'

describe('resolveTabValue', () => {
  it('passes every current tab through unchanged', () => {
    for (const t of TAB_VALUES) {
      expect(resolveTabValue(t)).toBe(t)
    }
  })

  it('maps every retired tab to its new home', () => {
    expect(resolveTabValue('upload')).toBe('sessions')
    expect(resolveTabValue('about')).toBe('help')
    expect(resolveTabValue('captions')).toBe('refinement')
  })

  it('lands unknown values on Chronicle rather than a dead tab', () => {
    expect(resolveTabValue('nonsense')).toBe('refinement')
    expect(resolveTabValue('')).toBe('refinement')
  })
})
