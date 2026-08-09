// Tests for the Claude Code subscription router + its pure helpers.
//
// Key invariants:
//   - ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN are stripped from the child
//     env so the CLI always resolves to the user's subscription, never a
//     stray API key (which would silently bill the API).
//   - `--output-format json` payloads parse into { text, usage, costUsd }.
//   - A non-zero exit / is_error / malformed JSON surface as actionable
//     HTTP errors rather than an empty 200.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mockSpawn, resetSpawnMock, spawnCalls, whenCommand } from '../testing/spawnMock.js'
import { withRouter } from '../testing/httpFixture.js'

vi.mock('node:child_process', () => mockSpawn())

beforeEach(() => resetSpawnMock())

describe('parseClaudeJson', () => {
  it('extracts text + usage + cost from a success payload', async () => {
    const { parseClaudeJson } = await import('./claudeCode.js')
    const out = parseClaudeJson(
      JSON.stringify({
        type: 'result',
        is_error: false,
        result: 'the chronicle',
        usage: { input_tokens: 11, output_tokens: 22 },
        total_cost_usd: 0.0042,
      }),
    )
    expect(out).toEqual({
      text: 'the chronicle',
      usage: { inputTokens: 11, outputTokens: 22 },
      costUsd: 0.0042,
    })
  })

  it('defaults usage to zero when absent', async () => {
    const { parseClaudeJson } = await import('./claudeCode.js')
    const out = parseClaudeJson(JSON.stringify({ result: 'x' }))
    expect(out.usage).toEqual({ inputTokens: 0, outputTokens: 0 })
  })

  it('throws on is_error with the CLI message', async () => {
    const { parseClaudeJson } = await import('./claudeCode.js')
    expect(() => parseClaudeJson(JSON.stringify({ is_error: true, result: 'usage limit reached' }))).toThrow(
      /usage limit reached/,
    )
  })

  it('throws on malformed JSON', async () => {
    const { parseClaudeJson } = await import('./claudeCode.js')
    expect(() => parseClaudeJson('not json')).toThrow(/valid JSON/)
  })
})

