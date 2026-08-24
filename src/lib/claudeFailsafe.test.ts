// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_FAILSAFE_TARGET,
  FAILSAFE_TARGETS,
  getFailsafeTarget,
  setFailsafeTarget,
} from './claudeFailsafe'
import { handlesMatureContent } from './openrouterModelsClient'

beforeEach(() => localStorage.clear())

describe('choosing which model repairs a refused chunk', () => {
  it('defaults to the model this used before it became a choice', () => {
    expect(getFailsafeTarget()).toEqual(DEFAULT_FAILSAFE_TARGET)
    expect(DEFAULT_FAILSAFE_TARGET.provider).toBe('gemini')
  })

  it('remembers an explicit choice', () => {
    setFailsafeTarget('x-ai/grok-4.20')
    expect(getFailsafeTarget().modelId).toBe('x-ai/grok-4.20')
  })

  it('falls back rather than silently disabling itself on a withdrawn model', () => {
    // A model can leave a catalogue between releases. A stale preference must
    // not leave the failsafe pointing at nothing, because the symptom would be
    // a refusal going unrepaired with no visible cause.
    localStorage.setItem('claude_failsafe_model', 'some/model-that-no-longer-exists')
    expect(getFailsafeTarget()).toEqual(DEFAULT_FAILSAFE_TARGET)
  })

  it('only offers models measured to carry explicit content', () => {
    // The whole point of the restriction: a repair runs BECAUSE something
    // already refused this material. An unproven model risks refusing twice,
    // and the second refusal has nowhere left to go.
    for (const t of FAILSAFE_TARGETS) {
      expect(handlesMatureContent(t.modelId), t.modelId).toBe(true)
    }
  })

  it('gives every option a reason, so the choice is informed rather than a list', () => {
    for (const t of FAILSAFE_TARGETS) {
      expect(t.why.length, t.modelId).toBeGreaterThan(40)
      expect(t.label, t.modelId).toMatch(/Gemini key|OpenRouter/)
    }
  })

  it('offers a route that needs no Gemini key at all', () => {
    // The edge this feature exists to close: a user without a Gemini key used
    // to get no repair, and the refusal became a permanent hole.
    expect(FAILSAFE_TARGETS.some((t) => t.provider === 'openrouter')).toBe(true)
  })
})
