import { describe, expect, it } from 'vitest'
import { sanitizeGeminiProfile } from './profileSanitizer'
import { type ProviderProfile } from './profiles'
import { type SlotAvailability } from './providerSettings'

function baseProfile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    phase1Model: 'gemini-2.5-pro',
    phase2Model: 'gemini-2.5-flash',
    phase3Model: 'gemini-2.5-pro',
    phase4Model: 'gemini-2.5-flash',
    ...overrides,
  }
}

function makeAvailability(probed: Array<{ id: string; accessible: boolean; reason?: string }>): SlotAvailability {
  return {
    fetchedAt: new Date().toISOString(),
    advertised: probed.map((p) => p.id),
    probed,
  }
}

describe('sanitizeGeminiProfile', () => {
  it('returns the input unchanged on paid tier', () => {
    const profile = baseProfile()
    const report = sanitizeGeminiProfile(profile, 'paid', undefined)
    expect(report.changed).toEqual([])
    expect(report.unfixable).toEqual([])
    expect(report.next).toBe(profile) // reference equality — no copy on no-op
  })

  it('rewrites paid-only ids on free tier using the heuristic when no probe data exists', () => {
    const profile = baseProfile()
    const report = sanitizeGeminiProfile(profile, 'free', undefined)
    // No probe data → no replacement candidate, so the changes go into `unfixable`.
    expect(report.changed).toEqual([])
    expect(report.unfixable.length).toBeGreaterThan(0)
    const phases = report.unfixable.map((u) => u.phase)
    expect(phases).toContain('phase1Model')
    expect(phases).toContain('phase3Model')
  })

  it('uses the probed-accessible set when picking replacements', () => {
    const profile = baseProfile()
    const avail = makeAvailability([
      { id: 'gemini-2.5-pro', accessible: false, reason: 'Free tier quota: 0' },
      { id: 'gemini-2.5-flash', accessible: true },
      { id: 'gemini-2.0-pro', accessible: true },
      { id: 'gemini-2.0-flash', accessible: true },
    ])
    const report = sanitizeGeminiProfile(profile, 'free', avail)

    // Phase 1 + 3 (gemini-2.5-pro) → replaced with the highest-versioned probed Pro.
    expect(report.changed.find((c) => c.phase === 'phase1Model')?.to).toBe('gemini-2.0-pro')
    expect(report.changed.find((c) => c.phase === 'phase3Model')?.to).toBe('gemini-2.0-pro')
    // Phase 2 + 4 (gemini-2.5-flash) → already accessible, untouched.
    expect(report.changed.find((c) => c.phase === 'phase2Model')).toBeUndefined()
    expect(report.changed.find((c) => c.phase === 'phase4Model')).toBeUndefined()
  })

  it('prefers same-family replacements (Pro→Pro, Flash→Flash)', () => {
    const profile = baseProfile({ phase1Model: 'gemini-2.5-pro' })
    const avail = makeAvailability([
      { id: 'gemini-2.5-pro', accessible: false },
      { id: 'gemini-2.5-flash', accessible: true }, // Flash available but profile asked for Pro
      { id: 'gemini-2.0-pro', accessible: true },
    ])
    const report = sanitizeGeminiProfile(profile, 'free', avail)
    expect(report.changed[0].to).toBe('gemini-2.0-pro')
  })

  it('falls through to any-family when no same-family alternative exists', () => {
    const profile = baseProfile({ phase1Model: 'gemini-2.5-pro' })
    const avail = makeAvailability([
      { id: 'gemini-2.5-pro', accessible: false },
      { id: 'gemini-2.5-flash', accessible: true },
      // No Pro alternative — sanitizer should pick the Flash rather than leave unfixable.
    ])
    const report = sanitizeGeminiProfile(profile, 'free', avail)
    expect(report.changed[0].to).toBe('gemini-2.5-flash')
  })

  it('marks phases unfixable when no probed alternative is accessible', () => {
    const profile = baseProfile({ phase1Model: 'gemini-2.5-pro' })
    const avail = makeAvailability([
      { id: 'gemini-2.5-pro', accessible: false, reason: 'Free tier quota: 0' },
      { id: 'gemini-2.5-flash', accessible: false, reason: 'Network error' },
    ])
    const report = sanitizeGeminiProfile(profile, 'free', avail)
    expect(report.changed).toEqual([])
    expect(report.unfixable.find((u) => u.phase === 'phase1Model')).toBeDefined()
  })

  it('does not mutate the input profile', () => {
    const profile = baseProfile()
    const original = { ...profile }
    const avail = makeAvailability([
      { id: 'gemini-2.5-pro', accessible: false },
      { id: 'gemini-2.0-pro', accessible: true },
      { id: 'gemini-2.5-flash', accessible: true },
    ])
    sanitizeGeminiProfile(profile, 'free', avail)
    expect(profile).toEqual(original)
  })

  it('treats auto tier the same as free for safety', () => {
    const profile = baseProfile({ phase1Model: 'gemini-2.5-pro' })
    const avail = makeAvailability([
      { id: 'gemini-2.5-pro', accessible: false },
      { id: 'gemini-2.0-pro', accessible: true },
      { id: 'gemini-2.5-flash', accessible: true },
    ])
    const report = sanitizeGeminiProfile(profile, 'auto', avail)
    expect(report.changed.length).toBeGreaterThan(0)
  })
})
