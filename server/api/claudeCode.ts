// Claude Code subscription provider — server side.
//
// Shells out to the user's locally-installed `claude` CLI in headless
// ("print") mode so the pipeline can use their OWN Claude Code subscription
// (Pro/Max) as the LLM, with NO API key. The browser can't spawn processes,
// so Express does it — same shape as the local-LLM proxy.
//
// Auth model: the app NEVER handles login. The user runs `claude login`
// themselves; we only invoke their already-authenticated binary. We also
// strip ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN from the child env so the
// CLI always resolves to the SUBSCRIPTION credentials — a stray key in the
// environment otherwise silently takes precedence and bills the API.
//
// Only mounted when the `claude-code-addon` is loaded; never part of the
// default install.

import express, { type Router } from 'express'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { loopbackOnly } from '../lib/loopbackGate.js'

const CLI_COMMAND = 'claude'

/** Model aliases + current full IDs the `--model` flag accepts. Aliases
 *  first so the default ('sonnet') stays stable across model upgrades. */
export const CLAUDE_CODE_MODELS = [
  'sonnet',
  'opus',
  'haiku',
  'claude-opus-4-8',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
]

/** Shell-safe model charset. Validated so the Windows `shell:true` spawn
 *  below stays injection-free (the model is the only req-derived value that
 *  reaches argv; system/prompt go via stdin). */
const MODEL_RE = /^[A-Za-z0-9._-]+$/

/** Neutral, empty working directory for headless CLI runs. Pins the child's
 *  cwd AWAY from the repo root: the chronicle phase is a pure stdin→stdout text
 *  transform that needs no project context, and the prompt is untrusted
 *  transcript text. If a user has pre-approved tools in their own ~/.claude
 *  config, a prompt-injected tool call can't then read/write the project tree
 *  (.git, .env, source) — it only sees this empty sandbox. Defense in depth on
 *  top of the loopback gate + API-key strip. (Explicit tool-deny flags are a
 *  planned follow-up; cwd-pinning is the CLI-version-agnostic blast-radius cap.) */
const CLI_SANDBOX_DIR = path.join(os.tmpdir(), 'tusks-tomes-claude-sandbox')

export type ClaudeCodeStatus = {
  installed: boolean
  version: string | null
  /** Set when the check itself failed (spawn error, timeout, or a process
   *  that could not start). `installed: false` then means "unknown", not
   *  "absent" — see NTSTATUS_FAILURE_FLOOR. */
  probeFailed?: string
  /** Best-effort: a credentials file exists on disk. Advisory only — on
   *  macOS credentials may live in the Keychain with no file, so a `false`
   *  here doesn't necessarily mean "not logged in". The generate route
   *  surfaces a clear "run `claude login`" error if auth actually fails. */
  authenticated: boolean
  models: string[]
}

// Short-lived cache so GET /api/providers (which gates on install status)
// doesn't spawn `claude --version` on every poll.
let statusCache: { value: ClaudeCodeStatus; at: number } | null = null
const STATUS_TTL_MS = 5_000

