// availableModelsFor contract:
//   - Probed > advertised > static fallback (three-tier precedence).
//   - Only `accessible: true` from probed survives.
//   - Empty probed list (cache invariant: probed could be present but
//     all-inaccessible) falls through to advertised, then to static.
//   - Gemini has no static fallback; an unprobed/unadvertised Gemini
//     option returns [].
//   - Output is sorted alphabetically + deduplicated.
//   - `optgroupLabel` surfaces the fingerprint when present.

import { describe, expect, it } from 'vitest'
import {
  availableModelsFor,
  hasUnverified,
  optgroupLabel,
} from './availableModels'
import type { CloudKeyOption } from './cloudKeys'
import { STATIC_PROVIDER_MODELS } from './cloudKeys'

const geminiPaidOpt: CloudKeyOption = {
  id: 'gemini-paid',
  provider: 'gemini',
  geminiTier: 'paid',
  label: 'Google Gemini — Paid',
  short: 'Gemini Paid',
  slot: 'gemini',
}

const geminiFreeOpt: CloudKeyOption = {
  id: 'gemini-free',
  provider: 'gemini',
  geminiTier: 'free',
  label: 'Google Gemini — Free',
  short: 'Gemini Free',
  slot: 'geminiFallback',
}

const claudeOpt: CloudKeyOption = {
  id: 'claude',
  provider: 'claude',
  label: 'Anthropic Claude',
  short: 'Claude',
  slot: 'claude',
}

const openaiOpt: CloudKeyOption = {
  id: 'openai',
  provider: 'openai',
  label: 'OpenAI',
  short: 'OpenAI',
  slot: 'openai',
}

describe('availableModelsFor — probe-driven path (gold standard)', () => {
  it('returns only `accessible: true` entries from probed[]', () => {
    const models = availableModelsFor(geminiPaidOpt, {
      gemini: {
        fetchedAt: '2026-05-24T00:00:00Z',
        keyFingerprint: 'abc123',
        advertised: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
        probed: [
          { id: 'gemini-2.5-pro', accessible: true },
          { id: 'gemini-2.5-flash', accessible: true },
          { id: 'gemini-2.5-flash-lite', accessible: false, reason: 'Free tier quota: 0 (paid-only)' },
        ],
      },
    })
    expect(models.map((m) => m.id)).toEqual(['gemini-2.5-flash', 'gemini-2.5-pro'])
    expect(models.every((m) => m.verified)).toBe(true)
  })

  it('preserves reason + latency for tooltips', () => {
    const models = availableModelsFor(geminiPaidOpt, {
      gemini: {
        fetchedAt: 't',
        advertised: [],
        probed: [{ id: 'gemini-2.5-flash', accessible: true, latencyMs: 420 }],
      },
    })
    expect(models[0].latencyMs).toBe(420)
  })
})

describe('availableModelsFor — advertised fallback (unprobed)', () => {
  it('returns advertised list with verified=false when probed is empty', () => {
    const models = availableModelsFor(claudeOpt, {
      claude: {
        fetchedAt: 't',
        advertised: ['claude-haiku-4-5', 'claude-sonnet-4-6'],
        probed: [],
      },
    })
    expect(models.map((m) => m.id)).toEqual(['claude-haiku-4-5', 'claude-sonnet-4-6'])
    expect(models.every((m) => !m.verified)).toBe(true)
  })

  it('also falls back to advertised when probed has entries but none are accessible', () => {
    const models = availableModelsFor(claudeOpt, {
      claude: {
        fetchedAt: 't',
        advertised: ['claude-haiku-4-5', 'claude-sonnet-4-6'],
        probed: [
          { id: 'claude-haiku-4-5', accessible: false, reason: '401' },
          { id: 'claude-sonnet-4-6', accessible: false, reason: '401' },
        ],
      },
    })
    expect(models.map((m) => m.id)).toEqual(['claude-haiku-4-5', 'claude-sonnet-4-6'])
    expect(models.every((m) => !m.verified)).toBe(true)
  })
})

describe('availableModelsFor — static fallback', () => {
  it('falls back to STATIC_PROVIDER_MODELS for Claude when no probe + no advertised', () => {
    const models = availableModelsFor(claudeOpt, {})
    expect(models.map((m) => m.id).sort()).toEqual([...STATIC_PROVIDER_MODELS.claude].sort())
    expect(models.every((m) => !m.verified)).toBe(true)
  })

  it('falls back to STATIC_PROVIDER_MODELS for OpenAI when no probe + no advertised', () => {
    const models = availableModelsFor(openaiOpt, {})
    expect(models.map((m) => m.id).sort()).toEqual([...STATIC_PROVIDER_MODELS.openai].sort())
  })

  it('returns empty list for unprobed Gemini (no static fallback for Gemini)', () => {
    // Gemini's "static" catalog is the public /v1beta/models endpoint —
    // listGeminiModelAvailability used to call it, but the new probe-
    // driven path treats unprobed Gemini as "needs a probe."
    const models = availableModelsFor(geminiPaidOpt, {})
    expect(models).toEqual([])
  })
})

describe('availableModelsFor — sorting + dedup', () => {
  it('sorts the output alphabetically by id', () => {
    const models = availableModelsFor(geminiPaidOpt, {
      gemini: {
        fetchedAt: 't',
        advertised: [],
        probed: [
          { id: 'gemini-2.5-pro', accessible: true },
          { id: 'gemini-2.5-flash', accessible: true },
          { id: 'gemini-2.5-flash-lite', accessible: true },
        ],
      },
    })
    expect(models.map((m) => m.id)).toEqual([
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
      'gemini-2.5-pro',
    ])
  })

  it('drops duplicates if probed and advertised both list the same id', () => {
    // Edge case — defensive. The probe-driven path only consumes probed,
    // so dedup matters mostly inside that list.
    const models = availableModelsFor(geminiPaidOpt, {
      gemini: {
        fetchedAt: 't',
        advertised: [],
        probed: [
          { id: 'gemini-2.5-flash', accessible: true },
          { id: 'gemini-2.5-flash', accessible: true },
        ],
      },
    })
    expect(models).toHaveLength(1)
  })
})

describe('optgroupLabel', () => {
  it('appends fingerprint when probe data has one', () => {
    expect(
      optgroupLabel(geminiPaidOpt, {
        gemini: { fetchedAt: 't', keyFingerprint: 'abc123', advertised: [], probed: [] },
      }),
    ).toBe('Google Gemini — Paid (abc123)')
  })

  it('omits fingerprint when no probe data', () => {
    expect(optgroupLabel(geminiPaidOpt, {})).toBe('Google Gemini — Paid')
  })

  it('omits fingerprint when probe data has none (defensive)', () => {
    expect(
      optgroupLabel(geminiFreeOpt, {
        geminiFallback: { fetchedAt: 't', advertised: ['x'], probed: [] },
      }),
    ).toBe('Google Gemini — Free')
  })
})

describe('hasUnverified', () => {
  it('returns true when any option is unverified', () => {
    expect(
      hasUnverified([
        { id: 'a', verified: true },
        { id: 'b', verified: false },
      ]),
    ).toBe(true)
  })

  it('returns false when every option is verified', () => {
    expect(
      hasUnverified([
        { id: 'a', verified: true },
        { id: 'b', verified: true },
      ]),
    ).toBe(false)
  })

  it('returns false on empty list', () => {
    expect(hasUnverified([])).toBe(false)
  })
})
