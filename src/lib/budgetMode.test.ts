import { describe, expect, it } from 'vitest'
import { BUDGET_FAST_MODELS, buildBudgetModePerPhase } from './budgetMode'

describe('buildBudgetModePerPhase', () => {
  it('routes every routable phase to the fast model for the chosen provider', () => {
    const perPhase = buildBudgetModePerPhase('claude', undefined)
    expect(perPhase.phase1?.target).toBe('cloud')
    expect(perPhase.phase2?.target).toBe('cloud')
    expect(perPhase.phase3?.target).toBe('cloud')
    expect(perPhase.phase4?.target).toBe('cloud')
    expect(perPhase.phase6?.target).toBe('cloud')
    for (const phase of ['phase1', 'phase2', 'phase3', 'phase4', 'phase6'] as const) {
      const entry = perPhase[phase]
      if (entry?.target === 'cloud') {
        expect(entry.cloudProvider).toBe('claude')
        expect(entry.modelId).toBe(BUDGET_FAST_MODELS.claude)
      }
    }
  })

  it('uses gemini-2.5-flash for the gemini provider', () => {
    const perPhase = buildBudgetModePerPhase('gemini', 'paid')
    const e = perPhase.phase3
    expect(e?.target).toBe('cloud')
    if (e?.target === 'cloud') {
      expect(e.modelId).toBe('gemini-2.5-flash')
      expect(e.geminiTier).toBe('paid')
    }
  })

  it('propagates the active gemini tier so free-tier users stay on the free key', () => {
    const perPhase = buildBudgetModePerPhase('gemini', 'free')
    for (const phase of ['phase1', 'phase2', 'phase3', 'phase4', 'phase6'] as const) {
      const entry = perPhase[phase]
      if (entry?.target === 'cloud') {
        expect(entry.geminiTier).toBe('free')
      }
    }
  })

  it('defaults gemini tier to "auto" when none provided', () => {
    const perPhase = buildBudgetModePerPhase('gemini', undefined)
    const e = perPhase.phase1
    if (e?.target === 'cloud') {
      expect(e.geminiTier).toBe('auto')
    }
  })

  it('does not set geminiTier on non-gemini providers', () => {
    for (const provider of ['claude', 'openai'] as const) {
      const perPhase = buildBudgetModePerPhase(provider, 'paid')
      const e = perPhase.phase1
      if (e?.target === 'cloud') {
        expect(e.geminiTier).toBeUndefined()
      }
    }
  })

  it('uses gpt-5-mini for openai', () => {
    const perPhase = buildBudgetModePerPhase('openai', undefined)
    const e = perPhase.phase4
    if (e?.target === 'cloud') {
      expect(e.modelId).toBe('gpt-5-mini')
    }
  })
})

// ────────────────────────────────────────────────────────────────────
// Gemini Smart Budget (Phase 8 — empirically validated hybrid).
// Locks down the per-phase recommendation so a future edit to
// GEMINI_HYBRID_RECOMMENDED has to update these tests deliberately.
// ────────────────────────────────────────────────────────────────────

import {
  GEMINI_HYBRID_RECOMMENDED,
  GEMINI_SMART_BUDGET_SUMMARY,
  buildGeminiSmartBudgetPerPhase,
} from './budgetMode'

