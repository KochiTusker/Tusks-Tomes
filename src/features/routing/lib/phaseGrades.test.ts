import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SIZING,
  GEMINI_PRO_REFERENCE,
  GRADE_MEANING,
  MEASURED_GRADES,
  PHASE_ORDER,
  REFERENCE_SESSION,
  PREDICTED_GRADES,
  baseModelId,
  lineageMeasurement,
  modelLineage,
  gradeFrom,
  gradePhase1Run,
  PHASE1_RUBRIC,
  isIndirectGrade,
  judgeAllPhases,
  judgePhase,
  overallVerdict,
  referenceSessionCost,
  structuralBlockers,
  type Grade,
  type Phase,
  type PhaseVerdict,
  lineageVersion,
} from './phaseGrades'
import type { OpenRouterModelInfo } from '@/features/providers'

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
    // Chronicle emits ~2,400 tokens from the default 30,000-char chunk
    // (OUTPUT_RATIO.phase3, measured). The ceiling has to sit under that to
    // block; 4,000 used to, back when the ratio claimed ~6,750.
    const v = judgePhase(model({ maxCompletionTokens: 2_000 }), 'phase3')
    expect(v.grade).toBe('F')
    expect(v.blockers.join(' ')).toContain('cut off')
  })

  it('does not block a model that clears the measured output size', () => {
    // The other side of the same correction, and the reason it matters beyond
    // cost: a ratio that overstates output rules out models that would have
    // run the phase. 4,000 is comfortably above the ~2,400 Chronicle emits.
    const v = judgePhase(model({ maxCompletionTokens: 4_000 }), 'phase3')
    expect(v.blockers.join(' ')).not.toContain('cut off')
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
      // Unverified is not a grade. Whatever letter these carry must not be a
      // markdown FOR being unverified, and it must not read as measured.
      expect(['C', 'D', 'F']).not.toContain(v.grade)
      // Either kind of indirect letter is acceptable here; what is not is a
      // letter presented as a measurement of this model.
      expect(isIndirectGrade(v)).toBe(true)
      expect(['prediction', 'sibling-measurement']).toContain(v.source?.method)
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
    expect(judgePhase(model({ id }), 'phase4').grade).toBe('B')
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
    // A reported caveat is not a measurement and must never become one. The
    // letter here is indirect either way, and says which kind it is.
    expect(isIndirectGrade(v)).toBe(true)
    expect(['prediction', 'sibling-measurement']).toContain(v.source?.method)
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
  it('lets the reference earn its grade instead of defining it', () => {
    // Pro used to be pinned at B on every phase by definition, which made the
    // best-measured model in the catalogue read as middling and left the scale
    // unable to say anything about the reference at all. It is now graded like
    // everything else: top of the Ground rubric, and genuinely weak at Extras.
    const pro = judgeAllPhases(model({ id: 'gemini-pro-latest' }))
    expect(pro.phase1.grade).toBe('A')
    expect(pro.phase4.grade).toBe('C')
    expect(new Set(PHASE_ORDER.map((p) => pro[p].grade)).size).toBeGreaterThan(1)
  })

  it('states quality without reference to price', () => {
    // The scale's own wording must not reintroduce the axis that was removed.
    for (const meaning of Object.values(GRADE_MEANING)) {
      expect(meaning).not.toMatch(/cheap|price|money|cost/i)
    }
  })

  it('reserves A for the top of the rubric, which price cannot buy', () => {
    // Flash grounds 5/6 at full fidelity and costs a sixth of Pro. Under the
    // old scale that combination WAS an A. Now the cheapness is a column and
    // the letter is the one correction it missed.
    expect(judgePhase(model({ id: 'google/gemini-3.1-flash' }), 'phase1').grade).toBe('B')
    expect(judgePhase(model({ id: 'gemini-pro-latest' }), 'phase1').grade).toBe('A')
  })

  it('gives B when a small quality gap is offset by price', () => {
    // Flash on Condense: nearly level, so cheapness lifts it to B, not A.
    expect(judgePhase(model({ id: 'google/gemini-3.1-flash' }), 'phase6').grade).toBe('B')
  })

  it('does not let cheapness rescue a clear quality gap', () => {
    // Flash on Extras: thin quotes and few jests. Cheapness does not close a
    // gap in what the phase is actually for.
    expect(judgePhase(model({ id: 'google/gemini-3.1-flash' }), 'phase4').grade).toBe('C')
  })
})

