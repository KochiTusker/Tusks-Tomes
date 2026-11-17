// Tests for the routing picker's option model.
//
// Written around the mistakes this code is actually prone to rather than
// around coverage. Three shaped the design and each has an assertion here:
//
//   Grouping by the wrong axis. An earlier version grouped by model vendor,
//   which filed "Gemini on your Google key" and "Gemini through OpenRouter"
//   together — different price, different reliability, measurably different
//   output — and buried the subscription CLIs where nobody would look.
//
//   Treating a subscription as free. It is not: it has a cost, just not one
//   charged per call. Sorting it as zero asserts something untrue.
//
//   Recommending an unmeasured model. Every recommendation must trace to a
//   measurement, and a filter must never quietly promote a guess.

import { describe, expect, it } from 'vitest'
import {
  type PhaseOption,
  buildPhaseOptions,
  compareByCost,
  compareByValue,
  comparePhaseOptions,
  filterPhaseOptions,
  groupByConnection,
  groupOpenRouterByVendor,
  recommendedFor,
  recommendedPreview,
  RECOMMENDED_PREVIEW,
  foldersHolding,
  connectionFolder,
  vendorFolder,
} from './phaseOptions'

function opt(over: Partial<PhaseOption> = {}): PhaseOption {
  return {
    key: over.modelId ?? 'k',
    modelId: 'vendor/model',
    provider: 'openrouter',
    providerLabel: 'OpenRouter',
    connection: 'openrouter',
    vendor: 'vendor',
    grade: 'untested',
    cost: 1,
    pickRank: Number.MAX_SAFE_INTEGER,
    tested: false,
    mature: false,
    ...over,
  }
}

describe('cost ordering', () => {
  it('puts cheaper before dearer', () => {
    expect(compareByCost(opt({ cost: 0.1 }), opt({ cost: 0.9 }))).toBeLessThan(0)
  })

  it('sorts a subscription AFTER priced options, not as zero', () => {
    // Sorting "on your plan" as 0 would place it above a genuinely free local
    // model and below everything else — a claim the app cannot support.
    const plan = opt({ cost: null })
    const cheap = opt({ cost: 0.001 })
    expect(compareByCost(plan, cheap)).toBeGreaterThan(0)
    expect(compareByCost(cheap, plan)).toBeLessThan(0)
  })

  it('keeps a genuinely free local model at the cheap end', () => {
    // Local runs on the user's own hardware. That IS zero, unlike a plan.
    expect(compareByCost(opt({ cost: 0 }), opt({ cost: 0.001 }))).toBeLessThan(0)
  })
})

describe('sort keys', () => {
  const a = opt({ modelId: 'a', grade: 'A', cost: 5 })
  const c = opt({ modelId: 'c', grade: 'C', cost: 0.1 })
  const picked = opt({ modelId: 'p', grade: 'C', cost: 9, pickRank: 0 })

  it('ranks by grade under performance, price only as a tiebreak', () => {
    expect([c, a].sort(comparePhaseOptions('performance'))[0].modelId).toBe('a')
  })

  it('ignores grade under cost', () => {
    expect([a, c].sort(comparePhaseOptions('cost'))[0].modelId).toBe('c')
  })

  it("lets a pick outrank a better-graded model, because a pick is an opinion", () => {
    // Picks weigh speed and reliability, which no grade encodes. If grade won,
    // the pick ordering would be redundant with the performance sort.
    expect([a, picked].sort(comparePhaseOptions('picks'))[0].modelId).toBe('p')
  })

  it('puts F last under performance — below even unmeasured', () => {
    const f = opt({ modelId: 'f', grade: 'F' })
    const unknown = opt({ modelId: 'u', grade: 'untested' })
    expect([f, unknown].sort(comparePhaseOptions('performance'))[0].modelId).toBe('u')
  })
})

describe('filtering', () => {
  const list = [
    opt({ modelId: 'tested/one', tested: true }),
    opt({ modelId: 'mature/one', mature: true }),
    opt({ modelId: 'plain/one' }),
  ]

  it('narrows to tested models', () => {
    expect(filterPhaseOptions(list, { testedOnly: true }).map((o) => o.modelId)).toEqual([
      'tested/one',
    ])
  })

  it('narrows to models measured on mature content', () => {
    expect(filterPhaseOptions(list, { matureOnly: true }).map((o) => o.modelId)).toEqual([
      'mature/one',
    ])
  })

  it('combines filters rather than replacing one with the other', () => {
    expect(filterPhaseOptions(list, { testedOnly: true, matureOnly: true })).toEqual([])
  })

  it('searches the provider label too, so "openrouter" finds its models', () => {
    const hits = filterPhaseOptions(list, { query: 'openrouter' })
    expect(hits).toHaveLength(3)
  })
})

