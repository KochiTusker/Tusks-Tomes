import { beforeEach, describe, expect, it, vi } from 'vitest'

// Stub the three phase runners — reforge.ts is pure orchestration over them.
vi.mock('./pipeline', () => ({
  runPhase3: vi.fn(async () => 'REGENERATED_CHRONICLE'),
  runPhase4: vi.fn(async () => ({ jests: ['j'], gore: ['g'], quotes: [] })),
  runPhase6: vi.fn(async () => ({ narrative: 'n', bulletPoints: ['b'] })),
}))

import { runReforge, validateReforge, type ReforgeInput, type ReforgeConfig } from './reforge'
import { runPhase3, runPhase4, runPhase6 } from './pipeline'

const baseInput: ReforgeInput = {
  chronicle: 'ORIGINAL_CHRONICLE',
  groundedTranscript: 'GROUNDED_TRANSCRIPT',
  dmQuestions: [{ id: 'q1', question: 'Q?' }],
  dmAnswers: { q1: 'A' },
  kb: [],
  campaign: 'Ironvale',
  sessionNumber: 24,
}

const cfg = (over: Partial<ReforgeConfig> = {}): ReforgeConfig => ({
  regenerateChronicle: false,
  doExtras: true,
  doCondense: true,
  extrasSource: 'transcript',
  geminiTier: 'paid',
  ...over,
})

const cb = { onEvent: () => {} }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('validateReforge', () => {
  it('rejects when nothing is selected', () => {
    expect(
      validateReforge(baseInput, cfg({ doExtras: false, doCondense: false, regenerateChronicle: false })),
    ).toMatch(/Nothing selected/i)
  })

  it('rejects regenerate-chronicle without a grounded transcript', () => {
    const input = { ...baseInput, groundedTranscript: undefined }
    expect(validateReforge(input, cfg({ regenerateChronicle: true }))).toMatch(/grounded transcript/i)
  })

  it('rejects transcript-source extras without a grounded transcript', () => {
    const input = { ...baseInput, groundedTranscript: undefined }
    expect(validateReforge(input, cfg({ extrasSource: 'transcript' }))).toMatch(/grounded transcript/i)
  })

  it('allows chronicle-source extras without a transcript', () => {
    const input = { ...baseInput, groundedTranscript: undefined }
    expect(validateReforge(input, cfg({ extrasSource: 'chronicle', doCondense: false }))).toBeNull()
  })

  it('accepts a valid full config', () => {
    expect(validateReforge(baseInput, cfg())).toBeNull()
  })
})

