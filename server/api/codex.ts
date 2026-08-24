// Codex CLI (OpenAI subscription) proxy — the Codex twin of
// server/api/claudeCode.ts. Lets the pipeline use a locally-installed,
// `codex login`-authenticated Codex CLI as an LLM provider with no API key.
//
// Deliberately a SEPARATE module from the Claude Code route: the two add-ons
// must not interfere. Neither file imports the other; each has its own
// marker file, router mount, sandbox dir, and status cache.
//
// CLI contract (documented behaviour as of 2026-08; the add-on ships `wip`
// because parts of the non-interactive surface are under-documented):
//   - `codex exec --json` runs one non-interactive turn and emits
//     newline-delimited JSON events on stdout. The final assistant text is
//     the last `item.completed` event whose `item.type === 'agent_message'`.
//   - Errors surface as `{"type":"error","message":"…"}` events and/or a
//     non-zero exit.
//   - Usage-limit messages observed in the wild: "You've hit your usage
//     limit…", "You've reached your workspace spend cap", with a
//     human-readable (NOT machine-readable) reset time.
//   - `--sandbox read-only` + `--skip-git-repo-check` let the child run in a
//     neutral scratch cwd that is not a git repo, with no write access.
//   - Auth: `codex login` (ChatGPT subscription). OPENAI_API_KEY is stripped
//     from the child env so the CLI can never silently bill API credit —
//     the whole point of the add-on is "bring your own subscription".

import express, { type Router } from 'express'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loopbackOnly } from '../lib/loopbackGate.js'

const CLI_COMMAND = 'codex'

/** Model ids offered in the routing UI. The CLI's default model is used
 *  when the id is 'default' — we pass no -m flag at all in that case, so
 *  a CLI upgrade moving the default forward is inherited for free. */
export const CODEX_MODELS = ['default', 'gpt-5-codex', 'gpt-5', 'gpt-5-mini', 'o3']

/** Same shape as the Claude Code route: model is the only request-derived
 *  argv value, and it must survive shell:true on Windows. */
const MODEL_RE = /^[A-Za-z0-9._-]+$/

/** Neutral cwd for the child — never the repo root, so a prompt-injected
 *  tool call can't reach the project tree. Separate dir from the Claude
 *  sandbox to keep the two add-ons' disk footprints disjoint. */
const CLI_SANDBOX_DIR = path.join(os.tmpdir(), 'tusks-tomes-codex-sandbox')

import type { ProbeOutcome } from './claudeCode.js'

export type CodexStatus = {
  installed: boolean
  version: string | null
  /** Mirrors ClaudeCodeStatus.probeFailed — set when the check itself
   *  could not run, so the UI can say "couldn't check" instead of
   *  claiming the CLI is absent. */
  probeFailed?: string
  /** Mirrors ClaudeCodeStatus.authenticated so callers can treat the two
   *  subscription providers symmetrically. Presence of the credentials file
   *  only — the file is never opened. */
  authenticated: boolean
  models: string[]
}

/** Has the user run `codex login`?
 *
 *  Existence check only: the file holds live credentials and this process has
 *  no business reading them. Same approach as claudeCode.ts
 *  credentialsFileExists(). A false here is advisory — the CLI is the real
 *  authority — so the UI should phrase it as "couldn't confirm", never as
 *  "you are logged out". */
function codexCredentialsFileExists(): Promise<boolean> {
  const home = os.homedir()
  const candidates = [
    path.join(home, '.codex', 'auth.json'),
    path.join(home, '.codex', 'credentials.json'),
  ]
  return Promise.all(
    candidates.map((p) =>
      fs
        .access(p)
        .then(() => true)
        .catch(() => false),
    ),
  ).then((results) => results.some(Boolean))
}

let statusCache: { at: number; value: CodexStatus } | null = null
const STATUS_TTL_MS = 5_000

function probeVersion(): Promise<ProbeOutcome> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(CLI_COMMAND, ['--version'], {
        shell: process.platform === 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      return resolve({ kind: 'unknown', reason: `spawn threw: ${(err as Error).message}` })
    }
    let out = ''
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      resolve({ kind: 'unknown', reason: 'the check timed out' })
    }, 4000)
    child.stdout?.on('data', (b: Buffer) => (out += b.toString('utf8')))
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ kind: 'unknown', reason: err.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0 && out.trim()) return resolve({ kind: 'found', version: out.trim() })
      // See claudeCode.ts:NTSTATUS_FAILURE_FLOOR — a process that could not
      // start is not evidence of absence.
      if (code !== null && code >= 0xc0000000) {
        return resolve({
          kind: 'unknown',
          reason: `the check could not start (0x${code.toString(16)}) — restarting Tusk's Tomes usually clears this`,
        })
      }
      resolve({ kind: 'absent' })
    })
  })
}