describe('grouping by connection, not by vendor', () => {
  const list = [
    opt({ modelId: 'gemini-pro-latest', connection: 'gemini', vendor: 'google', cost: 1 }),
    opt({ modelId: '~google/gemini-pro-latest', connection: 'openrouter', vendor: 'google', cost: 2 }),
    opt({ modelId: 'sonnet', connection: 'claudeCode', vendor: 'claudeCode', cost: null }),
  ]

  it('separates the same vendor reached two different ways', () => {
    // The bug this exists to prevent: these two share a vendor and nothing
    // else that matters — different price, different reliability, and in
    // blind comparison different output.
    const groups = Object.fromEntries(groupByConnection(list, 'cost'))
    expect(groups.gemini.map((o) => o.modelId)).toEqual(['gemini-pro-latest'])
    expect(groups.openrouter.map((o) => o.modelId)).toEqual(['~google/gemini-pro-latest'])
  })

  it('keeps the subscription CLI as its own group', () => {
    const keys = groupByConnection(list, 'cost').map(([c]) => c)
    expect(keys).toContain('claudeCode')
  })

  it('lists the short lists before the large catalogue', () => {
    // Someone scanning for "what do I already have" wants their own keys and
    // subscriptions first; four hundred catalogue entries are not that.
    const keys = groupByConnection(list, 'cost').map(([c]) => c)
    expect(keys.indexOf('openrouter')).toBe(keys.length - 1)
  })

  it('omits a connection with nothing in it rather than showing an empty folder', () => {
    const keys = groupByConnection(list, 'cost').map(([c]) => c)
    expect(keys).not.toContain('codex')
    expect(keys).not.toContain('local')
  })
})

describe('vendor sub-folders inside OpenRouter', () => {
  const list = [
    opt({ modelId: 'anthropic/x', vendor: 'anthropic' }),
    opt({ modelId: 'z-ai/y', vendor: 'z-ai', pickRank: 0, pick: { modelId: 'z-ai/y', reason: 'r', tag: 'balanced' } }),
    opt({ modelId: 'gemini-pro-latest', connection: 'gemini', vendor: 'google' }),
  ]

  it('covers only OpenRouter, since nothing else needs a second level', () => {
    const vendors = groupOpenRouterByVendor(list, 'cost').map(([v]) => v)
    expect(vendors).not.toContain('google')
  })

  it('floats a vendor holding a recommendation above the alphabetical rest', () => {
    const vendors = groupOpenRouterByVendor(list, 'cost').map(([v]) => v)
    expect(vendors[0]).toBe('z-ai')
  })
})

describe('the short list the picker opens on', () => {
  it('includes measured models and explicit picks, and nothing else', () => {
    const list = [
      opt({ modelId: 'graded', grade: 'B' }),
      opt({ modelId: 'picked', pickRank: 0, pick: { modelId: 'picked', reason: 'r', tag: 'value' } }),
      opt({ modelId: 'unknown' }),
    ]
    expect(recommendedFor(list, 'picks').map((o) => o.modelId).sort()).toEqual(['graded', 'picked'])
  })

  it('never recommends a model that cannot run the phase', () => {
    const list = [opt({ modelId: 'blocked', grade: 'F', blockedReason: 'context too small' })]
    expect(recommendedFor(list, 'performance')).toEqual([])
  })

  it('shows only the head of a long list, in sort order, until asked for all of it', () => {
    const many = Array.from({ length: 250 }, (_, i) => opt({ modelId: `m${i}`, key: `m${i}`, grade: 'B' }))
    const head = recommendedPreview(many, false)
    expect(head.shown).toEqual(many.slice(0, RECOMMENDED_PREVIEW))
    expect(head.hidden).toBe(250 - RECOMMENDED_PREVIEW)
    expect(recommendedPreview(many, true)).toEqual({ shown: many, hidden: 0 })
  })

  it('does not hide a row or two behind a control', () => {
    const few = Array.from({ length: RECOMMENDED_PREVIEW + 2 }, (_, i) => opt({ modelId: `m${i}`, key: `m${i}` }))
    expect(recommendedPreview(few, false)).toEqual({ shown: few, hidden: 0 })
  })
})