describe('gradeFrom', () => {
  it('maps quality straight onto a letter, with no second axis', () => {
    expect(gradeFrom('better')).toBe('A')
    expect(gradeFrom('comparable')).toBe('B')
    expect(gradeFrom('slightly-below')).toBe('C')
    expect(gradeFrom('below')).toBe('D')
    expect(gradeFrom('well-below')).toBe('F')
  })

  it('takes one argument, because there is one axis', () => {
    // It used to take `cheaperThanReference` and lift a grade a step for it,
    // which made A mean both "excellent" and "adequate but cheap" and froze a
    // price judgement into a letter that outlived the price behind it.
    expect(gradeFrom).toHaveLength(1)
  })
})

describe('the Ground rubric', () => {
  it('reproduces the grades of the models actually measured on it', () => {
    // The eleven Ground runs, scored by the written rubric rather than by
    // recall. If this drifts, either the rubric or a grade is wrong.
    const run = (c: number, lengthRatio: number, tagsKept: number) =>
      gradePhase1Run({ correctionsFound: c, correctionsPossible: 6, lengthRatio, tagsKept, tagsTotal: 609 })
    expect(run(6, 1.0, 609)).toBe('A') // gemini-pro-latest
    expect(run(5, 1.0, 609)).toBe('B') // gemini-flash-latest, claude-haiku-4.5
    expect(run(4, 1.0, 609)).toBe('C') // qwen3-30b-a3b
    expect(run(4, 0.99, 601)).toBe('C') // glm-4.7-flash
    expect(run(4, 0.96, 594)).toBe('C') // gpt-oss-120b, the loosest run still admitted
    expect(run(1, 1.0, 609)).toBe('D') // deepseek-v4-flash: faithful, grounds barely at all
    expect(run(0, 0.94, 561)).toBe('D') // nemotron-lightning: the silent no-op
  })

  it('caps a grade when the reproduction contract is broken', () => {
    // gpt-5-mini corrected as much as deepseek did but dropped 98 tags and 15%
    // of the length. Losing transcript is the worse failure on this phase.
    const faithful = gradePhase1Run({ correctionsFound: 5, correctionsPossible: 6, lengthRatio: 1.0, tagsKept: 609, tagsTotal: 609 })
    const lossy = gradePhase1Run({ correctionsFound: 5, correctionsPossible: 6, lengthRatio: 0.85, tagsKept: 511, tagsTotal: 609 })
    expect(faithful).toBe('B')
    expect(lossy).toBe('D')
  })

  it('fails a run that returned something other than the transcript', () => {
    // nemotron-3-super wrote its deliberation into the output: 3.49x length,
    // zero tags. That is not a low score, it is not the artefact at all.
    expect(
      gradePhase1Run({ correctionsFound: 0, correctionsPossible: 6, lengthRatio: 3.49, tagsKept: 0, tagsTotal: 609 }),
    ).toBe('F')
  })

  it('keeps the answer key away from any model', () => {
    // The first key came from a Gemini Pro run, which made Pro's own 6/6
    // circular. The rubric says where the key belongs instead.
    const doc = PHASE1_RUBRIC
    expect(doc.fidelityGate.minTagSurvival).toBeGreaterThan(0.9)
    expect(doc.corrections[0].grade).toBe('A')
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
    expect(v.phase6.grade).toBe('B')
    expect(new Set(PHASE_ORDER.map((p) => v[p].grade)).size).toBeGreaterThan(2)
  })

  it('lets a model be unusable on one phase and strong on another', () => {
    // Chronicle emits ~2,400 tokens at the default chunk; Audit emits ~75 and
    // Extras ~375. A 2k ceiling therefore blocks one phase outright and is
    // irrelevant to the others — the same model, genuinely unusable in one
    // place and fine in another.
    const v = judgeAllPhases(model({ maxCompletionTokens: 2_000 }))
    expect(v.phase3.grade).toBe('F')
    expect(v.phase2.grade).not.toBe('F')
    expect(v.phase4.grade).not.toBe('F')
  })

  it('scopes a family grade to the phases it was assessed on', () => {
    // The Claude humour finding is about Extras. It must not leak into
    // Chronicle, where Claude has no measured grade at all.
    const v = judgeAllPhases(model({ id: 'anthropic/claude-sonnet-4.5' }))
    expect(v.phase4.grade).toBe('C')
    expect(v.phase4.predicted).toBeFalsy()
    // Chronicle must not inherit the Extras C. It may carry a prediction of
    // its own — what it may not do is present that C as if it applied here.
    expect(v.phase3.predicted).toBe(true)
    expect(v.phase3.grade).not.toBe('C')
  })

  it('applies a blocker to one phase without touching the others', () => {
    // Reasoning written into the reply ruins prose but survives JSON parsing.
    const v = judgeAllPhases(model({ leaksReasoning: true }))
    expect(v.phase1.grade).toBe('F')
    expect(v.phase3.grade).toBe('F')
    expect(v.phase2.grade).toBe('untested')
  })
})