describe('buildGeminiSmartBudgetPerPhase', () => {
  it('returns null for non-Gemini providers (preset is Gemini-only)', () => {
    expect(buildGeminiSmartBudgetPerPhase('claude')).toBeNull()
    expect(buildGeminiSmartBudgetPerPhase('openai')).toBeNull()
  })

  // v1.1.0 policy change: Free key is only used for Phase 4 (extras) — the
  // smallest JSON-shaped phase, where the ~10 RPM Free Flash quota is
  // comfortable. Phase 1 (grounding) moved from Free Flash to Paid Flash
  // because Free Pro is too slow (2 RPM) and Free Flash on grounding still
  // saw long pacing pauses at real session sizes. The chronicle stays on
  // Paid Pro (quality phase).

  it('routes Phase 1 (grounding) to Paid Flash — Free quotas made grounding the slowest phase', () => {
    const perPhase = buildGeminiSmartBudgetPerPhase('gemini')
    expect(perPhase).not.toBeNull()
    const entry = perPhase!.phase1
    expect(entry?.target).toBe('cloud')
    if (entry?.target === 'cloud') {
      expect(entry.cloudProvider).toBe('gemini')
      expect(entry.geminiTier).toBe('paid')
      expect(entry.modelId).toBe('gemini-2.5-flash')
    }
  })

  it('routes Phase 2 (audit) to Paid Flash — bigger chunks dilute the PROHIBITED_CONTENT meta-filter (see brody-bisect probe)', () => {
    const perPhase = buildGeminiSmartBudgetPerPhase('gemini')!
    const entry = perPhase.phase2
    expect(entry?.target).toBe('cloud')
    if (entry?.target === 'cloud') {
      expect(entry.cloudProvider).toBe('gemini')
      expect(entry.geminiTier).toBe('paid')
      expect(entry.modelId).toBe('gemini-2.5-flash')
    }
  })

  it('routes Phase 3 (chronicle — the quality phase) to Paid Pro', () => {
    const perPhase = buildGeminiSmartBudgetPerPhase('gemini')!
    const e = perPhase.phase3
    expect(e?.target).toBe('cloud')
    if (e?.target === 'cloud') {
      expect(e.cloudProvider).toBe('gemini')
      expect(e.geminiTier).toBe('paid')
      expect(e.modelId).toBe('gemini-2.5-pro')
    }
  })

  it('routes Phase 4 (extras) to Free Flash — the only phase that uses your Free key under v1.1.0 policy', () => {
    const perPhase = buildGeminiSmartBudgetPerPhase('gemini')!
    const entry = perPhase.phase4
    expect(entry?.target).toBe('cloud')
    if (entry?.target === 'cloud') {
      expect(entry.cloudProvider).toBe('gemini')
      expect(entry.geminiTier).toBe('free')
      expect(entry.modelId).toBe('gemini-2.5-flash')
    }
  })

  it('routes Phase 6 (condense) to Paid Flash-Lite', () => {
    const perPhase = buildGeminiSmartBudgetPerPhase('gemini')!
    const entry = perPhase.phase6
    expect(entry?.target).toBe('cloud')
    if (entry?.target === 'cloud') {
      expect(entry.geminiTier).toBe('paid')
      expect(entry.modelId).toBe('gemini-2.5-flash-lite')
    }
  })

  it('produces entries for every routable phase (phase1, 2, 3, 4, 6)', () => {
    const perPhase = buildGeminiSmartBudgetPerPhase('gemini')!
    expect(Object.keys(perPhase).sort()).toEqual(['phase1', 'phase2', 'phase3', 'phase4', 'phase6'])
  })

  it('exposes the recommendation map for documentation + UI tooltips', () => {
    expect(GEMINI_HYBRID_RECOMMENDED.phase1.tier).toBe('paid')
    expect(GEMINI_HYBRID_RECOMMENDED.phase1.model).toBe('gemini-2.5-flash')
    expect(GEMINI_HYBRID_RECOMMENDED.phase2.tier).toBe('paid')
    expect(GEMINI_HYBRID_RECOMMENDED.phase2.model).toBe('gemini-2.5-flash')
    expect(GEMINI_HYBRID_RECOMMENDED.phase3.model).toBe('gemini-2.5-pro')
    expect(GEMINI_HYBRID_RECOMMENDED.phase4.tier).toBe('free')
    expect(GEMINI_HYBRID_RECOMMENDED.phase4.model).toBe('gemini-2.5-flash')
    expect(GEMINI_HYBRID_RECOMMENDED.phase6.model).toBe('gemini-2.5-flash-lite')
  })

  it('summary string covers the five key points (paid flash grounding+audit, paid pro chronicle, free flash extras, paid flash-lite condense, both keys required)', () => {
    expect(GEMINI_SMART_BUDGET_SUMMARY).toMatch(/Paid Flash/)
    expect(GEMINI_SMART_BUDGET_SUMMARY).toMatch(/Paid Pro/)
    expect(GEMINI_SMART_BUDGET_SUMMARY).toMatch(/Free Flash/)
    expect(GEMINI_SMART_BUDGET_SUMMARY).toMatch(/Flash-Lite/)
    expect(GEMINI_SMART_BUDGET_SUMMARY).toMatch(/both Paid AND Free Gemini keys/)
    // The new policy explicitly names Phase 4 as the only Free-key consumer.
    expect(GEMINI_SMART_BUDGET_SUMMARY).toMatch(/extras/i)
  })
})

