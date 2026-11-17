import { beforeEach, describe, expect, it, vi } from 'vitest'

// Stub the three phase runners — reforge.ts is pure orchestration over them.
vi.mock('../../pipeline/lib/pipeline', () => ({
  runPhase3: vi.fn(async () => 'REGENERATED_CHRONICLE'),
  runPhase4: vi.fn(async () => ({ jests: ['j'], gore: ['g'], quotes: [] })),
  runPhase6: vi.fn(async () => ({ narrative: 'n', bulletPoints: ['b'] })),
}))

import {
  hasResumableWork,
  phasesAlreadyDone,
  runReforge,
  validateReforge,
  type ReforgeInput,
  type ReforgeConfig,
} from './reforge'
import { runPhase3, runPhase4, runPhase6 } from '../../pipeline/lib/pipeline'

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

describe('runReforge — per-phase model routing', () => {
  it('routes each phase to its own model, and leaves unlisted phases on the shared choice', async () => {
    await runReforge(
      baseInput,
      cfg({
        regenerateChronicle: true,
        provider: 'gemini',
        model: 'gemini-pro-latest',
        phaseModels: {
          // Extras is the phase where the grades invert — the shared choice
          // would be the wrong model for it specifically.
          phase4: { provider: 'openrouter', geminiTier: 'paid', model: 'z-ai/glm-5.2' },
        },
      }),
      cb,
    )

    const p3 = vi.mocked(runPhase3).mock.calls[0][0]
    const p4 = vi.mocked(runPhase4).mock.calls[0][0]
    const p6 = vi.mocked(runPhase6).mock.calls[0][0]

    // Overridden phase takes its own provider AND model.
    expect(p4.cloudProvider).toBe('openrouter')
    expect(p4.model).toBe('z-ai/glm-5.2')
    // Unlisted phases fall back to the single top-level choice.
    expect(p3.cloudProvider).toBe('gemini')
    expect(p3.model).toBe('gemini-pro-latest')
    expect(p6.cloudProvider).toBe('gemini')
    expect(p6.model).toBe('gemini-pro-latest')
  })

  it('with no phaseModels, every phase keeps the single choice (unchanged behaviour)', async () => {
    await runReforge(
      baseInput,
      cfg({ regenerateChronicle: true, provider: 'gemini', model: 'gemini-flash-latest' }),
      cb,
    )
    for (const spy of [runPhase3, runPhase4, runPhase6]) {
      const call = vi.mocked(spy).mock.calls[0][0] as { cloudProvider?: string; model?: string }
      expect(call.cloudProvider).toBe('gemini')
      expect(call.model).toBe('gemini-flash-latest')
    }
  })
})

