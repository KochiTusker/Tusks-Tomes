import { describe, expect, it } from 'vitest'
import {
  MATURE_CONTENT_MEASURED_OK,
  MATURE_CONTENT_NATIVE_OK,
  handlesMatureContent,
} from './openrouterModelsClient'

describe('which models are known to carry mature content', () => {
  it('recognises a model by its catalogue id', () => {
    expect(handlesMatureContent('x-ai/grok-4.20')).toBe(true)
  })

  it('recognises the direct Gemini key, which is not in the catalogue at all', () => {
    // The gap this closes: the catalogue card only knows OpenRouter ids, so a
    // user reading it would conclude their own Gemini key was the one route
    // that might sanitise their session. Measured three ways — with BLOCK_NONE,
    // without any safety settings, and via OpenRouter — it does not.
    expect(handlesMatureContent('gemini-pro-latest')).toBe(true)
    expect(handlesMatureContent('gemini-flash-latest')).toBe(true)
  })

  it('covers the floating latest aliases, not only the pinned ids', () => {
    // routing.json stores the alias, so checking only pinned ids would miss
    // the exact string the app actually routes through.
    expect(handlesMatureContent('~google/gemini-pro-latest')).toBe(true)
    expect(handlesMatureContent('~google/gemini-flash-latest')).toBe(true)
  })

  it('says nothing about an unmeasured model rather than guessing', () => {
    // Absence means unmeasured, NOT refuses. Every moderated model tested
    // wrote the graphic passage without complaint, so the catalogue's
    // moderation flag is not a predictor and must not be treated as one.
    expect(handlesMatureContent('some/never-tested-model')).toBe(false)
  })

  it('keeps the two sources disjoint, so a model is listed once', () => {
    for (const id of MATURE_CONTENT_NATIVE_OK) {
      expect(MATURE_CONTENT_MEASURED_OK.has(id), id).toBe(false)
    }
  })
})
