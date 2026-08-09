/** @vitest-environment jsdom */
//
// K.3.3 — OpenAI provider tests. Mirrors claude.test.ts shape. The
// OpenAI Responses SDK call we stub is `client.responses.create(...).
// withResponse()` returning `{ data: response, response: rawResponse }`.
//
// Header parsing differs from Claude: OpenAI uses `x-ratelimit-*`
// headers with duration-string values (e.g. "6m0s", "30s", "1.5s",
// "100ms"). The provider parses these into a snapshot.resetMs value.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OpenAIProvider } from './openai'

type WithResponseResult = {
  data: {
    output_text?: string
    status?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      input_tokens_details?: { cached_tokens?: number }
    }
  }
  response: { headers: Headers }
}

type CreateFn = (...args: unknown[]) => { withResponse: () => Promise<WithResponseResult> }

function setClientStub(p: OpenAIProvider, createFn: CreateFn): { create: CreateFn } {
  const responses = { create: createFn }
  ;(p as unknown as { client: { responses: { create: CreateFn } } }).client = { responses }
  return responses
}

function makeOkResponse(text: string, opts?: {
  headers?: Record<string, string>
  inputTokens?: number
  outputTokens?: number
  cachedTokens?: number
}): WithResponseResult {
  return {
    data: {
      output_text: text,
      status: 'completed',
      usage: {
        input_tokens: opts?.inputTokens ?? 100,
        output_tokens: opts?.outputTokens ?? 50,
        input_tokens_details: { cached_tokens: opts?.cachedTokens ?? 0 },
      },
    },
    response: { headers: new Headers(opts?.headers ?? {}) },
  }
}

function makeError(status: number, opts?: { headers?: Record<string, string>; message?: string }): Error {
  const err = new Error(opts?.message ?? `HTTP ${status}`) as Error & {
    status?: number
    headers?: Record<string, string>
  }
  err.status = status
  if (opts?.headers) err.headers = opts.headers
  return err
}

function makeProvider(): OpenAIProvider {
  return new OpenAIProvider({ apiKey: 'sk-openai-test' })
}

// ──────────────────── happy path ────────────────────