describe('runReforge — phase dispatch', () => {
  it('keep-chronicle: skips Phase 3, extras from transcript, condense from the kept chronicle', async () => {
    const res = await runReforge(baseInput, cfg(), cb)

    expect(runPhase3).not.toHaveBeenCalled()
    expect(res.chronicle).toBe('ORIGINAL_CHRONICLE')
    expect(res.chronicleRegenerated).toBe(false)

    // Extras ran on the grounded transcript, flagged as transcript source.
    expect(runPhase4).toHaveBeenCalledTimes(1)
    const p4 = vi.mocked(runPhase4).mock.calls[0][0]
    expect(p4.groundedTranscript).toBe('GROUNDED_TRANSCRIPT')
    expect(p4.extrasSourceKind).toBe('transcript')
    expect(p4.cloudProvider).toBe('gemini')

    // Condense ran on the kept chronicle.
    const p6 = vi.mocked(runPhase6).mock.calls[0][0]
    expect(p6.chronicle).toBe('ORIGINAL_CHRONICLE')
    expect(res.condensed).toEqual({ narrative: 'n', bulletPoints: ['b'] })
  })

  it('regenerate: Phase 3 runs and condense uses the NEW chronicle', async () => {
    const res = await runReforge(baseInput, cfg({ regenerateChronicle: true, doExtras: false }), cb)

    expect(runPhase3).toHaveBeenCalledTimes(1)
    expect(res.chronicle).toBe('REGENERATED_CHRONICLE')
    expect(res.chronicleRegenerated).toBe(true)

    const p6 = vi.mocked(runPhase6).mock.calls[0][0]
    expect(p6.chronicle).toBe('REGENERATED_CHRONICLE') // not the original
  })

  it('chronicle-source extras: Phase 4 receives the chronicle as its source', async () => {
    await runReforge(baseInput, cfg({ extrasSource: 'chronicle', doCondense: false }), cb)
    const p4 = vi.mocked(runPhase4).mock.calls[0][0]
    expect(p4.groundedTranscript).toBe('ORIGINAL_CHRONICLE')
    expect(p4.extrasSourceKind).toBe('chronicle')
  })

  it('respects which outputs are selected', async () => {
    await runReforge(baseInput, cfg({ doExtras: false, doCondense: true }), cb)
    expect(runPhase4).not.toHaveBeenCalled()
    expect(runPhase6).toHaveBeenCalledTimes(1)
  })

  it('throws on an invalid config (gating)', async () => {
    const input = { ...baseInput, groundedTranscript: undefined }
    await expect(runReforge(input, cfg({ regenerateChronicle: true }), cb)).rejects.toThrow(/grounded transcript/i)
  })

  it('passes the selected gemini tier + persona templates through', async () => {
    await runReforge(
      baseInput,
      cfg({
        regenerateChronicle: true,
        geminiTier: 'free',
        personaTemplates: { phase3: { cloud: 'P3' }, phase6: { cloud: 'P6' } },
      }),
      cb,
    )
    expect(vi.mocked(runPhase3).mock.calls[0][0].geminiTier).toBe('free')
    expect(vi.mocked(runPhase3).mock.calls[0][0].personaTemplates).toEqual({ cloud: 'P3' })
    expect(vi.mocked(runPhase6).mock.calls[0][0].personaTemplates).toEqual({ cloud: 'P6' })
  })

  it('routes to the chosen provider + model (not hardcoded Gemini)', async () => {
    await runReforge(baseInput, cfg({ provider: 'claudeCode', model: 'claude-haiku-4-5' }), cb)
    const p4 = vi.mocked(runPhase4).mock.calls[0][0]
    const p6 = vi.mocked(runPhase6).mock.calls[0][0]
    expect(p4.cloudProvider).toBe('claudeCode')
    expect(p4.model).toBe('claude-haiku-4-5')
    expect(p6.cloudProvider).toBe('claudeCode')
    expect(p6.model).toBe('claude-haiku-4-5')
  })

  it('defaults to Gemini when no provider is given (back-compat)', async () => {
    await runReforge(baseInput, cfg({ doExtras: false }), cb)
    expect(vi.mocked(runPhase6).mock.calls[0][0].cloudProvider).toBe('gemini')
  })

  it('computes the condense target from condensePercentage against the resolved chronicle', async () => {
    // Kept chronicle: 'ORIGINAL_CHRONICLE' is 1 word → 50% → 1 word (rounded,
    // min 1). The point is that the percentage is resolved here, not passed raw.
    await runReforge(baseInput, cfg({ doExtras: false, condensePercentage: 50 }), cb)
    const p6 = vi.mocked(runPhase6).mock.calls[0][0]
    expect(p6.targetWordCount).toBe(1)
  })

  it('regenerate + condensePercentage: target tracks the NEW chronicle word count', async () => {
    // Phase 3 mock returns 'REGENERATED_CHRONICLE' (1 word) → 100% → 1 word.
    await runReforge(
      baseInput,
      cfg({ regenerateChronicle: true, doExtras: false, condensePercentage: 100 }),
      cb,
    )
    const p6 = vi.mocked(runPhase6).mock.calls[0][0]
    expect(p6.targetWordCount).toBe(1)
  })

  it('falls back to an explicit targetWordCount when no percentage is set', async () => {
    await runReforge(baseInput, cfg({ doExtras: false, targetWordCount: 1234 }), cb)
    expect(vi.mocked(runPhase6).mock.calls[0][0].targetWordCount).toBe(1234)
  })
})
