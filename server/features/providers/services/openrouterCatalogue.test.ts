// Tests for the OpenRouter catalogue normaliser.
//
// The fixture rows below are trimmed copies of real /api/v1/models responses,
// kept verbatim in shape (string prices, nested top_provider, etc.) because the
// raw feed's encoding is exactly the thing that would break silently if it
// changed. Each row is here for a reason:
//
//   gemini-2.5-pro       ordinary paid model, has a cached-read rate
//   claude-sonnet-4.5    moderated — the flag the prose phases care about
//   gpt-oss-120b         very cheap, small context (131k) — cannot host the vault
//   glm-4.7-flash        16k output ceiling, BELOW our 32,768 default request
//   nemotron ...:free    free AND lacks structured_outputs — wrong for JSON phases
//   openrouter/auto      sentinel negative price; must never reach an estimate

import { describe, expect, it } from 'vitest'
import {
  CATALOGUE_TTL_MS,
  findModel,
  isCatalogueFresh,
  normaliseCatalogue,
  priceAt,
  type OpenRouterCatalogue,
} from './openrouterCatalogue'

const RAW = {
  data: [
    {
      id: 'google/gemini-2.5-pro',
      name: 'Google: Gemini 2.5 Pro',
      context_length: 1048576,
      pricing: { prompt: '0.00000125', completion: '0.00001', input_cache_read: '0.000000125' },
      top_provider: { max_completion_tokens: 65536, is_moderated: false },
      architecture: { input_modalities: ['text', 'image', 'audio'], output_modalities: ['text'] },
      supported_parameters: ['max_tokens', 'response_format', 'structured_outputs', 'temperature'],
    },
    {
      id: 'anthropic/claude-sonnet-4.5',
      name: 'Anthropic: Claude Sonnet 4.5',
      context_length: 1000000,
      pricing: { prompt: '0.000003', completion: '0.000015', input_cache_read: '0.0000003' },
      top_provider: { max_completion_tokens: 64000, is_moderated: true },
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
      supported_parameters: ['max_tokens', 'response_format', 'structured_outputs', 'temperature'],
    },
    {
      id: 'openai/gpt-oss-120b',
      name: 'OpenAI: gpt-oss-120b',
      context_length: 131072,
      pricing: { prompt: '0.00000003', completion: '0.00000017', input_cache_read: '0.00000003' },
      top_provider: { max_completion_tokens: 131072, is_moderated: false },
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      supported_parameters: ['max_tokens', 'response_format', 'structured_outputs', 'temperature'],
    },
    {
      id: 'z-ai/glm-4.7-flash',
      name: 'Z.AI: GLM 4.7 Flash',
      context_length: 202752,
      pricing: { prompt: '0.00000006', completion: '0.0000004', input_cache_read: '0.00000001' },
      top_provider: { max_completion_tokens: 16384, is_moderated: false },
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      supported_parameters: ['max_tokens', 'response_format', 'structured_outputs', 'temperature'],
    },
    {
      id: 'nvidia/nemotron-3-ultra-550b-a55b:free',
      name: 'NVIDIA: Nemotron 3 Ultra 550B (free)',
      context_length: 1000000,
      pricing: { prompt: '0', completion: '0' },
      top_provider: { max_completion_tokens: 65536, is_moderated: false },
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      supported_parameters: ['max_tokens', 'temperature'],
    },
    {
      id: 'openrouter/auto',
      name: 'Auto Router',
      context_length: 2000000,
      pricing: { prompt: '-1', completion: '-1' },
      top_provider: { max_completion_tokens: null, is_moderated: false },
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      supported_parameters: ['max_tokens', 'response_format', 'structured_outputs', 'temperature'],
    },
  ],
}

const models = normaliseCatalogue(RAW)
const byId = (id: string) => models.find((m) => m.id === id)!