describe('OpenAIProvider — happy path', () => {
  it('returns text + usage on a successful call', async () => {
    const p = makeProvider()
    setClientStub(p, () => ({
      withResponse: async () => makeOkResponse('hello', { inputTokens: 250, outputTokens: 80 }),
    }))
    const out = await p.generate({
      systemPrompt: 'sys',
      userPrompt: 'u',
      model: 'gpt-5',
      maxOutputTokens: 100,
    })
    expect(out.text).toBe('hello')
    expect(out.usage.inputTokens).toBe(250)
    expect(out.usage.outputTokens).toBe(80)
  })

  it('exposes cached_tokens via usage.cachedInputTokens', async () => {
    const p = makeProvider()
    setClientStub(p, () => ({
      withResponse: async () =>
        makeOkResponse('ok', { inputTokens: 200, outputTokens: 30, cachedTokens: 150 }),
    }))
    const out = await p.generate({
      systemPrompt: '',
      userPrompt: 'u',
      model: 'gpt-5',
      maxOutputTokens: 100,
    })
    expect(out.usage.cachedInputTokens).toBe(150)
  })

  it('builds instructions from framing + systemPrompt + cacheablePrefix joined with blank lines', async () => {
    const p = makeProvider()
    const stub = setClientStub(p, () => ({
      withResponse: async () => makeOkResponse('ok'),
    }))
    const spy = vi.spyOn(stub, 'create')
    await p.generate({
      systemPrompt: 'user-sys',
      cacheablePrefix: 'big-kb',
      userPrompt: 'u',
      model: 'gpt-5',
      maxOutputTokens: 100,
    })
    const args = spy.mock.calls[0][0] as { instructions: string }
    expect(args.instructions).toMatch(/transcript from a tabletop role-playing game/)
    expect(args.instructions).toMatch(/user-sys/)
    expect(args.instructions).toMatch(/big-kb/)
    // Should be joined with double-newlines (the join('\n\n') contract).
    const parts = args.instructions.split('\n\n')
    expect(parts.length).toBeGreaterThanOrEqual(3)
  })

  it('omits empty parts from instructions', async () => {
    const p = makeProvider()
    const stub = setClientStub(p, () => ({
      withResponse: async () => makeOkResponse('ok'),
    }))
    const spy = vi.spyOn(stub, 'create')
    await p.generate({
      systemPrompt: '',
      userPrompt: 'u',
      model: 'gpt-5',
      maxOutputTokens: 100,
    })
    const args = spy.mock.calls[0][0] as { instructions: string }
    // No user system, no cacheable prefix → instructions = framing only.
    expect(args.instructions.split('\n\n').length).toBe(1)
  })

  it('sends store: false to keep responses local', async () => {
    const p = makeProvider()
    const stub = setClientStub(p, () => ({
      withResponse: async () => makeOkResponse('ok'),
    }))
    const spy = vi.spyOn(stub, 'create')
    await p.generate({
      systemPrompt: '',
      userPrompt: 'u',
      model: 'gpt-5',
      maxOutputTokens: 100,
    })
    const args = spy.mock.calls[0][0] as { store: boolean }
    expect(args.store).toBe(false)
  })

  it('passes temperature when set, omits when undefined', async () => {
    const p = makeProvider()
    const stub = setClientStub(p, () => ({
      withResponse: async () => makeOkResponse('ok'),
    }))
    const spy = vi.spyOn(stub, 'create')
    await p.generate({
      systemPrompt: '',
      userPrompt: 'u',
      model: 'gpt-5',
      maxOutputTokens: 100,
      temperature: 0.2,
    })
    expect((spy.mock.calls[0][0] as { temperature?: number }).temperature).toBe(0.2)
    spy.mockClear()
    await p.generate({
      systemPrompt: '',
      userPrompt: 'u',
      model: 'gpt-5',
      maxOutputTokens: 100,
    })
    expect('temperature' in (spy.mock.calls[0][0] as Record<string, unknown>)).toBe(false)
  })

  it('throws on empty response', async () => {
    const p = makeProvider()
    setClientStub(p, () => ({
      withResponse: async () => ({
        data: {
          output_text: '',
          status: 'incomplete',
          usage: { input_tokens: 100, output_tokens: 0 },
        },
        response: { headers: new Headers() },
      }),
    }))
    await expect(
      p.generate({
        systemPrompt: '',
        userPrompt: 'u',
        model: 'gpt-5',
        maxOutputTokens: 100,
      }),
    ).rejects.toThrow(/empty response/i)
  })
})

// ──────────────────── 429 / Retry-After ────────────────────

describe('OpenAIProvider — 429 / Retry-After', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('honours Retry-After in seconds', async () => {
    const p = makeProvider()
    let callCount = 0
    setClientStub(p, () => ({
      withResponse: async () => {
        callCount++
        if (callCount === 1) throw makeError(429, { headers: { 'retry-after': '20' } })
        return makeOkResponse('recovered')
      },
    }))
    const promise = p.generate({
      systemPrompt: '',
      userPrompt: 'u',
      model: 'gpt-5',
      maxOutputTokens: 100,
    })
    await vi.runAllTimersAsync()
    const out = await promise
    expect(out.text).toBe('recovered')
    expect(callCount).toBe(2)
  })

  it('parses Retry-After from a Headers instance', async () => {
    const p = makeProvider()
    let callCount = 0
    setClientStub(p, () => ({
      withResponse: async () => {
        callCount++
        if (callCount === 1) {
          const headers = new Headers()
          headers.set('retry-after', '10')
          throw Object.assign(new Error('rate-limited'), { status: 429, headers })
        }
        return makeOkResponse('ok')
      },
    }))
    const promise = p.generate({
      systemPrompt: '',
      userPrompt: 'u',
      model: 'gpt-5',
      maxOutputTokens: 100,
    })
    await vi.runAllTimersAsync()
    await promise
    expect(callCount).toBe(2)
  })

  it('invokes onRetry(attempt, waitMs) with the parsed retry-after', async () => {
    const p = makeProvider()
    let callCount = 0
    setClientStub(p, () => ({
      withResponse: async () => {
        callCount++
        if (callCount === 1) throw makeError(429, { headers: { 'retry-after': '7' } })
        return makeOkResponse('ok')
      },
    }))
    const onRetry = vi.fn()
    const promise = p.generate(
      { systemPrompt: '', userPrompt: 'u', model: 'gpt-5', maxOutputTokens: 100 },
      { onRetry },
    )
    await vi.runAllTimersAsync()
    await promise
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(onRetry.mock.calls[0][1]).toBe(7_000)
  })

  it('eventually throws after MAX_RETRIES of 429s', async () => {
    const p = makeProvider()
    setClientStub(p, () => ({
      withResponse: async () => {
        throw makeError(429)
      },
    }))
    const promise = p
      .generate({
        systemPrompt: '',
        userPrompt: 'u',
        model: 'gpt-5',
        maxOutputTokens: 100,
      })
      .catch((e: unknown) => e)
    await vi.runAllTimersAsync()
    const result = await promise
    expect(result).toBeInstanceOf(Error)
  })
})

