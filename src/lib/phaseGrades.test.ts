import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SIZING,
  GEMINI_PRO_REFERENCE,
  MEASURED_GRADES,
  PHASE_ORDER,
  REFERENCE_SESSION,
  gradeFrom,
  judgeAllPhases,
  judgePhase,
  referenceSessionCost,
  structuralBlockers,
} from './phaseGrades'
import type { OpenRouterModelInfo } from './openrouterModelsClient'

function model(over: Partial<OpenRouterModelInfo> = {}): OpenRouterModelInfo {
  return {
    id: 'test/model',
    name: 'Test',
    inputPerM: 1,
    outputPerM: 3,
    contextLength: 1_000_000,
    maxCompletionTokens: 65_536,
    supportsStructuredOutputs: true,
    isModerated: false,
    isFree: false,
    inputModalities: ['text'],
    outputModalities: ['text'],
    ...over,
  }
}

describe('grades refuse to guess', () => {
  it('reports an unmeasured model as untested, not as good', () => {
    // The point of the rewrite. A model with no structural problem is UNKNOWN,
    // not fine — the previous scheme called it green, which was wrong in
    // exactly the cases that mattered.
    const v = judgePhase(model(), 'phase1')
    expect(v.grade).toBe('untested')
    expect(v.blockers).toEqual([])
  })

  it('never invents a letter for a capable-looking model', () => {
    const verdicts = judgeAllPhases(model({ id: 'some/excellent-model' }))
    for (const v of Object.values(verdicts)) {
      expect(['untested', 'F']).toContain(v.grade)
    }
  })

  it('uses a recorded measurement when one exists', () => {
    // Flash 3.5 is graded D on Ground from hands-on testing, despite clearing
    // every structural bar comfortably.
    const v = judgePhase(model({ id: 'google/gemini-3.5-flash' }), 'phase1')
    expect(v.grade).toBe('D')
    expect(v.source?.method).toBe('operator-report')
    expect(v.blockers).toEqual([])
  })

  it('requires every recorded grade to carry a dated source', () => {
    for (const [key, entry] of Object.entries(MEASURED_GRADES)) {
      expect(entry.source, key).toBeDefined()
      expect(entry.source.date, key).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  it('anchors on a Gemini Pro reference', () => {
    expect(GEMINI_PRO_REFERENCE).toContain('pro')
  })
})

describe('structural blockers force F without a measurement', () => {
  it('blocks a phase whose input cannot fit the context', () => {
    const v = judgePhase(model({ contextLength: 8_000 }), 'phase3')
    expect(v.grade).toBe('F')
    expect(v.blockers[0]).toContain('context')
  })

  it('blocks when the output ceiling is below what the phase produces', () => {
    const v = judgePhase(model({ maxCompletionTokens: 4_000 }), 'phase3')
    expect(v.grade).toBe('F')
    expect(v.blockers.join(' ')).toContain('cut off')
  })

  it('blocks the JSON phases when structured output is unsupported', () => {
    const m = model({ supportsStructuredOutputs: false })
    expect(judgePhase(m, 'phase2').grade).toBe('F')
    expect(judgePhase(m, 'phase4').grade).toBe('F')
    // ...but not the prose phases, which do not need it.
    expect(judgePhase(m, 'phase3').grade).toBe('untested')
  })

  it('blocks prose phases for models that write reasoning into the reply', () => {
    const m = model({ leaksReasoning: true })
    expect(judgePhase(m, 'phase1').grade).toBe('F')
    expect(judgePhase(m, 'phase3').grade).toBe('F')
    expect(judgePhase(m, 'phase6').grade).toBe('F')
    // Audit is JSON and gets parsed, so a preamble is recoverable there.
    expect(judgePhase(m, 'phase2').grade).toBe('untested')
  })

  it('lets a blocker override a good measurement, never the reverse', () => {
    const v = judgePhase(
      model({ id: 'google/gemini-3.5-flash', supportsStructuredOutputs: false }),
      'phase2',
    )
    expect(v.grade).toBe('F')
  })
})

describe('caveats', () => {
  it('flags that Claude has a weak sense of humour on Extras', () => {
    // First-hand comparison: asked for funny quotes it returns merely notable
    // lines where Gemini finds the joke.
    const v = judgePhase(model({ id: 'anthropic/claude-sonnet-4.5' }), 'phase4')
    expect(v.caveats.some((c) => /funny/i.test(c.text))).toBe(true)
    expect(v.caveats.some((c) => c.kind === 'observed')).toBe(true)
  })

  it('does not apply the humour caveat to unrelated phases', () => {
    const v = judgePhase(model({ id: 'anthropic/claude-sonnet-4.5' }), 'phase1')
    expect(v.caveats.some((c) => /funny/i.test(c.text))).toBe(false)
  })

  it('marks UNMEASURED Chinese-lab models as unverified for prose rather than bad', () => {
    // These have no bake-off entry on phase3. qwen in particular could not be
    // measured at all: no endpoint serving it satisfies the privacy floor.
    for (const id of ['qwen/qwen3-max', 'z-ai/glm-4.7']) {
      const v = judgePhase(model({ id }), 'phase3')
      expect(v.caveats.some((c) => /unverified|untested/i.test(c.text))).toBe(true)
      // Unverified is not a grade. It stays untested rather than marked down.
      expect(v.grade).toBe('untested')
    }
  })

  it('retires the unverified-prose caveat once the model has actually been run', () => {
    // The caveat's own exit condition is "until you have read a chronicle it
    // wrote". The 2026-08-18 bake-off did exactly that for these, so leaving
    // the warning up beside a measured grade would undercut better evidence
    // with weaker evidence.
    for (const id of ['deepseek/deepseek-v4-flash', 'z-ai/glm-5.2', 'moonshotai/kimi-k2.6']) {
      const v = judgePhase(model({ id }), 'phase3')
      expect(v.caveats.some((c) => /unverified/i.test(c.text))).toBe(false)
      expect(v.grade).not.toBe('untested')
      expect(v.source?.method).toBe('bake-off')
    }
  })

  it('keeps grades per-phase, so one model can be strong at one and weak at another', () => {
    // The concrete case the per-phase scheme exists for. Gemini Flash was
    // graded near the top of the field on Chronicle and near the bottom on
    // Extras, on real session material — a single overall score would have
    // averaged the two into something true of neither.
    const flash = model({ id: 'gemini-flash-latest' })
    expect(judgePhase(flash, 'phase3').grade).toBe('A')
    expect(judgePhase(flash, 'phase4').grade).toBe('C')
  })

  it('carries the configuration a model needs, not just its grade', () => {
    // This model looked unusable until the cause was found: it needs BOTH a
    // reasoning cap and a pinned serving provider, because several providers
    // accept the cap and ignore it. Graded on that configuration it is good
    // at both prose phases, so the caveat has to travel with the grade —
    // the grade is only true of a correctly configured run.
    const id = 'moonshotai/kimi-k3'
    expect(judgePhase(model({ id }), 'phase3').grade).toBe('B')
    expect(judgePhase(model({ id }), 'phase4').grade).toBe('A')
    const caveat = judgePhase(model({ id }), 'phase4').caveats.map((c) => c.text).join(' ')
    expect(caveat).toMatch(/effort/i)
    expect(caveat, 'the pin is half the fix and must be stated').toMatch(/pin/i)
  })

  it('does not assume a sibling model shares the same fix', () => {
    // The same cap-and-pin does NOT rescue this one: on the very provider that
    // honours the cap for its sibling it still reasons past fifteen thousand
    // tokens and returns nothing. Good on prose, unusable on extraction.
    const id = 'moonshotai/kimi-k2.6'
    expect(judgePhase(model({ id }), 'phase3').grade).toBe('B')
    expect(judgePhase(model({ id }), 'phase4').grade).toBe('D')
    expect(
      judgePhase(model({ id }), 'phase4').caveats.some((c) => /neither capping nor pinning/i.test(c.text)),
    ).toBe(true)
  })

  it('flags character-drift risk on the reproduction phases only', () => {
    const drifts = (phase: 'phase1' | 'phase2') =>
      judgePhase(model({ id: 'deepseek/deepseek-v4-flash' }), phase).caveats.some((c) =>
        /non-Latin/i.test(c.text),
      )
    expect(drifts('phase1')).toBe(true)
    expect(drifts('phase2')).toBe(false)
  })

  it('expects xAI to suit humour and mature content, without grading it', () => {
    const v = judgePhase(model({ id: 'x-ai/grok-4.6' }), 'phase4')
    expect(v.caveats.some((c) => c.kind === 'reported')).toBe(true)
    expect(v.grade).toBe('untested')
  })

  it('flags moderation on the mature phases', () => {
    expect(
      judgePhase(model({ isModerated: true }), 'phase3').caveats.some((c) =>
        /moderation/i.test(c.text),
      ),
    ).toBe(true)
  })

  it('flags free-tier reliability', () => {
    expect(
      judgePhase(model({ isFree: true }), 'phase2').caveats.some((c) =>
        /rate-limited/i.test(c.text),
      ),
    ).toBe(true)
  })
})

describe('reference session cost', () => {
  it('is a 3-hour session with 10,000 words of lore', () => {
    expect(REFERENCE_SESSION.transcriptChars).toBe(220_000)
    // 10,000 words at ~5.8 characters including spaces.
    expect(REFERENCE_SESSION.loreChars).toBe(58_000)
  })

  it('prices a Gemini-Pro-like model in a plausible range', () => {
    const c = referenceSessionCost(model({ inputPerM: 1.25, outputPerM: 10 }))
    expect(c.usd).toBeGreaterThan(0.5)
    expect(c.usd).toBeLessThan(5)
  })

  it('prices a cheap model far lower', () => {
    const cheap = referenceSessionCost(model({ inputPerM: 0.03, outputPerM: 0.17 })).usd
    const pro = referenceSessionCost(model({ inputPerM: 1.25, outputPerM: 10 })).usd
    expect(pro / cheap).toBeGreaterThan(15)
  })

  it('charges the higher band once a phase crosses a threshold', () => {
    // Condense carries the lore, so it has the longest prompt of any phase.
    const flat = referenceSessionCost(model({ inputPerM: 0.78, outputPerM: 3.9 })).usd
    const tiered = referenceSessionCost(
      model({
        inputPerM: 0.78,
        outputPerM: 3.9,
        pricingTiers: [{ minPromptTokens: 20_000, inputPerM: 1.56, outputPerM: 7.8 }],
      }),
    ).usd
    expect(tiered).toBeGreaterThan(flat)
  })

  it('does NOT cross the common 32k threshold at 10,000 words of lore', () => {
    // Worth pinning, because it is the difference between this reference
    // workload and a full Obsidian vault. Condense here sends about 28k prompt
    // tokens — just under the threshold several models raise their price at.
    // A 2 MB vault is ~557k tokens and crosses every published band.
    const flat = referenceSessionCost(model({ inputPerM: 0.78, outputPerM: 3.9 })).usd
    const tiered = referenceSessionCost(
      model({
        inputPerM: 0.78,
        outputPerM: 3.9,
        pricingTiers: [{ minPromptTokens: 32_000, inputPerM: 1.56, outputPerM: 7.8 }],
      }),
    ).usd
    expect(tiered).toBe(flat)
  })

  it('reports every phase with a call count', () => {
    const c = referenceSessionCost(model())
    expect(c.perPhase).toHaveLength(5)
    for (const p of c.perPhase) expect(p.chunks).toBeGreaterThan(0)
  })

  it('costs a free model nothing', () => {
    expect(referenceSessionCost(model({ inputPerM: 0, outputPerM: 0, isFree: true })).usd).toBe(0)
  })
})

describe('structuralBlockers on its own', () => {
  it('returns empty for a capable model', () => {
    expect(structuralBlockers(model(), 'phase1', DEFAULT_SIZING.phase1)).toEqual([])
  })
})

describe('the value rubric', () => {
  it('grades the reference itself B on every phase', () => {
    // B is the bar, not a criticism. Grading Pro an A would leave no way to
    // say "as good and half the price".
    const pro = judgeAllPhases(model({ id: 'google/gemini-3.1-pro-preview' }))
    for (const p of PHASE_ORDER) expect(pro[p].grade, p).toBe('B')
  })

  it('awards A for matching the reference at a lower price', () => {
    // Flash on Extras: full parity, fraction of the cost.
    expect(judgePhase(model({ id: 'google/gemini-3.1-flash' }), 'phase4').grade).toBe('A')
  })

  it('gives B when a small quality gap is offset by price', () => {
    // Flash on Condense: nearly level, so cheapness lifts it to B, not A.
    expect(judgePhase(model({ id: 'google/gemini-3.1-flash' }), 'phase6').grade).toBe('B')
  })

  it('does not let cheapness rescue a clear quality gap', () => {
    // Flash on Chronicle: Pro is visibly better and no discount closes that.
    expect(judgePhase(model({ id: 'google/gemini-3.1-flash' }), 'phase3').grade).toBe('C')
  })
})

describe('gradeFrom', () => {
  it('awards A for better output regardless of price', () => {
    expect(gradeFrom('better', false)).toBe('A')
    expect(gradeFrom('better', true)).toBe('A')
  })

  it('splits comparable output on price alone', () => {
    expect(gradeFrom('comparable', true)).toBe('A')
    expect(gradeFrom('comparable', false)).toBe('B')
  })

  it('lets price lift a small gap by exactly one step', () => {
    expect(gradeFrom('slightly-below', true)).toBe('B')
    expect(gradeFrom('slightly-below', false)).toBe('C')
  })

  it('never lets price rescue a real quality gap', () => {
    // No discount makes a bad chronicle worth keeping.
    expect(gradeFrom('below', true)).toBe('C')
    expect(gradeFrom('well-below', true)).toBe('D')
  })
})

describe('grades are per phase, never per model', () => {
  it('gives one model different grades across phases', () => {
    // Flash 3.5 is the live example: poor at the mechanical phases, level with
    // Pro on Extras. A single overall score would average that into something
    // true of no phase.
    const v = judgeAllPhases(model({ id: 'google/gemini-3.5-flash' }))
    expect(v.phase1.grade).toBe('D')
    expect(v.phase2.grade).toBe('D')
    expect(v.phase4.grade).toBe('A')
    expect(new Set(PHASE_ORDER.map((p) => v[p].grade)).size).toBeGreaterThan(2)
  })

  it('lets a model be unusable on one phase and strong on another', () => {
    // Chronicle emits ~6,750 tokens at the default chunk; Audit and Extras emit
    // a few hundred. A 4k ceiling therefore blocks one phase outright and is
    // irrelevant to the others — the same model, genuinely unusable in one
    // place and fine in another.
    const v = judgeAllPhases(model({ maxCompletionTokens: 4_000 }))
    expect(v.phase3.grade).toBe('F')
    expect(v.phase2.grade).not.toBe('F')
    expect(v.phase4.grade).not.toBe('F')
  })

  it('scopes a family grade to the phases it was assessed on', () => {
    // The Claude humour finding is about Extras. It must not leak into
    // Chronicle, where Claude has no measured grade at all.
    const v = judgeAllPhases(model({ id: 'anthropic/claude-sonnet-4.5' }))
    expect(v.phase4.grade).toBe('C')
    expect(v.phase3.grade).toBe('untested')
  })

  it('applies a blocker to one phase without touching the others', () => {
    // Reasoning written into the reply ruins prose but survives JSON parsing.
    const v = judgeAllPhases(model({ leaksReasoning: true }))
    expect(v.phase1.grade).toBe('F')
    expect(v.phase3.grade).toBe('F')
    expect(v.phase2.grade).toBe('untested')
  })
})