describe('normaliseCatalogue', () => {
  it('drops sentinel-priced router rows so they can never reach an estimate', () => {
    // openrouter/auto quotes -1 because the real model is chosen per call.
    // Quoting a negative cost to a user would be worse than omitting it.
    expect(byId('google/gemini-2.5-pro')).toBeDefined()
    expect(models.find((m) => m.id === 'openrouter/auto')).toBeUndefined()
    expect(models).toHaveLength(5)
  })

  it('converts per-token string prices to USD per million', () => {
    const pro = byId('google/gemini-2.5-pro')
    expect(pro.inputPerM).toBeCloseTo(1.25, 6)
    expect(pro.outputPerM).toBeCloseTo(10, 6)
    expect(pro.cachedInputPerM).toBeCloseTo(0.125, 6)
  })

  it('omits cachedInputPerM when the feed has no cached rate', () => {
    expect(byId('nvidia/nemotron-3-ultra-550b-a55b:free').cachedInputPerM).toBeUndefined()
  })

  it('flags free models', () => {
    expect(byId('nvidia/nemotron-3-ultra-550b-a55b:free').isFree).toBe(true)
    expect(byId('openai/gpt-oss-120b').isFree).toBe(false)
  })

  it('flags moderated models — the signal the prose phases depend on', () => {
    expect(byId('anthropic/claude-sonnet-4.5').isModerated).toBe(true)
    expect(byId('google/gemini-2.5-pro').isModerated).toBe(false)
  })

  it('detects structured-output support', () => {
    // Phases 2 and 4 emit JSON. The headline free model cannot do it, which
    // makes it the wrong choice for exactly the phases people reach for it on.
    expect(byId('openai/gpt-oss-120b').supportsStructuredOutputs).toBe(true)
    expect(byId('nvidia/nemotron-3-ultra-550b-a55b:free').supportsStructuredOutputs).toBe(false)
  })

  it('captures the output ceiling, including ones below our request default', () => {
    // MAX_OUTPUT_TOKENS is 32,768. glm-4.7-flash advertises 16,384, so an
    // unclamped request against it is invalid — this is the field that lets us
    // clamp instead of 400ing.
    expect(byId('z-ai/glm-4.7-flash').maxCompletionTokens).toBe(16384)
    expect(byId('google/gemini-2.5-pro').maxCompletionTokens).toBe(65536)
  })

  it('captures context length for sizing decisions', () => {
    expect(byId('openai/gpt-oss-120b').contextLength).toBe(131072)
    expect(byId('google/gemini-2.5-pro').contextLength).toBe(1048576)
  })

  it('carries modalities through for the transcription work', () => {
    expect(byId('google/gemini-2.5-pro').inputModalities).toContain('audio')
    expect(byId('openai/gpt-oss-120b').inputModalities).toEqual(['text'])
  })

  it('survives a malformed or empty feed rather than throwing', () => {
    expect(normaliseCatalogue(null)).toEqual([])
    expect(normaliseCatalogue({})).toEqual([])
    expect(normaliseCatalogue({ data: 'nope' })).toEqual([])
    expect(normaliseCatalogue({ data: [] })).toEqual([])
  })

  it('drops rows that cannot be priced rather than defaulting them', () => {
    const out = normaliseCatalogue({
      data: [
        { id: 'no-pricing-block' },
        { id: 'unparseable', pricing: { prompt: 'abc', completion: '1' } },
        { name: 'no id at all', pricing: { prompt: '1', completion: '1' } },
        { id: 'good', pricing: { prompt: '0.000001', completion: '0.000002' } },
      ],
    })
    expect(out.map((m) => m.id)).toEqual(['good'])
  })

  it('defaults missing optional fields without inventing capability', () => {
    const [m] = normaliseCatalogue({
      data: [{ id: 'bare', pricing: { prompt: '0.000001', completion: '0.000002' } }],
    })
    expect(m.contextLength).toBe(0)
    expect(m.maxCompletionTokens).toBeNull()
    expect(m.supportsStructuredOutputs).toBe(false)
    expect(m.isModerated).toBe(false)
    expect(m.inputModalities).toEqual([])
  })
})

describe('isCatalogueFresh', () => {
  const at = (iso: string): OpenRouterCatalogue => ({ fetchedAt: iso, models })

  it('treats a just-fetched catalogue as fresh', () => {
    const now = Date.parse('2026-08-18T12:00:00Z')
    expect(isCatalogueFresh(at('2026-08-18T12:00:00Z'), now)).toBe(true)
  })

  it('expires once past the TTL', () => {
    const now = Date.parse('2026-08-18T12:00:00Z')
    expect(isCatalogueFresh(at('2026-08-17T11:59:00Z'), now)).toBe(false)
    expect(isCatalogueFresh(at('2026-08-17T12:30:00Z'), now)).toBe(true)
  })

  it('rejects null, empty and unparseable caches', () => {
    const now = Date.now()
    expect(isCatalogueFresh(null, now)).toBe(false)
    expect(isCatalogueFresh({ fetchedAt: 'not-a-date', models }, now)).toBe(false)
    expect(isCatalogueFresh({ fetchedAt: new Date(now).toISOString(), models: [] }, now)).toBe(false)
  })

  it('does not treat a future timestamp as immortally fresh', () => {
    // A clock that jumped backwards would otherwise pin the cache forever.
    const now = Date.parse('2026-08-18T12:00:00Z')
    const future = new Date(now + CATALOGUE_TTL_MS * 2).toISOString()
    expect(isCatalogueFresh({ fetchedAt: future, models }, now)).toBe(false)
  })
})

describe('findModel', () => {
  const cat: OpenRouterCatalogue = { fetchedAt: new Date().toISOString(), models }

  it('finds a known model', () => {
    expect(findModel(cat, 'openai/gpt-oss-120b')?.contextLength).toBe(131072)
  })

  it('returns null for unknown ids and a null catalogue', () => {
    expect(findModel(cat, 'nope/nope')).toBeNull()
    expect(findModel(null, 'openai/gpt-oss-120b')).toBeNull()
  })
})

