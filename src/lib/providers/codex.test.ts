// Tests for the Codex client provider — the Codex twin of
// claudeCode.test.ts. Same contract: compose system + cacheable + user into
// one prompt, POST to the server route, return { text, usage }, and mark
// 429/usage_limit responses as daily-quota exhaustion so the pipeline
// pauses as 'quota' instead of 'error'.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GenerateRequest } from './llm'

const guard = vi.hoisted(() => ({ strictFraming: false }))
vi.mock('../guardrails', () => ({
  getGuardrails: () => ({
    harassment: false,
    hateSpeech: false,
    sexuallyExplicit: false,
    dangerousContent: false,
    strictFraming: guard.strictFraming,
  }),
}))

import { CodexProvider } from './codex'

const baseReq: GenerateRequest = {
  systemPrompt: 'SYS',
  cacheablePrefix: 'KB',
  userPrompt: 'USER',
  model: 'gpt-5-codex',
  maxOutputTokens: 1000,
}

const originalFetch = globalThis.fetch
beforeEach(() => {
  guard.strictFraming = false
})
afterEach(() => {
  globalThis.fetch = originalFetch
})

function mockFetch(impl: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(impl(String(input), init)),
  ) as typeof fetch
}

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('CodexProvider.generate', () => {
  it('POSTs the composed prompt to /api/codex/generate and returns text + usage', async () => {
    let sentBody: { model?: string; prompt?: string } = {}
    mockFetch((url, init) => {
      expect(url).toBe('/api/codex/generate')
      sentBody = JSON.parse(String(init?.body)) as typeof sentBody
      return okResponse({ text: 'out', usage: { inputTokens: 3, outputTokens: 4 } })
    })
    const p = new CodexProvider()
    const res = await p.generate(baseReq)
    expect(res.text).toBe('out')
    expect(res.usage).toEqual({ inputTokens: 3, outputTokens: 4 })
    expect(sentBody.model).toBe('gpt-5-codex')
    // Framing + system + KB + user, in that order.
    expect(sentBody.prompt).toMatch(/OPERATING CONTEXT[\s\S]*SYS[\s\S]*KB[\s\S]*USER/)
  })

  it('drops the framing block under strictFraming', async () => {
    guard.strictFraming = true
    let sentPrompt = ''
    mockFetch((_url, init) => {
      sentPrompt = (JSON.parse(String(init?.body)) as { prompt: string }).prompt
      return okResponse({ text: 'out' })
    })
    await new CodexProvider().generate(baseReq)
    expect(sentPrompt).not.toContain('OPERATING CONTEXT')
    expect(sentPrompt).toMatch(/^SYS/)
  })

  it('throws an actionable error on an empty response', async () => {
    mockFetch(() => okResponse({ text: '' }))
    await expect(new CodexProvider().generate(baseReq)).rejects.toThrow(/codex login|usage limit/i)
  })
})

describe('usage-limit exhaustion classification', () => {
  type QuotaMarked = Error & {
    isDailyQuotaExhaustion?: boolean
    quotaProvider?: string
    quotaResetsAt?: string | null
  }

  it('marks a 429 usage_limit response as daily-quota exhaustion', async () => {
    mockFetch(
      () =>
        new Response(JSON.stringify({ error: 'Codex usage limit reached', code: 'usage_limit' }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        }),
    )
    let caught: QuotaMarked | null = null
    try {
      await new CodexProvider().generate(baseReq)
    } catch (err) {
      caught = err as QuotaMarked
    }
    expect(caught?.isDailyQuotaExhaustion).toBe(true)
    expect(caught?.quotaProvider).toBe('codex')
  })

  it('preserves the quota markers through the contextLabel wrap', async () => {
    mockFetch(
      () =>
        new Response(JSON.stringify({ error: 'limit', code: 'usage_limit' }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        }),
    )
    let caught: QuotaMarked | null = null
    try {
      await new CodexProvider().generate(baseReq, { contextLabel: 'Phase 4 · chunk 1/11' })
    } catch (err) {
      caught = err as QuotaMarked
    }
    expect(caught?.message).toContain('Phase 4 · chunk 1/11')
    expect(caught?.isDailyQuotaExhaustion).toBe(true)
  })

  it('hands off to shouldAutoCheckpointOnError as daily_quota', async () => {
    const { shouldAutoCheckpointOnError } = await import('../diagnose')
    mockFetch(
      () =>
        new Response(JSON.stringify({ error: 'limit', code: 'usage_limit' }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        }),
    )
    let caught: unknown = null
    try {
      await new CodexProvider().generate(baseReq, { contextLabel: 'Phase 3 · chunk 2/6' })
    } catch (err) {
      caught = err
    }
    expect(
      shouldAutoCheckpointOnError({ err: caught, currentPhase: 'phase3_chronicle', currentChunkIndex: 2 }),
    ).toBe('daily_quota')
  })

  it('does NOT mark ordinary HTTP failures', async () => {
    mockFetch(
      () =>
        new Response(JSON.stringify({ error: 'CLI not found' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }),
    )
    let caught: QuotaMarked | null = null
    try {
      await new CodexProvider().generate(baseReq)
    } catch (err) {
      caught = err as QuotaMarked
    }
    expect(caught?.isDailyQuotaExhaustion).toBeUndefined()
  })
})

describe('listModels', () => {
  it('returns models from /api/codex/status, [] on failure', async () => {
    mockFetch(() => okResponse({ installed: true, models: ['default', 'gpt-5-codex'] }))
    expect(await new CodexProvider().listModels()).toEqual(['default', 'gpt-5-codex'])
    mockFetch(() => new Response('down', { status: 500 }))
    expect(await new CodexProvider().listModels()).toEqual([])
  })
})
