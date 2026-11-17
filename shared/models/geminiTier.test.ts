import { describe, expect, it } from 'vitest'
import { classifyGeminiTier, GEMINI_TIER_LABELS, GEMINI_TIER_ORDER, TIER_PROBE_PRIORITY } from './geminiTier'

describe('classifyGeminiTier', () => {
  it('tests lite before flash, so the cheapest tier does not collapse into flash', () => {
    expect(classifyGeminiTier('gemini-2.5-flash-lite')).toBe('flash-lite')
    expect(classifyGeminiTier('gemini-flash-lite-latest')).toBe('flash-lite')
    expect(classifyGeminiTier('gemini-2.5-flash')).toBe('flash')
    expect(classifyGeminiTier('GEMINI-2.5-PRO')).toBe('pro')
  })

  it('puts anything unrecognised, or empty, in other', () => {
    expect(classifyGeminiTier('gemini-4-ultra')).toBe('other')
    expect(classifyGeminiTier('')).toBe('other')
  })
})

describe('tier tables', () => {
  it('labels, orders and prioritises every tier, with other last', () => {
    expect(GEMINI_TIER_ORDER).toEqual(['pro', 'flash', 'flash-lite', 'other'])
    expect(GEMINI_TIER_ORDER.map((t) => GEMINI_TIER_LABELS[t])).toEqual([
      'Pro Tier',
      'Flash Tier',
      'Flash Lite Tier',
      'Uncategorised',
    ])
    expect(GEMINI_TIER_ORDER.map((t) => TIER_PROBE_PRIORITY[t])).toEqual([0, 1, 2, 3])
  })
})
