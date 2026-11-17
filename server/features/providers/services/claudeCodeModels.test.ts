import { describe, expect, it } from 'vitest'
import { claudeCodeModelsFrom, cliIdFromOpenRouter } from './claudeCodeModels.js'
import type { OpenRouterCatalogue, OpenRouterModel } from './openrouterCatalogue.js'

function catalogue(...ids: string[]): OpenRouterCatalogue {
  return { fetchedAt: '2026-09-23T00:00:00.000Z', models: ids.map((id) => ({ id }) as OpenRouterModel) }
}

describe('cliIdFromOpenRouter', () => {
  it('turns an OpenRouter Anthropic id into the id the CLI takes', () => {
    expect(cliIdFromOpenRouter('anthropic/claude-opus-5.5')).toBe('claude-opus-5-5')
    expect(cliIdFromOpenRouter('anthropic/claude-sonnet-5')).toBe('claude-sonnet-5')
  })

  it('skips variants, routers, other vendors and the Claude 3 family', () => {
    expect(cliIdFromOpenRouter('anthropic/claude-opus-5.5:batch')).toBeNull()
    expect(cliIdFromOpenRouter('~anthropic/claude-latest')).toBeNull()
    expect(cliIdFromOpenRouter('moonshotai/kimi-k3')).toBeNull()
    expect(cliIdFromOpenRouter('anthropic/claude-3-haiku')).toBeNull()
  })
})

describe('claudeCodeModelsFrom', () => {
  it('offers a newly listed Claude model without a code change', () => {
    const models = claudeCodeModelsFrom(catalogue('anthropic/claude-opus-9', 'openai/gpt-9'))
    expect(models).toContain('claude-opus-9')
    expect(models).not.toContain('gpt-9')
  })

  it('keeps the aliases first and falls back to the baseline with no catalogue', () => {
    const models = claudeCodeModelsFrom(null)
    expect(models.slice(0, 3)).toEqual(['sonnet', 'opus', 'haiku'])
    expect(models).toContain('claude-opus-5-5')
    expect(new Set(models).size).toBe(models.length)
  })
})
