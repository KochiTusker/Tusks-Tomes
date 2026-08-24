// Tests for the Codex subscription router + its pure helpers — the Codex
// twin of claudeCode.test.ts. The CLI is not assumed to be installed:
// every test drives the route through the shared spawn mock, so what's
// pinned here is the route's contract, not the CLI binary.
//
// Key invariants:
//   - OPENAI_API_KEY is stripped from the child env so the CLI always
//     resolves to the user's `codex login` session, never API billing.
//   - `codex exec --json` JSONL streams parse into { text, usage }; the
//     LAST agent_message wins.
//   - Usage-limit output classifies as a typed 429 (code: 'usage_limit')
//     so the client provider can pause the run as 'quota', not 'error'.
//   - The prompt travels via stdin (positional '-'), never argv.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockSpawn, resetSpawnMock, spawnCalls, whenCommand } from '../testing/spawnMock.js'
import { withRouter } from '../testing/httpFixture.js'

vi.mock('node:child_process', () => mockSpawn())

beforeEach(() => resetSpawnMock())

const jl = (...events: unknown[]) => events.map((e) => JSON.stringify(e)).join('\n')

describe('parseCodexJsonl', () => {
  it('extracts the last agent_message and the usage totals', async () => {
    const { parseCodexJsonl } = await import('./codex.js')
    const out = parseCodexJsonl(
      jl(
        { type: 'thread.started' },
        { type: 'item.completed', item: { type: 'agent_message', text: 'draft one' } },
        { type: 'item.completed', item: { type: 'agent_message', text: 'final text' } },
        { type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 34 } },
      ),
    )
    expect(out.text).toBe('final text')
    expect(out.usage).toEqual({ inputTokens: 12, outputTokens: 34 })
  })

  it('skips interleaved non-JSON noise', async () => {
    const { parseCodexJsonl } = await import('./codex.js')
    const out = parseCodexJsonl(
      'spinner noise\n' +
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }),
    )
    expect(out.text).toBe('ok')
  })

  it('throws the error event message when no agent message arrived', async () => {
    const { parseCodexJsonl } = await import('./codex.js')
    expect(() =>
      parseCodexJsonl(jl({ type: 'error', message: 'stream disconnected' })),
    ).toThrow(/stream disconnected/)
  })

  it('throws a clear error on wholly unparseable output', async () => {
    const { parseCodexJsonl } = await import('./codex.js')
    expect(() => parseCodexJsonl('not json at all')).toThrow(/no parseable JSON/)
  })
})

describe('detectCodexUsageLimit', () => {
  it('flags the documented limit messages', async () => {
    const { detectCodexUsageLimit } = await import('./codex.js')
    expect(detectCodexUsageLimit("You've hit your usage limit. Upgrade to Pro…or try again at Jul 19th, 2026 10:27 AM.")).toBe(true)
    expect(detectCodexUsageLimit("You've reached your workspace spend cap")).toBe(true)
    expect(detectCodexUsageLimit('You have reached your Codex usage limits for code reviews.')).toBe(true)
  })

  it('ignores ordinary failures', async () => {
    const { detectCodexUsageLimit } = await import('./codex.js')
    expect(detectCodexUsageLimit('Not logged in. Run codex login.')).toBe(false)
    expect(detectCodexUsageLimit('')).toBe(false)
  })
})

describe('detectCodexUsageLimitInEvents', () => {
  it('matches error events but NEVER agent_message content', async () => {
    const { detectCodexUsageLimitInEvents } = await import('./codex.js')
    // Model output discussing usage limits must not classify as exhaustion.
    expect(
      detectCodexUsageLimitInEvents(
        jl({ type: 'item.completed', item: { type: 'agent_message', text: 'The mage hit his usage limit of spells.' } }),
      ),
    ).toBe(false)
    expect(
      detectCodexUsageLimitInEvents(jl({ type: 'error', message: "You've hit your usage limit." })),
    ).toBe(true)
    expect(
      detectCodexUsageLimitInEvents(
        jl({ type: 'item.completed', item: { type: 'error', message: 'workspace spend cap reached' } }),
      ),
    ).toBe(true)
  })
})

describe('childEnvWithoutOpenAiKeys', () => {
  it('strips OPENAI_API_KEY, keeps others', async () => {
    const { childEnvWithoutOpenAiKeys } = await import('./codex.js')
    const out = childEnvWithoutOpenAiKeys({ OPENAI_API_KEY: 'sk-x', PATH: '/bin' })
    expect(out.OPENAI_API_KEY).toBeUndefined()
    expect(out.PATH).toBe('/bin')
  })
})