export async function codexStatus(force = false): Promise<CodexStatus> {
  if (!force && statusCache && Date.now() - statusCache.at < STATUS_TTL_MS) {
    return statusCache.value
  }
  const [probe, authenticated] = await Promise.all([probeVersion(), codexCredentialsFileExists()])
  const value: CodexStatus = {
    installed: probe.kind === 'found',
    version: probe.kind === 'found' ? probe.version : null,
    probeFailed: probe.kind === 'unknown' ? probe.reason : undefined,
    authenticated,
    models: CODEX_MODELS,
  }
  statusCache = { at: Date.now(), value }
  return value
}

type GenerateBody = { model?: string; prompt?: string; maxOutputTokens?: number }

/** One line of `codex exec --json` output. Only the fields we consume. */
type CodexEvent = {
  type?: string
  message?: string
  item?: { type?: string; text?: string; message?: string }
  usage?: { input_tokens?: number; output_tokens?: number }
}

/** Usage-limit patterns for the Codex CLI. Same philosophy as the Claude
 *  Code detector: the strict direction (limit → generic error) recreates
 *  the pause-as-'error' bug, the loose direction costs one resumable pause,
 *  so patterns lean inclusive. Reset times in Codex messages are
 *  human-readable only — there is no epoch to parse. */
const USAGE_LIMIT_PATTERNS = [
  /you've (hit|reached) your (usage|codex usage) limit/i,
  /usage limit/i,
  /workspace spend cap/i,
  /rate.?limit/i,
]

export function detectCodexUsageLimit(raw: string): boolean {
  if (!raw) return false
  return USAGE_LIMIT_PATTERNS.some((re) => re.test(raw))
}

/** Parse the JSONL event stream into { text, usage }. Exported for unit
 *  testing. Throws when the stream carries an error event and no final
 *  agent message — partial streams with a trailing error prefer the error. */
export function parseCodexJsonl(stdout: string): {
  text: string
  usage: { inputTokens: number; outputTokens: number }
} {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim())
  let text = ''
  let inputTokens = 0
  let outputTokens = 0
  let lastError: string | null = null
  let sawParseableLine = false

  for (const line of lines) {
    let ev: CodexEvent
    try {
      ev = JSON.parse(line) as CodexEvent
    } catch {
      continue // interleaved non-JSON noise (progress spinners etc.)
    }
    if (typeof ev !== 'object' || ev === null) continue
    sawParseableLine = true
    if (ev.type === 'error' && typeof ev.message === 'string') {
      lastError = ev.message
      continue
    }
    if (ev.type === 'item.completed' && ev.item) {
      if (ev.item.type === 'agent_message' && typeof ev.item.text === 'string') {
        text = ev.item.text // last agent message wins
      }
      if (ev.item.type === 'error' && typeof ev.item.message === 'string') {
        lastError = ev.item.message
      }
    }
    if (ev.usage) {
      inputTokens = ev.usage.input_tokens ?? inputTokens
      outputTokens = ev.usage.output_tokens ?? outputTokens
    }
  }

  if (!text.trim()) {
    if (lastError) throw new Error(lastError)
    if (!sawParseableLine) {
      throw new Error(
        `Codex returned no parseable JSON events. First 300 chars:\n${stdout.slice(0, 300)}`,
      )
    }
    throw new Error('Codex completed without an agent message.')
  }
  return { text, usage: { inputTokens, outputTokens } }
}

/** Strip subscription-overriding keys so the CLI always resolves to the
 *  user's `codex login` session, never API billing. Exported for tests. */
export function childEnvWithoutOpenAiKeys(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Case-INSENSITIVE removal. Windows treats environment variable names
  // case-insensitively, but the spread above produces a plain JS object
  // where `delete next.FOO` is case-sensitive — so a variable set as
  // `openai_api_key` would survive the strip while the child still
  // resolved it, silently switching the user onto per-token billing on
  // the platform this app primarily targets.
  const STRIP = new Set(['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_API_BASE'].map((k) => k.toLowerCase()))
  const next: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (!STRIP.has(key.toLowerCase())) next[key] = value
  }
  return next
}

