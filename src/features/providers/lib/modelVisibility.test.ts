import { describe, expect, it } from 'vitest'
import {
  SMALL_MODEL_CEILING_B,
  declaredParameterSizeB,
  isBelowSizeFloor,
  isHiddenFromRouting,
  isUnrecommended,
} from './modelVisibility'
import type { OpenRouterModelInfo } from './openrouterModelsClient'

/** Generous everywhere the structural checks look, so a test about size or
 *  grades never trips a context or output blocker by accident. */
const model = (id: string, over: Partial<OpenRouterModelInfo> = {}): OpenRouterModelInfo => ({
  id,
  name: id,
  inputPerM: 1,
  outputPerM: 2,
  contextLength: 1_000_000,
  maxCompletionTokens: 128_000,
  supportsStructuredOutputs: true,
  isModerated: false,
  isFree: false,
  inputModalities: ['text'],
  outputModalities: ['text'],
  ...over,
})

describe('declaredParameterSizeB', () => {
  it('reads a size the id states', () => {
    expect(declaredParameterSizeB(model('meta-llama/llama-3.1-8b-instruct'))).toBe(8)
    expect(declaredParameterSizeB(model('mistralai/ministral-3b-2512'))).toBe(3)
    expect(declaredParameterSizeB(model('openai/gpt-oss-120b'))).toBe(120)
  })

  it('takes the total, not the active count, on a mixture-of-experts id', () => {
    // `a3b` is 3B ACTIVE of a 30B model. Reading the smaller number would file
    // a capable model under the size floor.
    expect(declaredParameterSizeB(model('qwen/qwen3-30b-a3b-instruct-2507'))).toBe(30)
    expect(declaredParameterSizeB(model('nvidia/nemotron-3-super-120b-a12b'))).toBe(120)
  })

  it('says nothing when the id says nothing', () => {
    expect(declaredParameterSizeB(model('anthropic/claude-opus-5'))).toBeNull()
    expect(declaredParameterSizeB(model('google/gemini-3.7-flash'))).toBeNull()
    // A version number is not a parameter count.
    expect(declaredParameterSizeB(model('x-ai/grok-4.20'))).toBeNull()
    expect(declaredParameterSizeB(model('z-ai/glm-4.5v'))).toBeNull()
  })

  it('reads the size off a :free variant too', () => {
    expect(declaredParameterSizeB(model('qwen/qwen3-8b:free'))).toBe(8)
  })
})

describe('isBelowSizeFloor', () => {
  it('is exclusive of the ceiling: under ten billion, not at it', () => {
    expect(isBelowSizeFloor(model(`x/y-${SMALL_MODEL_CEILING_B - 1}b`))).toBe(true)
    expect(isBelowSizeFloor(model(`x/y-${SMALL_MODEL_CEILING_B}b`))).toBe(false)
  })

  it('does not treat an unstated size as small', () => {
    expect(isBelowSizeFloor(model('anthropic/claude-opus-5'))).toBe(false)
  })
})

describe('isUnrecommended', () => {
  it('hides an untested model whose id declares a single-digit size', () => {
    expect(isUnrecommended(model('meta-llama/llama-3.2-3b-instruct'))).toBe(true)
    expect(isUnrecommended(model('qwen/qwen3-8b'))).toBe(true)
  })

  it('keeps an untested model that declares no size — unknown is not a low score', () => {
    expect(isUnrecommended(model('x-ai/grok-4.6'))).toBe(false)
  })

  it('hides a model measured D or F and never better', () => {
    // Bake-off, 2026-08-19: corrected nothing on Ground while returning
    // well-formed output. A silent no-op is the failure this filter exists for.
    expect(isUnrecommended(model('nvidia/nemotron-3.5-lightning'))).toBe(true)
    expect(isUnrecommended(model('openai/gpt-5-nano'))).toBe(true)
    expect(isUnrecommended(model('openai/gpt-5-mini'))).toBe(true)
  })

  it('does not hide a model whose only evidence is a single C', () => {
    // The regression this rule was rewritten for. An `anthropic/*` family rule
    // grades every Claude model C on Extras and says nothing about the other
    // four phases; the previous "no A or B anywhere" test read those four
    // unknowns as failures and hid the lot, Opus 5 included.
    expect(isUnrecommended(model('anthropic/claude-opus-5'))).toBe(false)
  })

  it('lets a measurement outrank the size floor', () => {
    // If an 8B model is ever graded A or B, evidence beats the heuristic that
    // exists only in evidence's absence.
    const graded = model('qwen/qwen3-30b-a3b-instruct-2507')
    expect(isUnrecommended(graded)).toBe(false)
  })
})

describe('isHiddenFromRouting', () => {
  it('additionally withholds free models from the dropdowns', () => {
    const free = model('some-vendor/capable-model:free', { isFree: true })
    expect(isUnrecommended(free)).toBe(false)
    expect(isHiddenFromRouting(free)).toBe(true)
  })

  it('offers a paid model the browser would also show', () => {
    expect(isHiddenFromRouting(model('anthropic/claude-opus-5'))).toBe(false)
  })
})

describe('isUnrecommended — a prediction is not evidence', () => {
  it('does not hide a model on a predicted grade alone', () => {
    // gpt-oss-20b carries predicted Ds from a pattern rule, no measurement of
    // its own, and declares 20B — above the floor. The header says that keeps
    // it visible: an unknown is not a low score, and a guess is not evidence.
    expect(isUnrecommended(model('openai/gpt-oss-20b'))).toBe(false)
    // A grade inherited from a measured sibling is a prediction here too.
    expect(isUnrecommended(model('openai/gpt-5.4-mini'))).toBe(false)
  })
})

describe('isBelowSizeFloor — under ten billion', () => {
  it('hides nine and a half billion, shows ten', () => {
    expect(isBelowSizeFloor(model('vendor/thing-9.5b'))).toBe(true)
    expect(isBelowSizeFloor(model('vendor/thing-10b'))).toBe(false)
  })
})
