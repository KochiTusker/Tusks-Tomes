import { describe, expect, it } from 'vitest'
import { estimateRunCost, rateFor, type PhaseRouting } from './pricing'

describe('rateFor — multi-provider pricing lookup', () => {
  it('returns Gemini Paid Pro rate', () => {
    expect(rateFor('gemini', 'paid', 'gemini-2.5-pro')).toEqual({
      input: 1.25, output: 10.0, cachedInput: 0.31,
    })
  })

  it('returns Gemini Free rate as zero', () => {
    expect(rateFor('gemini', 'free', 'gemini-2.5-flash')).toEqual({
      input: 0, output: 0, cachedInput: 0,
    })
  })

  it('returns Claude Sonnet rate', () => {
    expect(rateFor('claude', undefined, 'claude-sonnet-4-6')).toEqual({
      input: 3.0, output: 15.0,
    })
  })

  it('returns Claude Haiku rate', () => {
    expect(rateFor('claude', undefined, 'claude-haiku-4-5')).toEqual({
      input: 1.0, output: 5.0,
    })
  })

  it('returns OpenAI gpt-5 rate', () => {
    expect(rateFor('openai', undefined, 'gpt-5')).toEqual({
      input: 2.5, output: 10.0,
    })
  })

  it('falls back to a sane rate for unknown Gemini model (heuristic by name)', () => {
    const r = rateFor('gemini', 'paid', 'gemini-3-flash-experimental')
    expect(r.input).toBeGreaterThan(0)
    expect(r.output).toBeGreaterThan(0)
  })
})

describe('estimateRunCost — parity across all 3 providers', () => {
  // Realistic Session-24-sized inputs
  const SIZES = { transcriptChars: 292_000, kbChars: 381_000 }

  it('produces non-zero positive cost for Gemini Smart Budget', () => {
    const routing: Record<string, PhaseRouting> = {
      phase1_ground:    { provider: 'gemini', tier: 'free', model: 'gemini-2.5-flash' },
      phase2_audit:     { provider: 'gemini', tier: 'paid', model: 'gemini-2.5-flash' },
      phase3_chronicle: { provider: 'gemini', tier: 'paid', model: 'gemini-2.5-pro' },
      phase4_extras:    { provider: 'gemini', tier: 'paid', model: 'gemini-2.5-flash-lite' },
      phase6_condense:  { provider: 'gemini', tier: 'paid', model: 'gemini-2.5-flash-lite' },
    }
    const r = estimateRunCost({ routing, ...SIZES })
    expect(r.totalDollars).toBeGreaterThan(0.1)
    expect(r.totalDollars).toBeLessThan(2.0)
    expect(r.perPhase).toHaveLength(5)
  })

  it('produces non-zero positive cost for Claude Balanced', () => {
    const routing: Record<string, PhaseRouting> = {
      phase1_ground:    { provider: 'claude', model: 'claude-haiku-4-5' },
      phase2_audit:     { provider: 'claude', model: 'claude-haiku-4-5' },
      phase3_chronicle: { provider: 'claude', model: 'claude-sonnet-4-6' },
      phase4_extras:    { provider: 'claude', model: 'claude-haiku-4-5' },
      phase6_condense:  { provider: 'claude', model: 'claude-sonnet-4-6' },
    }
    const r = estimateRunCost({ routing, ...SIZES })
    expect(r.totalDollars).toBeGreaterThan(0.1)
    expect(r.perPhase).toHaveLength(5)
  })

  it('produces non-zero positive cost for OpenAI Balanced', () => {
    const routing: Record<string, PhaseRouting> = {
      phase1_ground:    { provider: 'openai', model: 'gpt-5-mini' },
      phase2_audit:     { provider: 'openai', model: 'gpt-5-mini' },
      phase3_chronicle: { provider: 'openai', model: 'gpt-5' },
      phase4_extras:    { provider: 'openai', model: 'gpt-5-mini' },
      phase6_condense:  { provider: 'openai', model: 'gpt-5' },
    }
    const r = estimateRunCost({ routing, ...SIZES })
    expect(r.totalDollars).toBeGreaterThan(0.1)
    expect(r.perPhase).toHaveLength(5)
  })

  it('Claude Opus chronicle is more expensive than Sonnet chronicle', () => {
    const sonnet: Record<string, PhaseRouting> = {
      phase3_chronicle: { provider: 'claude', model: 'claude-sonnet-4-6' },
    }
    const opus: Record<string, PhaseRouting> = {
      phase3_chronicle: { provider: 'claude', model: 'claude-opus-4-7' },
    }
    expect(estimateRunCost({ routing: opus, ...SIZES }).totalDollars).toBeGreaterThan(
      estimateRunCost({ routing: sonnet, ...SIZES }).totalDollars,
    )
  })

  it('mirror: gpt-5 chronicle is more expensive than gpt-5-mini chronicle', () => {
    const mini: Record<string, PhaseRouting> = {
      phase3_chronicle: { provider: 'openai', model: 'gpt-5-mini' },
    }
    const full: Record<string, PhaseRouting> = {
      phase3_chronicle: { provider: 'openai', model: 'gpt-5' },
    }
    expect(estimateRunCost({ routing: full, ...SIZES }).totalDollars).toBeGreaterThan(
      estimateRunCost({ routing: mini, ...SIZES }).totalDollars,
    )
  })
})
