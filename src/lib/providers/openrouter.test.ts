import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ROUTING,
  OPENROUTER_BASE_URL,
  OpenRouterProvider,
  buildMessages,
  buildProviderBlock,
  isFreeVariant,
} from './openrouter'
import { OPENROUTER_FREE_LIMITS } from '../rateLimit'

type TextBlock = { type: string; text: string; cache_control?: { type: string } }
type Msg = { role: string; content: string | TextBlock[] }

describe('buildMessages', () => {
  const base = {
    framing: 'FRAMING',
    systemPrompt: 'SYSTEM',
    cacheablePrefix: 'PREFIX',
    userPrompt: 'CHUNK',
  }

  it('puts the stable content in a system message and the chunk in a user message', () => {
    const [sys, user] = buildMessages(base) as Msg[]
    expect(sys.role).toBe('system')
    expect(user.role).toBe('user')
    expect(user.content).toBe('CHUNK')
  })

  it('marks the system block with a cache_control breakpoint', () => {
    // Without this the prefix is re-billed in full on every chunk. The failure
    // is silent — the request still succeeds, the bill is just several times
    // larger — so it is worth an explicit assertion.
    const [sys] = buildMessages(base) as Msg[]
    const blocks = sys.content as TextBlock[]
    expect(Array.isArray(blocks)).toBe(true)
    expect(blocks[0].cache_control).toEqual({ type: 'ephemeral' })
  })

  it('keeps the system content as an array, since a plain string cannot carry the breakpoint', () => {
    const [sys] = buildMessages(base) as Msg[]
    expect(typeof sys.content).not.toBe('string')
  })

  it('orders framing, then system prompt, then cacheable prefix', () => {
    const [sys] = buildMessages(base) as Msg[]
    const text = (sys.content as TextBlock[])[0].text
    expect(text).toBe('FRAMING\n\nSYSTEM\n\nPREFIX')
  })

  it('drops empty parts rather than emitting blank separators', () => {
    // strictFraming passes framing: '' and most phases pass systemPrompt: ''.
    const [sys] = buildMessages({ ...base, framing: '', systemPrompt: '' }) as Msg[]
    expect((sys.content as TextBlock[])[0].text).toBe('PREFIX')
  })

  it('emits no system message at all when there is nothing stable to cache', () => {
    // Phases 2 and 4 ship no cacheablePrefix. Sending an empty system block
    // would create a cache entry worth nothing.
    const msgs = buildMessages({
      framing: '',
      systemPrompt: '',
      cacheablePrefix: '',
      userPrompt: 'CHUNK',
    }) as Msg[]
    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe('user')
  })

  it('trims surrounding whitespace so the prefix stays byte-stable across chunks', () => {
    // Prompt builders assemble with joins and can leave trailing newlines. A
    // prefix that differs by one character between chunks never hits cache.
    const a = buildMessages({ ...base, cacheablePrefix: 'PREFIX' }) as Msg[]
    const b = buildMessages({ ...base, cacheablePrefix: '  PREFIX\n\n' }) as Msg[]
    expect((a[0].content as TextBlock[])[0].text).toBe((b[0].content as TextBlock[])[0].text)
  })
})

describe('buildProviderBlock — the privacy floor', () => {
  it('defaults to zero-retention and no data collection', () => {
    // This is the default, not a suggestion. A session transcript is other
    // people's private conversation and they did not agree to it being
    // retained by an inference provider.
    const block = buildProviderBlock()
    expect(block.zdr).toBe(true)
    expect(block.data_collection).toBe('deny')
  })

  it('sorts by price by default', () => {
    expect(buildProviderBlock().sort).toBe('price')
  })

  it('exposes the same defaults as DEFAULT_ROUTING', () => {
    const block = buildProviderBlock()
    expect(block.zdr).toBe(DEFAULT_ROUTING.zdr)
    expect(block.data_collection).toBe(DEFAULT_ROUTING.dataCollection)
  })

  it('allows the floor to be lowered explicitly, never implicitly', () => {
    // Reaching a :free model requires this, because as of 2026-08-18 none of
    // the 15 free models runs on a zero-retention provider and 7 are hosted by
    // NVIDIA, which may train on prompts.
    const block = buildProviderBlock({ zdr: false, dataCollection: 'allow' })
    expect(block.zdr).toBe(false)
    expect(block.data_collection).toBe('allow')
  })

  it('pins to specific upstreams when asked', () => {
    // Needed for transcription, where verbose_json + word timestamps only work
    // on OpenAI, Groq and Together.
    expect(buildProviderBlock({ only: ['groq'] }).only).toEqual(['groq'])
  })

  it('omits `only` entirely when the list is empty', () => {
    expect(buildProviderBlock({ only: [] }).only).toBeUndefined()
    expect(buildProviderBlock().only).toBeUndefined()
  })

  it('keeps unspecified fields at their defaults when partially overridden', () => {
    const block = buildProviderBlock({ sort: 'throughput' })
    expect(block.sort).toBe('throughput')
    expect(block.zdr).toBe(true)
    expect(block.data_collection).toBe('deny')
  })
})

