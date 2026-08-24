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
  classifyGeminiTier,
  groupModels,
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

const openrouterOpt: CloudKeyOption = {
  id: 'openrouter',
  provider: 'openrouter',
  label: 'OpenRouter',
  short: 'OpenRouter',
  slot: 'openrouter',
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
    const models = availableModelsFor(openrouterOpt, {
      openrouter: {
        fetchedAt: 't',
        advertised: ['claude-haiku-4-5', 'claude-sonnet-4-6'],
        probed: [],
      },
    })
    expect(models.map((m) => m.id)).toEqual(['claude-haiku-4-5', 'claude-sonnet-4-6'])
    expect(models.every((m) => !m.verified)).toBe(true)
  })

  it('also falls back to advertised when probed has entries but none are accessible', () => {
    const models = availableModelsFor(openrouterOpt, {
      openrouter: {
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
  it('falls back to STATIC_PROVIDER_MODELS for OpenRouter when no probe + no advertised', () => {
    const models = availableModelsFor(openrouterOpt, {})
    expect(models.map((m) => m.id).sort()).toEqual([...STATIC_PROVIDER_MODELS.openrouter].sort())
    expect(models.every((m) => !m.verified)).toBe(true)
  })

  it('falls back to STATIC_PROVIDER_MODELS for OpenRouter (second slot) when no probe + no advertised', () => {
    const models = availableModelsFor(openrouterOpt, {})
    expect(models.map((m) => m.id).sort()).toEqual([...STATIC_PROVIDER_MODELS.openrouter].sort())
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

describe('classifyGeminiTier', () => {
  // Every flash-lite id also contains 'flash'. If 'flash' were tested first
  // the Flash Lite tier would collapse into Flash and vanish from the picker.
  it('resolves flash-lite before flash', () => {
    expect(classifyGeminiTier('gemini-2.5-flash-lite')).toBe('flash-lite')
    expect(classifyGeminiTier('gemini-flash-lite-latest')).toBe('flash-lite')
    expect(classifyGeminiTier('gemini-2.5-flash')).toBe('flash')
  })

  it('classifies pro ids and the floating aliases', () => {
    expect(classifyGeminiTier('gemini-2.5-pro')).toBe('pro')
    expect(classifyGeminiTier('gemini-pro-latest')).toBe('pro')
    expect(classifyGeminiTier('gemini-3.1-pro-preview')).toBe('pro')
  })

  it('buckets an unrecognised family as other rather than guessing', () => {
    expect(classifyGeminiTier('gemini-4-ultra')).toBe('other')
    expect(classifyGeminiTier('')).toBe('other')
  })

  // Mirrors server/lib/geminiTier.ts. The two must agree or a model lands in
  // one tier when probed and another when shown.
  it('agrees with the server classifier on the shipped catalog', () => {
    const cases: Array<[string, string]> = [
      ['gemini-pro-latest', 'pro'],
      ['gemini-flash-latest', 'flash'],
      ['gemini-flash-lite-latest', 'flash-lite'],
      ['gemini-3.6-flash', 'flash'],
      ['gemini-3.5-flash-lite', 'flash-lite'],
      ['gemini-3-pro', 'pro'],
      ['gemini-2.0-flash', 'flash'],
    ]
    for (const [id, tier] of cases) expect(classifyGeminiTier(id)).toBe(tier)
  })
})

describe('groupModels', () => {
  it('splits Gemini into tier groups in Pro → Flash → Lite → Uncategorised order', () => {
    const groups = groupModels(
      geminiPaidOpt,
      [
        { id: 'gemini-2.5-flash-lite', verified: true, tier: 'flash-lite' },
        { id: 'gemini-4-ultra', verified: true, tier: 'other' },
        { id: 'gemini-2.5-pro', verified: true, tier: 'pro' },
        { id: 'gemini-2.5-flash', verified: true, tier: 'flash' },
      ],
      'Gemini Paid',
    )
    expect(groups.map((g) => g.label)).toEqual([
      'Gemini Paid — Pro Tier',
      'Gemini Paid — Flash Tier',
      'Gemini Paid — Flash Lite Tier',
      'Gemini Paid — Uncategorised',
    ])
  })

  it('omits tiers with no models', () => {
    const groups = groupModels(
      geminiPaidOpt,
      [{ id: 'gemini-2.5-flash', verified: true, tier: 'flash' }],
      'Gemini Paid',
    )
    expect(groups).toHaveLength(1)
    expect(groups[0].tier).toBe('flash')
  })

  it('derives the tier when the cache entry predates tier stamping', () => {
    // An availability.json written by an older server build has no `tier`
    // field. Grouping must still work rather than dumping everything into
    // Uncategorised.
    const groups = groupModels(
      geminiPaidOpt,
      [
        { id: 'gemini-2.5-pro', verified: true },
        { id: 'gemini-2.5-flash-lite', verified: true },
      ],
      'Gemini Paid',
    )
    expect(groups.map((g) => g.tier)).toEqual(['pro', 'flash-lite'])
  })

  it('keeps non-Gemini providers as one flat group', () => {
    const groups = groupModels(
      openrouterOpt,
      [
        { id: 'claude-opus-4-7', verified: true },
        { id: 'claude-haiku-4-5', verified: true },
      ],
      'Claude',
    )
    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBe('Claude')
    expect(groups[0].tier).toBeUndefined()
  })

  it('returns no groups for an empty model list', () => {
    expect(groupModels(openrouterOpt, [], 'Claude')).toEqual([])
    expect(groupModels(geminiPaidOpt, [], 'Gemini Paid')).toEqual([])
  })

  // Grouping is presentation only. Whatever availableModelsFor decided is
  // offerable must survive it — a model in an unrecognised family belongs
  // under Uncategorised, never dropped.
  it('loses no models regardless of tier', () => {
    const models = [
      { id: 'gemini-2.5-pro', verified: true, tier: 'pro' as const },
      { id: 'zzz-unknown', verified: false },
      { id: 'gemini-2.5-flash', verified: true, tier: 'flash' as const },
    ]
    const flat = groupModels(geminiPaidOpt, models, 'Gemini Paid').flatMap((g) => g.models)
    expect(flat).toHaveLength(models.length)
    expect(flat.map((m) => m.id).sort()).toEqual(models.map((m) => m.id).sort())
  })
})

describe('availableModelsFor — tier propagation', () => {
  it('carries the probe-stamped tier through to the dropdown model', () => {
    const models = availableModelsFor(geminiPaidOpt, {
      gemini: {
        fetchedAt: 'now',
        advertised: [],
        probed: [{ id: 'gemini-4-ultra', accessible: true, tier: 'other' }],
      },
    })
    expect(models[0].tier).toBe('other')
  })

  it('derives a tier for advertised-only entries, which never carry one', () => {
    const models = availableModelsFor(geminiPaidOpt, {
      gemini: { fetchedAt: 'now', advertised: ['gemini-9-flash-lite'], probed: [] },
    })
    expect(models[0].tier).toBe('flash-lite')
    expect(models[0].verified).toBe(false)
  })

  it('leaves tier undefined for non-Gemini providers', () => {
    const models = availableModelsFor(openrouterOpt, {
      openrouter: {
        fetchedAt: 'now',
        advertised: [],
        probed: [{ id: 'claude-opus-4-7', accessible: true }],
      },
    })
    expect(models[0].tier).toBeUndefined()
  })
})