// ──────────────────── Transient retries (500/502/503) ────────────────────

describe('OpenAIProvider — transient retries', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it.each([500, 502, 503])('retries on %d and succeeds on the next attempt', async (status) => {
    const p = makeProvider()
    let callCount = 0
    setClientStub(p, () => ({
      withResponse: async () => {
        callCount++
        if (callCount === 1) throw makeError(status)
        return makeOkResponse('ok')
      },
    }))
    const promise = p.generate({
      systemPrompt: '',
      userPrompt: 'u',
      model: 'gpt-5',
      maxOutputTokens: 100,
    })
    await vi.runAllTimersAsync()
    const out = await promise
    expect(out.text).toBe('ok')
    expect(callCount).toBe(2)
  })

  it('does NOT retry on 400 / 401 / 403', async () => {
    for (const status of [400, 401, 403]) {
      const p = makeProvider()
      let callCount = 0
      setClientStub(p, () => ({
        withResponse: async () => {
          callCount++
          throw makeError(status)
        },
      }))
      await expect(
        p.generate({
          systemPrompt: '',
          userPrompt: 'u',
          model: 'gpt-5',
          maxOutputTokens: 100,
        }),
      ).rejects.toThrow()
      expect(callCount).toBe(1)
    }
  })

  it('eventually throws after MAX_RETRIES of transient errors', async () => {
    const p = makeProvider()
    let callCount = 0
    setClientStub(p, () => ({
      withResponse: async () => {
        callCount++
        throw makeError(503)
      },
    }))
    const promise = p
      .generate({
        systemPrompt: '',
        userPrompt: 'u',
        model: 'gpt-5',
        maxOutputTokens: 100,
      })
      .catch((e: unknown) => e)
    await vi.runAllTimersAsync()
    const result = await promise
    expect(result).toBeInstanceOf(Error)
    expect(callCount).toBe(5) // initial + 4 retries
  })

  it('wraps the final error with contextLabel', async () => {
    const p = makeProvider()
    setClientStub(p, () => ({
      withResponse: async () => {
        throw makeError(503, { message: 'Service Unavailable' })
      },
    }))
    const promise = p
      .generate(
        { systemPrompt: '', userPrompt: 'u', model: 'gpt-5', maxOutputTokens: 100 },
        { contextLabel: 'Phase 4 — chunk 1/3' },
      )
      .catch((e: unknown) => e)
    await vi.runAllTimersAsync()
    const result = (await promise) as Error
    expect(result.message).toMatch(/Phase 4 — chunk 1\/3/)
  })

  it('wraps non-retryable errors with contextLabel immediately', async () => {
    const p = makeProvider()
    setClientStub(p, () => ({
      withResponse: async () => {
        throw makeError(400, { message: 'bad request' })
      },
    }))
    await expect(
      p.generate(
        { systemPrompt: '', userPrompt: 'u', model: 'gpt-5', maxOutputTokens: 100 },
        { contextLabel: 'Phase 2 chunk 1' },
      ),
    ).rejects.toThrow(/Phase 2 chunk 1/)
  })
})

// ──────────────────── Header parsing (x-ratelimit-* + duration strings) ────────────────────