describe('runReforge — keeping and resuming a stopped run', () => {
  const EXTRAS_SO_FAR = { jests: ['j1'], gore: ['g1'], quotes: [{ speaker: 'Vell', line: 'Run.', kind: 'funny' }] }

  // Extras that finishes 5 of 6 chunks, then fails the way an account out of
  // credits does.
  const stopExtrasAtChunk6 = () =>
    vi.mocked(runPhase4).mockImplementationOnce(async ({ callbacks }) => {
      callbacks.onEvent({ type: 'phase_start', phase: 'phase4_extras', totalChunks: 6, startChunkIndex: 0, chunkSizeChars: 30_000 })
      for (let i = 0; i < 5; i++) {
        callbacks.onEvent({
          type: 'chunk_done',
          phase: 'phase4_extras',
          index: i,
          totalChunks: 6,
          partial: JSON.stringify(EXTRAS_SO_FAR),
        })
      }
      throw new Error('[Phase 4 (Extras) — chunk 6/6]\n402 This request would exceed your available credits')
    })

  async function stoppedProgress(config = cfg()) {
    let latest: import('./reforge').ReforgeProgress | null = null
    await expect(
      runReforge(baseInput, config, cb, { onProgress: (p) => (latest = p) }),
    ).rejects.toThrow(/402/)
    return latest as unknown as import('./reforge').ReforgeProgress
  }

  it('reports how far a failed phase got', async () => {
    stopExtrasAtChunk6()
    const progress = await stoppedProgress()
    expect(progress.inFlight).toEqual({
      phase: 'phase4',
      nextChunk: 5,
      totalChunks: 6,
      chunkSizeChars: 30_000,
      partial: JSON.stringify(EXTRAS_SO_FAR),
    })
    expect(hasResumableWork(progress)).toBe(true)
    expect(runPhase6).not.toHaveBeenCalled()
  })

  it('resumes the stopped phase at its failed chunk, with the same split and the finished extras', async () => {
    stopExtrasAtChunk6()
    const progress = await stoppedProgress()
    vi.clearAllMocks()

    const res = await runReforge(baseInput, cfg(), cb, { resumeFrom: progress })

    expect(runPhase4).toHaveBeenCalledTimes(1)
    const p4 = vi.mocked(runPhase4).mock.calls[0][0]
    expect(p4.startChunkIndex).toBe(5)
    expect(p4.chunkSizeChars).toBe(30_000)
    expect(p4.priorExtras).toEqual(EXTRAS_SO_FAR)
    // The phases after it run as normal.
    expect(runPhase6).toHaveBeenCalledTimes(1)
    expect(res.condensed).toEqual({ narrative: 'n', bulletPoints: ['b'] })
  })

  it('does not re-run a phase that finished before the stop', async () => {
    vi.mocked(runPhase6).mockImplementationOnce(async () => {
      throw new Error('condense failed')
    })
    let latest: import('./reforge').ReforgeProgress | null = null
    await expect(runReforge(baseInput, cfg(), cb, { onProgress: (p) => (latest = p) })).rejects.toThrow(/condense/)
    const progress = latest as unknown as import('./reforge').ReforgeProgress
    expect(progress.extras).toEqual({ jests: ['j'], gore: ['g'], quotes: [] })
    vi.clearAllMocks()

    const res = await runReforge(baseInput, cfg(), cb, { resumeFrom: progress })

    expect(runPhase4).not.toHaveBeenCalled()
    expect(res.extras).toEqual({ jests: ['j'], gore: ['g'], quotes: [] })
    // Condense is never resumed part-way — it starts over.
    expect(vi.mocked(runPhase6).mock.calls[0][0]).not.toHaveProperty('startChunkIndex')
  })

  it('resumes a chronicle rewrite part-way, and condenses the finished chronicle', async () => {
    vi.mocked(runPhase3).mockImplementationOnce(async ({ callbacks }) => {
      callbacks.onEvent({ type: 'phase_start', phase: 'phase3_chronicle', totalChunks: 4, startChunkIndex: 0, chunkSizeChars: 40_000 })
      callbacks.onEvent({ type: 'chunk_done', phase: 'phase3_chronicle', index: 0, totalChunks: 4, partial: 'Part one.' })
      callbacks.onEvent({ type: 'chunk_done', phase: 'phase3_chronicle', index: 1, totalChunks: 4, partial: 'Part one.\n\nPart two.' })
      throw new Error('upstream 500')
    })
    let latest: import('./reforge').ReforgeProgress | null = null
    const config = cfg({ regenerateChronicle: true, doExtras: false })
    await expect(runReforge(baseInput, config, cb, { onProgress: (p) => (latest = p) })).rejects.toThrow(/500/)
    vi.clearAllMocks()

    const res = await runReforge(baseInput, config, cb, { resumeFrom: latest! })

    const p3 = vi.mocked(runPhase3).mock.calls[0][0]
    expect(p3.startChunkIndex).toBe(2)
    expect(p3.chunkSizeChars).toBe(40_000)
    expect(p3.priorPartial).toBe('Part one.\n\nPart two.')
    expect(res.chronicle).toBe('REGENERATED_CHRONICLE')
    expect(vi.mocked(runPhase6).mock.calls[0][0].chronicle).toBe('REGENERATED_CHRONICLE')
  })

  it('keeps everything it carried in when a resume fails again before the phase starts', async () => {
    stopExtrasAtChunk6()
    const progress = await stoppedProgress()
    vi.clearAllMocks()
    vi.mocked(runPhase4).mockImplementationOnce(async () => {
      throw new Error('still out of credits')
    })
    const reports: import('./reforge').ReforgeProgress[] = []

    await expect(
      runReforge(baseInput, cfg(), cb, { resumeFrom: progress, onProgress: (p) => reports.push(p) }),
    ).rejects.toThrow(/credits/)

    // Nothing new was reported, so the caller's record — the carried progress
    // — is still the whole truth.
    expect(reports).toHaveLength(0)
  })

  it('starts extras over rather than resume from partial output it cannot read', async () => {
    const progress = {
      inFlight: { phase: 'phase4' as const, nextChunk: 3, totalChunks: 6, chunkSizeChars: 30_000, partial: 'not json' },
    }
    await runReforge(baseInput, cfg({ doCondense: false }), cb, { resumeFrom: progress })
    expect(vi.mocked(runPhase4).mock.calls[0][0]).not.toHaveProperty('startChunkIndex')
  })

  it('offers no resume when nothing but condense had started', () => {
    expect(
      hasResumableWork({ inFlight: { phase: 'phase6', nextChunk: 1, totalChunks: 2, partial: '{}' } }),
    ).toBe(false)
    expect(hasResumableWork({ inFlight: { phase: 'phase4', nextChunk: 0, totalChunks: 6, chunkSizeChars: 1, partial: '' } })).toBe(false)
    // Without the split it cannot land on the right chunk, so it will not try.
    expect(hasResumableWork({ inFlight: { phase: 'phase4', nextChunk: 3, totalChunks: 6, partial: '{}' } })).toBe(false)
  })

  it('counts the phases a resume skips outright', () => {
    expect(phasesAlreadyDone(cfg({ regenerateChronicle: true }), { chronicle: 'c', extras: { jests: [], gore: [], quotes: [] } })).toBe(2)
    expect(phasesAlreadyDone(cfg(), undefined)).toBe(0)
  })
})
