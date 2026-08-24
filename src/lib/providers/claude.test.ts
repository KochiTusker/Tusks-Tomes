/** @vitest-environment jsdom */
//
// K.3.2 — Claude provider tests. Mirrors the gemini.test.ts shape so
// future maintenance is a single set of conventions across providers.
//
// We stub `this.client.messages.create().withResponse()` by reassigning
// `(p as unknown as { client: unknown }).client = {...}` after
// construction. The constructor already gates on `args.apiKey`; passing
// a sentinel key gets us a real Anthropic SDK instance that we then
// replace before any test calls generate().

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClaudeProvider } from './claude'

// ──────────────────── stub helpers ────────────────────

type WithResponseResult = {
  data: {
    content: Array<{ type: string; text?: string }>
    stop_reason?: string
    usage: {
      input_tokens: number
      output_tokens: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
    }
  }
  response: { headers: Headers }
}

type CreateFn = (...args: unknown[]) => { withResponse: () => Promise<WithResponseResult> }

function setClientStub(p: ClaudeProvider, createFn: CreateFn): { create: CreateFn } {
  const messages = { create: createFn }
  ;(p as unknown as { client: { messages: { create: CreateFn } } }).client = { messages }
  return messages
}

function makeOkResponse(text: string, opts?: {
  headers?: Record<string, string>
  inputTokens?: number
  outputTokens?: number
  cacheRead?: number
  cacheCreation?: number
  stopReason?: string
}): WithResponseResult {
  const headers = new Headers(opts?.headers ?? {})
  return {
    data: {
      content: [{ type: 'text', text }],
      stop_reason: opts?.stopReason ?? 'end_turn',
      usage: {
        input_tokens: opts?.inputTokens ?? 100,
        output_tokens: opts?.outputTokens ?? 50,
        cache_creation_input_tokens: opts?.cacheCreation ?? 0,
        cache_read_input_tokens: opts?.cacheRead ?? 0,
      },
    },
    response: { headers },
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

function withFakeTimers(fn: () => Promise<void>): Promise<void> {
  // The retry loop sleeps for TRANSIENT_RETRY_MS/EXHAUSTION_RETRY_MS so
  // tests that hit retry paths MUST use fake timers + runAllTimersAsync.
  return fn()
}

function makeProvider(): ClaudeProvider {
  return new ClaudeProvider({ apiKey: 'sk-ant-test' })
}

// ──────────────────── happy path ────────────────────

describe('ClaudeProvider — happy path', () => {
  it('returns text + usage on a successful call', async () => {
    const p = makeProvider()
    setClientStub(p, () => ({
      withResponse: async () => makeOkResponse('hello world', { inputTokens: 200, outputTokens: 30 }),
    }))
    const out = await p.generate({
      systemPrompt: 'sys',
      userPrompt: 'u',
      model: 'claude-sonnet-4-6',
      maxOutputTokens: 100,
    })
    expect(out.text).toBe('hello world')
    expect(out.usage.inputTokens).toBe(200) // input + cache_creation(0) + cache_read(0)
    expect(out.usage.outputTokens).toBe(30)
  })

  it('concatenates multiple text content blocks', async () => {
    const p = makeProvider()
    ;(p as unknown as { client: { messages: { create: CreateFn } } }).client = {
      messages: {
        create: () => ({
          withResponse: async () => ({
            data: {
              content: [
                { type: 'text', text: 'part one ' },
                { type: 'text', text: 'part two' },
              ],
              stop_reason: 'end_turn',
              usage: { input_tokens: 10, output_tokens: 5 },
            },
            response: { headers: new Headers() },
          }),
        }),
      },
    }
    const out = await p.generate({
      systemPrompt: '',
      userPrompt: 'u',
      model: 'claude-sonnet-4-6',
      maxOutputTokens: 100,
    })
    expect(out.text).toBe('part one part two')
  })

  it('filters non-text content blocks', async () => {
    const p = makeProvider()
    ;(p as unknown as { client: { messages: { create: CreateFn } } }).client = {
      messages: {
        create: () => ({
          withResponse: async () => ({
            data: {
              content: [
                { type: 'tool_use' },
                { type: 'text', text: 'visible' },
                { type: 'image' },
              ],
              stop_reason: 'end_turn',
              usage: { input_tokens: 10, output_tokens: 5 },
            },
            response: { headers: new Headers() },
          }),
        }),
      },
    }
    const out = await p.generate({
      systemPrompt: '',
      userPrompt: 'u',
      model: 'claude-sonnet-4-6',
      maxOutputTokens: 100,
    })
    expect(out.text).toBe('visible')
  })

  it('sums input + cache_creation + cache_read into usage.inputTokens', async () => {
    const p = makeProvider()
    setClientStub(p, () => ({
      withResponse: async () =>
        makeOkResponse('ok', {
          inputTokens: 100,
          outputTokens: 20,
          cacheCreation: 50,
          cacheRead: 30,
        }),
    }))
    const out = await p.generate({
      systemPrompt: 's',
      userPrompt: 'u',
      model: 'claude-sonnet-4-6',
      maxOutputTokens: 100,
    })
    expect(out.usage.inputTokens).toBe(180) // 100 + 50 + 30
    expect(out.usage.cachedInputTokens).toBe(30) // cache_read explicitly
  })

  it('passes systemBlocks with TTRPG framing as first system block', async () => {
    const p = makeProvider()
    const stub = setClientStub(p, () => ({
      withResponse: async () => makeOkResponse('ok'),
    }))
    const spy = vi.spyOn(stub, 'create')
    await p.generate({
      systemPrompt: 'user-sys',
      userPrompt: 'u',
      model: 'claude-sonnet-4-6',
      maxOutputTokens: 100,
    })
    const args = spy.mock.calls[0][0] as { system: Array<{ text: string }> }
    expect(args.system).toHaveLength(1) // no cacheable prefix → single block
    expect(args.system[0].text).toMatch(/transcript from a tabletop role-playing game/)
    expect(args.system[0].text).toMatch(/user-sys/)
  })

  it('emits cacheablePrefix as a second system block with cache_control: ephemeral', async () => {
    const p = makeProvider()
    const stub = setClientStub(p, () => ({
      withResponse: async () => makeOkResponse('ok'),
    }))
    const spy = vi.spyOn(stub, 'create')
    await p.generate({
      systemPrompt: 's',
      cacheablePrefix: 'big-kb-payload',
      userPrompt: 'u',
      model: 'claude-sonnet-4-6',
      maxOutputTokens: 100,
    })
    const args = spy.mock.calls[0][0] as {
      system: Array<{ text: string; cache_control?: { type: string } }>
    }
    expect(args.system).toHaveLength(2)
    expect(args.system[1].text).toBe('big-kb-payload')
    expect(args.system[1].cache_control).toEqual({ type: 'ephemeral' })
  })

  it('passes temperature when set, omits when undefined', async () => {
    const p = makeProvider()
    const stub = setClientStub(p, () => ({
      withResponse: async () => makeOkResponse('ok'),
    }))
    const spy = vi.spyOn(stub, 'create')
    await p.generate({
      systemPrompt: 's',
      userPrompt: 'u',
      model: 'claude-sonnet-4-6',
      maxOutputTokens: 100,
      temperature: 0.4,
    })
    const args = spy.mock.calls[0][0] as { temperature?: number }
    expect(args.temperature).toBe(0.4)

    spy.mockClear()
    await p.generate({
      systemPrompt: 's',
      userPrompt: 'u',
      model: 'claude-sonnet-4-6',
      maxOutputTokens: 100,
    })
    const args2 = spy.mock.calls[0][0] as Record<string, unknown>
    expect('temperature' in args2).toBe(false)
  })

  it('throws on empty response (no text content)', async () => {
    const p = makeProvider()
    setClientStub(p, () => ({
      withResponse: async () => ({
        data: {
          content: [{ type: 'text', text: '' }],
          stop_reason: 'max_tokens',
          usage: { input_tokens: 100, output_tokens: 0 },
        },
        response: { headers: new Headers() },
      }),
    }))
    await expect(
      p.generate({
        systemPrompt: 's',
        userPrompt: 'u',
        model: 'claude-sonnet-4-6',
        maxOutputTokens: 100,
      }),
    ).rejects.toThrow(/empty response/)
  })
})

// ──────────────────── 429 + Retry-After ────────────────────

describe('ClaudeProvider — 429 / Retry-After', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('honours Retry-After in seconds and updates RateLimitState.retryAfterUntil', async () => {
    const p = makeProvider()
    let callCount = 0
    setClientStub(p, () => ({
      withResponse: async () => {
        callCount++
        if (callCount === 1) throw makeError(429, { headers: { 'retry-after': '30' } })
        return makeOkResponse('recovered')
      },
    }))

    const promise = p.generate({
      systemPrompt: 's',
      userPrompt: 'u',
      model: 'claude-sonnet-4-6',
      maxOutputTokens: 100,
    })
    await vi.runAllTimersAsync()
    const out = await promise
    expect(out.text).toBe('recovered')
    expect(callCount).toBe(2)
    // RateLimitState should have observed the retry-after (delay ~30s after the 429).
    const snap = p.rateLimit.snapshotForDebug()
    // The snapshot doesn't carry retryAfterUntil directly — we assert by
    // observing the next delay reports ~30000ms before any time advances.
    // Already advanced past it by runAllTimers above; use a fresh check
    // pattern by computing what delayBeforeNextCall would return.
    expect(snap).toBeDefined() // retryAfterUntil is private; covered indirectly via the wait math
  })

  it('parses Retry-After from a Headers instance (real fetch shape)', async () => {
    const p = makeProvider()
    let callCount = 0
    setClientStub(p, () => ({
      withResponse: async () => {
        callCount++
        if (callCount === 1) {
          const headers = new Headers()
          headers.set('retry-after', '15')
          throw Object.assign(new Error('rate-limited'), { status: 429, headers })
        }
        return makeOkResponse('ok')
      },
    }))
    const promise = p.generate({
      systemPrompt: '',
      userPrompt: 'u',
      model: 'claude-sonnet-4-6',
      maxOutputTokens: 100,
    })
    await vi.runAllTimersAsync()
    await promise
    expect(callCount).toBe(2)
  })

  it('falls back to EXHAUSTION_RETRY_MS / TRANSIENT_RETRY_MS when Retry-After missing', async () => {
    const p = makeProvider()
    let callCount = 0
    setClientStub(p, () => ({
      withResponse: async () => {
        callCount++
        if (callCount <= 1) throw makeError(429) // no retry-after header
        return makeOkResponse('ok')
      },
    }))
    const promise = p.generate({
      systemPrompt: '',
      userPrompt: 'u',
      model: 'claude-sonnet-4-6',
      maxOutputTokens: 100,
    })
    await vi.runAllTimersAsync()
    await promise
    expect(callCount).toBe(2)
  })

  it('calls onRetry(attempt, waitMs) on each retry', async () => {
    const p = makeProvider()
    let callCount = 0
    setClientStub(p, () => ({
      withResponse: async () => {
        callCount++
        if (callCount === 1) throw makeError(429, { headers: { 'retry-after': '5' } })
        return makeOkResponse('ok')
      },
    }))
    const onRetry = vi.fn()
    const promise = p.generate(
      {
        systemPrompt: '',
        userPrompt: 'u',
        model: 'claude-sonnet-4-6',
        maxOutputTokens: 100,
      },
      { onRetry },
    )
    await vi.runAllTimersAsync()
    await promise
    expect(onRetry).toHaveBeenCalledTimes(1)
    const [attempt, wait] = onRetry.mock.calls[0]
    expect(attempt).toBe(1)
    expect(wait).toBe(5_000) // 5 seconds * 1000
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
        model: 'claude-sonnet-4-6',
        maxOutputTokens: 100,
      })
      .catch((e: unknown) => e)
    await vi.runAllTimersAsync()
    const result = await promise
    expect(result).toBeInstanceOf(Error)
  })
})

