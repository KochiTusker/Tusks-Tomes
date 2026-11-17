import { describe, expect, it } from 'vitest'
import { acceptModel, claudeCodeSlot, withOpenRouterCatalogue } from './knownModels.js'
import type { OpenRouterCatalogue, OpenRouterModel } from './openrouterCatalogue.js'

function catalogue(...ids: string[]): OpenRouterCatalogue {
  return {
    fetchedAt: '2026-09-23T00:00:00.000Z',
    models: ids.map((id) => ({ id }) as OpenRouterModel),
  }
}

describe('withOpenRouterCatalogue', () => {
  it('accepts an OpenRouter id the catalogue lists, with no probe run', () => {
    const cache = withOpenRouterCatalogue({}, catalogue('moonshotai/kimi-k3'))
    expect(acceptModel('openrouter', undefined, 'moonshotai/kimi-k3', cache)).toEqual({
      ok: true,
      source: 'advertised',
    })
  })

  it('still warns on an id the catalogue does not list', () => {
    const cache = withOpenRouterCatalogue({}, catalogue('moonshotai/kimi-k3'))
    expect(acceptModel('openrouter', undefined, 'moonshotai/kimi-k33', cache).ok).toBe(false)
  })

  it('leaves a probe verdict in charge', () => {
    const cache = withOpenRouterCatalogue(
      {
        openrouter: {
          fetchedAt: '2026-09-23T00:00:00.000Z',
          advertised: [],
          probed: [{ id: 'moonshotai/kimi-k3', accessible: false, reason: 'No credits' }],
        },
      },
      catalogue('moonshotai/kimi-k3'),
    )
    expect(acceptModel('openrouter', undefined, 'moonshotai/kimi-k3', cache)).toMatchObject({
      ok: false,
      source: 'probe-inaccessible',
    })
  })

  it('returns the cache unchanged when there is no catalogue', () => {
    const cache = {}
    expect(withOpenRouterCatalogue(cache, null)).toBe(cache)
  })
})

describe('claudeCodeSlot', () => {
  it('accepts a Claude Code model the catalogue lists', () => {
    const cache = { claudeCode: claudeCodeSlot(catalogue('anthropic/claude-fable-5.1')) }
    expect(acceptModel('claudeCode', undefined, 'claude-fable-5-1', cache).ok).toBe(true)
    expect(acceptModel('claudeCode', undefined, 'claude-fable-5-9', cache).ok).toBe(false)
  })
})
