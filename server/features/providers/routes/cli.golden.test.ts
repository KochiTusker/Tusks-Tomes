// Characterisation ("golden") tests for the subscription-CLI routes.
//
// These pin what the routes do TODAY, byte for byte: the process they spawn,
// the arguments, which environment variables survive the strip, where it runs,
// what is written to its stdin, and the HTTP answer for every outcome the CLI
// can produce. They assert nothing about what the behaviour SHOULD be — if one
// fails after a refactor, the refactor changed behaviour; decide deliberately
// whether the new behaviour is the intended one, then update the snapshot.
//
// No real process is ever started: node:child_process is replaced wholesale
// (server/testing/golden/harness.ts), the home directory and temp directory
// are redirected into a throw-away tree, and the fixture credentials below
// are placeholders.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import express from 'express'
import {
  childProcessMock,
  createSandbox,
  httpRequest,
  listen,
  makeNormaliser,
  spawnCapture,
  type Reply,
  type Sandbox,
  type SpawnOutcome,
  type SpawnRecord,
} from '../../../testing/golden/harness.js'

type Cli = 'claude-code' | 'codex'

let sandbox: Sandbox
let norm: ReturnType<typeof makeNormaliser>

// Placeholder credentials: only their NAMES matter to these tests.
const PARENT_ENV: Record<string, string> = {
  ANTHROPIC_API_KEY: 'placeholder-anthropic-key',
  ANTHROPIC_AUTH_TOKEN: 'placeholder-anthropic-token',
  ANTHROPIC_BASE_URL: 'http://placeholder.invalid',
  OPENAI_API_KEY: 'placeholder-openai-key',
  OPENAI_BASE_URL: 'http://placeholder.invalid',
  OPENAI_API_BASE: 'http://placeholder.invalid',
  TT_GOLDEN_KEEP: '1',
}

beforeAll(async () => {
  sandbox = await createSandbox('tt-golden-cli-')
  // Timestamps here are derived from fixture input, so they are deterministic
  // and stay in the snapshot unmasked.
  norm = makeNormaliser(sandbox.root, [], { maskIso: false })
  for (const [k, v] of Object.entries(PARENT_ENV)) process.env[k] = v
  vi.stubGlobal('fetch', async () => {
    throw new Error('network disabled in golden tests')
  })
})

afterAll(async () => {
  vi.unstubAllGlobals()
  vi.doUnmock('node:child_process')
  await sandbox.restore()
})

beforeEach(async () => {
  spawnCapture.reset()
  vi.resetModules()
  vi.doMock('node:child_process', () => childProcessMock())
  // Credentials file state is part of each scenario; start from "absent".
  await fs.rm(path.join(sandbox.paths.home, '.claude'), { recursive: true, force: true })
  await fs.rm(path.join(sandbox.paths.home, '.codex'), { recursive: true, force: true })
})

/** A fresh router import per call: both modules keep a 5 s status cache in
 *  module state, which would otherwise leak between scenarios. */
async function withCli<T>(cli: Cli, body: (port: number) => Promise<T>): Promise<T> {
  const app = express()
  app.use(express.json({ limit: '20mb' }))
  if (cli === 'claude-code') {
    const mod = await import('./claudeCode.js')
    app.use('/api/claude-code', mod.claudeCodeRouter())
  } else {
    const mod = await import('./codex.js')
    app.use('/api/codex', mod.codexRouter())
  }
  const srv = await listen(app)
  try {
    return await body(srv.port)
  } finally {
    await srv.close()
  }
}

function req(
  port: number,
  method: string,
  p: string,
  json?: unknown,
  extra: { abortWhen?: () => boolean } = {},
): Promise<Reply> {
  return httpRequest({ port, hostHeader: `127.0.0.1:${port}`, method, path: p, json, ...extra })
}

function shape(rec: SpawnRecord) {
  const env = rec.options.env
  return {
    command: rec.command,
    // An empty option value is a real '' off Windows and the two-character
    // '""' under the Windows shell; claudeCode.test.ts pins both spellings.
    args: rec.args.map((a) => (a === '' || a === '""' ? '<none>' : a)),
    // The shell flag is true only on Windows; pin that it tracks the platform.
    shellIsWin32: rec.options.shell === (process.platform === 'win32'),
    stdio: rec.options.stdio,
    cwd: rec.options.cwd === undefined ? '<unset>' : norm.str(rec.options.cwd),
    // `env` absent means the child inherits the parent's environment unchanged.
    envPassed: env !== undefined,
    envKeys:
      env === undefined
        ? null
        : Object.keys(env)
            .filter((k) => /^(ANTHROPIC_|OPENAI_|TT_GOLDEN_)/i.test(k))
            .sort(),
    envInheritsPath: env === undefined ? null : Object.keys(env).some((k) => /^path$/i.test(k)),
    stdin: rec.stdin,
    stdinEnded: rec.stdinEnded,
    killed: rec.killed,
  }
}

