// The invariant this file defends: applying ANY preset, from ANY starting
// state, leaves lastSelectedProvider non-null. It is read at run start and
// stored in every checkpoint; the Active Provider card that used to
// guarantee it is gone, so the plan-apply path carries the guarantee now.

import { describe, expect, it } from 'vitest'
import { stageRoutingFromPreset, type PresetPrimary } from './routingStage'
import type { RoutingDocument } from './routing'
import {
  buildBalancedPerPhase,
  buildFreeSubscriptionPerPhase,
  buildGeminiMeasuredHybridPerPhase,
  buildMaxQualityPerPhase,
  buildMeasuredHybridSubPerPhase,
  buildOpenRouterBestPerPhase,
  buildOpenRouterHybridPerPhase,
} from './budgetMode'

/** Every ladder rung's recipe × the primary it declares, across the
 *  provider combinations that can produce it. */
const CASES: Array<{ name: string; perPhase: NonNullable<RoutingDocument['perPhase']> | null; primary: PresetPrimary }> = [
  { name: 'max-quality (gemini)', perPhase: buildMaxQualityPerPhase('gemini'), primary: { provider: 'gemini', geminiTier: 'paid' } },
  { name: 'max-quality (openrouter)', perPhase: buildMaxQualityPerPhase('openrouter'), primary: { provider: 'openrouter' } },
  { name: 'balanced (claudeCode)', perPhase: buildBalancedPerPhase('claudeCode'), primary: { provider: 'gemini', geminiTier: 'paid' } },
  { name: 'balanced (codex)', perPhase: buildBalancedPerPhase('codex'), primary: { provider: 'gemini', geminiTier: 'paid' } },
  { name: 'openrouter-hybrid (claudeCode)', perPhase: buildOpenRouterHybridPerPhase('claudeCode'), primary: { provider: 'openrouter' } },
  { name: 'openrouter-hybrid (codex)', perPhase: buildOpenRouterHybridPerPhase('codex'), primary: { provider: 'openrouter' } },
  { name: 'openrouter-best', perPhase: buildOpenRouterBestPerPhase(), primary: { provider: 'openrouter' } },
  { name: 'measured-hybrid (gemini only)', perPhase: buildGeminiMeasuredHybridPerPhase('gemini'), primary: { provider: 'gemini', geminiTier: 'paid' } },
  { name: 'measured-hybrid (claudeCode)', perPhase: buildMeasuredHybridSubPerPhase('claudeCode'), primary: { provider: 'gemini', geminiTier: 'paid' } },
  { name: 'measured-hybrid (codex)', perPhase: buildMeasuredHybridSubPerPhase('codex'), primary: { provider: 'gemini', geminiTier: 'paid' } },
  { name: 'free-subscription (claudeCode)', perPhase: buildFreeSubscriptionPerPhase('claudeCode'), primary: { provider: 'claudeCode' } },
  { name: 'free-subscription (codex)', perPhase: buildFreeSubscriptionPerPhase('codex'), primary: { provider: 'codex' } },
]

const STARTING_STATES: Array<RoutingDocument | null> = [
  // A fresh install that has never chosen anything — the dangerous case.
  null,
  { version: 3, lastSelectedProvider: null, perPhase: {} },
  // An established config being switched.
  { version: 3, lastSelectedProvider: 'claudeCode', geminiTier: 'paid', perPhase: { phase1: { target: 'cloud', cloudProvider: 'claudeCode', modelId: 'sonnet' } } },
]

describe('stageRoutingFromPreset — the lastSelectedProvider invariant', () => {
  for (const c of CASES) {
    it(`${c.name}: non-null provider from every starting state`, () => {
      expect(c.perPhase).not.toBeNull()
      for (const current of STARTING_STATES) {
        const staged = stageRoutingFromPreset(current, c.perPhase!, c.primary)
        expect(staged.lastSelectedProvider).not.toBeNull()
        expect(staged.lastSelectedProvider).toBe(c.primary.provider)
        expect(staged.version).toBe(3)
        expect(staged.perPhase).toBe(c.perPhase)
      }
    })
  }

  it('gemini primaries pin an explicit tier even from nothing', () => {
    const staged = stageRoutingFromPreset(null, buildGeminiMeasuredHybridPerPhase('gemini')!, {
      provider: 'gemini',
      geminiTier: 'paid',
    })
    expect(staged.geminiTier).toBe('paid')
  })

  it('non-gemini primaries preserve the existing gemini tier for later', () => {
    const current: RoutingDocument = { version: 3, lastSelectedProvider: 'gemini', geminiTier: 'free', perPhase: {} }
    const staged = stageRoutingFromPreset(current, buildOpenRouterBestPerPhase(), { provider: 'openrouter' })
    expect(staged.geminiTier).toBe('free')
  })

  it('every recipe covers all five routable phases', () => {
    for (const c of CASES) {
      const keys = Object.keys(c.perPhase!)
      for (const k of ['phase1', 'phase2', 'phase3', 'phase4', 'phase6']) {
        expect(keys, `${c.name} must route ${k}`).toContain(k)
      }
    }
  })
})