export function codexRouter(): Router {
  const router = express.Router()

  router.get('/status', async (_req, res) => {
    try {
      res.json(await codexStatus())
    } catch (err) {
      console.error('[codex/status] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // loopback-only: spawns a process on the HOST machine, same threat model
  // as the Claude Code route.
  router.post('/generate', loopbackOnly(), async (req, res) => {
    const { model, prompt } = (req.body ?? {}) as GenerateBody
    const chosenModel = (model || 'default').trim()
    if (!MODEL_RE.test(chosenModel)) {
      return res.status(400).json({ error: `Invalid model id: ${chosenModel}` })
    }
    if (typeof prompt !== 'string' || !prompt.trim()) {
      return res.status(400).json({ error: 'Missing prompt in request body.' })
    }

    // argv is literals + the validated model. The prompt goes via stdin
    // (positional `-`), so it never touches the shell even under the
    // Windows shell:true path. `--sandbox read-only` keeps the agent from
    // writing anywhere; `--skip-git-repo-check` because the sandbox cwd is
    // deliberately not a repo.
    const args = ['exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check']
    if (chosenModel !== 'default') args.push('--model', chosenModel)
    args.push('-')

    let sandboxCwd: string | undefined
    try {
      await fs.mkdir(CLI_SANDBOX_DIR, { recursive: true })
      sandboxCwd = CLI_SANDBOX_DIR
    } catch {
      sandboxCwd = undefined
    }

    let child
    try {
      child = spawn(CLI_COMMAND, args, {
        shell: process.platform === 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: childEnvWithoutOpenAiKeys(process.env),
        cwd: sandboxCwd,
      })
    } catch (err) {
      return res.status(500).json({
        error: `Couldn't launch the Codex CLI: ${(err as Error).message}. Make sure "codex" is on your PATH.`,
      })
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    const done = (fn: () => void) => {
      if (!settled) {
        settled = true
        fn()
      }
    }

    // Same abort semantics as the Claude Code route: kill the child only on
    // a genuine client abort (res 'close' with the response not yet ended).
    res.on('close', () => {
      if (!settled && !res.writableEnded) {
        settled = true
        try {
          child.kill()
        } catch {
          /* already gone */
        }
      }
    })

    child.stdout.on('data', (b: Buffer) => (stdout += b.toString('utf8')))
    child.stderr.on('data', (b: Buffer) => (stderr += b.toString('utf8')))

    child.on('error', (err) => {
      const msg =
        (err as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'Codex CLI not found. Install it (npm i -g @openai/codex) and run `codex login`.'
          : `Codex CLI error: ${err.message}`
      done(() => res.status(500).json({ error: msg }))
    })

    child.on('close', (code, signal) => {
      done(() => {
        const limited = detectCodexUsageLimit(stderr) || detectCodexUsageLimitInEvents(stdout)
        if (code !== 0) {
          const detail =
            stderr.trim() ||
            stdout.trim() ||
            (signal ? `terminated by signal ${signal}` : `exit code ${code}`)
          if (limited) {
            return res.status(429).json({
              error: `Codex usage limit reached: ${detail.slice(0, 300)}`,
              code: 'usage_limit',
              resetsAt: null,
            })
          }
          return res.status(502).json({
            error: `Codex CLI failed: ${detail.slice(0, 600)}`,
          })
        }
        try {
          const parsed = parseCodexJsonl(stdout)
          res.json(parsed)
        } catch (err) {
          const msg = (err as Error).message
          if (limited || detectCodexUsageLimit(msg)) {
            return res.status(429).json({
              error: `Codex usage limit reached: ${msg.slice(0, 300)}`,
              code: 'usage_limit',
              resetsAt: null,
            })
          }
          res.status(502).json({ error: msg })
        }
      })
    })

    // stdin.write() on a prompt this size (transcript chunks are tens to
    // hundreds of KB) buffers and flushes ASYNCHRONOUSLY. If the CLI exits
    // before draining — not logged in, bad model id, usage limit at launch —
    // the stream emits 'error'. Without this listener that is an uncaught
    // exception that takes down the whole server, losing the in-flight run.
    // The try/catch below only ever caught synchronous throws.
    child.stdin.on('error', (err: NodeJS.ErrnoException) => {
      done(() =>
        res.status(502).json({
          error:
            `Codex closed its input before the prompt was sent (${err.code ?? err.message}). ` +
            `The CLI usually exits this early when it is not logged in, the model id is ` +
            `unavailable on your plan, or a usage limit was already reached.`,
        }),
      )
    })

    try {
      child.stdin.write(prompt)
      child.stdin.end()
    } catch (err) {
      done(() =>
        res.status(500).json({ error: `Failed to send prompt to Codex: ${(err as Error).message}` }),
      )
    }
  })

  return router
}

/** Limit detection over the event stream: only ERROR events are matched —
 *  never agent_message text, which is model output and could legitimately
 *  discuss usage limits. */
export function detectCodexUsageLimitInEvents(stdout: string): boolean {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const ev = JSON.parse(line) as CodexEvent
      if (typeof ev !== 'object' || ev === null) continue
      const msg =
        ev.type === 'error'
          ? ev.message
          : ev.type === 'item.completed' && ev.item?.type === 'error'
            ? ev.item.message
            : undefined
      if (msg && detectCodexUsageLimit(msg)) return true
    } catch {
      continue
    }
  }
  return false
}