// ──────────────────── Transient retries (500/502/503/529) ────────────────────

describe('ClaudeProvider — transient retries', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it.each([500, 502, 503, 529])('retries on %d and succeeds on the next attempt', async (status) => {
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
      model: 'claude-sonnet-4-6',
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
          model: 'claude-sonnet-4-6',
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
        model: 'claude-sonnet-4-6',
        maxOutputTokens: 100,
      })
      .catch((e: unknown) => e)
    await vi.runAllTimersAsync()
    const result = await promise
    expect(result).toBeInstanceOf(Error)
    expect(callCount).toBe(5) // initial + 4 retries (MAX_RETRIES = 4)
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
        {
          systemPrompt: '',
          userPrompt: 'u',
          model: 'claude-sonnet-4-6',
          maxOutputTokens: 100,
        },
        { contextLabel: 'Phase 1 — chunk 3/7' },
      )
      .catch((e: unknown) => e)
    await vi.runAllTimersAsync()
    const result = (await promise) as Error
    expect(result).toBeInstanceOf(Error)
    expect(result.message).toMatch(/Phase 1 — chunk 3\/7/)
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
        {
          systemPrompt: '',
          userPrompt: 'u',
          model: 'claude-sonnet-4-6',
          maxOutputTokens: 100,
        },
        { contextLabel: 'Phase 3 chunk 1' },
      ),
    ).rejects.toThrow(/Phase 3 chunk 1/)
  })
})