describe('predicted grades', () => {
  it('never awards an A', () => {
    // A means "better than the reference, or as good for less money". Only a
    // real comparison can establish that, so the prediction ceiling is B. This
    // is the invariant that keeps an A worth reading.
    for (const rule of PREDICTED_GRADES) {
      expect(rule.grade).not.toBe('A')
    }
  })

  it('says so on the verdict, and carries its reasoning', () => {
    const v = judgePhase(model({ id: 'anthropic/claude-opus-5' }), 'phase3')
    expect(v.predicted).toBe(true)
    expect(v.source?.method).toBe('prediction')
    expect(v.source?.note).toBeTruthy()
  })

  it('never overrides a measurement', () => {
    // gpt-5-nano is measured F on Ground — it refused the task outright. The
    // nano prediction rule would say D. The measurement has to win.
    const v = judgePhase(model({ id: 'openai/gpt-5-nano' }), 'phase1')
    expect(v.grade).toBe('F')
    expect(v.predicted).toBeFalsy()
    expect(v.source?.method).toBe('bake-off')
  })

  it('leaves a model it has no pattern for genuinely untested', () => {
    // The line the prediction layer must not cross. A vendor with no track
    // record, no declared size and no product category to read gets nothing,
    // rather than a letter with nothing behind it.
    expect(judgePhase(model({ id: 'test/model' }), 'phase3').grade).toBe('untested')
  })

  it('reads a purpose off the model, not a quality judgement', () => {
    expect(judgePhase(model({ id: 'meta-llama/llama-guard-4-12b' }), 'phase3').grade).toBe('F')
    expect(judgePhase(model({ id: 'relace/relace-apply-3' }), 'phase3').grade).toBe('F')
    expect(judgePhase(model({ id: 'perplexity/sonar-pro' }), 'phase3').grade).toBe('F')
  })

  it('grades a creative finetune on prose above its JSON phases', () => {
    // The split is the useful part: these are worth reaching for on Chronicle
    // and a bad idea on the phases that must return strict JSON.
    const id = 'thedrummer/rocinante-12b'
    expect(judgePhase(model({ id }), 'phase3').grade).toBe('C')
    expect(judgePhase(model({ id }), 'phase4').grade).toBe('D')
  })
})