describe('childEnvWithoutApiKeys', () => {
  it('strips ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN, keeps others', async () => {
    const { childEnvWithoutApiKeys } = await import('./claudeCode.js')
    const out = childEnvWithoutApiKeys({
      ANTHROPIC_API_KEY: 'sk-ant-secret',
      ANTHROPIC_AUTH_TOKEN: 'tok',
      PATH: '/usr/bin',
    })
    expect(out.ANTHROPIC_API_KEY).toBeUndefined()
    expect(out.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(out.PATH).toBe('/usr/bin')
  })
})

describe('POST /generate', () => {
  const savedKey = process.env.ANTHROPIC_API_KEY
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-should-be-stripped'
  })
  afterEach(() => {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = savedKey
  })

  it('returns text + usage and strips the API key from the child env', async () => {
    whenCommand('claude', () => ({
      code: 0,
      stdout: JSON.stringify({
        result: 'grounded text',
        usage: { input_tokens: 5, output_tokens: 7 },
        total_cost_usd: 0.01,
      }),
    }))
    const { claudeCodeRouter } = await import('./claudeCode.js')
    await withRouter('/api/claude-code', claudeCodeRouter(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'sonnet', prompt: 'hello' }),
      })
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.text).toBe('grounded text')
      expect(json.usage).toEqual({ inputTokens: 5, outputTokens: 7 })
    })
    const call = spawnCalls().find((c) => c.command === 'claude')
    expect(call).toBeTruthy()
    expect(call?.options.env?.ANTHROPIC_API_KEY).toBeUndefined()
    // The model is the only req-derived argv value; prompt goes via stdin.
    expect(call?.args).toContain('--output-format')
    expect(call?.args).toContain('sonnet')
    // Hardening: the child runs in a neutral sandbox cwd, never the repo root,
    // so a prompt-injected tool call can't reach the project tree.
    expect(call?.options.cwd).toBeTruthy()
    expect(String(call?.options.cwd)).toContain('tusks-tomes-claude-sandbox')
    expect(String(call?.options.cwd)).not.toBe(process.cwd())
  })

  it('does NOT kill a slow child when the request body stream closes early (regression)', async () => {
    // The request's own 'close' fires ~immediately after express.json()
    // consumes the body — long before a real `claude -p` (seconds) finishes.
    // A 60ms-delayed child stands in for that latency; the route must still
    // return the result, proving abort detection keys off res (writableEnded)
    // and not the spurious early request-close.
    whenCommand('claude', () => ({
      code: 0,
      stdout: JSON.stringify({ result: 'slow but done', usage: { input_tokens: 1, output_tokens: 1 } }),
      delayMs: 60,
    }))
    const { claudeCodeRouter } = await import('./claudeCode.js')
    await withRouter('/api/claude-code', claudeCodeRouter(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'sonnet', prompt: 'hello' }),
      })
      expect(res.status).toBe(200)
      expect((await res.json()).text).toBe('slow but done')
    })
  })

  it('rejects an invalid model id with 400', async () => {
    const { claudeCodeRouter } = await import('./claudeCode.js')
    await withRouter('/api/claude-code', claudeCodeRouter(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'sonnet; rm -rf /', prompt: 'hello' }),
      })
      expect(res.status).toBe(400)
    })
    expect(spawnCalls().length).toBe(0)
  })

  it('rejects a missing prompt with 400', async () => {
    const { claudeCodeRouter } = await import('./claudeCode.js')
    await withRouter('/api/claude-code', claudeCodeRouter(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'sonnet' }),
      })
      expect(res.status).toBe(400)
    })
  })

  it('surfaces a non-zero exit as 502 with stderr detail', async () => {
    whenCommand('claude', () => ({ code: 1, stderr: 'Invalid API key · Please run /login' }))
    const { claudeCodeRouter } = await import('./claudeCode.js')
    await withRouter('/api/claude-code', claudeCodeRouter(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'sonnet', prompt: 'hello' }),
      })
      expect(res.status).toBe(502)
      const json = await res.json()
      expect(json.error).toMatch(/login/i)
    })
  })

  it('returns 502 instead of crashing when the CLI closes stdin early', async () => {
    // Regression: stdin.write() flushes ASYNCHRONOUSLY for prompts this size,
    // so a CLI that exits before draining emits 'error' on the stream. With no
    // listener that is an uncaught exception which kills the whole server —
    // and the surrounding try/catch only ever caught synchronous throws.
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
    whenCommand('claude', () => ({ code: 0, stdinError: epipe }))
    const { claudeCodeRouter } = await import('./claudeCode.js')
    await withRouter('/api/claude-code', claudeCodeRouter(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'sonnet', prompt: 'x'.repeat(50_000) }),
      })
      expect(res.status).toBe(502)
      expect((await res.json()).error).toMatch(/closed its input|EPIPE/i)
    })
  })

  it('reports a clear message when the CLI is missing (ENOENT)', async () => {
    const err = new Error('spawn claude ENOENT') as NodeJS.ErrnoException
    err.code = 'ENOENT'
    whenCommand('claude', () => ({ code: -1, emitError: err }))
    const { claudeCodeRouter } = await import('./claudeCode.js')
    await withRouter('/api/claude-code', claudeCodeRouter(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'sonnet', prompt: 'hello' }),
      })
      expect(res.status).toBe(500)
      const json = await res.json()
      expect(json.error).toMatch(/not found|claude login/i)
    })
  })
})