describe('POST /generate', () => {
  const savedKey = process.env.OPENAI_API_KEY
  beforeEach(() => {
    // Deliberately not in `sk-…` form: the assertion only cares that the
    // value is REMOVED, so a credential-shaped fixture buys nothing.
    process.env.OPENAI_API_KEY = 'dummy-openai-value-should-be-stripped'
    return () => {
      if (savedKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = savedKey
    }
  })

  it('returns text + usage, strips the API key, keeps the prompt off argv', async () => {
    whenCommand('codex', () => ({
      code: 0,
      stdout: jl(
        { type: 'item.completed', item: { type: 'agent_message', text: 'grounded text' } },
        { type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 7 } },
      ),
    }))
    const { codexRouter } = await import('./codex.js')
    await withRouter('/api/codex', codexRouter(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-5-codex', prompt: 'secret prompt content' }),
      })
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.text).toBe('grounded text')
      expect(json.usage).toEqual({ inputTokens: 5, outputTokens: 7 })
    })
    const call = spawnCalls().find((c) => c.command === 'codex')
    expect(call).toBeTruthy()
    expect(call?.options.env?.OPENAI_API_KEY).toBeUndefined()
    expect(call?.args).toContain('exec')
    expect(call?.args).toContain('--json')
    expect(call?.args).toContain('--sandbox')
    expect(call?.args.join(' ')).not.toContain('secret prompt content')
    // Neutral sandbox cwd, never the repo root.
    expect(String(call?.options.cwd)).toContain('tusks-tomes-codex-sandbox')
  })

  it("omits --model entirely for the 'default' id", async () => {
    whenCommand('codex', () => ({
      code: 0,
      stdout: jl({ type: 'item.completed', item: { type: 'agent_message', text: 'x' } }),
    }))
    const { codexRouter } = await import('./codex.js')
    await withRouter('/api/codex', codexRouter(), async (baseUrl) => {
      await fetch(`${baseUrl}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'default', prompt: 'hello' }),
      })
    })
    const call = spawnCalls().find((c) => c.command === 'codex')
    expect(call?.args).not.toContain('--model')
  })

  it('rejects an invalid model id with 400', async () => {
    const { codexRouter } = await import('./codex.js')
    await withRouter('/api/codex', codexRouter(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'bad model; rm -rf', prompt: 'hello' }),
      })
      expect(res.status).toBe(400)
    })
  })

  it('classifies limit text on stderr as 429 usage_limit', async () => {
    whenCommand('codex', () => ({
      code: 1,
      stderr: "You've hit your usage limit. Upgrade to Pro, or try again at Jul 19th, 2026 10:27 AM.",
    }))
    const { codexRouter } = await import('./codex.js')
    await withRouter('/api/codex', codexRouter(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-5-codex', prompt: 'hello' }),
      })
      expect(res.status).toBe(429)
      const json = await res.json()
      expect(json.code).toBe('usage_limit')
    })
  })

  it('classifies a limit error EVENT on stdout as 429 even at exit 0', async () => {
    whenCommand('codex', () => ({
      code: 0,
      stdout: jl({ type: 'error', message: "You've reached your workspace spend cap" }),
    }))
    const { codexRouter } = await import('./codex.js')
    await withRouter('/api/codex', codexRouter(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-5-codex', prompt: 'hello' }),
      })
      expect(res.status).toBe(429)
      const json = await res.json()
      expect(json.code).toBe('usage_limit')
    })
  })

  it('surfaces ordinary non-zero exits as 502', async () => {
    whenCommand('codex', () => ({ code: 1, stderr: 'Not logged in. Run codex login.' }))
    const { codexRouter } = await import('./codex.js')
    await withRouter('/api/codex', codexRouter(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-5-codex', prompt: 'hello' }),
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
    whenCommand('codex', () => ({ code: 0, stdinError: epipe }))
    const { codexRouter } = await import('./codex.js')
    await withRouter('/api/codex', codexRouter(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-5-codex', prompt: 'x'.repeat(50_000) }),
      })
      expect(res.status).toBe(502)
      expect((await res.json()).error).toMatch(/closed its input|EPIPE/i)
    })
  })

  it('reports a clear message when the CLI is missing (ENOENT)', async () => {
    const err = new Error('spawn codex ENOENT') as NodeJS.ErrnoException
    err.code = 'ENOENT'
    whenCommand('codex', () => ({ code: -1, emitError: err }))
    const { codexRouter } = await import('./codex.js')
    await withRouter('/api/codex', codexRouter(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-5-codex', prompt: 'hello' }),
      })
      expect(res.status).toBe(500)
      const json = await res.json()
      expect(json.error).toMatch(/not found|codex login/i)
    })
  })
})