describe('tiered pricing', () => {
  // 61 of 413 catalogue models raise their rate above a prompt-length
  // threshold. Condense ships the whole knowledge base — a 2 MB vault is
  // ~557k prompt tokens — so quoting the base rate there can understate the
  // real charge by 2x or more.
  const TIERED = {
    data: [
      {
        id: 'qwen/qwen3-max',
        pricing: {
          prompt: '0.00000078',
          completion: '0.0000039',
          overrides: [
            { min_prompt_tokens: 32000, prompt: '0.00000156', completion: '0.0000078' },
            { min_prompt_tokens: 128000, prompt: '0.00000195', completion: '0.00000975' },
          ],
        },
      },
      {
        id: 'flat/model',
        pricing: { prompt: '0.000001', completion: '0.000002' },
      },
      {
        id: 'timeband/model',
        pricing: {
          prompt: '0.000001',
          completion: '0.000002',
          // Off-peak discount bands, keyed on time of day rather than length.
          overrides: [{ utc_start: 100, utc_end: 400, prompt: '0.0000005', completion: '0.000001' }],
        },
      },
    ],
  }
  const tiered = normaliseCatalogue(TIERED)
  const qwen = tiered.find((m) => m.id === 'qwen/qwen3-max')!

  it('captures prompt-length bands in ascending order', () => {
    expect(qwen.pricingTiers).toHaveLength(2)
    expect(qwen.pricingTiers![0].minPromptTokens).toBe(32_000)
    expect(qwen.pricingTiers![1].minPromptTokens).toBe(128_000)
  })

  it('quotes the base rate below the first threshold', () => {
    const p = priceAt(qwen, 9_000)
    expect(p.inputPerM).toBeCloseTo(0.78, 6)
    expect(p.tiered).toBe(false)
  })

  it('doubles above the first threshold', () => {
    const p = priceAt(qwen, 40_000)
    expect(p.inputPerM).toBeCloseTo(1.56, 6)
    expect(p.outputPerM).toBeCloseTo(7.8, 6)
    expect(p.tiered).toBe(true)
  })

  it('picks the highest band that applies, not the first', () => {
    const p = priceAt(qwen, 200_000)
    expect(p.inputPerM).toBeCloseTo(1.95, 6)
  })

  it('applies the top band at the vault-sized prompt Condense actually sends', () => {
    // ~557k tokens for the reference vault. Quoting the base rate here would
    // understate this phase by 2.5x.
    const p = priceAt(qwen, 557_000)
    expect(p.inputPerM).toBeCloseTo(1.95, 6)
    expect(p.inputPerM / qwen.inputPerM).toBeCloseTo(2.5, 1)
  })

  it('leaves flat-priced models alone', () => {
    const flat = tiered.find((m) => m.id === 'flat/model')!
    expect(flat.pricingTiers).toBeUndefined()
    expect(priceAt(flat, 1_000_000).tiered).toBe(false)
  })

  it('ignores time-of-day bands', () => {
    // An off-peak discount would make an estimate depend on when the user
    // happens to press the button, which is worse than quoting standard rate.
    const tb = tiered.find((m) => m.id === 'timeband/model')!
    expect(tb.pricingTiers).toBeUndefined()
  })
})

describe('reasoning metadata', () => {
  const RAW_R = {
    data: [
      {
        id: 'openai/gpt-oss-120b',
        pricing: { prompt: '0.00000003', completion: '0.00000017' },
        reasoning: { mandatory: true, supported_efforts: ['high', 'medium', 'low'] },
      },
      {
        id: 'nvidia/nemotron-3.5-lightning:free',
        pricing: { prompt: '0', completion: '0' },
        reasoning: { mandatory: false },
      },
      { id: 'plain/model', pricing: { prompt: '0.000001', completion: '0.000002' } },
    ],
  }
  const models = normaliseCatalogue(RAW_R)

  it('records mandatory reasoning and the available effort levels', () => {
    const m = models.find((x) => x.id === 'openai/gpt-oss-120b')!
    expect(m.reasoning?.mandatory).toBe(true)
    expect(m.reasoning?.supportedEfforts).toEqual(['high', 'medium', 'low'])
  })

  it('marks models measured to write reasoning into the reply body', () => {
    // Distinct from mandatory reasoning: Gemini 2.5 Pro is mandatory-reasoning
    // and perfectly clean. What matters is whether deliberation lands in the
    // prose, which can only be established by probing.
    const leaky = models.find((x) => x.id === 'nvidia/nemotron-3.5-lightning:free')!
    expect(leaky.leaksReasoning).toBe(true)
    expect(leaky.reasoning?.mandatory).toBe(false)
  })

  it('leaves non-reasoning models unmarked', () => {
    const plain = models.find((x) => x.id === 'plain/model')!
    expect(plain.reasoning).toBeUndefined()
    expect(plain.leaksReasoning).toBeUndefined()
  })
})
