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

import express, { type Express, type Router } from 'express'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { loopbackOnly } from '../../../platform/loopbackGate.js'
import { claudeCodeModelsFrom } from '../services/claudeCodeModels.js'
import { readCachedCatalogue } from '../services/openrouterCatalogue.js'
import { asyncRoute } from '../../../platform/asyncRoute.js'
import {
  anyFileExists,
  createStatusCache,
  ensureSandboxDir,
  probeCliVersion,
  sendPromptToCli,
  stripEnvKeys,
  superviseCliChild,
  type ProbeOutcome,
} from '../../../platform/cliSubscription.js'

const CLI_COMMAND = 'claude'


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
   *  "absent" (see platform/cliSubscription). */
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
const cachedStatus = createStatusCache<ClaudeCodeStatus>()

function credentialsFileExists(): Promise<boolean> {
  const home = os.homedir()
  return anyFileExists([
    path.join(home, '.claude', '.credentials.json'),
    path.join(home, '.claude', '.credentials'),
  ])
}

/** `claude --version`; an empty version still counts as found, as 'unknown'. */
function probeVersion(): Promise<ProbeOutcome> {
  return probeCliVersion(CLI_COMMAND, (code, out) => (code === 0 ? out.trim() || 'unknown' : null))
}

export function claudeCodeStatus(force = false): Promise<ClaudeCodeStatus> {
  return cachedStatus(force, async () => {
    const [probe, authenticated, catalogue] = await Promise.all([
      probeVersion(),
      credentialsFileExists(),
      readCachedCatalogue().catch(() => null),
    ])
    return {
      installed: probe.kind === 'found',
      version: probe.kind === 'found' ? probe.version : null,
      // Distinct from installed:false. Consumers that ignore it behave
      // exactly as before; the UI uses it to say "couldn't check".
      probeFailed: probe.kind === 'unknown' ? probe.reason : undefined,
      authenticated,
      models: claudeCodeModelsFrom(catalogue),
    }
  })
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

/** The CLI's context-overflow signal.
 *
 *  Worth separating from the generic failure path because the two need
 *  opposite responses from the user: a CLI failure is something to retry or
 *  re-authenticate, and this is something that will fail identically every
 *  time until less is sent. Undiagnosed, it reaches the user as several
 *  hundred bytes of truncated JSON whose one informative field —
 *  `terminal_reason` — is usually past the truncation point.
 *
 *  Matched on both the structured `terminal_reason` and the prose forms the
 *  API returns, since which one surfaces depends on CLI version. */
const PROMPT_TOO_LONG_PATTERNS = [
  /"terminal_reason"\s*:\s*"prompt_too_long"/i,
  /prompt is too long/i,
  /input length and `max_tokens` exceed context limit/i,
  /exceeds? the maximum (allowed )?(number of )?(input )?tokens/i,
]

export function isPromptTooLong(raw: string): boolean {
  if (!raw) return false
  return PROMPT_TOO_LONG_PATTERNS.some((re) => re.test(raw))
}

/** Say what was sent, and what to do about it. The character count is the
 *  only figure we can state without guessing at a tokenizer, and it is
 *  enough to make the scale of the problem obvious. */
export function promptTooLongMessage(promptChars: number, model: string): string {
  const approxTokens = Math.round(promptChars / 4)
  return [
    `The prompt was too long for ${model}: ${promptChars.toLocaleString()} characters (roughly ${approxTokens.toLocaleString()} tokens), which is past the model's context window.`,
    '',
    'This is almost always the Knowledge Base rather than the transcript — a',
    'large lore vault is sent with every chunk. In Settings → Pipeline tuning,',
    'turn on "Trim lore to what the session references" to send only the notes',
    'the session actually mentions.',
  ].join('\n')
}

/** The CLI's own error message, when stdout is its JSON wrapper. The wrapper
 *  is ~600 characters of usage counters with the one line that matters,
 *  `result`, near the end — so truncating the raw payload cuts off exactly
 *  what the user needs. Adds the fix for the failure that needs one: an
 *  expired sign-in, which no retry will clear. Exported for unit testing. */
export function cliErrorMessage(stdout: string): string | null {
  let parsed: ClaudeJsonResult & { terminal_reason?: string }
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.is_error) return null
  const msg = typeof parsed.result === 'string' ? parsed.result.trim() : ''
  if (!msg) return parsed.terminal_reason ? `the CLI stopped with "${parsed.terminal_reason}" and no message.` : null
  if (/authenticat|oauth|log ?in|credentials/i.test(msg)) {
    return `${msg}. Run \`claude\` in a terminal and sign in again (/login), then resume the run.`
  }
  return msg.slice(0, 600)
}

/** Build the child env with subscription-overriding keys stripped. Exported
 *  for unit testing the strip invariant. */
export function childEnvWithoutApiKeys(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return stripEnvKeys(env, ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'])
}

export function claudeCodeRouter(): Router {
  const router = express.Router()

  router.get('/status', asyncRoute('claude-code/status', async (_req, res) => {
    res.json(await claudeCodeStatus())
  }))

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
    const sandboxCwd = await ensureSandboxDir(CLI_SANDBOX_DIR)

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

    const { done, stdout: getStdout, stderr: getStderr } = superviseCliChild(res, child, {
      errorLabel: 'Claude Code CLI',
      notFound: 'Claude Code CLI not found. Install it and run `claude login` with your Pro/Max plan.',
    })

    child.on('close', (code, signal) => {
      done(() => {
        const stdout = getStdout()
        const stderr = getStderr()
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
          if (isPromptTooLong(stdout) || isPromptTooLong(stderr)) {
            return res.status(413).json({
              error: promptTooLongMessage(prompt.length, chosenModel),
              code: 'prompt_too_long',
            })
          }
          return res.status(502).json({
            error: `Claude Code CLI failed: ${cliErrorMessage(stdout) ?? detail.slice(0, 600)}`,
          })
        }
        try {
          const parsed = parseClaudeJson(stdout)
          res.json(parsed)
        } catch (err) {
          const msg = (err as Error).message
          if (isPromptTooLong(stdout) || isPromptTooLong(msg)) {
            return res.status(413).json({
              error: promptTooLongMessage(prompt.length, chosenModel),
              code: 'prompt_too_long',
            })
          }
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

    sendPromptToCli(res, child, prompt, done, 'Claude Code')
  })

  return router
}

let mounted = false

/** Mounts the Claude Code routes. */
export function registerClaudeCodeRoutes(app: Express): void {
  app.use('/api/claude-code', claudeCodeRouter())
  mounted = true
}

/** Whether the Claude Code routes are mounted in this process, which is true
 *  once start-up has registered them and stays false if it skipped them. */
export function isClaudeCodeMounted(): boolean {
  return mounted
}
