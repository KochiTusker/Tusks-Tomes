import { describe, expect, it, vi } from 'vitest'
import { contextWindowFor, contextWindowFromCatalogue } from './contextWindow'
import type { CatalogueResult, OpenRouterModelInfo } from '../../providers/lib/openrouterModelsClient'

const catalogue = vi.hoisted(() => ({
  fetch: (): Promise<CatalogueResult> => Promise.resolve({ fetchedAt: null, models: [], providerPolicies: [] }),
}))
vi.mock('../../providers/lib/openrouterModelsClient', () => ({
  getOpenRouterCatalogue: () => catalogue.fetch(),
}))

function entry(id: string, contextLength: number): OpenRouterModelInfo {
  return {
    id,
    name: id,
    inputPerM: 1,
    outputPerM: 1,
    contextLength,
    maxCompletionTokens: null,
    supportsStructuredOutputs: false,
    isModerated: false,
    isFree: false,
    inputModalities: ['text'],
    outputModalities: ['text'],
  }
}

// Newest first, as the catalogue lists them.
const CATALOGUE = [
  entry('anthropic/claude-opus-5.5', 1_000_000),
  entry('anthropic/claude-opus-5.5:batch', 7),
  entry('anthropic/claude-sonnet-5', 400_000),
  entry('anthropic/claude-opus-4.8', 200_000),
  entry('anthropic/claude-3-opus', 3),
  entry('google/gemini-3.1-pro-preview', 2_000_000),
  entry('google/gemini-2.5-pro', 1_048_576),
  entry('google/gemini-2.5-flash', 900_000),
  entry('openai/gpt-5.5', 400_000),
  entry('meta-llama/llama-4-scout', 128_000),
  entry('broken/zero-window', 0),
]

describe('contextWindowFromCatalogue', () => {
  it('reads an OpenRouter model by its exact id', () => {
    expect(contextWindowFromCatalogue(CATALOGUE, 'openrouter', 'meta-llama/llama-4-scout')).toBe(128_000)
    expect(contextWindowFromCatalogue(CATALOGUE, 'openrouter', 'meta-llama/llama-9')).toBeNull()
  })

  it('maps a pinned Gemini id to its own family and version only', () => {
    expect(contextWindowFromCatalogue(CATALOGUE, 'gemini', 'gemini-2.5-pro')).toBe(1_048_576)
    expect(contextWindowFromCatalogue(CATALOGUE, 'gemini', 'gemini-2.5-flash')).toBe(900_000)
    // A version the catalogue does not list is unknown, not borrowed from a neighbour.
    expect(contextWindowFromCatalogue(CATALOGUE, 'gemini', 'gemini-2.0-pro')).toBeNull()
    // A pinned id accepts its own -preview when the plain id is absent.
    expect(contextWindowFromCatalogue(CATALOGUE, 'gemini', 'gemini-3.1-pro')).toBe(2_000_000)
  })

  it('maps a floating Gemini alias to the newest version of its family', () => {
    expect(contextWindowFromCatalogue(CATALOGUE, 'gemini', 'gemini-pro-latest')).toBe(2_000_000)
  })

  it('maps a Claude Code id to its Anthropic catalogue entry, ignoring variants', () => {
    expect(contextWindowFromCatalogue(CATALOGUE, 'claudeCode', 'claude-opus-5-5')).toBe(1_000_000)
    expect(contextWindowFromCatalogue(CATALOGUE, 'claudeCode', 'claude-opus-4-8')).toBe(200_000)
    expect(contextWindowFromCatalogue(CATALOGUE, 'claudeCode', 'claude-3-opus')).toBeNull()
  })

  it('bounds a Claude Code alias by the smallest window in its tier', () => {
    // The CLI decides which opus an alias means; whichever it picks, the
    // window is at least the smallest of them, never the largest.
    expect(contextWindowFromCatalogue(CATALOGUE, 'claudeCode', 'opus')).toBe(200_000)
    expect(contextWindowFromCatalogue(CATALOGUE, 'claudeCode', 'sonnet')).toBe(400_000)
    expect(contextWindowFromCatalogue(CATALOGUE, 'claudeCode', 'haiku')).toBeNull()
  })

  it('maps a Codex id to the OpenAI entry of the same name', () => {
    expect(contextWindowFromCatalogue(CATALOGUE, 'codex', 'gpt-5.5')).toBe(400_000)
    expect(contextWindowFromCatalogue(CATALOGUE, 'codex', 'gpt-9')).toBeNull()
  })

  it('is unknown with no catalogue, no provider, or no usable figure', () => {
    expect(contextWindowFromCatalogue([], 'gemini', 'gemini-2.5-pro')).toBeNull()
    expect(contextWindowFromCatalogue(CATALOGUE, undefined, 'gemini-2.5-pro')).toBeNull()
    expect(contextWindowFromCatalogue(CATALOGUE, 'openrouter', 'broken/zero-window')).toBeNull()
    expect(contextWindowFromCatalogue(CATALOGUE, 'openrouter', '')).toBeNull()
  })
})

describe('contextWindowFor', () => {
  it('reads the window from the fetched catalogue', async () => {
    catalogue.fetch = () => Promise.resolve({ fetchedAt: null, models: CATALOGUE, providerPolicies: [] })
    await expect(contextWindowFor('gemini', 'gemini-2.5-pro')).resolves.toBe(1_048_576)
  })

  it('gives up as unknown rather than hold the phase on a stalled catalogue', async () => {
    catalogue.fetch = () => new Promise(() => {})
    const started = Date.now()
    await expect(contextWindowFor('gemini', 'gemini-2.5-pro', 50)).resolves.toBeNull()
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})
