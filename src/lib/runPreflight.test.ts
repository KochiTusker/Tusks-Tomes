import { describe, expect, it } from 'vitest'
import { estimateRunCost, type PhaseRouting } from './pricing'
import { callsForRun, preflight } from './runPreflight'

const RESETS = '2026-08-19T00:00:00.000Z'

describe('callsForRun', () => {
  it('sums chunks across every phase', () => {
    const routing: Record<string, PhaseRouting> = {
      phase1_ground: { provider: 'gemini', tier: 'paid', model: 'gemini-2.5-pro' },
      phase2_audit: { provider: 'gemini', tier: 'paid', model: 'gemini-2.5-pro' },
      phase3_chronicle: { provider: 'gemini', tier: 'paid', model: 'gemini-2.5-pro' },
      phase4_extras: { provider: 'gemini', tier: 'paid', model: 'gemini-2.5-pro' },
      phase6_condense: { provider: 'gemini', tier: 'paid', model: 'gemini-2.5-pro' },
    }
    const estimate = estimateRunCost({ routing, transcriptChars: 220_000, kbChars: 50_000 })
    const calls = callsForRun(estimate)
    expect(calls).toBe(estimate.perPhase.reduce((s, p) => s + p.chunks, 0))
    // A 3-hour session on the default paid rows is a couple of dozen calls.
    expect(calls).toBeGreaterThan(15)
    expect(calls).toBeLessThan(40)
  })
})

describe('preflight', () => {
  it('passes silently when no cap applies — the paid-model case', () => {
    // OpenRouter applies no platform request cap to paid models. Unknown must
    // read as unlimited, never as zero.
    const v = preflight({ callsNeeded: 500, remaining: null, resetsAt: RESETS })
    expect(v.ok).toBe(true)
    expect(v.message).toBeNull()
    expect(v.shortfall).toBe(0)
  })

  it('fails a run that cannot finish, naming the shortfall', () => {
    const v = preflight({ callsNeeded: 26, remaining: 12, resetsAt: RESETS })
    expect(v.ok).toBe(false)
    expect(v.shortfall).toBe(14)
    expect(v.message).toContain('26')
    expect(v.message).toContain('12')
    expect(v.message).toContain('14 short')
  })

  it('tells the user when the allowance resets rather than just refusing', () => {
    const v = preflight({ callsNeeded: 26, remaining: 12, resetsAt: RESETS })
    expect(v.message).toContain('2026-08-19 00:00 UTC')
  })

  it('passes quietly when the run is a small share of what is left', () => {
    // 26 of 1000 — the post-top-up tier. No need to say anything.
    const v = preflight({ callsNeeded: 26, remaining: 1000, resetsAt: RESETS })
    expect(v.ok).toBe(true)
    expect(v.message).toBeNull()
  })

  it('warns when a run fits but consumes nearly everything left', () => {
    // Technically fine, but landing on 2 remaining is worth knowing about
    // before starting rather than after.
    const v = preflight({ callsNeeded: 26, remaining: 28, resetsAt: RESETS })
    expect(v.ok).toBe(true)
    expect(v.message).toContain('will leave 2')
  })

  it('treats an exact fit as passing', () => {
    const v = preflight({ callsNeeded: 26, remaining: 26, resetsAt: RESETS })
    expect(v.ok).toBe(true)
    expect(v.shortfall).toBe(0)
  })

  it('fails when nothing is left at all', () => {
    const v = preflight({ callsNeeded: 1, remaining: 0, resetsAt: RESETS })
    expect(v.ok).toBe(false)
    expect(v.shortfall).toBe(1)
  })

  it('honours a custom warn threshold', () => {
    const lenient = preflight({
      callsNeeded: 26,
      remaining: 40,
      resetsAt: RESETS,
      warnThreshold: 0.9,
    })
    expect(lenient.message).toBeNull()
    const strict = preflight({
      callsNeeded: 26,
      remaining: 40,
      resetsAt: RESETS,
      warnThreshold: 0.5,
    })
    expect(strict.message).not.toBeNull()
  })

  it('degrades gracefully on an unparseable reset timestamp', () => {
    const v = preflight({ callsNeeded: 26, remaining: 12, resetsAt: 'nonsense' })
    expect(v.message).toContain('the next UTC midnight')
  })

  it('models the real scenario: one 3-hour session against the 50/day tier', () => {
    // Before any credit purchase the cap is 50/day. A single session fits;
    // a second one the same day does not.
    const routing: Record<string, PhaseRouting> = {
      phase1_ground: { provider: 'openrouter', model: 'openai/gpt-oss-120b' },
      phase2_audit: { provider: 'openrouter', model: 'openai/gpt-oss-120b' },
      phase3_chronicle: { provider: 'openrouter', model: 'openai/gpt-oss-120b' },
      phase4_extras: { provider: 'openrouter', model: 'openai/gpt-oss-120b' },
      phase6_condense: { provider: 'openrouter', model: 'openai/gpt-oss-120b' },
    }
    const calls = callsForRun(
      estimateRunCost({ routing, transcriptChars: 220_000, kbChars: 50_000 }),
    )
    expect(preflight({ callsNeeded: calls, remaining: 50, resetsAt: RESETS }).ok).toBe(true)
    expect(preflight({ callsNeeded: calls, remaining: 50 - calls, resetsAt: RESETS }).ok).toBe(false)
  })
})
