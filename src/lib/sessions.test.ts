/** @vitest-environment jsdom */
// buildSession behavioural tests — these lock in the contract that the
// audit identified as silently broken:
//   1. perPhaseOverrides surface when a perPhase entry pins a different
//      tier than the global selector (audit cause #5).
//   2. modelAvailabilityWarning surfaces when listGeminiModelAvailability
//      fails (audit cause #4).
//   3. dryRun=true does NOT persist lastSelectedProvider (audit found this
//      was needed for the resume's originalSession path).

import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock every network/disk-touching module sessions.ts pulls in so the unit
// test runs purely in-memory. The factory functions return objects with
// `vi.fn()` slots that each test overrides via .mockImplementation.

vi.mock('./profiles', async () => {
  const mod = await vi.importActual<typeof import('./profiles')>('./profiles')
  return {
    ...mod,
    getProfiles: vi.fn(),
  }
})

vi.mock('./routing', async () => {
  const mod = await vi.importActual<typeof import('./routing')>('./routing')
  return {
    ...mod,
    getRouting: vi.fn(),
    putRouting: vi.fn(),
  }
})

vi.mock('./providerSettings', async () => {
  const mod = await vi.importActual<typeof import('./providerSettings')>('./providerSettings')
  return {
    ...mod,
    getProvidersSummary: vi.fn(),
    getAvailabilityCache: vi.fn(),
  }
})

vi.mock('./gemini', async () => {
  const mod = await vi.importActual<typeof import('./gemini')>('./gemini')
  return {
    ...mod,
    listGeminiModelAvailability: vi.fn(),
    isPaidOnlyGeminiModel: vi.fn().mockReturnValue(false),
  }
})

import { buildSession } from './sessions'
import * as profiles from './profiles'
import * as routing from './routing'
import * as gemini from './gemini'
import * as providerSettings from './providerSettings'

function freshProfilesDoc() {
  return {
    version: 1 as const,
    profiles: {
      gemini: {
        phase1Model: 'gemini-2.5-flash',
        phase2Model: 'gemini-2.5-flash',
        phase3Model: 'gemini-2.5-flash',
        phase4Model: 'gemini-2.5-flash',
        phase5Model: 'gemini-2.5-flash',
        phase6Model: 'gemini-2.5-flash',
      },
      claude: {
        phase1Model: 'claude-haiku-4-5',
        phase2Model: 'claude-haiku-4-5',
        phase3Model: 'claude-haiku-4-5',
        phase4Model: 'claude-haiku-4-5',
        phase5Model: 'claude-haiku-4-5',
        phase6Model: 'claude-haiku-4-5',
      },
      openai: {
        phase1Model: 'gpt-4o-mini',
        phase2Model: 'gpt-4o-mini',
        phase3Model: 'gpt-4o-mini',
        phase4Model: 'gpt-4o-mini',
        phase5Model: 'gpt-4o-mini',
        phase6Model: 'gpt-4o-mini',
      },
      claudeCode: {
        phase1Model: 'sonnet',
        phase2Model: 'haiku',
        phase3Model: 'sonnet',
        phase4Model: 'haiku',
        phase5Model: 'sonnet',
        phase6Model: 'sonnet',
      },
      codex: {
        phase1Model: 'default',
        phase2Model: 'gpt-5-mini',
        phase3Model: 'default',
        phase4Model: 'gpt-5-mini',
        phase5Model: 'default',
        phase6Model: 'default',
      },
    },
  }
}

function freshRoutingDoc(overrides: Partial<routing.RoutingDocument> = {}): routing.RoutingDocument {
  return {
    version: 3,
    lastSelectedProvider: 'gemini',
    geminiTier: 'paid',
    ...overrides,
  }
}

beforeEach(() => {
  // Reset call history between tests so assertions like "putRouting was NOT
  // called" see a fresh slate. mockResolvedValue lines below re-seed the
  // resolved values that the prior call cleared.
  vi.clearAllMocks()
  vi.mocked(profiles.getProfiles).mockResolvedValue(freshProfilesDoc())
  vi.mocked(routing.getRouting).mockResolvedValue(freshRoutingDoc())
  vi.mocked(routing.putRouting).mockResolvedValue(freshRoutingDoc())
  vi.mocked(providerSettings.getProvidersSummary).mockResolvedValue({
    configured: ['gemini', 'geminiFallback'],
    hasFallback: { gemini: true },
  })
  vi.mocked(providerSettings.getAvailabilityCache).mockResolvedValue({})
  vi.mocked(gemini.listGeminiModelAvailability).mockResolvedValue([
    {
      id: 'gemini-2.5-flash',
      displayName: 'Flash',
      supportsGenerate: true,
      tier: 'flash',
      billingRequired: false,
    },
    {
      id: 'gemini-2.5-pro',
      displayName: 'Pro',
      supportsGenerate: true,
      tier: 'pro',
      billingRequired: true,
    },
  ])
})