describe('delivery channels inherit what is known about the model', () => {
  it('applies a measured grade to the :free twin of the same weights', () => {
    // A measured D reappearing as an untested :free twin was a real gap: the
    // filter hid one and offered the other.
    const paid = judgePhase(model({ id: 'nvidia/nemotron-3.5-lightning' }), 'phase1')
    const free = judgePhase(model({ id: 'nvidia/nemotron-3.5-lightning:free', isFree: true }), 'phase1')
    expect(free.grade).toBe(paid.grade)
  })

  it('applies it to a :batch endpoint too', () => {
    const plain = judgePhase(model({ id: 'google/gemini-3.5-flash' }), 'phase1')
    const batch = judgePhase(model({ id: 'google/gemini-3.5-flash:batch' }), 'phase1')
    expect(batch.grade).toBe(plain.grade)
  })

  it('strips only the channel, never part of the model name', () => {
    expect(baseModelId('~google/gemini-pro-latest')).toBe('google/gemini-pro-latest')
    expect(baseModelId('qwen/qwen3-8b:free')).toBe('qwen/qwen3-8b')
    expect(baseModelId('openai/gpt-5.4:batch')).toBe('openai/gpt-5.4')
    expect(baseModelId('anthropic/claude-opus-5')).toBe('anthropic/claude-opus-5')
  })
})

describe('overallVerdict', () => {
  const of = (grades: Partial<Record<Phase, Grade>>, predicted: Phase[] = []) => {
    const verdicts = {} as Record<Phase, PhaseVerdict>
    for (const p of PHASE_ORDER) {
      verdicts[p] = {
        grade: grades[p] ?? 'untested',
        blockers: [],
        caveats: [],
        predicted: predicted.includes(p),
      }
    }
    return overallVerdict(verdicts)
  }

  it('averages only the phases that carry a letter', () => {
    // An unknown is not a bad score, so it must not drag the mean toward the
    // middle of the scale.
    expect(of({ phase1: 'A', phase3: 'A' }).grade).toBe('A')
    expect(of({ phase1: 'A', phase3: 'A' }).gradedPhases).toBe(2)
  })

  it('is untested when nothing is known', () => {
    const o = of({})
    expect(o.grade).toBe('untested')
    expect(o.gradedPhases).toBe(0)
    expect(o.predicted).toBe(false)
  })

  it('rounds the mean across mixed grades', () => {
    // B B B C C -> 2.6 -> B
    expect(of({ phase1: 'B', phase2: 'B', phase3: 'B', phase4: 'C', phase6: 'C' }).grade).toBe('B')
    // D D C -> 1.33 -> D
    expect(of({ phase1: 'D', phase2: 'D', phase3: 'C' }).grade).toBe('D')
  })

  it('counts as predicted unless every contributing grade was measured', () => {
    // One measurement must not launder four predictions into looking like
    // evidence, so the confidence is the weakest link rather than the best.
    expect(of({ phase1: 'B', phase3: 'B' }).predicted).toBe(false)
    expect(of({ phase1: 'B', phase3: 'B' }, ['phase3']).predicted).toBe(true)
  })

  it('reports how many phases cannot run at all', () => {
    expect(of({ phase1: 'F', phase2: 'F', phase3: 'B' }).blockedPhases).toBe(2)
  })
})