function replyShape(r: Reply) {
  return {
    status: r.status,
    contentType: r.contentType,
    body: r.json !== undefined ? norm.walk(r.json) : norm.str(r.text),
  }
}

type Row = { case: string; spawned: ReturnType<typeof shape>[]; response: ReturnType<typeof replyShape> | { aborted: true } }

async function runGenerate(
  cli: Cli,
  name: string,
  body: unknown,
  outcome: SpawnOutcome | null,
  opts: { abort?: boolean } = {},
): Promise<Row> {
  spawnCapture.reset()
  if (outcome) spawnCapture.when(cli === 'claude-code' ? 'claude' : 'codex', () => outcome)
  return withCli(cli, async (port) => {
    // Abort only once the prompt has been delivered, so the route is
    // genuinely mid-run when the socket closes.
    const abortWhen = opts.abort
      ? () => spawnCapture.records().some((r) => r.stdinEnded)
      : undefined
    const r = await req(port, 'POST', `/api/${cli}/generate`, body, { abortWhen })
    if (opts.abort) {
      // The route kills the child on a genuine client abort; wait for it.
      for (let i = 0; i < 400 && !spawnCapture.records().some((x) => x.killed); i++) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    }
    return {
      case: name,
      spawned: spawnCapture.records().map(shape),
      response: opts.abort ? { aborted: true as const } : replyShape(r),
    }
  })
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

const CLAUDE_OK = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'Place-Delta lay quiet.',
  total_cost_usd: 0.0123,
  usage: { input_tokens: 11, output_tokens: 7 },
})

describe('POST /api/claude-code/generate', () => {
  it('pins spawn shape and responses for every outcome', async () => {
    const PROMPT = 'SYSTEM: be brief\n\nUSER: describe Place-Delta'
    const rows: Row[] = []
    const run = (n: string, body: unknown, o: SpawnOutcome | null, opts?: { abort?: boolean }) =>
      runGenerate('claude-code', n, body, o, opts).then((r) => rows.push(r))

    await run('success (default model)', { prompt: PROMPT }, { code: 0, stdout: CLAUDE_OK })
    await run('success (explicit model, maxOutputTokens ignored)', { prompt: PROMPT, model: 'opus', maxOutputTokens: 99 }, { code: 0, stdout: CLAUDE_OK })
    await run('success with whitespace-padded model', { prompt: PROMPT, model: '  haiku  ' }, { code: 0, stdout: CLAUDE_OK })
    await run('success without usage or cost', { prompt: PROMPT }, { code: 0, stdout: JSON.stringify({ result: 'plain' }) })
    await run(
      'usage limit: non-zero exit, JSON is_error',
      { prompt: PROMPT },
      { code: 1, stdout: JSON.stringify({ is_error: true, result: "You've hit your limit · resets 3:45pm" }) },
    )
    await run(
      'usage limit: exit 0, is_error with api_error_status 429',
      { prompt: PROMPT },
      { code: 0, stdout: JSON.stringify({ is_error: true, api_error_status: 429, result: 'Too many requests' }) },
    )
    await run(
      'usage limit: exit 0, is_error with pattern match',
      { prompt: PROMPT },
      { code: 0, stdout: JSON.stringify({ is_error: true, result: "You're out of extra usage for now" }) },
    )
    await run(
      'usage limit: legacy epoch on stderr',
      { prompt: PROMPT },
      { code: 1, stderr: 'Claude AI usage limit reached|1754500000' },
    )
    await run('non-zero exit with stderr', { prompt: PROMPT }, { code: 1, stderr: 'boom: something broke' })
    await run('non-zero exit with stdout only', { prompt: PROMPT }, { code: 2, stdout: 'plain failure text' })
    await run('non-zero exit with no output', { prompt: PROMPT }, { code: 3 })
    await run(
      'non-zero exit, JSON error wrapper (auth)',
      { prompt: PROMPT },
      { code: 1, stdout: JSON.stringify({ is_error: true, result: 'OAuth token has expired' }) },
    )
    await run(
      'non-zero exit, JSON error wrapper (no message, terminal_reason)',
      { prompt: PROMPT },
      { code: 1, stdout: JSON.stringify({ is_error: true, terminal_reason: 'max_turns' }) },
    )
    await run('exit 0, empty stdout', { prompt: PROMPT }, { code: 0 })
    await run('exit 0, stdout not JSON', { prompt: PROMPT }, { code: 0, stdout: 'not json at all' })
    await run(
      'exit 0, is_error without limit or length signal',
      { prompt: PROMPT },
      { code: 0, stdout: JSON.stringify({ is_error: true, result: 'Something odd happened' }) },
    )
    await run(
      'prompt too long: non-zero exit, terminal_reason',
      { prompt: PROMPT },
      { code: 1, stdout: JSON.stringify({ is_error: true, terminal_reason: 'prompt_too_long', result: 'x' }) },
    )
    await run(
      'prompt too long: exit 0, is_error prose',
      { prompt: PROMPT },
      { code: 0, stdout: JSON.stringify({ is_error: true, result: 'Prompt is too long' }) },
    )
    await run(
      'prompt too long on stderr',
      { prompt: PROMPT },
      { code: 1, stderr: 'input length and `max_tokens` exceed context limit' },
    )
    await run('invalid model id', { prompt: PROMPT, model: 'bad model; rm -rf' }, null)
    await run('invalid model id (path-like)', { prompt: PROMPT, model: '../x' }, null)
    await run('missing prompt', { model: 'sonnet' }, null)
    await run('empty prompt', { prompt: '   ' }, null)
    await run('non-string prompt', { prompt: 42 }, null)
    await run('empty body', {}, null)
    await run('spawn error ENOENT', { prompt: PROMPT }, { emitError: Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }) })
    await run('spawn error other', { prompt: PROMPT }, { emitError: new Error('EACCES nope') })
    await run(
      'stdin closed early (EPIPE)',
      { prompt: PROMPT },
      { stdinError: Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }) },
    )
    await run('client abort kills the child', { prompt: PROMPT }, { hang: true }, { abort: true })

    expect(rows).toMatchSnapshot()
  })
})