describe('buildSession — perPhaseOverrides surfacing (cause #5)', () => {
  it('populates perPhaseOverrides when a perPhase entry pins a tier different from defaults', async () => {
    const stale = freshRoutingDoc({
      geminiTier: 'paid',
      perPhase: {
        phase1: { target: 'cloud', cloudProvider: 'gemini', geminiTier: 'free' },
      },
    })
    vi.mocked(routing.getRouting).mockResolvedValue(stale)
    const session = await buildSession('gemini', { geminiTier: 'paid' })
    expect(session.perPhaseOverrides).toBeDefined()
    expect(session.perPhaseOverrides).toHaveLength(1)
    expect(session.perPhaseOverrides![0].phase).toBe('phase1')
    expect(session.perPhaseOverrides![0].resolved.tier).toBe('free')
    expect(session.perPhaseOverrides![0].expected.tier).toBe('paid')
    expect(session.perPhaseOverrides![0].reason).toContain('tier pinned to free')
  })

  it('leaves perPhaseOverrides undefined when no overrides diverge from defaults', async () => {
    vi.mocked(routing.getRouting).mockResolvedValue(freshRoutingDoc({ geminiTier: 'paid' }))
    const session = await buildSession('gemini', { geminiTier: 'paid' })
    expect(session.perPhaseOverrides).toBeUndefined()
  })

  it('catches a provider override (perPhase pinned to claude when defaults are gemini)', async () => {
    const stale = freshRoutingDoc({
      perPhase: {
        phase3: { target: 'cloud', cloudProvider: 'claude' },
      },
    })
    vi.mocked(routing.getRouting).mockResolvedValue(stale)
    const session = await buildSession('gemini', { geminiTier: 'paid' })
    expect(session.perPhaseOverrides).toHaveLength(1)
    expect(session.perPhaseOverrides![0].phase).toBe('phase3')
    expect(session.perPhaseOverrides![0].resolved.provider).toBe('claude')
    expect(session.perPhaseOverrides![0].reason).toContain('provider pinned to claude')
  })

  it('does NOT flag local-routed phases as overrides (those are intentional)', async () => {
    const stale = freshRoutingDoc({
      perPhase: {
        phase1: { target: 'local', modelId: 'llama3.2:3b' },
      },
    })
    vi.mocked(routing.getRouting).mockResolvedValue(stale)
    const session = await buildSession('gemini', { geminiTier: 'paid' })
    expect(session.perPhaseOverrides).toBeUndefined()
  })
})

describe('buildSession — modelAvailabilityWarning surfacing (cause #4)', () => {
  it('populates modelAvailabilityWarning when listGeminiModelAvailability throws on a Free run', async () => {
    vi.mocked(routing.getRouting).mockResolvedValue(freshRoutingDoc({ geminiTier: 'free' }))
    vi.mocked(gemini.listGeminiModelAvailability).mockRejectedValue(new Error('probe failed'))
    const session = await buildSession('gemini', { geminiTier: 'free' })
    expect(session.modelAvailabilityWarning).toBeDefined()
    expect(session.modelAvailabilityWarning!.consequence).toBe('auto_escalation_disabled')
    expect(session.modelAvailabilityWarning!.error).toContain('probe failed')
    expect(session.geminiPaidOnlyModels).toBeUndefined()
  })

  it('populates modelAvailabilityWarning when the probe returns an empty list', async () => {
    vi.mocked(routing.getRouting).mockResolvedValue(freshRoutingDoc({ geminiTier: 'free' }))
    vi.mocked(gemini.listGeminiModelAvailability).mockResolvedValue([])
    const session = await buildSession('gemini', { geminiTier: 'free' })
    expect(session.modelAvailabilityWarning).toBeDefined()
    expect(session.modelAvailabilityWarning!.consequence).toBe('all_models_assumed_free')
  })

  it('does NOT populate the warning when probe succeeds with a non-empty list', async () => {
    vi.mocked(routing.getRouting).mockResolvedValue(freshRoutingDoc({ geminiTier: 'free' }))
    const session = await buildSession('gemini', { geminiTier: 'free' })
    expect(session.modelAvailabilityWarning).toBeUndefined()
    // The successful probe populates the paid-only-models list.
    expect(session.geminiPaidOnlyModels).toContain('gemini-2.5-pro')
  })

  it('does NOT call the probe at all on a Paid-only run (no Free phase)', async () => {
    vi.mocked(routing.getRouting).mockResolvedValue(freshRoutingDoc({ geminiTier: 'paid' }))
    await buildSession('gemini', { geminiTier: 'paid' })
    expect(gemini.listGeminiModelAvailability).not.toHaveBeenCalled()
  })
})

