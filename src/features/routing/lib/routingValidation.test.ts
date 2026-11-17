import { describe, expect, it } from 'vitest'
import { validateRouting } from './routingValidation'
import type { RoutingDocument } from './routing'

describe('validateRouting', () => {
  it('returns clean result for a Smart Budget routing', () => {
    const doc: RoutingDocument = {
      version: 3,
      lastSelectedProvider: 'gemini',
      geminiTier: 'paid',
      perPhase: {
        phase1: { target: 'cloud', cloudProvider: 'gemini', geminiTier: 'free', modelId: 'gemini-2.5-flash' },
        phase3: { target: 'cloud', cloudProvider: 'gemini', geminiTier: 'paid', modelId: 'gemini-2.5-pro' },
      },
    }
    // Phase 1 free vs global paid is an intentional pin — this DOES warn,
    // but the warning is informational ("did you mean to keep this?"). Not
    // an error.
    const r = validateRouting(doc)
    expect(r.hasErrors).toBe(false)
  })

  it('warns on stale Gemini tier override (per-phase tier ≠ global)', () => {
    const doc: RoutingDocument = {
      version: 3,
      lastSelectedProvider: 'gemini',
      geminiTier: 'free',
      perPhase: {
        phase3: { target: 'cloud', cloudProvider: 'gemini', geminiTier: 'paid', modelId: 'gemini-2.5-pro' },
      },
    }
    const r = validateRouting(doc)
    expect(r.hasWarnings).toBe(true)
    expect(r.findings[0].title).toMatch(/pinned to paid but global tier is free/)
  })

  it('does NOT warn when both sides are auto', () => {
    const doc: RoutingDocument = {
      version: 3,
      lastSelectedProvider: 'gemini',
      geminiTier: 'auto',
      perPhase: {
        phase1: { target: 'cloud', cloudProvider: 'gemini', geminiTier: 'paid', modelId: 'gemini-2.5-pro' },
      },
    }
    const r = validateRouting(doc)
    // auto is a wildcard — paid pin against auto global is not a stale-override warning
    expect(r.hasWarnings).toBe(false)
  })

  it('warns on unknown model id', () => {
    const doc: RoutingDocument = {
      version: 3,
      lastSelectedProvider: 'gemini',
      geminiTier: 'paid',
      perPhase: {
        phase1: { target: 'cloud', cloudProvider: 'gemini', modelId: 'gemini-totally-not-a-model' },
      },
    }
    const r = validateRouting(doc)
    expect(r.hasWarnings).toBe(true)
    expect(r.findings.some((f) => /unrecognised model/.test(f.title))).toBe(true)
  })

  it('accepts known Claude / OpenAI models', () => {
    const doc: RoutingDocument = {
      version: 3,
      lastSelectedProvider: 'claudeCode',
      perPhase: {
        phase1: { target: 'cloud', cloudProvider: 'claudeCode', modelId: 'claude-haiku-4-5' },
        phase3: { target: 'cloud', cloudProvider: 'codex', modelId: 'gpt-5' },
      },
    }
    const r = validateRouting(doc)
    expect(r.hasErrors).toBe(false)
  })

  it('errors on a local override with no modelId', () => {
    const doc: RoutingDocument = {
      version: 3,
      lastSelectedProvider: 'gemini',
      perPhase: {
        // @ts-expect-error — intentionally missing modelId to test validation
        phase1: { target: 'local' },
      },
    }
    const r = validateRouting(doc)
    expect(r.hasErrors).toBe(true)
  })

  it('returns clean when doc is null', () => {
    expect(validateRouting(null).clean).toBe(true)
  })

  it('returns clean when doc has no perPhase overrides', () => {
    const doc: RoutingDocument = {
      version: 3,
      lastSelectedProvider: 'gemini',
      geminiTier: 'paid',
    }
    expect(validateRouting(doc).clean).toBe(true)
  })
})