function credentialsFileExists(): Promise<boolean> {
  const home = os.homedir()
  const candidates = [
    path.join(home, '.claude', '.credentials.json'),
    path.join(home, '.claude', '.credentials'),
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

/** Exit codes at or above 0xC0000000 are NTSTATUS failures — the process
 *  was created but could not start (0xC0000142 STATUS_DLL_INIT_FAILED is
 *  the one seen in practice, from a long-lived parent that has exhausted
 *  Windows desktop heap after thousands of spawns). That is emphatically
 *  NOT "the CLI is absent": it means we could not look. Reporting it as
 *  absent made the UI state, confidently and wrongly, that a working CLI
 *  was not installed. */
const NTSTATUS_FAILURE_FLOOR = 0xc0000000

export type ProbeOutcome =
  | { kind: 'found'; version: string }
  /** Ran, and the command genuinely is not there. */
  | { kind: 'absent' }
  /** Could not run the check at all — say so rather than guessing. */
  | { kind: 'unknown'; reason: string }

/** Spawn `claude --version` with a short timeout to detect the binary. */
function probeVersion(): Promise<ProbeOutcome> {
  return new Promise((resolve) => {
    let out = ''
    let settled = false
    const finish = (v: ProbeOutcome) => {
      if (!settled) {
        settled = true
        resolve(v)
      }
    }
    let child
    try {
      // shell:true on Windows resolves the `claude.cmd` npm shim (bare-name
      // spawn can't find .cmd via PATHEXT otherwise). Safe: argv is the
      // literal '--version' only — no req-derived value.
      // AUDIT: shell:true safe — literal inputs
      child = spawn(CLI_COMMAND, ['--version'], {
        shell: process.platform === 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      return finish({ kind: 'unknown', reason: `spawn threw: ${(err as Error).message}` })
    }
    child.stdout?.on('data', (b: Buffer) => (out += b.toString('utf8')))
    child.on('error', (err) => finish({ kind: 'unknown', reason: err.message }))
    child.on('close', (code) => {
      if (code === 0) return finish({ kind: 'found', version: out.trim() || 'unknown' })
      if (code !== null && code >= NTSTATUS_FAILURE_FLOOR) {
        return finish({
          kind: 'unknown',
          reason: `the check could not start (0x${code.toString(16)}) — restarting Tusk's Tomes usually clears this`,
        })
      }
      return finish({ kind: 'absent' })
    })
    setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      finish({ kind: 'unknown', reason: 'the check timed out' })
    }, 4000)
  })
}

export async function claudeCodeStatus(force = false): Promise<ClaudeCodeStatus> {
  if (!force && statusCache && Date.now() - statusCache.at < STATUS_TTL_MS) {
    return statusCache.value
  }
  const [probe, authenticated] = await Promise.all([probeVersion(), credentialsFileExists()])
  const value: ClaudeCodeStatus = {
    installed: probe.kind === 'found',
    version: probe.kind === 'found' ? probe.version : null,
    // Distinct from installed:false. Consumers that ignore it behave
    // exactly as before; the UI uses it to say "couldn't check".
    probeFailed: probe.kind === 'unknown' ? probe.reason : undefined,
    authenticated,
    models: CLAUDE_CODE_MODELS,
  }
  statusCache = { value, at: Date.now() }
  return value
}

type GenerateBody = { model?: string; prompt?: string; maxOutputTokens?: number }

type ClaudeJsonResult = {
  type?: string
  subtype?: string
  is_error?: boolean
  result?: string
  total_cost_usd?: number
  usage?: { input_tokens?: number; output_tokens?: number }
}

/** Parse the `--output-format json` payload into our provider response shape.
 *  Exported for unit testing. Throws on a malformed or error result. */
export function parseClaudeJson(stdout: string): {
  text: string
  usage: { inputTokens: number; outputTokens: number }
  costUsd?: number
} {
  let parsed: ClaudeJsonResult
  try {
    parsed = JSON.parse(stdout) as ClaudeJsonResult
  } catch {
    throw new Error(
      `Claude Code returned output that wasn't valid JSON. First 300 chars:\n${stdout.slice(0, 300)}`,
    )
  }
  if (parsed.is_error) {
    throw new Error(parsed.result?.trim() || 'Claude Code reported an error with no detail.')
  }
  const text = typeof parsed.result === 'string' ? parsed.result : ''
  return {
    text,
    usage: {
      inputTokens: parsed.usage?.input_tokens ?? 0,
      outputTokens: parsed.usage?.output_tokens ?? 0,
    },
    costUsd: parsed.total_cost_usd,
  }
}

/** Usage-limit detection over the CLI's output.
 *
 *  Why pattern-matching: the CLI has no typed, documented error channel for
 *  subscription exhaustion. What IS documented (docs + issue tracker, verified
 *  2026-08): the `--output-format json` wrapper carries
 *  `{ is_error: true, result: "<human message>", api_error_status: 429 }`,
 *  and the message strings in the wild are "You've hit your limit · resets
 *  3:45pm", "You're out of extra usage…", the 429 rate-limit text, and the
 *  legacy "Claude AI usage limit reached|<epoch>". A machine-readable reset
 *  timestamp is NOT guaranteed in current output — parse the legacy epoch
 *  opportunistically, never rely on it.
 *
 *  Getting this wrong in the strict direction (limit classified as generic
 *  error) is exactly the pre-existing bug: a 5-hour-window expiry pauses the
 *  run as 'error' instead of 'quota', and the Resume banner tells the user
 *  something failed rather than that they're waiting on a reset. The loose
 *  direction (transient 429 classified as limit) costs one unnecessary
 *  pause that a single click resumes — so patterns lean inclusive. */
const USAGE_LIMIT_PATTERNS = [
  /you've hit your (usage )?limit/i,
  /you're out of extra usage/i,
  /usage limit reached/i,
  /rate.?limit(_error| reached|ed)?/i,
  /exceed your account'?s rate limit/i,
  /resource_exhausted/i,
]

/** Legacy CLI shape: "Claude AI usage limit reached|1754500000" (epoch s or ms). */
const LEGACY_RESET_EPOCH_RE = /limit reached\|(\d{10,13})/i

export type UsageLimitDetection = {
  limited: boolean
  /** ISO timestamp when the window resets, when the CLI included a
   *  machine-readable epoch. Usually absent on current CLI versions. */
  resetsAt: string | null
}

/** Detect a subscription usage-limit / rate-limit signal in any CLI output
 *  (stdout JSON `result` text, stderr, or a parse-error message). Exported
 *  for unit testing. */
export function detectUsageLimit(raw: string): UsageLimitDetection {
  if (!raw) return { limited: false, resetsAt: null }
  // Structured path: when the input is the CLI's JSON wrapper, only the
  // error message is a trustworthy signal. Pattern-matching the whole
  // payload would false-positive on GENERATED content that happens to
  // mention limits (the `result` field of a successful call is model
  // output). A non-error JSON wrapper is therefore never "limited".
  try {
    const parsed = JSON.parse(raw) as ClaudeJsonResult & { api_error_status?: number }
    if (typeof parsed === 'object' && parsed !== null) {
      if (!parsed.is_error) return { limited: false, resetsAt: null }
      const msg = parsed.result ?? ''
      if (parsed.api_error_status === 429) {
        return { limited: true, resetsAt: epochFrom(msg) }
      }
      const limited = USAGE_LIMIT_PATTERNS.some((re) => re.test(msg))
      return { limited, resetsAt: limited ? epochFrom(msg) : null }
    }
  } catch {
    /* not JSON — fall through to text patterns */
  }
  const limited = USAGE_LIMIT_PATTERNS.some((re) => re.test(raw))
  return { limited, resetsAt: limited ? epochFrom(raw) : null }
}

function epochFrom(text: string): string | null {
  const m = LEGACY_RESET_EPOCH_RE.exec(text)
  if (!m) return null
  const n = Number(m[1])
  const ms = m[1].length === 13 ? n : n * 1000
  const d = new Date(ms)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/** Build the child env with subscription-overriding keys stripped. Exported
 *  for unit testing the strip invariant. */
export function childEnvWithoutApiKeys(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Case-INSENSITIVE removal. Windows treats environment variable names
  // case-insensitively, but the spread above produces a plain JS object
  // where `delete next.FOO` is case-sensitive — so a variable set as
  // `openai_api_key` would survive the strip while the child still
  // resolved it, silently switching the user onto per-token billing on
  // the platform this app primarily targets.
  const STRIP = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'].map((k) => k.toLowerCase()))
  const next: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (!STRIP.has(key.toLowerCase())) next[key] = value
  }
  return next
}

export function claudeCodeRouter(): Router {
  const router = express.Router()

  router.get('/status', async (_req, res) => {
    try {
      res.json(await claudeCodeStatus())
    } catch (err) {
      console.error('[claude-code/status] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // loopback-only: this spawns a process on the HOST machine. LAN visitors
  // must not be able to trigger process creation; the host's own browser
  // hits 127.0.0.1 and passes.
  router.post('/generate', loopbackOnly(), async (req, res) => {
    const { model, prompt } = (req.body ?? {}) as GenerateBody
    const chosenModel = (model || 'sonnet').trim()
    if (!MODEL_RE.test(chosenModel)) {
      return res.status(400).json({ error: `Invalid model id: ${chosenModel}` })
    }
    if (typeof prompt !== 'string' || !prompt.trim()) {
      return res.status(400).json({ error: 'Missing prompt in request body.' })
    }

    // argv contains only literals + the validated model — no untrusted text.
    // The composed prompt (system + cacheable + user) goes via stdin, so it
    // never touches the shell even under shell:true on Windows.
    //
    // KNOWN TRADEOFF: we deliberately do NOT pass `--system-prompt` (which
    // would replace the CLI's default coding-agent system prompt). Doing so
    // would mean putting the arbitrary app system prompt on argv, which is a
    // shell-injection risk under the Windows shell:true path. The cost is
    // that each call carries the CLI's default system-prompt overhead and a
    // coding-agent priming the chronicle phase doesn't need. The app's own
    // instructions ride in the stdin prompt and dominate, but if chronicle
    // voice ever degrades, the fix is a shell:false + resolved-binary path
    // that lets us pass `--system-prompt` safely cross-platform.
    // AUDIT: shell:true safe — literal inputs (model validated by MODEL_RE)
    const args = ['-p', '--output-format', 'json', '--model', chosenModel]

    // Run in a neutral sandbox dir, not the repo root (see CLI_SANDBOX_DIR).
    // Best-effort: if temp isn't writable, fall back to the default cwd rather
    // than failing the run.
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
        env: childEnvWithoutApiKeys(process.env),
        cwd: sandboxCwd,
      })
    } catch (err) {
      return res.status(500).json({
        error: `Couldn't launch the Claude Code CLI: ${(err as Error).message}. Make sure "claude" is on your PATH.`,
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

    // Kill the child only on a GENUINE client abort (pipeline cancel /
    // navigation). Listen on `res` 'close', not `req` 'close' — the latter
    // fires the instant express.json() finishes consuming the request body
    // (~0ms), which would kill the CLI before it produces any output. A real
    // abort fires `res` 'close' with writableEnded still false.
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
          ? 'Claude Code CLI not found. Install it and run `claude login` with your Pro/Max plan.'
          : `Claude Code CLI error: ${err.message}`
      done(() => res.status(500).json({ error: msg }))
    })

    child.on('close', (code, signal) => {
      done(() => {
        // Usage-limit check runs on BOTH failure paths (non-zero exit, and
        // exit 0 with is_error JSON) — versions differ on which one a limit
        // hit takes. A typed 429 lets the client provider mark the error as
        // quota exhaustion so the pipeline pauses as 'quota', not 'error'.
        const fromStdout = detectUsageLimit(stdout)
        const limitSignal = fromStdout.limited ? fromStdout : detectUsageLimit(stderr)
        if (code !== 0) {
          const detail =
            stderr.trim() ||
            stdout.trim() ||
            (signal ? `terminated by signal ${signal}` : `exit code ${code}`)
          if (limitSignal.limited) {
            return res.status(429).json({
              error: `Claude Code usage limit reached: ${detail.slice(0, 300)}`,
              code: 'usage_limit',
              resetsAt: limitSignal.resetsAt,
            })
          }
          return res.status(502).json({
            error: `Claude Code CLI failed: ${detail.slice(0, 600)}`,
          })
        }
        try {
          const parsed = parseClaudeJson(stdout)
          res.json(parsed)
        } catch (err) {
          const msg = (err as Error).message
          if (limitSignal.limited || detectUsageLimit(msg).limited) {
            return res.status(429).json({
              error: `Claude Code usage limit reached: ${msg.slice(0, 300)}`,
              code: 'usage_limit',
              resetsAt: limitSignal.resetsAt ?? detectUsageLimit(msg).resetsAt,
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
            `Claude Code closed its input before the prompt was sent (${err.code ?? err.message}). ` +
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
        res.status(500).json({ error: `Failed to send prompt to Claude Code: ${(err as Error).message}` }),
      )
    }
  })

  return router
}
