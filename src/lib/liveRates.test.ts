// The catalogue-rate resolver's mapping rules, against a synthetic
// catalogue shaped like the real one (google/ ids, previews, batch and
// image variants). The rules are deliberately conservative — these tests
// exist mostly to prove what the resolver REFUSES to guess.

import { describe, expect, it } from 'vitest'
import { buildLiveRateResolver } from './liveRates'
import { estimateRunCost, liveRateFor, rateFor } from './pricing'
import type { OpenRouterModelInfo } from './openrouterModelsClient'

function m(id: string, inputPerM: number, outputPerM: number, cachedInputPerM?: number) {
  return { id, inputPerM, outputPerM, cachedInputPerM } as OpenRouterModelInfo
}

/** Mirrors the shape (and the traps) of the real catalogue on 2026-08-19. */
const CATALOGUE: OpenRouterModelInfo[] = [
  m('google/gemini-3.7-flash', 0.375, 1.875, 0.0375),
  m('google/gemini-3.6-flash', 0.75, 3.75, 0.075),
  m('google/gemini-3.5-flash-lite', 0.3, 2.5, 0.03),
  m('google/gemini-3.1-pro-preview', 2, 12, 0.2),
  m('google/gemini-2.5-pro', 1.25, 10, 0.125),
  m('google/gemini-2.5-flash', 0.3, 2.5, 0.03),
  // Traps: none of these may ever be picked.
  m('google/gemini-3.7-flash:batch', 0.1875, 0.9375),
  m('google/gemini-3.1-flash-image', 0.5, 3),
  m('google/gemini-3-pro-image', 2, 12),
  m('google/gemini-3.1-pro-preview-customtools', 2, 12),
  // Non-Gemini entries for the exact-id path.
  m('deepseek/deepseek-v4-flash', 0.038, 0.14),
  m('z-ai/glm-5.2', 0.36, 1.12),
]

const resolver = buildLiveRateResolver(CATALOGUE)!

describe('gemini mapping — floating aliases track the newest version', () => {
  it('gemini-flash-latest → 3.7-flash, skipping batch/image traps', () => {
    expect(resolver.gemini('gemini-flash-latest')).toMatchObject({ input: 0.375, output: 1.875 })
  })
  it('gemini-pro-latest → 3.1-pro-preview (the only 3.x pro text entry)', () => {
    expect(resolver.gemini('gemini-pro-latest')).toMatchObject({ input: 2, output: 12 })
  })
  it('gemini-flash-lite-latest stays in its own family — never plain flash', () => {
    expect(resolver.gemini('gemini-flash-lite-latest')).toMatchObject({ input: 0.3, output: 2.5, cachedInput: 0.03 })
  })
})

describe('gemini mapping — pinned ids never guess across versions', () => {
  it('gemini-2.5-pro → exact catalogue 2.5-pro', () => {
    expect(resolver.gemini('gemini-2.5-pro')).toMatchObject({ input: 1.25, output: 10 })
  })
  it('gemini-3.1-pro (no plain entry) → the 3.1 preview, same version only', () => {
    expect(resolver.gemini('gemini-3.1-pro')).toMatchObject({ input: 2, output: 12 })
  })
  it('gemini-3-pro (version absent from catalogue) → null, static fallback decides', () => {
    expect(resolver.gemini('gemini-3-pro')).toBeNull()
    const rate = liveRateFor(resolver, 'gemini', 'paid', 'gemini-3-pro')
    expect(rate).toEqual(rateFor('gemini', 'paid', 'gemini-3-pro'))
  })
  it('an unparseable id → null', () => {
    expect(resolver.gemini('gemma-3-27b')).toBeNull()
  })
})

describe('liveRateFor — precedence and zero-cost invariants', () => {
  it('openrouter ids price at their exact catalogue rate', () => {
    expect(liveRateFor(resolver, 'openrouter', undefined, 'deepseek/deepseek-v4-flash'))
      .toMatchObject({ input: 0.038, output: 0.14 })
  })
  it('an openrouter id missing from the catalogue falls back to the static rate', () => {
    expect(liveRateFor(resolver, 'openrouter', undefined, 'vendor/never-heard-of-it'))
      .toEqual(rateFor('openrouter', undefined, 'vendor/never-heard-of-it'))
  })
  it('free Gemini and both CLIs stay at zero even with a catalogue present', () => {
    expect(liveRateFor(resolver, 'gemini', 'free', 'gemini-pro-latest').input).toBe(0)
    expect(liveRateFor(resolver, 'claudeCode', undefined, 'sonnet').output).toBe(0)
    expect(liveRateFor(resolver, 'codex', undefined, 'default').output).toBe(0)
  })
  it('a null resolver is byte-identical to the static path', () => {
    expect(liveRateFor(null, 'gemini', 'paid', 'gemini-pro-latest'))
      .toEqual(rateFor('gemini', 'paid', 'gemini-pro-latest'))
  })
})

describe('estimateRunCost with live rates', () => {
  const args = {
    transcriptChars: 240_000,
    kbChars: 100_000,
    routing: {
      phase3_chronicle: { provider: 'gemini' as const, tier: 'paid' as const, model: 'gemini-pro-latest' },
      phase4_extras: { provider: 'openrouter' as const, model: 'deepseek/deepseek-v4-flash' },
    },
  }
  it('the catalogue moves both providers off the static rates', () => {
    const offline = estimateRunCost(args)
    const live = estimateRunCost({ ...args, liveRates: resolver })
    const phase3 = (e: typeof live) => e.perPhase.find((p) => p.phase === 'phase3_chronicle')!.dollars
    const phase4 = (e: typeof live) => e.perPhase.find((p) => p.phase === 'phase4_extras')!.dollars
    // Gemini pro: $1.25/$10 static → $2/$12 live (the handover's discrepancy, resolved).
    expect(phase3(live)).toBeGreaterThan(phase3(offline))
    // OpenRouter deepseek: generic $1.25/$10 fallback → real $0.038/$0.14.
    expect(phase4(live)).toBeLessThan(phase4(offline) / 10)
  })
})