// ── Usage-limit classification ──────────────────────────────────────
// A 5-hour-window expiry mid-run must pause the pipeline as 'quota', not
// 'error'. That chain starts here: the route answers a typed 429 so the
// client provider can mark the thrown error as quota exhaustion. Shapes
// under test are the DOCUMENTED CLI outputs (docs + issue tracker, 2026-08):
// the JSON wrapper's { is_error, result, api_error_status } and the known
// human message strings, plus the legacy "…limit reached|<epoch>" form.
describe('detectUsageLimit', () => {
  it('flags the documented JSON wrapper with api_error_status 429', async () => {
    const { detectUsageLimit } = await import('./claudeCode.js')
    const out = detectUsageLimit(
      JSON.stringify({
        type: 'result',
        is_error: true,
        result: "This request would exceed your account's rate limit. Please try again later.",
        api_error_status: 429,
      }),
    )
    expect(out.limited).toBe(true)
  })

  it('flags the known human limit messages in plain text (stderr path)', async () => {
    const { detectUsageLimit } = await import('./claudeCode.js')
    expect(detectUsageLimit("You've hit your limit · resets 3:45pm").limited).toBe(true)
    expect(detectUsageLimit("You're out of extra usage. Add more at claude.ai/settings/usage").limited).toBe(true)
    expect(detectUsageLimit('Claude AI usage limit reached|1754500000').limited).toBe(true)
  })

  it('parses the legacy reset epoch into ISO (seconds and millis)', async () => {
    const { detectUsageLimit } = await import('./claudeCode.js')
    const secs = detectUsageLimit('Claude AI usage limit reached|1754500000')
    expect(secs.resetsAt).toBe(new Date(1754500000 * 1000).toISOString())
    const millis = detectUsageLimit('Claude AI usage limit reached|1754500000000')
    expect(millis.resetsAt).toBe(new Date(1754500000000).toISOString())
  })

  it('NEVER flags generated content inside a successful JSON payload', async () => {
    const { detectUsageLimit } = await import('./claudeCode.js')
    // The result field of a success payload is MODEL OUTPUT. A chronicle
    // that happens to mention rate limits must not read as exhaustion.
    const out = detectUsageLimit(
      JSON.stringify({
        type: 'result',
        is_error: false,
        result: 'The wizard explained the rate limit on teleportation, a usage limit reached only by gods.',
      }),
    )
    expect(out.limited).toBe(false)
  })

  it('ignores ordinary failures', async () => {
    const { detectUsageLimit } = await import('./claudeCode.js')
    expect(detectUsageLimit('Invalid API key · Please run /login').limited).toBe(false)
    expect(detectUsageLimit('').limited).toBe(false)
    expect(detectUsageLimit('terminated by signal SIGKILL').limited).toBe(false)
  })
})

describe('POST /generate — usage-limit → typed 429', () => {
  it('classifies a non-zero exit with limit text on stderr as 429 usage_limit', async () => {
    whenCommand('claude', () => ({ code: 1, stderr: "You've hit your limit · resets 3:45pm" }))
    const { claudeCodeRouter } = await import('./claudeCode.js')
    await withRouter('/api/claude-code', claudeCodeRouter(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'sonnet', prompt: 'hello' }),
      })
      expect(res.status).toBe(429)
      const json = await res.json()
      expect(json.code).toBe('usage_limit')
      expect(json.error).toMatch(/usage limit/i)
    })
  })

  it('classifies an exit-0 is_error payload with api_error_status 429', async () => {
    whenCommand('claude', () => ({
      code: 0,
      stdout: JSON.stringify({
        type: 'result',
        is_error: true,
        result: "You're out of extra usage. Add more at claude.ai/settings/usage and keep going.",
        api_error_status: 429,
      }),
    }))
    const { claudeCodeRouter } = await import('./claudeCode.js')
    await withRouter('/api/claude-code', claudeCodeRouter(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'sonnet', prompt: 'hello' }),
      })
      expect(res.status).toBe(429)
      const json = await res.json()
      expect(json.code).toBe('usage_limit')
    })
  })

  it('surfaces the legacy epoch as resetsAt on the 429 body', async () => {
    whenCommand('claude', () => ({
      code: 0,
      stdout: JSON.stringify({
        type: 'result',
        is_error: true,
        result: 'Claude AI usage limit reached|1754500000',
      }),
    }))
    const { claudeCodeRouter } = await import('./claudeCode.js')
    await withRouter('/api/claude-code', claudeCodeRouter(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'sonnet', prompt: 'hello' }),
      })
      expect(res.status).toBe(429)
      const json = await res.json()
      expect(json.resetsAt).toBe(new Date(1754500000 * 1000).toISOString())
    })
  })

  it('leaves ordinary failures on the 502 path (no reclassification)', async () => {
    whenCommand('claude', () => ({ code: 1, stderr: 'model not available on your plan' }))
    const { claudeCodeRouter } = await import('./claudeCode.js')
    await withRouter('/api/claude-code', claudeCodeRouter(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'sonnet', prompt: 'hello' }),
      })
      expect(res.status).toBe(502)
    })
  })
})
