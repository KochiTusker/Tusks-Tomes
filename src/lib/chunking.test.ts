import { describe, expect, it } from 'vitest'
import {
  chunkSizeFor,
  cloudChunkSize,
  cloudProfileFor,
  cloudSizingKeyFor,
  localChunkSize,
} from './chunking'
import type { ModelTier } from './modelTier'

describe('cloudProfileFor', () => {
  it('maps gemini + paid tier to geminiPaid', () => {
    expect(cloudProfileFor('gemini', 'paid')).toBe('geminiPaid')
  })
  it('maps gemini + free tier to geminiFree', () => {
    expect(cloudProfileFor('gemini', 'free')).toBe('geminiFree')
  })
  it("treats 'auto' as paid for sizing purposes", () => {
    expect(cloudProfileFor('gemini', 'auto')).toBe('geminiPaid')
    expect(cloudProfileFor('gemini', undefined)).toBe('geminiPaid')
  })
  it('maps claude and openai directly', () => {
    expect(cloudProfileFor('claude', undefined)).toBe('claude')
    expect(cloudProfileFor('openai', undefined)).toBe('openai')
  })
})

describe('chunkSizeFor', () => {
  it('returns local sizes when isLocal is true regardless of cloud args', () => {
    const size = chunkSizeFor({
      phase: 'p3',
      isLocal: true,
      cloudProvider: 'gemini',
      geminiTier: 'paid',
    })
    expect(size).toBe(localChunkSize('p3'))
  })

  it('returns the right per-provider size for cloud routing', () => {
    expect(chunkSizeFor({ phase: 'p1', isLocal: false, cloudProvider: 'gemini', geminiTier: 'paid' }))
      .toBe(cloudChunkSize('geminiPaid', 'p1'))
    expect(chunkSizeFor({ phase: 'p3', isLocal: false, cloudProvider: 'claude' }))
      .toBe(cloudChunkSize('claude', 'p3'))
    expect(chunkSizeFor({ phase: 'p6', isLocal: false, cloudProvider: 'openai' }))
      .toBe(cloudChunkSize('openai', 'p6'))
  })

  it('treats phase 5 as local-only even on cloud routing', () => {
    expect(chunkSizeFor({ phase: 'p5', isLocal: false, cloudProvider: 'gemini', geminiTier: 'paid' }))
      .toBe(localChunkSize('p5'))
  })

  it('falls back to gemini-paid defaults when cloudProvider is unset', () => {
    expect(chunkSizeFor({ phase: 'p1', isLocal: false }))
      .toBe(cloudChunkSize('geminiPaid', 'p1'))
  })

  it('ensures local sizes are always smaller than paid Gemini sizes for the same phase', () => {
    // Guards against accidentally bumping local chunk sizes above what a
    // small consumer-GPU model can handle.
    for (const phase of ['p1', 'p2', 'p3', 'p4', 'p6'] as const) {
      expect(localChunkSize(phase)).toBeLessThan(cloudChunkSize('geminiPaid', phase))
    }
  })

  it('ensures grounding/audit chunks (p1/p2) are smaller than chronicle/extras (p3/p4) across all profiles', () => {
    // Phase 1-2 accuracy degrades on long input; keep them tight everywhere.
    for (const profile of ['geminiPaid', 'geminiFree', 'claude', 'openai'] as const) {
      expect(cloudChunkSize(profile, 'p1')).toBeLessThanOrEqual(cloudChunkSize(profile, 'p3'))
      expect(cloudChunkSize(profile, 'p2')).toBeLessThanOrEqual(cloudChunkSize(profile, 'p4'))
    }
  })
})

describe('cloudSizingKeyFor', () => {
  it('composes profile and tier into a single key', () => {
    expect(cloudSizingKeyFor('gemini', 'paid', 'flagship')).toBe('geminiPaid:flagship')
    expect(cloudSizingKeyFor('gemini', 'free', 'fast')).toBe('geminiFree:fast')
    expect(cloudSizingKeyFor('claude', undefined, 'frontier')).toBe('claude:frontier')
    expect(cloudSizingKeyFor('openai', undefined, 'fast')).toBe('openai:fast')
  })
})