describe('folders the picker opens on', () => {
  const list = [
    opt({ key: 'cloud:gemini-paid:gemini-2.5-pro', modelId: 'gemini-2.5-pro', connection: 'gemini', provider: 'gemini', vendor: 'google' }),
    opt({ key: 'cloud:claude-code:sonnet', modelId: 'sonnet', connection: 'claudeCode', provider: 'claudeCode', vendor: 'claudeCode' }),
    opt({ key: 'cloud:openrouter:z-ai/glm-5', modelId: 'z-ai/glm-5', vendor: 'z-ai' }),
  ]

  it('opens the connection holding the current choice', () => {
    expect([...foldersHolding(list, 'cloud:claude-code:sonnet')]).toEqual([connectionFolder('claudeCode')])
    expect([...foldersHolding(list, 'cloud:gemini-paid:gemini-2.5-pro')]).toEqual([connectionFolder('gemini')])
  })

  it('opens the vendor sub-folder too when the choice is on OpenRouter', () => {
    expect(foldersHolding(list, 'cloud:openrouter:z-ai/glm-5')).toEqual(
      new Set([connectionFolder('openrouter'), vendorFolder('z-ai')]),
    )
  })

  it('opens nothing when there is no choice, or it is no longer offered', () => {
    expect(foldersHolding(list, null).size).toBe(0)
    expect(foldersHolding(list, 'cloud:openrouter:gone/model').size).toBe(0)
  })
})

describe('building the option list from what is configured', () => {
  const catalogueModel = {
    id: 'z-ai/glm-5.2',
    name: 'GLM 5.2',
    inputPerM: 0.48,
    outputPerM: 1.5,
    contextLength: 1_000_000,
    maxCompletionTokens: 131_072,
    supportsStructuredOutputs: true,
    isModerated: false,
    isFree: false,
    inputModalities: ['text'],
    outputModalities: ['text'],
  } as unknown as Parameters<typeof buildPhaseOptions>[0]['openRouterModels'][number]

  const geminiKey = {
    id: 'gemini-paid',
    provider: 'gemini',
    geminiTier: 'paid',
    label: 'Google Gemini — Paid',
    short: 'Gemini Paid',
    slot: 'gemini',
  } as unknown as Parameters<typeof buildPhaseOptions>[0]['cloudKeyOptions'][number]

  const claudeCodeKey = {
    id: 'claude-code',
    provider: 'claudeCode',
    label: 'Claude Code (your subscription)',
    short: 'Claude Code',
    slot: 'claudeCode',
  } as unknown as Parameters<typeof buildPhaseOptions>[0]['cloudKeyOptions'][number]

  const build = (over: Partial<Parameters<typeof buildPhaseOptions>[0]> = {}) =>
    buildPhaseOptions({
      phase: 'phase3',
      cloudKeyOptions: [geminiKey, claudeCodeKey],
      availability: {},
      openRouterModels: [catalogueModel],
      measuredGrades: {},
      ...over,
    })

  it('prices a subscription as unknown, never as zero', () => {
    // "Included in your plan" and "free" are different claims. Only one of
    // them is true, and the app cannot make the other.
    const cc = build().filter((o) => o.connection === 'claudeCode')
    expect(cc.length).toBeGreaterThan(0)
    for (const o of cc) expect(o.cost).toBeNull()
  })

  it('gives a Gemini model a real per-phase figure', () => {
    // Gemini has no static model list by design — an unprobed key yields
    // nothing rather than a guess — so the cache has to supply one here.
    const built = build({
      availability: {
        gemini: { fetchedAt: 't', advertised: ['gemini-pro-latest'] },
      } as unknown as Parameters<typeof buildPhaseOptions>[0]['availability'],
    })
    const gem = built.find((o) => o.connection === 'gemini')
    expect(gem, 'no Gemini option was built').toBeDefined()
    expect(gem!.cost).toBeGreaterThan(0)
  })

  it('offers no Gemini models until the key has been probed or advertised', () => {
    // The behaviour the fixture above works around, asserted deliberately:
    // an unprobed Gemini key shows nothing rather than a plausible-looking
    // list the key may not actually be able to call.
    expect(build().some((o) => o.connection === 'gemini')).toBe(false)
  })

  it('offers no catalogue models when no OpenRouter key is configured', () => {
    // The catalogue is public and loads regardless; offering a model the user
    // cannot call is not a choice.
    const built = buildPhaseOptions({
      phase: 'phase3',
      cloudKeyOptions: [geminiKey],
      availability: {},
      openRouterModels: [],
      measuredGrades: {},
    })
    expect(built.some((o) => o.connection === 'openrouter')).toBe(false)
  })

  it('assigns every option a connection, so nothing falls out of the grouping', () => {
    for (const o of build()) expect(o.connection).toBeTruthy()
  })

  it('marks a model measured on ANY phase as tested, not just this one', () => {
    // A model graded on Chronicle is a known quantity when you are looking at
    // Condense, in a way an untouched catalogue entry is not.
    const built = build({ measuredGrades: { 'z-ai/glm-5.2::phase4': { grade: 'B' } } })
    expect(built.find((o) => o.modelId === 'z-ai/glm-5.2')?.tested).toBe(true)
  })

  it('skips a local model that is not eligible for the phase', () => {
    const built = build({
      localProbes: [
        { modelId: 'llama', backend: 'ollama', baseUrl: 'http://x', eligible: { phase3: false } },
      ],
    })
    expect(built.some((o) => o.connection === 'local')).toBe(false)
  })
})

