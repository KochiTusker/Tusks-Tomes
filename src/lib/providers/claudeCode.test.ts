// Tests for the Claude Code client provider. It mirrors LocalProviderAdapter:
// composes system + cacheable + user into one prompt, POSTs to the server
// route, and returns { text, usage }. No rate limit, no prefix cache.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GenerateRequest } from './llm'

// Control the strictFraming guardrail without depending on localStorage
// (this file runs in the node env where localStorage is absent).
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

import { ClaudeCodeProvider } from './claudeCode'

const baseReq: GenerateRequest = {
  systemPrompt: 'SYS',
  cacheablePrefix: 'KB',
  userPrompt: 'USER',
  model: 'sonnet',
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
  ) as unknown as typeof fetch
}

describe('ClaudeCodeProvider.generate', () => {
  it('composes system + cacheable + user into one prompt and returns text + usage', async () => {
    let sentBody: Record<string, unknown> = {}
    mockFetch((_url, init) => {
      sentBody = JSON.parse(String(init?.body))
      return new Response(
        JSON.stringify({ text: 'hello world', usage: { inputTokens: 3, outputTokens: 9 } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    })

    const provider = new ClaudeCodeProvider()
    const res = await provider.generate(baseReq)

    expect(res.text).toBe('hello world')
    expect(res.usage).toEqual({ inputTokens: 3, outputTokens: 9 })
    expect(sentBody.model).toBe('sonnet')
    // Composed prompt keeps system/cacheable/user in order…
    const prompt = String(sentBody.prompt)
    expect(prompt).toContain('SYS\n\nKB\n\nUSER')
    // …and (with default guardrails) leads with the Claude-Code framing that
    // preserves mature content + character-name usage.
    expect(prompt).toMatch(/do NOT sanitise/i)
    expect(prompt).toMatch(/character name/i)
    expect(prompt.indexOf('OPERATING CONTEXT')).toBeLessThan(prompt.indexOf('SYS'))
  })

  it('drops the framing when the strictFraming guardrail is on', async () => {
    guard.strictFraming = true
    let sentBody: Record<string, unknown> = {}
    mockFetch((_url, init) => {
      sentBody = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({ text: 'ok', usage: { inputTokens: 1, outputTokens: 1 } }), {
        status: 200,
      })
    })
    await new ClaudeCodeProvider().generate(baseReq)
    expect(sentBody.prompt).toBe('SYS\n\nKB\n\nUSER')
    expect(sentBody.prompt).not.toMatch(/OPERATING CONTEXT/)
  })

  it('throws on an empty response', async () => {
    mockFetch(() => new Response(JSON.stringify({ text: '   ' }), { status: 200 }))
    const provider = new ClaudeCodeProvider()
    await expect(provider.generate(baseReq)).rejects.toThrow(/empty response/i)
  })

  it('surfaces the server error message on a non-ok response', async () => {
    mockFetch(
      () =>
        new Response(JSON.stringify({ error: 'Claude Code CLI not found' }), { status: 500 }),
    )
    const provider = new ClaudeCodeProvider()
    await expect(provider.generate(baseReq)).rejects.toThrow(/not found/i)
  })

  it('prefixes the error with the contextLabel when provided', async () => {
    mockFetch(() => new Response(JSON.stringify({ error: 'boom' }), { status: 502 }))
    const provider = new ClaudeCodeProvider()
    await expect(
      provider.generate(baseReq, { contextLabel: 'Phase 1 — chunk 2/4' }),
    ).rejects.toThrow(/\[Phase 1 — chunk 2\/4\]/)
  })
})

// ── Usage-limit exhaustion chain ────────────────────────────────────
// Server answers 429 + code:'usage_limit' → provider throws an error
// marked isDailyQuotaExhaustion → shouldAutoCheckpointOnError returns
// 'daily_quota' → RefinementTool persists pausedReason 'quota'. These
// tests pin the provider's link and the classifier hand-off, including
// marker survival through the contextLabel wrap (a NEW Error is created
// there — an easy place to silently strip the marker).
describe('usage-limit exhaustion classification', () => {
  type QuotaMarked = Error & {
    isDailyQuotaExhaustion?: boolean
    quotaProvider?: string
    quotaResetsAt?: string | null
  }

  it('marks a 429 usage_limit response as daily-quota exhaustion', async () => {
    mockFetch(() =>
      new Response(
        JSON.stringify({
          error: 'Claude Code usage limit reached: You have hit your limit',
          code: 'usage_limit',
          resetsAt: '2026-08-06T18:00:00.000Z',
        }),
        { status: 429, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    const p = new ClaudeCodeProvider()
    let caught: QuotaMarked | null = null
    try {
      await p.generate(baseReq)
    } catch (err) {
      caught = err as QuotaMarked
    }
    expect(caught).toBeTruthy()
    expect(caught?.isDailyQuotaExhaustion).toBe(true)
    expect(caught?.quotaProvider).toBe('claudeCode')
    expect(caught?.quotaResetsAt).toBe('2026-08-06T18:00:00.000Z')
    expect(caught?.message).toMatch(/usage limit/i)
  })

  it('preserves the quota markers through the contextLabel wrap', async () => {
    mockFetch(() =>
      new Response(JSON.stringify({ error: 'limit', code: 'usage_limit' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const p = new ClaudeCodeProvider()
    let caught: QuotaMarked | null = null
    try {
      await p.generate(baseReq, { contextLabel: 'Phase 3 · chunk 2/6' })
    } catch (err) {
      caught = err as QuotaMarked
    }
    expect(caught?.message).toContain('Phase 3 · chunk 2/6')
    expect(caught?.isDailyQuotaExhaustion).toBe(true)
    expect(caught?.quotaProvider).toBe('claudeCode')
  })

  it('does NOT mark ordinary HTTP failures', async () => {
    mockFetch(() =>
      new Response(JSON.stringify({ error: 'CLI not found' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const p = new ClaudeCodeProvider()
    let caught: QuotaMarked | null = null
    try {
      await p.generate(baseReq)
    } catch (err) {
      caught = err as QuotaMarked
    }
    expect(caught?.isDailyQuotaExhaustion).toBeUndefined()
  })

  it('hands off to shouldAutoCheckpointOnError as daily_quota', async () => {
    const { shouldAutoCheckpointOnError } = await import('../diagnose')
    mockFetch(() =>
      new Response(JSON.stringify({ error: 'limit', code: 'usage_limit' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const p = new ClaudeCodeProvider()
    let caught: unknown = null
    try {
      await p.generate(baseReq, { contextLabel: 'Phase 1 · chunk 5/15' })
    } catch (err) {
      caught = err
    }
    expect(
      shouldAutoCheckpointOnError({
        err: caught,
        currentPhase: 'phase1_ground',
        currentChunkIndex: 5,
      }),
    ).toBe('daily_quota')
  })
})