describe('GET /api/claude-code/status', () => {
  const homeCreds = async (present: boolean, file = '.credentials.json') => {
    if (!present) return
    await fs.mkdir(path.join(sandbox.paths.home, '.claude'), { recursive: true })
    await fs.writeFile(path.join(sandbox.paths.home, '.claude', file), '{}', 'utf8')
  }

  async function status(name: string, outcome: SpawnOutcome, creds: false | string): Promise<unknown> {
    spawnCapture.reset()
    vi.resetModules()
    vi.doMock('node:child_process', () => childProcessMock())
    await fs.rm(path.join(sandbox.paths.home, '.claude'), { recursive: true, force: true })
    if (creds) await homeCreds(true, creds)
    spawnCapture.when('claude', () => outcome)
    return withCli('claude-code', async (port) => {
      const r = await req(port, 'GET', '/api/claude-code/status')
      return { case: name, spawned: spawnCapture.records().map(shape), response: replyShape(r) }
    })
  }

  it('pins version, credentials and probe-failure combinations', async () => {
    const rows = [
      await status('version present, credentials absent', { code: 0, stdout: '2.0.5 (Claude Code)\n' }, false),
      await status('version present, .credentials.json present', { code: 0, stdout: '2.0.5 (Claude Code)\n' }, '.credentials.json'),
      await status('version present, legacy .credentials present', { code: 0, stdout: '2.0.5 (Claude Code)\n' }, '.credentials'),
      await status('exit 0 with empty stdout', { code: 0 }, false),
      await status('absent (exit 1)', { code: 1 }, false),
      await status('absent (exit 127)', { code: 127, stderr: 'not found' }, '.credentials.json'),
      await status('NTSTATUS failure code', { code: 0xc0000142 }, false),
      await status('spawn error', { emitError: new Error('spawn claude ENOENT') }, false),
    ]
    expect(rows).toMatchSnapshot()
  })

  it('pins the timeout outcome (hung CLI)', async () => {
    // The route waits a real 4 s before giving up; there is no seam to shorten it.
    const row = await status('timeout', { hang: true }, false)
    expect(row).toMatchSnapshot()
  }, 20_000)

  it('serves a second call from the 5 s cache without spawning again', async () => {
    spawnCapture.reset()
    spawnCapture.when('claude', () => ({ code: 0, stdout: '9.9.9\n' }))
    const out = await withCli('claude-code', async (port) => {
      const a = await req(port, 'GET', '/api/claude-code/status')
      spawnCapture.when('claude', () => ({ code: 1 }))
      const b = await req(port, 'GET', '/api/claude-code/status')
      return { first: replyShape(a), second: replyShape(b), spawnCount: spawnCapture.records().length }
    })
    expect(out).toMatchSnapshot()
  })
})

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

const CODEX_OK = [
  JSON.stringify({ type: 'thread.started', thread_id: 'thread-placeholder' }),
  JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Place-Delta lay quiet.' } }),
  JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 11, output_tokens: 7 } }),
].join('\n')