describe('lineage: one measurement covers a tier', () => {
  it('groups versions of the same tier under one key', () => {
    const sonnet = modelLineage('anthropic/claude-sonnet-5')
    expect(modelLineage('anthropic/claude-sonnet-4.8')).toBe(sonnet)
    expect(modelLineage('anthropic/claude-sonnet-4.6:batch')).toBe(sonnet)
    expect(modelLineage('~anthropic/claude-sonnet-latest')).toBe(sonnet)

    const flash = modelLineage('google/gemini-3.7-flash')
    expect(modelLineage('google/gemini-3.6-flash')).toBe(flash)
    expect(modelLineage('gemini-flash-latest')).toBe(flash)
  })

  it('reaches the same model through a subscription CLI and through OpenRouter', () => {
    // The CLI names it `claude-sonnet-5`; the catalogue names it
    // `anthropic/claude-sonnet-5`. A grade earned on one route is a fact about
    // the model, not about the route.
    expect(modelLineage('claude-sonnet-5')).toBe(modelLineage('anthropic/claude-sonnet-5'))
    expect(modelLineage('sonnet')).toBe(modelLineage('anthropic/claude-sonnet-4.8'))
    expect(modelLineage('gemini-pro-latest')).toBe(modelLineage('google/gemini-3.1-pro-preview'))
  })

  it('keeps tiers apart, because tier is what the measurements distinguish', () => {
    const flash = modelLineage('google/gemini-3.5-flash')
    expect(modelLineage('google/gemini-3.5-flash-lite')).not.toBe(flash)
    expect(modelLineage('google/gemini-3.1-pro-preview')).not.toBe(flash)
    expect(modelLineage('openai/gpt-5.4-mini')).not.toBe(modelLineage('openai/gpt-5.4'))
    expect(modelLineage('openai/gpt-5-nano')).not.toBe(modelLineage('openai/gpt-5-mini'))
  })

  it('declines to guess a lineage it cannot read', () => {
    expect(modelLineage('sakana/fugu-ultra')).toBe('sakana/fugu-ultra')
    expect(modelLineage('someunknownbaremodel')).toBeNull()
  })

  it('gives two versions of one tier the same grades', () => {
    // The whole point: 3.6 and 3.7 Flash were never run, but Flash was.
    for (const phase of PHASE_ORDER) {
      const a = judgePhase(model({ id: 'google/gemini-3.6-flash' }), phase)
      const b = judgePhase(model({ id: 'google/gemini-3.7-flash' }), phase)
      expect(a.grade, phase).toBe(b.grade)
    }
  })

  it('carries the Flash tier measurements onto an unrun version', () => {
    const v = judgeAllPhases(model({ id: 'google/gemini-3.7-flash' }))
    // Ground: measured B on the current Flash in the 2026-08-19 bake-off.
    expect(v.phase1.grade).toBe('B')
    // Audit: only ever measured on 3.5-flash, which failed it.
    expect(v.phase2.grade).toBe('D')
    // Inherited, not predicted: a real bake-off produced this letter, on a
    // sibling of the same tier. The two are separate flags precisely so this
    // grade is not filed as a guess.
    expect(v.phase1.inherited).toBe(true)
    expect(v.phase1.predicted).toBeFalsy()
    expect(v.phase1.source?.method).toBe('sibling-measurement')
    expect(v.phase1.source?.note).toContain('gemini-flash-latest')
  })

  it('never lets an old model borrow a newer sibling grade', () => {
    // Claude 3 Haiku is not what Haiku 4.5 measured, and inheriting that A
    // would be the most flattering possible reading of the oldest Claude here.
    expect(lineageMeasurement('anthropic/claude-3-haiku', 'phase1')).toBeNull()
    expect(judgePhase(model({ id: 'anthropic/claude-3-haiku' }), 'phase1').grade).not.toBe('A')
  })

  it('does not report a measurement as being of the model itself', () => {
    // The id that WAS measured keeps its own grade, unmarked.
    const v = judgePhase(model({ id: 'gemini-flash-latest' }), 'phase3')
    expect(v.predicted).toBeFalsy()
    expect(v.source?.method).toBe('bake-off')
  })
})