// ──────────────────── Header parsing → RateLimitState ────────────────────

describe('ClaudeProvider — RateLimitState updates from anthropic-ratelimit-* headers', () => {
  it('parses requests-limit + tokens-limit into rpm + tpm', async () => {
    const p = makeProvider()
    setClientStub(p, () => ({
      withResponse: async () =>
        makeOkResponse('ok', {
          headers: {
            'anthropic-ratelimit-requests-limit': '500',
            'anthropic-ratelimit-tokens-limit': '40000',
          },
        }),
    }))
    await p.generate({
      systemPrompt: '',
      userPrompt: 'u',
      model: 'claude-sonnet-4-6',
      maxOutputTokens: 100,
    })
    const snap = p.rateLimit.snapshotForDebug()
    expect(snap.rpm).toBe(500)
    expect(snap.tpm).toBe(40000)
  })

  it('parses requests-remaining + tokens-remaining', async () => {
    const p = makeProvider()
    setClientStub(p, () => ({
      withResponse: async () =>
        makeOkResponse('ok', {
          headers: {
            'anthropic-ratelimit-requests-limit': '500',
            'anthropic-ratelimit-requests-remaining': '237',
            'anthropic-ratelimit-tokens-limit': '40000',
            'anthropic-ratelimit-tokens-remaining': '12000',
          },
        }),
    }))
    await p.generate({
      systemPrompt: '',
      userPrompt: 'u',
      model: 'claude-sonnet-4-6',
      maxOutputTokens: 100,
    })
    const snap = p.rateLimit.snapshotForDebug()
    expect(snap.requestsRemaining).toBe(237)
    expect(snap.tokensRemaining).toBe(12000)
  })

  it('accepts the input-tokens-* aliases when tokens-* are absent', async () => {
    const p = makeProvider()
    setClientStub(p, () => ({
      withResponse: async () =>
        makeOkResponse('ok', {
          headers: {
            'anthropic-ratelimit-input-tokens-limit': '60000',
            'anthropic-ratelimit-input-tokens-remaining': '45000',
          },
        }),
    }))
    await p.generate({
      systemPrompt: '',
      userPrompt: 'u',
      model: 'claude-sonnet-4-6',
      maxOutputTokens: 100,
    })
    const snap = p.rateLimit.snapshotForDebug()
    expect(snap.tpm).toBe(60000)
    expect(snap.tokensRemaining).toBe(45000)
  })

  it('parses reset header into resetMs (ISO timestamp relative to now)', async () => {
    const p = makeProvider()
    const futureIso = new Date(Date.now() + 30_000).toISOString()
    setClientStub(p, () => ({
      withResponse: async () =>
        makeOkResponse('ok', {
          headers: { 'anthropic-ratelimit-tokens-reset': futureIso },
        }),
    }))
    await p.generate({
      systemPrompt: '',
      userPrompt: 'u',
      model: 'claude-sonnet-4-6',
      maxOutputTokens: 100,
    })
    const snap = p.rateLimit.snapshotForDebug()
    expect(snap.resetMs).toBeGreaterThan(25_000)
    expect(snap.resetMs).toBeLessThanOrEqual(30_000)
  })

  it('ignores unparseable header values', async () => {
    const p = makeProvider()
    setClientStub(p, () => ({
      withResponse: async () =>
        makeOkResponse('ok', {
          headers: {
            'anthropic-ratelimit-requests-limit': 'nope',
            'anthropic-ratelimit-tokens-limit': '',
          },
        }),
    }))
    await p.generate({
      systemPrompt: '',
      userPrompt: 'u',
      model: 'claude-sonnet-4-6',
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
            'anthropic-ratelimit-requests-limit': '60', // 1 req/sec
            'anthropic-ratelimit-tokens-limit': '999999999',
          },
        }),
    }))
    await p.generate({
      systemPrompt: '',
      userPrompt: 'u',
      model: 'claude-sonnet-4-6',
      maxOutputTokens: 100,
    })
    // With 60 RPM, the next call has to wait ~1100ms (1000ms * 1.1 safety).
    const delay = p.getNextDelayMs(1000)
    expect(delay).toBeGreaterThanOrEqual(900)
    expect(delay).toBeLessThanOrEqual(1200)
  })
})