describe('OpenAIProvider — header parsing', () => {
  it('parses x-ratelimit-limit-requests / -tokens into rpm + tpm', async () => {
    const p = makeProvider()
    setClientStub(p, () => ({
      withResponse: async () =>
        makeOkResponse('ok', {
          headers: {
            'x-ratelimit-limit-requests': '60',
            'x-ratelimit-limit-tokens': '40000',
          },
        }),
    }))
    await p.generate({
      systemPrompt: '',
      userPrompt: 'u',
      model: 'gpt-5',
      maxOutputTokens: 100,
    })
    const snap = p.rateLimit.snapshotForDebug()
    expect(snap.rpm).toBe(60)
    expect(snap.tpm).toBe(40000)
  })

  it('parses x-ratelimit-remaining-requests / -tokens', async () => {
    const p = makeProvider()
    setClientStub(p, () => ({
      withResponse: async () =>
        makeOkResponse('ok', {
          headers: {
            'x-ratelimit-remaining-requests': '53',
            'x-ratelimit-remaining-tokens': '38000',
          },
        }),
    }))
    await p.generate({
      systemPrompt: '',
      userPrompt: 'u',
      model: 'gpt-5',
      maxOutputTokens: 100,
    })
    const snap = p.rateLimit.snapshotForDebug()
    expect(snap.requestsRemaining).toBe(53)
    expect(snap.tokensRemaining).toBe(38000)
  })

  it('parses duration string "6m0s" into resetMs = 360_000', async () => {
    const p = makeProvider()
    setClientStub(p, () => ({
      withResponse: async () =>
        makeOkResponse('ok', {
          headers: { 'x-ratelimit-reset-tokens': '6m0s' },
        }),
    }))
    await p.generate({
      systemPrompt: '',
      userPrompt: 'u',
      model: 'gpt-5',
      maxOutputTokens: 100,
    })
    expect(p.rateLimit.snapshotForDebug().resetMs).toBe(360_000)
  })

  it('parses duration string "30s" into resetMs = 30_000', async () => {
    const p = makeProvider()
    setClientStub(p, () => ({
      withResponse: async () =>
        makeOkResponse('ok', {
          headers: { 'x-ratelimit-reset-tokens': '30s' },
        }),
    }))
    await p.generate({
      systemPrompt: '',
      userPrompt: 'u',
      model: 'gpt-5',
      maxOutputTokens: 100,
    })
    expect(p.rateLimit.snapshotForDebug().resetMs).toBe(30_000)
  })

  it('parses sub-second duration "1.5s" into resetMs = 1500', async () => {
    const p = makeProvider()
    setClientStub(p, () => ({
      withResponse: async () =>
        makeOkResponse('ok', {
          headers: { 'x-ratelimit-reset-tokens': '1.5s' },
        }),
    }))
    await p.generate({
      systemPrompt: '',
      userPrompt: 'u',
      model: 'gpt-5',
      maxOutputTokens: 100,
    })
    expect(p.rateLimit.snapshotForDebug().resetMs).toBe(1500)
  })

  it('parses millisecond duration "100ms" into resetMs = 100', async () => {
    const p = makeProvider()
    setClientStub(p, () => ({
      withResponse: async () =>
        makeOkResponse('ok', {
          headers: { 'x-ratelimit-reset-tokens': '100ms' },
        }),
    }))
    await p.generate({
      systemPrompt: '',
      userPrompt: 'u',
      model: 'gpt-5',
      maxOutputTokens: 100,
    })
    expect(p.rateLimit.snapshotForDebug().resetMs).toBe(100)
  })

  it('picks the larger of reset-requests vs reset-tokens', async () => {
    const p = makeProvider()
    setClientStub(p, () => ({
      withResponse: async () =>
        makeOkResponse('ok', {
          headers: {
            'x-ratelimit-reset-requests': '30s',
            'x-ratelimit-reset-tokens': '2m',
          },
        }),
    }))
    await p.generate({
      systemPrompt: '',
      userPrompt: 'u',
      model: 'gpt-5',
      maxOutputTokens: 100,
    })
    expect(p.rateLimit.snapshotForDebug().resetMs).toBe(120_000) // 2m wins
  })

  it('ignores unparseable header values', async () => {
    const p = makeProvider()
    setClientStub(p, () => ({
      withResponse: async () =>
        makeOkResponse('ok', {
          headers: {
            'x-ratelimit-limit-requests': '???',
            'x-ratelimit-limit-tokens': '',
          },
        }),
    }))
    await p.generate({
      systemPrompt: '',
      userPrompt: 'u',
      model: 'gpt-5',
      maxOutputTokens: 100,
    })
    const snap = p.rateLimit.snapshotForDebug()
    expect(snap.rpm).toBeUndefined()
    expect(snap.tpm).toBeUndefined()
  })

  it('getNextDelayMs reflects updated snapshot after a header-bearing call', async () => {
    const p = makeProvider()
    setClientStub(p, () => ({
      withResponse: async () =>
        makeOkResponse('ok', {
          headers: {
            'x-ratelimit-limit-requests': '60', // 1 req/sec
            'x-ratelimit-limit-tokens': '999999999',
          },
        }),
    }))
    await p.generate({
      systemPrompt: '',
      userPrompt: 'u',
      model: 'gpt-5',
      maxOutputTokens: 100,
    })
    const delay = p.getNextDelayMs(1000)
    expect(delay).toBeGreaterThanOrEqual(900)
    expect(delay).toBeLessThanOrEqual(1200)
  })
})