describe('buildSession — dryRun preserves Active Provider', () => {
  it('dryRun=true does NOT call putRouting', async () => {
    const routingDoc = freshRoutingDoc({ lastSelectedProvider: 'claude' })
    vi.mocked(routing.getRouting).mockResolvedValue(routingDoc)
    await buildSession('gemini', { geminiTier: 'paid', dryRun: true })
    expect(routing.putRouting).not.toHaveBeenCalled()
  })

  it('dryRun=false (default) persists the new lastSelectedProvider when it differs', async () => {
    const routingDoc = freshRoutingDoc({ lastSelectedProvider: 'claude' })
    vi.mocked(routing.getRouting).mockResolvedValue(routingDoc)
    await buildSession('gemini', { geminiTier: 'paid' })
    expect(routing.putRouting).toHaveBeenCalledWith(
      expect.objectContaining({ lastSelectedProvider: 'gemini', geminiTier: 'paid' }),
    )
  })

  it('routingOverride is used in place of getRouting when provided', async () => {
    const override: routing.RoutingDocument = {
      version: 3,
      lastSelectedProvider: 'gemini',
      geminiTier: 'free',
      perPhase: {
        phase2: { target: 'cloud', cloudProvider: 'gemini', geminiTier: 'paid' },
      },
    }
    const session = await buildSession('gemini', {
      geminiTier: 'free',
      routingOverride: override,
      dryRun: true,
    })
    expect(session.perPhaseOverrides).toHaveLength(1)
    expect(session.perPhaseOverrides![0].phase).toBe('phase2')
    expect(session.perPhaseOverrides![0].resolved.tier).toBe('paid')
    // The saved routing was NOT read.
    expect(routing.getRouting).not.toHaveBeenCalled()
  })
})

// ────────────────────────────────────────────────────────────────────────
// scoreCandidate — the substitution ranker. Tests the contract that
// `-lite-`, `experimental`, and `-latest` variants are deprioritised
// vs. dated stable versions. Locks the user-reported bug fix:
//   "I did not select flash-lite to be used. It should not have been
//    selected in the first place and it wasn't in the UI."
// — caused by the previous descending-lex sort picking gemini-flash-lite-latest
// over gemini-2.5-flash when both were accessible on Free.
// ────────────────────────────────────────────────────────────────────────

import { _scoreGeminiCandidateForTests } from './sessions'

describe('scoreGeminiCandidate — auto-substitution ranking', () => {
  it('penalises lite variants heavily', () => {
    expect(_scoreGeminiCandidateForTests('gemini-2.5-flash')).toBe(0)
    expect(_scoreGeminiCandidateForTests('gemini-flash-lite-latest')).toBeGreaterThan(50)
  })

  it('ranks gemini-2.5-flash above gemini-flash-lite-latest (the user-reported case)', () => {
    const flash = _scoreGeminiCandidateForTests('gemini-2.5-flash')
    const lite = _scoreGeminiCandidateForTests('gemini-flash-lite-latest')
    expect(flash).toBeLessThan(lite)
  })

  it('penalises experimental / preview / exp markers', () => {
    expect(_scoreGeminiCandidateForTests('gemini-2.5-flash-experimental')).toBeGreaterThan(0)
    expect(_scoreGeminiCandidateForTests('gemini-pro-preview-001')).toBeGreaterThan(0)
    expect(_scoreGeminiCandidateForTests('gemini-2.5-pro-exp-0820')).toBeGreaterThan(0)
  })

  it('lightly penalises `-latest` aliases', () => {
    const latest = _scoreGeminiCandidateForTests('gemini-2.5-flash-latest')
    const dated = _scoreGeminiCandidateForTests('gemini-2.5-flash-001')
    expect(latest).toBeGreaterThan(dated)
  })

  it('does NOT penalise dated stable versions', () => {
    expect(_scoreGeminiCandidateForTests('gemini-2.5-flash-001')).toBe(0)
    expect(_scoreGeminiCandidateForTests('gemini-2.5-pro')).toBe(0)
  })

  it('combines penalties additively (lite + experimental + latest)', () => {
    // Pathological worst-case candidate.
    const worst = _scoreGeminiCandidateForTests('gemini-flash-lite-experimental-latest')
    expect(worst).toBeGreaterThan(100) // lite alone is 100
  })
})