describe('evidence precedence', () => {
  it('prefers the newer of two findings about the same phase', () => {
    // Extras: an 18 Aug family note calling Flash level with Pro, and a 19 Aug
    // bake-off calling its output thin. The later one is what a reader needs.
    const v = judgePhase(model({ id: 'google/gemini-3.7-flash' }), 'phase4')
    expect(v.grade).toBe('C')
    expect(v.source?.date).toBe('2026-08-19')
  })

  it('breaks a same-day tie by how the finding was arrived at', () => {
    // Chronicle: a blind bake-off against the reference and a same-day
    // impression from ordinary use, disagreeing. The bake-off wins.
    const v = judgePhase(model({ id: 'google/gemini-3.7-flash' }), 'phase3')
    expect(v.grade).toBe('A')
    expect(v.source?.method).toBe('sibling-measurement')
  })

  it('still lets a family rule stand where it is the only or the newer word', () => {
    const v = judgePhase(model({ id: 'google/gemini-3.7-flash' }), 'phase6')
    expect(v.grade).toBe('B')
    expect(v.predicted).toBeFalsy()
  })
})

describe('lore sizing per phase', () => {
  it('sizes each phase for the lore it actually carries', () => {
    // Phases 1, 2 and 4 take the compact form, so they are sized alike. Phase 3
    // takes the reference lore in full. Phase 6 is sized without lore because
    // retrieval brings it within range, which structuralBlockers says outright.
    expect(DEFAULT_SIZING.phase2.kbChars).toBe(DEFAULT_SIZING.phase1.kbChars)
    expect(DEFAULT_SIZING.phase4.kbChars).toBe(DEFAULT_SIZING.phase1.kbChars)
    expect(DEFAULT_SIZING.phase3.kbChars).toBe(REFERENCE_SESSION.loreChars)
    expect(DEFAULT_SIZING.phase6.kbChars).toBe(0)
  })
})

describe('lineage: a size is a tier, not a version', () => {
  it('reads no declared size or date stamp as a version', () => {
    expect(lineageVersion('openai/gpt-oss-120b')).toBe(0)
    expect(lineageVersion('openai/gpt-oss-20b')).toBe(0)
    expect(lineageVersion('mistralai/ministral-8b-2512')).toBe(0)
    expect(lineageVersion('mistralai/ministral-3b-2512')).toBe(0)
    expect(lineageVersion('qwen/qwen3-30b-a3b-instruct-2507')).toBe(3)
    expect(lineageVersion('google/gemini-3.5-flash')).toBe(3.5)
    expect(lineageVersion('anthropic/claude-haiku-4.5')).toBe(4.5)
    expect(lineageVersion('gemini-pro-latest')).toBe(Number.POSITIVE_INFINITY)
  })

  it('keeps a declared size in the lineage, so a 20B cannot borrow a 120B grade', () => {
    expect(modelLineage('openai/gpt-oss-120b')).not.toBe(modelLineage('openai/gpt-oss-20b'))
    expect(modelLineage('mistralai/ministral-8b-2512')).not.toBe(
      modelLineage('mistralai/ministral-3b-2512'),
    )
    // Versions and channels still fold together.
    expect(modelLineage('anthropic/claude-sonnet-4.8')).toBe(
      modelLineage('anthropic/claude-sonnet-5:batch'),
    )
    expect(modelLineage('google/gemini-3.7-flash')).toBe(modelLineage('google/gemini-3.6-flash'))
  })

  it('does not hand gpt-oss-20b the measurement taken on gpt-oss-120b', () => {
    for (const phase of PHASE_ORDER) {
      expect(lineageMeasurement('openai/gpt-oss-20b', phase)?.fromId).not.toBe('openai/gpt-oss-120b')
    }
  })

  it('settles two measurements of one version by evidence, not by table order', () => {
    // gemini-pro-latest is measured on the Google key and, as
    // ~google/gemini-pro-latest, through OpenRouter. Both are `-latest`, so
    // the newer measurement must win whichever row the table lists first.
    const hit = lineageMeasurement('google/gemini-2.5-pro', 'phase3')
    expect(hit).not.toBeNull()
    const other =
      hit!.fromId === 'gemini-pro-latest' ? '~google/gemini-pro-latest' : 'gemini-pro-latest'
    const loser = MEASURED_GRADES[`${other}::phase3`]
    expect(loser).toBeDefined()
    expect(hit!.source.date >= loser!.source.date).toBe(true)
  })
})

