// Characterisation of what the provider SDKs put on the wire.
//
// The pipeline goldens capture requests through fake SDK modules, so they pin
// what the providers ask the SDK for, never what the SDK then sends. These
// tests run the real SDKs against a stubbed fetch and pin the far side of that
// boundary: the URL and method, the request body, the headers a browser has to
// clear CORS with, how many times one call reaches the network, and how an
// HTTP failure surfaces as an error the retry logic can classify. An SDK
// upgrade that moves any of those fails here instead of in somebody's run.
//
// Gemini runs against both of its builds. The browser bundle ships the `web`
// entry; vitest's node environment would otherwise resolve the `node` one,
// which only the smoke test reaches.
//
// Expected values are written out rather than snapshotted so that a change
// has to be made, and explained, in this file.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { TRANSIENT_RETRY_MS } from '../constants'
import type { GenerateRequest } from './llm'
import { OpenRouterProvider } from './openrouter'

// ---------------------------------------------------------------------------
// The two places the SDKs' own conventions show through. Everything else in
// this file is expected to hold across SDK versions.

/** How @google/genai turns an HTTP failure into an Error message. The
 *  provider's classifiers read this text, and the user sees it as the
 *  "Original error" line.
 *
 *  Since 1.0 it is the error body alone. Up to 0.x it was prefixed with
 *  `got status: <status> <statusText>. `; every classifier keys on the body
 *  (`"code":503`, `RESOURCE_EXHAUSTED`, `limit: 0`, ...), so dropping the
 *  prefix changes the text shown and nothing that is decided from it. The
 *  status is still on the error, now as `.status`. Unchanged through 3.x. */
function geminiErrorText(_status: number, _statusText: string, body: string): string {
  return body
}

/** How the openai SDK serialises a JSON request body: compact since 5.0. Up
 *  to 4.x it was indented two spaces. Same JSON, fewer bytes. */
function openaiBody(value: unknown): string {
  return JSON.stringify(value)
}

/** Headers the openai SDK sets on every request. OpenRouter is called from the
 *  browser, so a new name here is a new name its CORS policy has to allow.
 *  6.x sends a strict subset of what 4.x did: it leaves `content-length` to
 *  fetch and no longer sends `x-stainless-timeout` for the default timeout.
 *  7.x sends the same set as 6.x. */
const OPENAI_SDK_HEADERS = [
  'accept',
  'authorization',
  'content-type',
  'user-agent',
  'x-stainless-arch',
  'x-stainless-lang',
  'x-stainless-os',
  'x-stainless-package-version',
  'x-stainless-retry-count',
  'x-stainless-runtime',
  'x-stainless-runtime-version',
]

// ---------------------------------------------------------------------------
// Network stub, shared by both SDKs.

type Captured = {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

const net = vi.hoisted(() => {
  const state = {
    calls: [] as Array<{ url: string; method: string; headers: Record<string, string>; body?: string }>,
    respond: (() => {
      throw new Error('No response configured for this test.')
    }) as (n: number) => Response,
    async fetch(input: unknown, init?: RequestInit): Promise<Response> {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
      const raw = new Headers(
        (init?.headers as HeadersInit | undefined) ??
          (input instanceof Request ? input.headers : undefined),
      )
      const headers: Record<string, string> = {}
      raw.forEach((v, k) => {
        headers[k] = v
      })
      let body: string | undefined
      if (init?.body !== undefined && init?.body !== null) {
        body =
          typeof init.body === 'string' ? init.body : await new Response(init.body as BodyInit).text()
      }
      state.calls.push({ url, method, headers, body })
      return state.respond(state.calls.length)
    },
  }
  return state
})

/** Guardrails are read from localStorage, which the node environment lacks,
 *  so every test runs on the defaults (every Gemini filter relaxed, TTRPG
 *  framing on) unless it stubs this. Going through the persisted key rather
 *  than mocking the module keeps the test independent of where it lives. */
function stubGuardrails(settings: Record<string, boolean>): void {
  const stored: Record<string, string> = { guardrails_settings: JSON.stringify(settings) }
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored[key] ?? null,
    setItem: () => {},
    removeItem: () => {},
  })
}