describe('POST /api/codex/generate', () => {
  it('pins spawn shape and responses for every outcome', async () => {
    const PROMPT = 'SYSTEM: be brief\n\nUSER: describe Place-Delta'
    const rows: Row[] = []
    const run = (n: string, body: unknown, o: SpawnOutcome | null, opts?: { abort?: boolean }) =>
      runGenerate('codex', n, body, o, opts).then((r) => rows.push(r))

    await run('success (default model)', { prompt: PROMPT }, { code: 0, stdout: CODEX_OK })
    await run('success (explicit model)', { prompt: PROMPT, model: 'gpt-5-codex' }, { code: 0, stdout: CODEX_OK })
    await run('success (model "default" passed explicitly)', { prompt: PROMPT, model: 'default' }, { code: 0, stdout: CODEX_OK })
    await run(
      'usage limit: non-zero exit, stderr',
      { prompt: PROMPT },
      { code: 1, stderr: "You've hit your usage limit. Try again later." },
    )
    await run(
      'usage limit: exit 0, error event',
      { prompt: PROMPT },
      { code: 0, stdout: JSON.stringify({ type: 'error', message: "You've hit your usage limit." }) },
    )
    await run('non-zero exit with stderr', { prompt: PROMPT }, { code: 1, stderr: 'boom: something broke' })
    await run('non-zero exit with stdout only', { prompt: PROMPT }, { code: 2, stdout: 'plain failure text' })
    await run('non-zero exit with no output', { prompt: PROMPT }, { code: 3 })
    await run('exit 0, empty stdout', { prompt: PROMPT }, { code: 0 })
    await run('exit 0, stdout not JSONL', { prompt: PROMPT }, { code: 0, stdout: 'not json at all' })
    await run(
      'exit 0, error event without limit signal',
      { prompt: PROMPT },
      { code: 0, stdout: JSON.stringify({ type: 'error', message: 'Something odd happened' }) },
    )
    await run('invalid model id', { prompt: PROMPT, model: 'bad model; rm -rf' }, null)
    await run('missing prompt', { model: 'default' }, null)
    await run('empty prompt', { prompt: '  ' }, null)
    await run('empty body', {}, null)
    await run('spawn error ENOENT', { prompt: PROMPT }, { emitError: Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }) })
    await run('spawn error other', { prompt: PROMPT }, { emitError: new Error('EACCES nope') })
    await run(
      'stdin closed early (EPIPE)',
      { prompt: PROMPT },
      { stdinError: Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }) },
    )
    await run('client abort kills the child', { prompt: PROMPT }, { hang: true }, { abort: true })

    expect(rows).toMatchSnapshot()
  })
})

describe('GET /api/codex/status', () => {
  async function status(name: string, outcome: SpawnOutcome, creds: false | string): Promise<unknown> {
    spawnCapture.reset()
    vi.resetModules()
    vi.doMock('node:child_process', () => childProcessMock())
    await fs.rm(path.join(sandbox.paths.home, '.codex'), { recursive: true, force: true })
    if (creds) {
      await fs.mkdir(path.join(sandbox.paths.home, '.codex'), { recursive: true })
      await fs.writeFile(path.join(sandbox.paths.home, '.codex', creds), '{}', 'utf8')
    }
    spawnCapture.when('codex', () => outcome)
    return withCli('codex', async (port) => {
      const r = await req(port, 'GET', '/api/codex/status')
      return { case: name, spawned: spawnCapture.records().map(shape), response: replyShape(r) }
    })
  }

  it('pins version, credentials and probe-failure combinations', async () => {
    const rows = [
      await status('version present, credentials absent', { code: 0, stdout: 'codex-cli 0.9.1\n' }, false),
      await status('version present, auth.json present', { code: 0, stdout: 'codex-cli 0.9.1\n' }, 'auth.json'),
      await status('version present, credentials.json present', { code: 0, stdout: 'codex-cli 0.9.1\n' }, 'credentials.json'),
      await status('exit 0 with empty stdout', { code: 0 }, false),
      await status('absent (exit 1)', { code: 1 }, false),
      await status('NTSTATUS failure code', { code: 0xc0000142 }, false),
      await status('spawn error', { emitError: new Error('spawn codex ENOENT') }, false),
    ]
    expect(rows).toMatchSnapshot()
  })

  it('pins the timeout outcome (hung CLI)', async () => {
    const row = await status('timeout', { hang: true }, false)
    expect(row).toMatchSnapshot()
  }, 20_000)

  it('serves a second call from the 5 s cache without spawning again', async () => {
    spawnCapture.reset()
    spawnCapture.when('codex', () => ({ code: 0, stdout: 'codex-cli 1.0.0\n' }))
    const out = await withCli('codex', async (port) => {
      const a = await req(port, 'GET', '/api/codex/status')
      spawnCapture.when('codex', () => ({ code: 1 }))
      const b = await req(port, 'GET', '/api/codex/status')
      return { first: replyShape(a), second: replyShape(b), spawnCount: spawnCapture.records().length }
    })
    expect(out).toMatchSnapshot()
  })
})