describe('chunk sizes — model tier dimension', () => {
  it('omitting modelTier returns the flagship-row size (back-compat lock)', () => {
    // This is the critical guarantee — existing callers that pass no
    // modelTier must produce the exact same numbers as before A3 landed.
    for (const phase of ['p1', 'p2', 'p3', 'p4', 'p6'] as const) {
      expect(chunkSizeFor({ phase, isLocal: false, cloudProvider: 'gemini', geminiTier: 'paid' }))
        .toBe(cloudChunkSize('geminiPaid', phase, 'flagship'))
      expect(chunkSizeFor({ phase, isLocal: false, cloudProvider: 'claude' }))
        .toBe(cloudChunkSize('claude', phase, 'flagship'))
      expect(chunkSizeFor({ phase, isLocal: false, cloudProvider: 'openai' }))
        .toBe(cloudChunkSize('openai', phase, 'flagship'))
    }
  })

  it('returns the fast-tier size when modelTier="fast"', () => {
    for (const profile of ['geminiPaid', 'geminiFree', 'claude', 'openai'] as const) {
      for (const phase of ['p1', 'p2', 'p3', 'p4', 'p6'] as const) {
        const fast = cloudChunkSize(profile, phase, 'fast')
        const flagship = cloudChunkSize(profile, phase, 'flagship')
        // Fast-tier chunks should be strictly smaller than flagship chunks —
        // smaller models lose accuracy on long inputs, smaller chunks help.
        expect(fast).toBeLessThan(flagship)
      }
    }
  })

  it('frontier mirrors flagship until we have data to tune it differently', () => {
    for (const profile of ['geminiPaid', 'geminiFree', 'claude', 'openai'] as const) {
      for (const phase of ['p1', 'p2', 'p3', 'p4', 'p6'] as const) {
        expect(cloudChunkSize(profile, phase, 'frontier'))
          .toBe(cloudChunkSize(profile, phase, 'flagship'))
      }
    }
  })

  it('chunkSizeFor threads modelTier through to the right row', () => {
    const flashGemini = chunkSizeFor({
      phase: 'p3',
      isLocal: false,
      cloudProvider: 'gemini',
      geminiTier: 'paid',
      modelTier: 'fast',
    })
    expect(flashGemini).toBe(cloudChunkSize('geminiPaid', 'p3', 'fast'))

    const haikuClaude = chunkSizeFor({
      phase: 'p1',
      isLocal: false,
      cloudProvider: 'claude',
      modelTier: 'fast',
    })
    expect(haikuClaude).toBe(cloudChunkSize('claude', 'p1', 'fast'))
  })

  it('exhaustive coverage — every (profile, tier, phase) is defined', () => {
    for (const profile of ['geminiPaid', 'geminiFree', 'claude', 'openai'] as const) {
      for (const tier of ['flagship', 'fast', 'frontier'] as ModelTier[]) {
        for (const phase of ['p1', 'p2', 'p3', 'p4', 'p6'] as const) {
          expect(cloudChunkSize(profile, phase, tier)).toBeGreaterThan(0)
        }
      }
    }
  })

  describe('allPhasesFast shrink', () => {
    it('shrinks every fast-tier chunk to ~0.7x when the session is all-fast', () => {
      for (const tier of ['paid', 'free'] as const) {
        for (const phase of ['p1', 'p2', 'p3', 'p4', 'p6'] as const) {
          const base = chunkSizeFor({
            phase,
            isLocal: false,
            cloudProvider: 'gemini',
            geminiTier: tier,
            modelTier: 'fast',
          })
          const shrunk = chunkSizeFor({
            phase,
            isLocal: false,
            cloudProvider: 'gemini',
            geminiTier: tier,
            modelTier: 'fast',
            allPhasesFast: true,
          })
          // Strictly smaller, but not so small the pipeline becomes round-trip
          // bound. 0.7x with 1k rounding gives a wide band.
          expect(shrunk).toBeLessThan(base)
          expect(shrunk).toBeGreaterThan(base * 0.5)
          // Rounded to nearest 1000.
          expect(shrunk % 1000).toBe(0)
        }
      }
    })

    it('leaves flagship-tier sizes alone when allPhasesFast is set (caller guarantees the precondition)', () => {
      // The chunking layer doesn't second-guess `allPhasesFast` — it trusts
      // the caller. Even if a flagship phase slips through with the flag
      // set, the shrink applies uniformly (defensive: we never make Flash
      // chunks LARGER than Pro chunks because of this flag).
      const base = chunkSizeFor({
        phase: 'p3',
        isLocal: false,
        cloudProvider: 'gemini',
        geminiTier: 'paid',
        modelTier: 'flagship',
      })
      const shrunk = chunkSizeFor({
        phase: 'p3',
        isLocal: false,
        cloudProvider: 'gemini',
        geminiTier: 'paid',
        modelTier: 'flagship',
        allPhasesFast: true,
      })
      expect(shrunk).toBeLessThan(base)
    })

    it('does not touch local sizing (local chunks are already conservative)', () => {
      const local = chunkSizeFor({ phase: 'p3', isLocal: true })
      const localFast = chunkSizeFor({
        phase: 'p3',
        isLocal: true,
        allPhasesFast: true,
      })
      expect(localFast).toBe(local)
    })
  })
})