describe('OpenRouterProvider', () => {
  it('reports the right provider name', () => {
    expect(new OpenRouterProvider({ apiKey: 'k' }).name).toBe('openrouter')
  })

  it('targets the OpenRouter base URL', () => {
    expect(OPENROUTER_BASE_URL).toBe('https://openrouter.ai/api/v1')
  })

  it('has no key until one is supplied', () => {
    expect(new OpenRouterProvider({ apiKey: 'sk-or-test' }).hasKey()).toBe(true)
  })

  it('reports actual billed cost rather than an estimate', () => {
    // OpenRouter returns usage.cost on every response with no opt-in, so this
    // is the one provider where the number shown is what was charged.
    const p = new OpenRouterProvider({ apiKey: 'k' })
    expect(p.estimateCost({ inputTokens: 1000, outputTokens: 500, costUsd: 0.0123 })).toBe(0.0123)
  })

  it('reports zero rather than guessing when the response carried no cost', () => {
    const p = new OpenRouterProvider({ apiKey: 'k' })
    expect(p.estimateCost({ inputTokens: 1000, outputTokens: 500 })).toBe(0)
  })

  it('suggests only models fit for the pipeline', async () => {
    // Every suggestion must be unmoderated (prose phases get refused
    // otherwise), support structured outputs (audit and extras emit JSON) and
    // declare an output ceiling at or above MAX_OUTPUT_TOKENS.
    const models = await new OpenRouterProvider({ apiKey: 'k' }).listModels()
    expect(models.length).toBeGreaterThan(0)
    for (const id of models) expect(id).toContain('/')
  })

  it('exposes pacing through its own rate-limit state', () => {
    const p = new OpenRouterProvider({ apiKey: 'k' })
    expect(p.getNextDelayMs(1000)).toBe(0)
  })
})

describe('free-variant handling', () => {
  it('recognises the :free suffix', () => {
    expect(isFreeVariant('nvidia/nemotron-3-ultra-550b-a55b:free')).toBe(true)
    expect(isFreeVariant('openai/gpt-oss-120b')).toBe(false)
    // The paid variant of the same model has no platform request cap.
    expect(isFreeVariant('openai/gpt-oss-20b')).toBe(false)
    expect(isFreeVariant('openai/gpt-oss-20b:free')).toBe(true)
  })

  it('paces a free variant at the platform cap', () => {
    // 20 RPM -> 3,000ms, x1.1 safety = 3,300ms between calls.
    const p = new OpenRouterProvider({ apiKey: 'k' })
    const free = 'openai/gpt-oss-20b:free'
    expect(p.getNextDelayMs(1000, 1, free)).toBe(0)
    p.rateLimit.noteCall(free)
    // Bounded, not exact. The delay is the cap MINUS however long has already
    // elapsed since noteCall, so asserting 3,300 exactly only passes when both
    // statements land in the same millisecond — true on an idle machine, false
    // under load. That made this fail intermittently for reasons having
    // nothing to do with pacing.
    // The ceiling is 3_301, not 3_300: the cap is computed as 3_000 * 1.1,
    // which in floating point is 3300.0000000000005, so an exact-or-below
    // assertion fails on the very case it is meant to accept.
    const delay = p.getNextDelayMs(1000, 1, free)
    expect(delay).toBeGreaterThan(3_200)
    expect(delay).toBeLessThanOrEqual(3_301)
  })

  it('lets a paid model run at full speed rather than a guessed floor', () => {
    // Paid models carry no platform request cap, so with no observed headers
    // yet there is nothing to wait for. Seeding them with a conservative
    // default would throttle the fast path for no reason.
    const p = new OpenRouterProvider({ apiKey: 'k' })
    expect(p.getNextDelayMs(1000, 1, 'openai/gpt-oss-120b')).toBe(0)
  })

  it('keeps free and paid budgets separate within one run', () => {
    // The whole point of per-model buckets: a hybrid routing that grounds on a
    // free model and writes prose on a paid one must not pace the paid calls
    // at the free model's 20 RPM.
    const p = new OpenRouterProvider({ apiKey: 'k' })
    p.rateLimit.noteCall('openai/gpt-oss-20b:free')
    expect(p.getNextDelayMs(1000, 1, 'openai/gpt-oss-120b')).toBe(0)
  })

  it('sets the daily cap from the account tier', () => {
    const p = new OpenRouterProvider({ apiKey: 'k' })
    p.setDailyBudget(true)
    expect(p.rateLimit.daily.remaining()).toBe(OPENROUTER_FREE_LIMITS.rpdNoCredits)
    p.setDailyBudget(false)
    expect(p.rateLimit.daily.remaining()).toBe(OPENROUTER_FREE_LIMITS.rpdWithCredits)
  })
})
