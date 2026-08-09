import { describe, expect, it } from 'vitest'
import { wrapWithContext } from './gemini'

describe('wrapWithContext — diagnostic annotation preservation', () => {
  it('returns the base error unchanged when no contextLabel is provided', () => {
    const base = new Error('boom')
    const out = wrapWithContext(base)
    expect(out).toBe(base)
  })

  it('wraps with [contextLabel] prefix when label provided', () => {
    const out = wrapWithContext(new Error('boom'), 'Phase 1 chunk 1/3')
    expect(out.message).toContain('[Phase 1 chunk 1/3]')
    expect(out.message).toContain('boom')
  })

  it('PRESERVES isProhibitedContent annotation across wrap (regression)', () => {
    // Regression: a Phase 2 audit chunk hitting PROHIBITED_CONTENT was
    // killing the run because wrapWithContext built a fresh Error from
    // base.message and lost the annotation. Pipeline soft-skip then saw
    // .isProhibitedContent === undefined and re-threw.
    const base = new Error('Gemini returned empty response.\nReason: PROHIBITED_CONTENT')
    ;(base as Error & { isProhibitedContent?: boolean }).isProhibitedContent = true
    ;(base as Error & { prohibitedBlockReason?: string }).prohibitedBlockReason = 'PROHIBITED_CONTENT'
    const wrapped = wrapWithContext(base, 'Phase 2 chunk 3/3')
    expect((wrapped as Error & { isProhibitedContent?: boolean }).isProhibitedContent).toBe(true)
    expect((wrapped as Error & { prohibitedBlockReason?: string }).prohibitedBlockReason).toBe('PROHIBITED_CONTENT')
  })

  it('preserves isDailyQuotaExhaustion annotation across wrap', () => {
    const base = new Error('Daily quota exhausted')
    ;(base as Error & { isDailyQuotaExhaustion?: boolean }).isDailyQuotaExhaustion = true
    const wrapped = wrapWithContext(base, 'Phase 1 chunk 1/12')
    expect((wrapped as Error & { isDailyQuotaExhaustion?: boolean }).isDailyQuotaExhaustion).toBe(true)
  })

  it('still preserves cause for downstream introspection', () => {
    const base = new Error('boom')
    const wrapped = wrapWithContext(base, 'Phase X')
    expect((wrapped as Error & { cause?: unknown }).cause).toBe(base)
  })

  it('coerces non-Error inputs to Error', () => {
    const wrapped = wrapWithContext('string error', 'Phase X')
    expect(wrapped).toBeInstanceOf(Error)
    expect(wrapped.message).toContain('string error')
  })
})