// ──────────────────── Abort handling ────────────────────

describe('OpenAIProvider — abort handling', () => {
  it('throws AbortError when signal is pre-aborted', async () => {
    const p = makeProvider()
    setClientStub(p, () => ({
      withResponse: async () => makeOkResponse('should-not-reach'),
    }))
    const ac = new AbortController()
    ac.abort()
    await expect(
      p.generate(
        { systemPrompt: '', userPrompt: 'u', model: 'gpt-5', maxOutputTokens: 100 },
        { signal: ac.signal },
      ),
    ).rejects.toThrow(/Abort/i)
  })

  it('throws AbortError if signal aborts during a retry sleep', async () => {
    vi.useFakeTimers()
    const p = makeProvider()
    setClientStub(p, () => ({
      withResponse: async () => {
        throw makeError(503)
      },
    }))
    const ac = new AbortController()
    const promise = p
      .generate(
        { systemPrompt: '', userPrompt: 'u', model: 'gpt-5', maxOutputTokens: 100 },
        { signal: ac.signal },
      )
      .catch((e: unknown) => e)
    await Promise.resolve()
    ac.abort()
    await vi.runAllTimersAsync()
    const result = (await promise) as Error | DOMException
    expect(String((result as Error).message ?? result)).toMatch(/Abort/i)
    vi.useRealTimers()
  })
})

// ──────────────────── Cost estimation ────────────────────

describe('OpenAIProvider.estimateCost', () => {
  it('computes cost from PRICING table for gpt-5', () => {
    const p = makeProvider()
    const cost = p.estimateCost(
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      'gpt-5',
    )
    // gpt-5 pricing: input $5/MTok, output $15/MTok.
    expect(cost).toBeCloseTo(20, 2)
  })

  it('applies cached-input discount', () => {
    const p = makeProvider()
    const cost = p.estimateCost(
      { inputTokens: 1_000_000, cachedInputTokens: 500_000, outputTokens: 0 },
      'gpt-5',
    )
    // 500K * 5 / 1M + 500K * 0.5 / 1M = 2.5 + 0.25 = 2.75
    expect(cost).toBeCloseTo(2.75, 2)
  })

  it('uses gpt-5-mini pricing', () => {
    const p = makeProvider()
    const cost = p.estimateCost(
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      'gpt-5-mini',
    )
    // mini: input $0.3, output $1.2.
    expect(cost).toBeCloseTo(1.5, 2)
  })

  it('returns 0 for unknown models', () => {
    const p = makeProvider()
    expect(p.estimateCost({ inputTokens: 1000, outputTokens: 500 }, 'gpt-4-mythical')).toBe(0)
  })
})

// ──────────────────── hasKey + listModels ────────────────────

describe('OpenAIProvider — hasKey / listModels', () => {
  it('hasKey returns true when constructed with a key', () => {
    expect(new OpenAIProvider({ apiKey: 'sk-openai-test' }).hasKey()).toBe(true)
  })

  it('hasKey returns false when no key is configured', () => {
    expect(new OpenAIProvider({ apiKey: '' }).hasKey()).toBe(false)
  })

  it('listModels returns suggested model IDs', async () => {
    const p = makeProvider()
    const models = await p.listModels()
    expect(models).toEqual(['gpt-5', 'gpt-5-mini', 'gpt-5-nano'])
  })
})

// ──────────────────── No-key path ────────────────────

describe('OpenAIProvider — no key configured', () => {
  it('throws a configuration error when generate() is called without a client', async () => {
    const p = new OpenAIProvider({ apiKey: '' })
    await expect(
      p.generate({
        systemPrompt: '',
        userPrompt: 'u',
        model: 'gpt-5',
        maxOutputTokens: 100,
      }),
    ).rejects.toThrow(/No OpenAI API key/i)
  })
})
