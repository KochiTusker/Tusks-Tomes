import { describe, expect, it } from 'vitest'
import {
  isRetiredProvider,
  migratePhaseEntry,
  migrateRouting,
  toOpenRouterModelId,
} from './legacyProviders'

describe('what counts as retired', () => {
  it('retires the two direct API keys and nothing else', () => {
    expect(isRetiredProvider('claude')).toBe(true)
    expect(isRetiredProvider('openai')).toBe(true)
    expect(isRetiredProvider('gemini')).toBe(false)
    expect(isRetiredProvider('openrouter')).toBe(false)
  })

  it('leaves the subscription CLIs alone', () => {
    // The easiest mistake to make here: claudeCode is not claude. It bills
    // against a subscription rather than an API key and is the reason the
    // hybrid presets exist.
    expect(isRetiredProvider('claudeCode')).toBe(false)
    expect(isRetiredProvider('codex')).toBe(false)
  })
})

describe('mapping a model onto its OpenRouter namespace', () => {
  it('keeps the same model rather than substituting a cheaper one', () => {
    expect(toOpenRouterModelId('claude', 'claude-sonnet-4-5')).toBe('anthropic/claude-sonnet-4.5')
    expect(toOpenRouterModelId('openai', 'gpt-5-mini')).toBe('openai/gpt-5-mini')
  })

  it('drops the dated suffix, which OpenRouter resolves from the alias', () => {
    expect(toOpenRouterModelId('claude', 'claude-haiku-4-5-20251001')).toBe(
      'anthropic/claude-haiku-4.5',
    )
  })

  it('is safe to run twice', () => {
    const once = toOpenRouterModelId('claude', 'claude-sonnet-4-5')
    expect(toOpenRouterModelId('claude', once)).toBe(once)
  })

  it('leaves an empty model id alone rather than inventing a namespace', () => {
    expect(toOpenRouterModelId('openai', '')).toBe('')
  })
})

describe('migrating a stored routing document', () => {
  it('moves a retired phase to OpenRouter, keeping the model', () => {
    const { doc, notices } = migrateRouting({
      lastSelectedProvider: 'claude',
      perPhase: {
        phase3: { target: 'cloud', cloudProvider: 'claude', modelId: 'claude-sonnet-4-6' },
      },
    })
    expect(doc.perPhase!.phase3.cloudProvider).toBe('openrouter')
    expect(doc.perPhase!.phase3.modelId).toBe('anthropic/claude-sonnet-4.6')
    expect(doc.lastSelectedProvider).toBe('openrouter')
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ phase: 'phase3', from: 'claude' })
  })

  it('does not touch phases on providers that are staying', () => {
    const { doc, notices } = migrateRouting({
      lastSelectedProvider: 'gemini',
      perPhase: {
        phase1: { target: 'cloud', cloudProvider: 'claudeCode', modelId: 'sonnet' },
        phase3: { target: 'cloud', cloudProvider: 'gemini', modelId: 'gemini-pro-latest' },
      },
    })
    expect(doc.perPhase!.phase1.cloudProvider).toBe('claudeCode')
    expect(doc.perPhase!.phase3.cloudProvider).toBe('gemini')
    expect(doc.lastSelectedProvider).toBe('gemini')
    expect(notices).toEqual([])
  })

  it('reports every phase it moved, so the change can be shown not hidden', () => {
    const { notices } = migrateRouting({
      perPhase: {
        phase1: { cloudProvider: 'claude', modelId: 'claude-haiku-4-5' },
        phase2: { cloudProvider: 'openai', modelId: 'gpt-5-nano' },
        phase3: { cloudProvider: 'gemini', modelId: 'gemini-pro-latest' },
      },
    })
    expect(notices.map((n) => n.phase).sort()).toEqual(['phase1', 'phase2'])
  })

  it('survives a document with no per-phase routing at all', () => {
    const { doc, notices } = migrateRouting({ lastSelectedProvider: 'openai' })
    expect(doc.lastSelectedProvider).toBe('openrouter')
    expect(notices).toEqual([])
  })

  it('is idempotent — a migrated document migrates to itself', () => {
    const first = migrateRouting({
      lastSelectedProvider: 'claude',
      perPhase: { phase3: { cloudProvider: 'claude', modelId: 'claude-sonnet-4-5' } },
    })
    const second = migrateRouting(first.doc)
    expect(second.doc).toEqual(first.doc)
    expect(second.notices).toEqual([])
  })
})

describe('migrating one entry', () => {
  it('returns a supported entry untouched, by identity', () => {
    const entry = { cloudProvider: 'gemini', modelId: 'gemini-pro-latest' }
    expect(migratePhaseEntry(entry)).toBe(entry)
  })
})