// The providers construct their own OpenAI clients. Wrapping the class keeps
// their constructor options in play and adds only the fetch, which every SDK
// version accepts as a client option.
vi.mock('openai', async (importOriginal) => {
  const mod = await importOriginal<typeof import('openai')>()
  const Real = mod.default
  const OpenAI = class OpenAI extends Real {
    constructor(opts: ConstructorParameters<typeof Real>[0]) {
      super({ ...opts, fetch: ((i: unknown, n?: RequestInit) => net.fetch(i, n)) as never })
    }
  }
  return { ...mod, default: OpenAI, OpenAI }
})

beforeEach(() => {
  net.calls = []
  net.respond = () => {
    throw new Error('No response configured for this test.')
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function json(status: number, body: unknown, statusText = '', headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function only(calls: Captured[]): Captured {
  expect(calls).toHaveLength(1)
  return calls[0]
}

// ---------------------------------------------------------------------------
// Gemini

// The provider pins `v1beta` (GEMINI_API_VERSION in ./gemini). The SDK's own
// default has been `v1` since 3.0, so a lost pin fails the URL checks below.
// The failure tests further down construct the SDK directly, on its default
// version: they pin how an error surfaces, which does not depend on it.
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta'
const GENERATE_URL = `${GEMINI_BASE}/models/gemini-2.5-flash:generateContent`

const GEMINI_REQ: GenerateRequest = {
  model: 'gemini-2.5-flash',
  systemPrompt: 'SYSTEM',
  cacheablePrefix: 'PREFIX',
  userPrompt: 'CHUNK',
  maxOutputTokens: 1024,
  temperature: 0.3,
}

const GEMINI_OK = {
  candidates: [
    { content: { role: 'model', parts: [{ text: 'GROUNDED' }] }, finishReason: 'STOP', index: 0 },
  ],
  usageMetadata: {
    promptTokenCount: 120,
    candidatesTokenCount: 30,
    thoughtsTokenCount: 10,
    totalTokenCount: 160,
    cachedContentTokenCount: 100,
  },
  modelVersion: 'gemini-2.5-flash',
}

const ALL_FILTERS_OFF = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
]

const INLINE_CONTENTS = [{ parts: [{ text: 'SYSTEM\n\nPREFIX\n\nCHUNK' }], role: 'user' }]

/** One HTTP failure, and what the provider is expected to make of it. */
type GeminiFailure = {
  name: string
  status: number
  statusText: string
  contentType: string
  body: string
  transient: boolean
  hardZero: string | null
  kind: 'rate_limit' | 'daily_quota' | 'transient'
  /** What generate() does on the first failure. */
  outcome:
    | { retryAfterMs: number; event?: 'rate_limit' }
    | { throws: 'wrapped' | 'daily_quota' | 'zero_quota' }
}

function geminiError(code: number, message: string, status: string, extra: object = {}): string {
  return JSON.stringify({ error: { code, message, status, ...extra } })
}

function htmlError(code: number, statusText: string, html: string): string {
  // What the SDK synthesises when the body is not JSON.
  return JSON.stringify({ error: { message: html, code, status: statusText } })
}

const quotaFailure = (quotaId: string, quotaMetric: string, quotaValue: string) => ({
  details: [
    {
      '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
      violations: [{ quotaMetric, quotaId, quotaValue }],
    },
  ],
})

const GEMINI_FAILURES: GeminiFailure[] = [
  {
    name: '400 invalid key',
    status: 400,
    statusText: 'Bad Request',
    contentType: 'application/json',
    body: geminiError(400, 'API key not valid. Please pass a valid API key.', 'INVALID_ARGUMENT'),
    transient: false,
    hardZero: null,
    kind: 'transient',
    outcome: { throws: 'wrapped' },
  },
  {
    name: '429 per-minute quota',
    status: 429,
    statusText: 'Too Many Requests',
    contentType: 'application/json',
    body: geminiError(
      429,
      'You exceeded your current quota.',
      'RESOURCE_EXHAUSTED',
      quotaFailure(
        'GenerateContentPaidTierInputTokensPerModelPerMinute',
        'generativelanguage.googleapis.com/generate_content_paid_tier_input_token_count',
        '2000000',
      ),
    ),
    transient: false,
    hardZero: null,
    kind: 'rate_limit',
    outcome: { retryAfterMs: TRANSIENT_RETRY_MS, event: 'rate_limit' },
  },
  {
    name: '429 per-day quota',
    status: 429,
    statusText: 'Too Many Requests',
    contentType: 'application/json',
    body: geminiError(
      429,
      'You exceeded your current quota.',
      'RESOURCE_EXHAUSTED',
      quotaFailure(
        'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
        'generativelanguage.googleapis.com/generate_content_free_tier_requests',
        '250',
      ),
    ),
    transient: false,
    hardZero: null,
    kind: 'daily_quota',
    outcome: { throws: 'daily_quota' },
  },
  {
    name: '429 zero quota',
    status: 429,
    statusText: 'Too Many Requests',
    contentType: 'application/json',
    body: geminiError(
      429,
      'Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-2.5-pro',
      'RESOURCE_EXHAUSTED',
    ),
    transient: false,
    hardZero: 'limit:0',
    kind: 'rate_limit',
    outcome: { throws: 'zero_quota' },
  },
  {
    name: '500 JSON',
    status: 500,
    statusText: 'Internal Server Error',
    contentType: 'application/json',
    body: geminiError(500, 'An internal error has occurred.', 'INTERNAL'),
    transient: true,
    hardZero: null,
    kind: 'transient',
    outcome: { retryAfterMs: 3_000 },
  },
  {
    name: '503 JSON',
    status: 503,
    statusText: 'Service Unavailable',
    contentType: 'application/json',
    body: geminiError(503, 'The model is overloaded. Please try again later.', 'UNAVAILABLE'),
    transient: true,
    hardZero: null,
    kind: 'transient',
    outcome: { retryAfterMs: 3_000 },
  },
  ...(
    [
      [500, 'Internal Server Error'],
      [502, 'Bad Gateway'],
      [503, 'Service Unavailable'],
      [504, 'Gateway Timeout'],
    ] as const
  ).map(
    ([status, statusText]): GeminiFailure => ({
      name: `${status} HTML`,
      status,
      statusText,
      contentType: 'text/html',
      body: `<html><body>${statusText}</body></html>`,
      transient: true,
      hardZero: null,
      kind: 'transient',
      outcome: { retryAfterMs: 3_000 },
    }),
  ),
]

describe.each([
  ['web', '@google/genai/web'],
  ['node', '@google/genai/node'],
])('Gemini through the %s build', (build, entry) => {
  let G: typeof import('./gemini')
  let SDK: typeof import('@google/genai')

  beforeAll(async () => {
    vi.resetModules()
    vi.doMock('@google/genai', async () => await import(/* @vite-ignore */ entry))
    SDK = await import('@google/genai')
    G = await import('./gemini')
  })

  beforeEach(() => {
    vi.stubGlobal('fetch', (i: unknown, n?: RequestInit) => net.fetch(i, n))
  })

  afterAll(() => {
    vi.doUnmock('@google/genai')
  })

  const provider = () =>
    new G.GeminiProvider({ primaryKey: 'paid-test-key', fallbackKey: null, tier: 'paid' })

  it('sends the composed prompt inline with every filter relaxed', async () => {
    net.respond = () => json(200, GEMINI_OK)
    const out = await provider().generate(GEMINI_REQ)

    const call = only(net.calls)
    expect(call.method).toBe('POST')
    expect(call.url).toBe(GENERATE_URL)
    expect(call.body).toBe(
      JSON.stringify({
        contents: INLINE_CONTENTS,
        safetySettings: ALL_FILTERS_OFF,
        generationConfig: { temperature: 0.3, maxOutputTokens: 1024 },
      }),
    )
    expect(Object.keys(call.headers).sort()).toEqual([
      'content-type',
      'user-agent',
      'x-goog-api-client',
      'x-goog-api-key',
    ])
    expect(call.headers['content-type']).toBe('application/json')
    expect(call.headers['x-goog-api-key']).toBe('paid-test-key')
    expect(call.headers['x-goog-api-client']).toMatch(/^google-genai-sdk\//)
    // Proves the build under test is the one this block claims to load.
    expect(call.headers['x-goog-api-client'].endsWith('gl-node/web')).toBe(build === 'web')

    expect(out).toEqual({
      text: 'GROUNDED',
      usage: { inputTokens: 120, cachedInputTokens: 100, outputTokens: 40, thinkingTokens: 10 },
    })
  })

  it('omits safetySettings entirely when every filter is left on', async () => {
    stubGuardrails({
      harassment: true,
      hateSpeech: true,
      sexuallyExplicit: true,
      dangerousContent: true,
      strictFraming: false,
    })
    net.respond = () => json(200, GEMINI_OK)
    await provider().generate(GEMINI_REQ)

    expect(only(net.calls).body).toBe(
      JSON.stringify({
        contents: INLINE_CONTENTS,
        generationConfig: { temperature: 0.3, maxOutputTokens: 1024 },
      }),
    )
  })

  it('sends only the chunk, plus the handle, when the prefix is cached', async () => {
    net.respond = () => json(200, GEMINI_OK)
    await provider().generate(GEMINI_REQ, { cachedContentHandle: 'cachedContents/abc123' })

    expect(only(net.calls).body).toBe(
      JSON.stringify({
        contents: [{ parts: [{ text: 'CHUNK' }], role: 'user' }],
        safetySettings: ALL_FILTERS_OFF,
        cachedContent: 'cachedContents/abc123',
        generationConfig: { temperature: 0.3, maxOutputTokens: 1024 },
      }),
    )
  })

  it('carries a thinking budget of zero and of a positive cap', async () => {
    net.respond = () => json(200, GEMINI_OK)
    await provider().generate({ ...GEMINI_REQ, thinkingBudget: 0 })
    await provider().generate({ ...GEMINI_REQ, thinkingBudget: 2048, temperature: undefined })

    expect(net.calls.map((c) => c.body)).toEqual([
      JSON.stringify({
        contents: INLINE_CONTENTS,
        safetySettings: ALL_FILTERS_OFF,
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 1024,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
      JSON.stringify({
        contents: INLINE_CONTENTS,
        safetySettings: ALL_FILTERS_OFF,
        generationConfig: { maxOutputTokens: 1024, thinkingConfig: { thinkingBudget: 2048 } },
      }),
    ])
  })

  it('creates and deletes the prefix cache', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-03-04T05:06:07.000Z'))
    try {
      net.respond = (n) =>
        n === 1
          ? json(200, { name: 'cachedContents/xyz', model: 'models/gemini-2.5-flash' })
          : json(200, {})
      const p = provider()
      const prefix = 'P'.repeat(4000)
      const handle = await p.createPrefixCache({ ...GEMINI_REQ, cacheablePrefix: prefix })
      expect(handle).toBe('cachedContents/xyz')
      await p.deletePrefixCache('cachedContents/xyz')

      expect(net.calls.map((c) => [c.method, c.url])).toEqual([
        ['POST', `${GEMINI_BASE}/cachedContents`],
        ['DELETE', `${GEMINI_BASE}/cachedContents/xyz`],
      ])
      expect(net.calls[0].body).toBe(
        JSON.stringify({
          model: 'models/gemini-2.5-flash',
          ttl: '3600s',
          displayName: 'tusks-tomes:2026-03-04T05:06:07',
          contents: [{ parts: [{ text: `SYSTEM\n\n${prefix}` }], role: 'user' }],
        }),
      )
      expect(net.calls[1].body).toBe('{}')
    } finally {
      vi.useRealTimers()
    }
  })

  describe.each(GEMINI_FAILURES)('a $name', (f) => {
    const respond = () =>
      new Response(f.body, {
        status: f.status,
        statusText: f.statusText,
        headers: { 'content-type': f.contentType },
      })
    const sdkBody = f.contentType === 'text/html' ? htmlError(f.status, f.statusText, f.body) : f.body
    const sdkText = geminiErrorText(f.status, f.statusText, sdkBody)

    it('reaches the network once and surfaces a message the classifiers can read', async () => {
      net.respond = respond
      let err: unknown
      try {
        await new SDK.GoogleGenAI({ apiKey: 'k' }).models.generateContent({
          model: 'gemini-2.5-flash',
          contents: 'x',
        })
      } catch (e) {
        err = e
      }
      expect(net.calls).toHaveLength(1)
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).toBe(sdkText)
      expect(G.isTransientServerError(err)).toBe(f.transient)
      expect(G.detectHardZeroQuota(err)).toEqual(
        f.hardZero ? { matched: true, pattern: f.hardZero } : { matched: false },
      )
      expect(G.classifyExhaustion(err)).toBe(f.kind)
    })

    it('is handled by generate() as before', async () => {
      net.respond = respond
      const ctrl = new AbortController()
      const retries: Array<[number, number]> = []
      const events: unknown[] = []
      let err: unknown
      try {
        await provider().generate(GEMINI_REQ, {
          signal: ctrl.signal,
          contextLabel: 'Phase 1 chunk 1/3',
          // Stop at the first scheduled retry: what is asserted is the
          // decision, not the wait.
          onRetry: (attempt, waitMs) => {
            retries.push([attempt, waitMs])
            ctrl.abort()
          },
          onProviderEvent: (e) => events.push(e),
        })
      } catch (e) {
        err = e
      }
      expect(net.calls).toHaveLength(1)
      const message = (err as Error).message

      if ('retryAfterMs' in f.outcome) {
        expect((err as Error).name).toBe('AbortError')
        expect(retries).toEqual([[1, f.outcome.retryAfterMs]])
        if (f.outcome.event) {
          expect(events).toHaveLength(1)
          expect(events[0]).toMatchObject({
            kind: 'quota_exhausted',
            provider: 'gemini',
            quotaKind: f.outcome.event,
            tier: 'paid',
            model: 'gemini-2.5-flash',
          })
        } else {
          expect(events).toEqual([])
        }
        return
      }

      expect(retries).toEqual([])
      switch (f.outcome.throws) {
        case 'wrapped':
          expect(message).toBe(
            [
              '[Phase 1 chunk 1/3]',
              'Gemini API call failed.',
              '',
              '--- Diagnostic context ---',
              'Model:         gemini-2.5-flash',
              'Prompt length: 21 chars',
              '',
              '--- Original error ---',
              sdkText,
            ].join('\n'),
          )
          break
        case 'daily_quota':
          expect((err as { isDailyQuotaExhaustion?: boolean }).isDailyQuotaExhaustion).toBe(true)
          expect(message).toContain('Daily quota exhausted on Gemini paid for model "gemini-2.5-flash".')
          expect(message.endsWith(`Original: ${sdkText.slice(0, 200)}`)).toBe(true)
          expect(events).toHaveLength(1)
          expect(events[0]).toMatchObject({ kind: 'quota_exhausted', quotaKind: 'daily_quota' })
          break
        case 'zero_quota':
          expect(message).toContain('Quota is 0 for "gemini-2.5-flash" (detected via pattern: limit:0).')
          expect(message.endsWith(`Original: ${sdkText}`)).toBe(true)
          break
      }
    })
  })
})

// ---------------------------------------------------------------------------
// OpenRouter (Chat Completions through the openai SDK)

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

const TTRPG_FRAMING =
  'This is a transcript from a tabletop role-playing game (D&D / TTRPG) session. ' +
  'Mature themes are expected: profanity, violence, dark humour, sexual references, ' +
  'gore. Preserve them verbatim — do not sanitise or paraphrase.'

describe('OpenRouter through the openai SDK', () => {
  const smallReq: GenerateRequest = {
    model: 'deepseek/deepseek-v4-flash',
    systemPrompt: 'S',
    userPrompt: 'U',
    maxOutputTokens: 100,
  }

  it('sends the cache breakpoint, the JSON format and the privacy floor', async () => {
    net.respond = () =>
      json(200, {
        id: 'gen-1',
        object: 'chat.completion',
        created: 1,
        model: 'deepseek/deepseek-v4-flash',
        choices: [
          { index: 0, message: { role: 'assistant', content: '{"questions":[]}' }, finish_reason: 'stop' },
        ],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          cost: 0.0012,
          prompt_tokens_details: { cached_tokens: 80 },
        },
      })
    const out = await new OpenRouterProvider({ apiKey: 'or-test-key' }).generate(
      {
        model: 'deepseek/deepseek-v4-flash',
        systemPrompt: 'SYSTEM',
        cacheablePrefix: 'PREFIX',
        userPrompt: 'CHUNK',
        maxOutputTokens: 4096,
        temperature: 0.2,
        responseFormat: 'json',
      },
      { contextLabel: 'Phase 2 chunk 1/3' },
    )

    const call = only(net.calls)
    expect(call.method).toBe('POST')
    expect(call.url).toBe(OPENROUTER_URL)
    const expected = {
      model: 'deepseek/deepseek-v4-flash',
      messages: [
        {
          role: 'system',
          content: [
            {
              type: 'text',
              text: `${TTRPG_FRAMING}\n\nSYSTEM\n\nPREFIX`,
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
        { role: 'user', content: 'CHUNK' },
      ],
      max_tokens: 4096,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      provider: { zdr: true, data_collection: 'deny', sort: 'price' },
    }
    // Content and key order, independent of whitespace...
    expect(JSON.stringify(JSON.parse(call.body ?? 'null'))).toBe(JSON.stringify(expected))
    // ...and the exact bytes.
    expect(call.body).toBe(openaiBody(expected))

    expect(Object.keys(call.headers).sort()).toEqual(OPENAI_SDK_HEADERS)
    expect(call.headers.authorization).toBe('Bearer or-test-key')
    expect(call.headers['content-type']).toBe('application/json')
    expect(call.headers.accept).toBe('application/json')

    expect(out).toEqual({
      text: '{"questions":[]}',
      usage: { inputTokens: 100, cachedInputTokens: 80, outputTokens: 20, costUsd: 0.0012 },
    })
  })

  async function failOnce(res: () => Response) {
    net.respond = res
    const ctrl = new AbortController()
    const retries: Array<[number, number]> = []
    let err: unknown
    try {
      await new OpenRouterProvider({ apiKey: 'or-test-key' }).generate(smallReq, {
        signal: ctrl.signal,
        contextLabel: 'Phase 2 chunk 1/3',
        onRetry: (attempt, waitMs) => {
          retries.push([attempt, waitMs])
          ctrl.abort()
        },
      })
    } catch (e) {
      err = e
    }
    return { err: err as Error & { cause?: { status?: number } }, retries }
  }

  // `retry-after-ms` paces the SDK's own retries (kept at 1ms here); the
  // provider reads `retry-after` for its own wait.
  it('lets the SDK retry a 429 twice, then waits the Retry-After itself', async () => {
    const { err, retries } = await failOnce(() =>
      json(
        429,
        { error: { message: 'Rate limit exceeded: free-models-per-min', code: 429 } },
        'Too Many Requests',
        { 'retry-after': '2', 'retry-after-ms': '1' },
      ),
    )
    expect(net.calls).toHaveLength(3)
    expect(net.calls.map((c) => c.headers['x-stainless-retry-count'])).toEqual(['0', '1', '2'])
    expect(err.name).toBe('AbortError')
    expect(retries).toEqual([[1, 2_000]])
  })

  it('lets the SDK retry a 503 twice, then falls back to the transient wait', async () => {
    const { err, retries } = await failOnce(() =>
      json(503, { error: { message: 'No instances available', code: 503 } }, 'Service Unavailable', {
        'retry-after-ms': '1',
      }),
    )
    expect(net.calls).toHaveLength(3)
    expect(err.name).toBe('AbortError')
    expect(retries).toEqual([[1, TRANSIENT_RETRY_MS]])
  })

  it('does not retry a 400, and labels the error with the chunk', async () => {
    const { err, retries } = await failOnce(() =>
      json(400, { error: { message: 'deepseek/nope is not a valid model ID', code: 400 } }, 'Bad Request'),
    )
    expect(net.calls).toHaveLength(1)
    expect(retries).toEqual([])
    expect(err.message).toBe('[Phase 2 chunk 1/3]\n400 deepseek/nope is not a valid model ID')
    expect(err.cause?.status).toBe(400)
  })
})