describe('value ordering — quality per dollar', () => {
  const sorted = (...os: PhaseOption[]) =>
    [...os].sort(compareByValue).map((o) => o.modelId)

  it('prefers the better ratio, not the better letter', () => {
    // The whole point of separating the letter from the price: a B at a tenth
    // of the cost is a better buy than an A, and the sort says so.
    const cheapB = opt({ modelId: 'cheap-B', grade: 'B', cost: 0.1 })
    const dearA = opt({ modelId: 'dear-A', grade: 'A', cost: 1 })
    expect(sorted(dearA, cheapB)).toEqual(['cheap-B', 'dear-A'])
  })

  it('puts a free graded model at the top rather than dividing by zero', () => {
    const free = opt({ modelId: 'free-B', grade: 'B', cost: 0 })
    const cheap = opt({ modelId: 'cheap-A', grade: 'A', cost: 0.01 })
    expect(sorted(cheap, free)).toEqual(['free-B', 'cheap-A'])
  })

  it('ranks a D above an A when the D is cheap enough', () => {
    // Deliberate and pinned rather than discovered: at a hundredth of the
    // price a D wins a ratio sort outright. That is what "quality per dollar"
    // means, and the grade shown on the row is what stops it being a trap —
    // so if this ever reads wrong, the fix is a floor on the letter, not a
    // quiet change to the arithmetic.
    const cheapD = opt({ modelId: 'cheap-D', grade: 'D', cost: 0.01 })
    const dearA = opt({ modelId: 'dear-A', grade: 'A', cost: 1 })
    expect(sorted(dearA, cheapD)).toEqual(['cheap-D', 'dear-A'])
  })

  it('treats an F and an untested model as worthless at any price', () => {
    // Zero quality divided by any price is still zero, so neither can buy its
    // way up the list. They sort below anything with a letter that works.
    const f = opt({ modelId: 'f', grade: 'F', cost: 0.001 })
    const untested = opt({ modelId: 'untested', grade: 'untested', cost: 0.001 })
    const d = opt({ modelId: 'd', grade: 'D', cost: 10 })
    expect(sorted(f, untested, d)[0]).toBe('d')
  })

  it('orders the two worthless kinds by grade, so untested beats a measured F', () => {
    const f = opt({ modelId: 'f', grade: 'F', cost: 1 })
    const untested = opt({ modelId: 'untested', grade: 'untested', cost: 1 })
    expect(sorted(f, untested)).toEqual(['untested', 'f'])
  })

  it('places a subscription model after every priced one', () => {
    // A plan costs something; it is just not charged per call. Calling that
    // zero would hand the top of a value sort to an accounting artefact.
    const plan = opt({ modelId: 'plan-A', grade: 'A', cost: null })
    const priced = opt({ modelId: 'priced-D', grade: 'D', cost: 5 })
    expect(sorted(plan, priced)).toEqual(['priced-D', 'plan-A'])
  })

  it('orders unpriced options among themselves by grade', () => {
    const planA = opt({ modelId: 'plan-A', grade: 'A', cost: null })
    const planC = opt({ modelId: 'plan-C', grade: 'C', cost: null })
    expect(sorted(planC, planA)).toEqual(['plan-A', 'plan-C'])
  })

  it('breaks an equal ratio on the better grade', () => {
    // B at 0.3 and A at 0.4 both come to 10 per dollar. The stronger letter
    // takes it, because the tie means the money says nothing.
    const b = opt({ modelId: 'b', grade: 'B', cost: 0.3 })
    const a = opt({ modelId: 'a', grade: 'A', cost: 0.4 })
    expect(sorted(b, a)).toEqual(['a', 'b'])
  })

  it('is a total order: sorting is stable whichever way the input arrives', () => {
    const all = [
      opt({ modelId: 'free-B', grade: 'B', cost: 0 }),
      opt({ modelId: 'cheap-D', grade: 'D', cost: 0.01 }),
      opt({ modelId: 'dear-A', grade: 'A', cost: 1 }),
      opt({ modelId: 'plan-A', grade: 'A', cost: null }),
      opt({ modelId: 'f', grade: 'F', cost: 0.001 }),
    ]
    const forwards = [...all].sort(compareByValue).map((o) => o.modelId)
    const backwards = [...all].reverse().sort(compareByValue).map((o) => o.modelId)
    expect(backwards).toEqual(forwards)
  })
})