// ── Preset ladder builders ──────────────────────────────────────────
// Every rung must emit explicit cloudProvider + modelId on every phase —
// an entry that omits cloudProvider inherits lastSelectedProvider at run
// time, which would silently re-route the whole preset when the user
// changes their active provider.
describe('preset ladder builders', () => {
  const PHASES = ['phase1', 'phase2', 'phase3', 'phase4', 'phase6'] as const

  it('buildMaxQualityPerPhase routes every phase to the latest pro-tier model', async () => {
    const { buildMaxQualityPerPhase } = await import('./budgetMode')
    const perPhase = buildMaxQualityPerPhase('gemini')
    expect(perPhase).toBeTruthy()
    for (const ph of PHASES) {
      const e = perPhase![ph]
      expect(e).toMatchObject({ target: 'cloud', cloudProvider: 'gemini', modelId: 'gemini-pro-latest', geminiTier: 'paid' })
    }
    // Subscription providers have no pro-tier API model — rung unavailable.
    expect(buildMaxQualityPerPhase('claudeCode')).toBeNull()
    expect(buildMaxQualityPerPhase('codex')).toBeNull()
  })

  it('buildMeasuredHybridSubPerPhase puts mechanical phases on the CLI, prose on latest Flash', async () => {
    const { buildMeasuredHybridSubPerPhase } = await import('./budgetMode')
    const cc = buildMeasuredHybridSubPerPhase('claudeCode')
    expect(cc.phase1).toMatchObject({ cloudProvider: 'claudeCode', modelId: 'sonnet' })
    expect(cc.phase2).toMatchObject({ cloudProvider: 'claudeCode', modelId: 'haiku' })
    for (const ph of ['phase3', 'phase4', 'phase6'] as const) {
      expect(cc[ph]).toMatchObject({ cloudProvider: 'gemini', geminiTier: 'paid', modelId: 'gemini-flash-latest' })
    }
    const cx = buildMeasuredHybridSubPerPhase('codex')
    expect(cx.phase1).toMatchObject({ cloudProvider: 'codex', modelId: 'default' })
    expect(cx.phase2).toMatchObject({ cloudProvider: 'codex', modelId: 'gpt-5-mini' })
  })

  it('buildBalancedPerPhase keeps Pro on the prose phases', async () => {
    const { buildBalancedPerPhase } = await import('./budgetMode')
    const b = buildBalancedPerPhase('claudeCode')
    expect(b.phase3).toMatchObject({ modelId: 'gemini-pro-latest' })
    expect(b.phase6).toMatchObject({ modelId: 'gemini-pro-latest' })
    expect(b.phase4).toMatchObject({ modelId: 'gemini-flash-latest' })
  })

  it('Balanced and Measured Hybrid are DISTINCT recipes', async () => {
    // Regression: these two once emitted identical routing while quoting
    // different savings, so both rungs lit up "Current" simultaneously.
    const { buildBalancedPerPhase, buildMeasuredHybridSubPerPhase } = await import('./budgetMode')
    const a = buildBalancedPerPhase('claudeCode')
    const b = buildMeasuredHybridSubPerPhase('claudeCode')
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b))
  })

  it('buildFreeSubscriptionPerPhase routes EVERY phase to the CLI — zero API usage', async () => {
    const { buildFreeSubscriptionPerPhase } = await import('./budgetMode')
    for (const sub of ['claudeCode', 'codex'] as const) {
      const perPhase = buildFreeSubscriptionPerPhase(sub)
      for (const ph of PHASES) {
        expect(perPhase[ph]).toMatchObject({ target: 'cloud', cloudProvider: sub })
        // No gemini tier on non-Gemini entries.
        expect('geminiTier' in perPhase[ph]!).toBe(false)
      }
    }
  })

  it('savings constants keep their measured/estimated ordering', async () => {
    const m = await import('./budgetMode')
    expect(m.MAX_QUALITY_SAVING_PCT).toBe(0)
    expect(m.BALANCED_THINKING_SAVING_PCT).toBeLessThan(m.MEASURED_HYBRID_SUB_SAVING_PCT)
    expect(m.MEASURED_HYBRID_SUB_SAVING_PCT).toBeLessThan(m.FREE_SUBSCRIPTION_SAVING_PCT)
    expect(m.FREE_SUBSCRIPTION_SAVING_PCT).toBe(100)
  })
})