describe('a prediction and an inherited grade are not the same claim', () => {
  // The bug this pins: a grade measured on a sibling was flagged `predicted`,
  // so a dashed A appeared beside a legend promising that predictions never
  // award an A. Both are drawn the same way and both mean "not measured on
  // this model" — but one is a guess and the other is a real run next door,
  // and only the guess carries the A ceiling.

  it('never lets a PREDICTION award an A, anywhere in the catalogue', () => {
    // The table-level guarantee, which the type already enforces.
    for (const rule of PREDICTED_GRADES) expect(rule.grade).not.toBe('A')
    // And the guarantee as a reader meets it: every verdict the engine can
    // actually produce, not just the rules it is built from. This is the
    // assertion that was passing vacuously while an A shipped beside it.
    for (const id of [
      'google/gemini-3.7-flash',
      'google/gemini-2.5-pro',
      'anthropic/claude-opus-5',
      'openai/gpt-5.5-nano',
      'openai/gpt-oss-20b',
      'z-ai/glm-4.7',
      'x-ai/grok-4.6',
      'test/model',
    ]) {
      for (const phase of PHASE_ORDER) {
        const v = judgePhase(model({ id }), phase)
        if (v.predicted === true) expect(v.grade).not.toBe('A')
      }
    }
  })

  it('files a sibling measurement as inherited, and keeps the letter it earned', () => {
    const v = judgePhase(model({ id: 'google/gemini-3.7-flash' }), 'phase3')
    expect(v.grade).toBe('A')
    expect(v.inherited).toBe(true)
    expect(v.predicted).toBeFalsy()
    expect(v.source?.method).toBe('sibling-measurement')
  })

  it('files a pattern rule as predicted, and never as inherited', () => {
    const v = judgePhase(model({ id: 'openai/gpt-5.5-nano' }), 'phase3')
    expect(v.predicted).toBe(true)
    expect(v.inherited).toBeFalsy()
    expect(v.source?.method).toBe('prediction')
  })

  it('never sets both flags on one verdict', () => {
    for (const id of ['google/gemini-3.7-flash', 'openai/gpt-5.5-nano', 'openai/gpt-5-nano']) {
      for (const phase of PHASE_ORDER) {
        const v = judgePhase(model({ id }), phase)
        expect(v.predicted === true && v.inherited === true).toBe(false)
      }
    }
  })

  it('draws both the same way, because both are "not measured here"', () => {
    const inherited = judgePhase(model({ id: 'google/gemini-3.7-flash' }), 'phase3')
    const predicted = judgePhase(model({ id: 'openai/gpt-5.5-nano' }), 'phase3')
    const measured = judgePhase(model({ id: 'openai/gpt-5-nano' }), 'phase1')
    expect(isIndirectGrade(inherited)).toBe(true)
    expect(isIndirectGrade(predicted)).toBe(true)
    expect(isIndirectGrade(measured)).toBe(false)
  })

  it('reports the two separately on the overall verdict', () => {
    const build = (flags: Partial<PhaseVerdict>) => {
      const verdicts = {} as Record<Phase, PhaseVerdict>
      for (const p of PHASE_ORDER) verdicts[p] = { grade: 'untested', blockers: [], caveats: [] }
      verdicts.phase1 = { grade: 'B', blockers: [], caveats: [], ...flags }
      return overallVerdict(verdicts)
    }
    expect(build({}).predicted).toBe(false)
    expect(build({}).inherited).toBe(false)
    expect(build({ inherited: true }).inherited).toBe(true)
    expect(build({ inherited: true }).predicted).toBe(false)
    expect(build({ predicted: true }).predicted).toBe(true)
    expect(build({ predicted: true }).inherited).toBe(false)
  })
})