// ────────────────────────────────────────────────────────────────────────
// T1.1 (Phase 8) — hybrid Paid+Free routing-config resolution matrix.
//
// Validates that every hybrid mode resolves to the right per-phase tier
// before any chunk is dispatched. If the resolver is wrong here, every
// downstream live-API test is testing the wrong path — and we'd burn
// quota for nothing.
//
// The four modes:
//   1. Paid only      — geminiTier: 'paid' globally, no perPhase overrides
//   2. Free only      — geminiTier: 'free' globally, no perPhase overrides
//   3. Auto hybrid    — geminiTier: 'auto' globally (paid + free fallback)
//   4. Manual perPhase — different tier per phase (the user's actual config)
// Plus the escalation edge case:
//   5. Free + paid-only model → that one phase auto-escalates to Paid
// ────────────────────────────────────────────────────────────────────────

describe('T1.1 — hybrid routing-config resolution', () => {
  it('Mode 1 (Paid only): all five phases resolve to geminiTier="paid"', async () => {
    vi.mocked(routing.getRouting).mockResolvedValue(freshRoutingDoc({ geminiTier: 'paid' }))
    const session = await buildSession('gemini', { geminiTier: 'paid' })
    expect(session.phases.phase1.geminiTier).toBe('paid')
    expect(session.phases.phase2.geminiTier).toBe('paid')
    expect(session.phases.phase3.geminiTier).toBe('paid')
    expect(session.phases.phase4.geminiTier).toBe('paid')
    expect(session.phases.phase6.geminiTier).toBe('paid')
    // No perPhase overrides should be flagged when defaults are clean.
    expect(session.perPhaseOverrides).toBeUndefined()
  })

  it('Mode 2 (Free only): all five phases resolve to geminiTier="free"', async () => {
    vi.mocked(routing.getRouting).mockResolvedValue(freshRoutingDoc({ geminiTier: 'free' }))
    const session = await buildSession('gemini', { geminiTier: 'free' })
    expect(session.phases.phase1.geminiTier).toBe('free')
    expect(session.phases.phase2.geminiTier).toBe('free')
    expect(session.phases.phase3.geminiTier).toBe('free')
    expect(session.phases.phase4.geminiTier).toBe('free')
    expect(session.phases.phase6.geminiTier).toBe('free')
  })

  it('Mode 3 (Auto hybrid): all phases resolve to geminiTier="auto"', async () => {
    vi.mocked(routing.getRouting).mockResolvedValue(freshRoutingDoc({ geminiTier: 'auto' }))
    const session = await buildSession('gemini', { geminiTier: 'auto' })
    expect(session.phases.phase1.geminiTier).toBe('auto')
    expect(session.phases.phase3.geminiTier).toBe('auto')
    // The actual paid/free flip happens at runtime in GeminiProvider — the
    // resolver just passes 'auto' through.
  })

  it('Mode 4 (Manual perPhase): each phase resolves to its own tier', async () => {
    // The user's actual config pattern: cheap grounding/audit on Free,
    // smart chronicle + extras on Paid.
    const userPattern = freshRoutingDoc({
      geminiTier: 'free', // global default; perPhase overrides take precedence
      perPhase: {
        phase1: { target: 'cloud', cloudProvider: 'gemini', geminiTier: 'free', modelId: 'gemini-2.5-flash' },
        phase2: { target: 'cloud', cloudProvider: 'gemini', geminiTier: 'free', modelId: 'gemini-2.5-flash' },
        phase3: { target: 'cloud', cloudProvider: 'gemini', geminiTier: 'paid', modelId: 'gemini-2.5-pro' },
        phase4: { target: 'cloud', cloudProvider: 'gemini', geminiTier: 'paid', modelId: 'gemini-2.5-flash-lite' },
        phase6: { target: 'cloud', cloudProvider: 'gemini', geminiTier: 'paid', modelId: 'gemini-2.5-flash-lite' },
      },
    })
    vi.mocked(routing.getRouting).mockResolvedValue(userPattern)
    const session = await buildSession('gemini', { geminiTier: 'free' })
    expect(session.phases.phase1.geminiTier).toBe('free')
    expect(session.phases.phase2.geminiTier).toBe('free')
    expect(session.phases.phase3.geminiTier).toBe('paid')
    expect(session.phases.phase4.geminiTier).toBe('paid')
    expect(session.phases.phase6.geminiTier).toBe('paid')
    // Per-phase resolved model honours the routing.perPhase.modelId override
    // (session.models is the profile fallback; session.phases[N].model is the
    // resolved-after-overrides value the pipeline actually dispatches against).
    expect(session.phases.phase1.model).toBe('gemini-2.5-flash')
    expect(session.phases.phase3.model).toBe('gemini-2.5-pro')
    expect(session.phases.phase4.model).toBe('gemini-2.5-flash-lite')
  })

  it('Mode 5 (Free + paid-only model): geminiPaidOnlyModels list flags the model', async () => {
    // Free tier globally, but probe says gemini-2.5-pro is paid-only.
    // The resolved phase tier should STILL say 'free' here — the
    // escalation happens later in chunkedGenerate (pipeline.ts:218–225).
    // But the geminiPaidOnlyModels list must be populated so the pipeline
    // knows to escalate at dispatch time.
    vi.mocked(routing.getRouting).mockResolvedValue(freshRoutingDoc({
      geminiTier: 'free',
      perPhase: {
        phase1: { target: 'cloud', cloudProvider: 'gemini', geminiTier: 'free', modelId: 'gemini-2.5-pro' },
      },
    }))
    const session = await buildSession('gemini', { geminiTier: 'free' })
    expect(session.phases.phase1.geminiTier).toBe('free') // resolver doesn't pre-escalate
    expect(session.geminiPaidOnlyModels).toContain('gemini-2.5-pro')
    // No warning since the probe returned a non-empty list.
    expect(session.modelAvailabilityWarning).toBeUndefined()
  })

  it('global Paid + a single perPhase pin to Free is flagged as override (audit drift detection)', async () => {
    // The "stale perPhase override" scenario from the audit. The user
    // flipped global to Paid; one perPhase entry is still Free from an
    // earlier intent. Should surface in perPhaseOverrides.
    vi.mocked(routing.getRouting).mockResolvedValue(freshRoutingDoc({
      geminiTier: 'paid',
      perPhase: {
        phase2: { target: 'cloud', cloudProvider: 'gemini', geminiTier: 'free' },
      },
    }))
    const session = await buildSession('gemini', { geminiTier: 'paid' })
    expect(session.phases.phase2.geminiTier).toBe('free')
    expect(session.phases.phase1.geminiTier).toBe('paid') // other phases keep global
    expect(session.perPhaseOverrides).toHaveLength(1)
    expect(session.perPhaseOverrides![0].phase).toBe('phase2')
  })

  it('does NOT call the model-availability probe when global tier is paid', async () => {
    // Paid-only runs don't need to know which models are paid-only —
    // they're all "accessible" on paid. Skipping the probe saves a round
    // trip on every run start.
    vi.mocked(routing.getRouting).mockResolvedValue(freshRoutingDoc({ geminiTier: 'paid' }))
    await buildSession('gemini', { geminiTier: 'paid' })
    expect(gemini.listGeminiModelAvailability).not.toHaveBeenCalled()
  })

  it('DOES call the probe when ANY perPhase entry is on Free (even if global is Paid)', async () => {
    // Even if global is Paid, a single Free perPhase pin means we need
    // to know which models that phase's key can reach.
    vi.mocked(routing.getRouting).mockResolvedValue(freshRoutingDoc({
      geminiTier: 'paid',
      perPhase: {
        phase2: { target: 'cloud', cloudProvider: 'gemini', geminiTier: 'free' },
      },
    }))
    await buildSession('gemini', { geminiTier: 'paid' })
    expect(gemini.listGeminiModelAvailability).toHaveBeenCalled()
  })
})