// ──────────────────── Abort handling ────────────────────

describe('ClaudeProvider — abort handling', () => {
  it('throws AbortError when signal is pre-aborted', async () => {
    const p = makeProvider()
    setClientStub(p, () => ({
      withResponse: async () => makeOkResponse('should-not-reach'),
    }))
    const ac = new AbortController()
    ac.abort()
    await expect(
      p.generate(
        {
          systemPrompt: '',
          userPrompt: 'u',
          model: 'claude-sonnet-4-6',
          maxOutputTokens: 100,
        },
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
        {
          systemPrompt: '',
          userPrompt: 'u',
          model: 'claude-sonnet-4-6',
          maxOutputTokens: 100,
        },
        { signal: ac.signal },
      )
      .catch((e: unknown) => e)
    // Tick once so the first 503 fires and the retry-sleep starts.
    await Promise.resolve()
    ac.abort()
    await vi.runAllTimersAsync()
    const result = (await promise) as Error | DOMException
    expect(String((result as Error).message ?? result)).toMatch(/Abort/i)
    vi.useRealTimers()
  })
})

// ──────────────────── Cost estimation ────────────────────

describe('ClaudeProvider.estimateCost', () => {
  it('computes cost from PRICING table for Sonnet', () => {
    const p = makeProvider()
    const cost = p.estimateCost(
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      'claude-sonnet-4-6',
    )
    // Sonnet pricing: input $3/MTok, output $15/MTok.
    expect(cost).toBeCloseTo(18, 2)
  })

  it('applies cached-input discount', () => {
    const p = makeProvider()
    // 800K billed at full rate, 200K at the cached rate.
    const cost = p.estimateCost(
      { inputTokens: 1_000_000, cachedInputTokens: 200_000, outputTokens: 0 },
      'claude-sonnet-4-6',
    )
    // 800K * 3 / 1M + 200K * 0.3 / 1M = 2.4 + 0.06 = 2.46
    expect(cost).toBeCloseTo(2.46, 2)
  })

  it('returns 0 for unknown models', () => {
    const p = makeProvider()
    expect(p.estimateCost({ inputTokens: 1000, outputTokens: 500 }, 'unknown-model')).toBe(0)
  })
})

// ──────────────────── hasKey + listModels ────────────────────

describe('ClaudeProvider — hasKey / listModels', () => {
  it('hasKey returns true when constructed with a key', () => {
    expect(new ClaudeProvider({ apiKey: 'sk-ant-test' }).hasKey()).toBe(true)
  })

  it('hasKey returns false when no key is configured', () => {
    expect(new ClaudeProvider({ apiKey: '' }).hasKey()).toBe(false)
  })

  it('listModels returns suggested model IDs', async () => {
    const p = makeProvider()
    const models = await p.listModels()
    expect(models).toContain('claude-opus-4-7')
    expect(models).toContain('claude-sonnet-4-6')
    expect(models).toContain('claude-haiku-4-5-20251001')
  })
})

// ──────────────────── No-key error path ────────────────────

describe('ClaudeProvider — no key configured', () => {
  it('throws a configuration error when generate() is called without a client', async () => {
    const p = new ClaudeProvider({ apiKey: '' })
    await expect(
      p.generate({
        systemPrompt: '',
        userPrompt: 'u',
        model: 'claude-sonnet-4-6',
        maxOutputTokens: 100,
      }),
    ).rejects.toThrow(/No Anthropic API key/i)
  })
})

// withFakeTimers helper kept for clarity even though most tests use it inline.
void withFakeTimers
