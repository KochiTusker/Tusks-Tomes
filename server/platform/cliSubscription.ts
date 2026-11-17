import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { promises as fs } from 'node:fs'
import type { Readable, Writable } from 'node:stream'
import type { Response } from 'express'

/**
 * The plumbing the subscription CLIs (Claude Code, Codex) share. What stays in
 * each CLI's own module is everything that is about that CLI: its arguments,
 * how its output is parsed, how a usage limit and an over-long prompt are
 * recognised, the exit-code to status mapping, the Windows `shell` spawn and its
 * quoting, and the model list.
 */

/** Exit codes at or above 0xC0000000 are NTSTATUS failures: the process was
 *  created but could not start (0xC0000142 STATUS_DLL_INIT_FAILED is the one
 *  seen in practice, from a long-lived parent that has exhausted Windows
 *  desktop heap after thousands of spawns). That is emphatically NOT "the CLI
 *  is absent": it means we could not look. Reporting it as absent made the UI
 *  state, confidently and wrongly, that a working CLI was not installed. */
const NTSTATUS_FAILURE_FLOOR = 0xc0000000

export type ProbeOutcome =
  | { kind: 'found'; version: string }
  /** Ran, and the command genuinely is not there. */
  | { kind: 'absent' }
  /** Could not run the check at all, so say so rather than guessing. */
  | { kind: 'unknown'; reason: string }

/**
 * Run `<command> --version` with a four-second limit to detect the binary.
 * `versionFrom` is each CLI's own rule for "found": it gets the exit code and
 * stdout and returns the version, or null when the run does not count as a
 * find (Claude accepts an empty version as 'unknown'; Codex requires one).
 */
export function probeCliVersion(
  command: string,
  versionFrom: (code: number | null, stdout: string) => string | null,
): Promise<ProbeOutcome> {
  return new Promise((resolve) => {
    let out = ''
    let settled = false
    const finish = (v: ProbeOutcome) => {
      if (!settled) {
        settled = true
        resolve(v)
      }
    }
    let child: ReturnType<typeof spawn>
    try {
      // shell on Windows resolves the `<command>.cmd` npm shim (a bare-name
      // spawn can't find .cmd via PATHEXT otherwise). Safe: `command` is a
      // literal from the two callers and argv is the literal '--version'; no
      // request-derived value reaches either.
      child = spawn(command, ['--version'], {
        shell: process.platform === 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      return finish({ kind: 'unknown', reason: `spawn threw: ${(err as Error).message}` })
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      finish({ kind: 'unknown', reason: 'the check timed out' })
    }, 4000)
    child.stdout?.on('data', (b: Buffer) => (out += b.toString('utf8')))
    child.on('error', (err) => {
      clearTimeout(timer)
      finish({ kind: 'unknown', reason: err.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const version = versionFrom(code, out)
      if (version !== null) return finish({ kind: 'found', version })
      if (code !== null && code >= NTSTATUS_FAILURE_FLOOR) {
        return finish({
          kind: 'unknown',
          reason: `the check could not start (0x${code.toString(16)}) — restarting Tusk's Tomes usually clears this`,
        })
      }
      return finish({ kind: 'absent' })
    })
  })
}

/** Whether any of the given credential files exists. Existence only: the files
 *  hold live credentials and this process has no business reading them. */
export function anyFileExists(candidates: string[]): Promise<boolean> {
  return Promise.all(
    candidates.map((p) =>
      fs
        .access(p)
        .then(() => true)
        .catch(() => false),
    ),
  ).then((results) => results.some(Boolean))
}

/** Copy of `env` without the named variables, matched case-INSENSITIVELY.
 *  Windows treats environment variable names case-insensitively, but a plain JS
 *  object makes `delete next.FOO` case-sensitive, so a variable set as
 *  `openai_api_key` would survive a case-sensitive strip while the child still
 *  resolved it, silently switching the user onto per-token billing on the
 *  platform this app primarily targets. */
export function stripEnvKeys(env: NodeJS.ProcessEnv, keys: readonly string[]): NodeJS.ProcessEnv {
  const strip = new Set(keys.map((k) => k.toLowerCase()))
  const next: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (!strip.has(key.toLowerCase())) next[key] = value
  }
  return next
}

/** A short-lived cache for a status probe, so a route polled by the UI doesn't
 *  spawn the CLI on every request. `force` skips the cached value. */
export function createStatusCache<T>(ttlMs = 5_000): (force: boolean, compute: () => Promise<T>) => Promise<T> {
  let entry: { value: T; at: number } | null = null
  return async (force, compute) => {
    if (!force && entry && Date.now() - entry.at < ttlMs) return entry.value
    const value = await compute()
    entry = { value, at: Date.now() }
    return value
  }
}

/** Create the neutral working directory for a headless run. Best-effort: when
 *  temp isn't writable it resolves undefined, so the run falls back to the
 *  default cwd rather than failing. */
export async function ensureSandboxDir(dir: string): Promise<string | undefined> {
  try {
    await fs.mkdir(dir, { recursive: true })
    return dir
  } catch {
    return undefined
  }
}

export type CliChild = ChildProcessByStdio<Writable, Readable, Readable>

export interface CliSupervisor {
  /** Runs `fn` at most once across every path that can end the request. */
  done: (fn: () => void) => void
  stdout: () => string
  stderr: () => string
}

/**
 * Collect a CLI child's output and make sure exactly one path answers the
 * request. The child is killed only on a GENUINE client abort (pipeline cancel
 * or navigation). It listens on `res` 'close', not `req` 'close', because the
 * latter fires the instant express.json() finishes consuming the request body
 * (about 0ms), which would kill the CLI before it produced any output. A real
 * abort fires `res` 'close' with writableEnded still false.
 *
 * A spawn failure answers 500: `notFound` for a missing binary, otherwise
 * `<errorLabel> error: <message>`.
 */
export function superviseCliChild(
  res: Response,
  child: CliChild,
  opts: { errorLabel: string; notFound: string },
): CliSupervisor {
  let stdout = ''
  let stderr = ''
  let settled = false
  const done = (fn: () => void) => {
    if (!settled) {
      settled = true
      fn()
    }
  }

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
        ? opts.notFound
        : `${opts.errorLabel} error: ${err.message}`
    done(() => res.status(500).json({ error: msg }))
  })

  return { done, stdout: () => stdout, stderr: () => stderr }
}

/**
 * Send the prompt to the child over stdin, so it never touches the shell even
 * under the Windows `shell` spawn. `label` names the CLI in the two failure
 * answers.
 *
 * stdin.write() on a prompt this size (transcript chunks are tens to hundreds
 * of KB) buffers and flushes ASYNCHRONOUSLY. If the CLI exits before draining
 * (not logged in, bad model id, usage limit at launch) the stream emits
 * 'error'. Without the listener that is an uncaught exception that takes down
 * the whole server, losing the in-flight run. The try/catch only ever catches
 * synchronous throws.
 */
export function sendPromptToCli(
  res: Response,
  child: CliChild,
  prompt: string,
  done: CliSupervisor['done'],
  label: string,
): void {
  child.stdin.on('error', (err: NodeJS.ErrnoException) => {
    done(() =>
      res.status(502).json({
        error:
          `${label} closed its input before the prompt was sent (${err.code ?? err.message}). ` +
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
      res.status(500).json({ error: `Failed to send prompt to ${label}: ${(err as Error).message}` }),
    )
  }
}
