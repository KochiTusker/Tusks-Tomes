// Shared plumbing for the characterisation ("golden") tests. These tests
// pin what the HTTP layer does TODAY; nothing in here decides what it
// should do. See server/platform/api.golden.test.ts and server/features/providers/routes/cli.golden.test.ts.

import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { repoRoot } from '../../platform/repoRoot.js'
import { promises as fs } from 'node:fs'
import type { AddressInfo } from 'node:net'

// ---------------------------------------------------------------------------
// Temp-dir isolation
// ---------------------------------------------------------------------------

const REPO_ROOT = repoRoot()

export type Sandbox = {
  root: string
  /** Restores every env var the sandbox touched and deletes the temp tree. */
  restore: () => Promise<void>
  paths: {
    roaming: string
    local: string
    home: string
    ostmp: string
    sessions: string
    lore: string
    vault: string
  }
}

const SANDBOX_ENV_KEYS = [
  'APPDATA',
  'LOCALAPPDATA',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'HOME',
  'USERPROFILE',
  'TMP',
  'TEMP',
  'TMPDIR',
  'TUSKS_SESSIONS_DIR',
  'TUSKS_LORE_DIR',
  'TUSKS_VAULT_DIR',
  'TUSKS_HOST',
  'TUSKS_LAN_WRITES',
  'PAID_GEMINI_API_KEY',
  'VITE_GEMINI_API_KEY',
  'OPENROUTER_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
  'FFMPEG_PATH',
] as const

/** Point every directory the server resolves at a fresh temp tree and strip
 *  every credential-bearing variable from the environment. Must run BEFORE the
 *  server modules are imported: env-paths reads its variables once, at import. */
export async function createSandbox(prefix = 'tt-golden-'): Promise<Sandbox> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)))
  const saved = new Map<string, string | undefined>()
  for (const k of SANDBOX_ENV_KEYS) saved.set(k, process.env[k])

  const paths = {
    roaming: path.join(root, 'roaming'),
    local: path.join(root, 'local'),
    home: path.join(root, 'home'),
    ostmp: path.join(root, 'ostmp'),
    sessions: path.join(root, 'sessions'),
    lore: path.join(root, 'lore'),
    vault: path.join(root, 'vault'),
  }
  for (const d of Object.values(paths)) await fs.mkdir(d, { recursive: true })

  for (const k of SANDBOX_ENV_KEYS) delete process.env[k]
  process.env.APPDATA = paths.roaming
  process.env.LOCALAPPDATA = paths.local
  process.env.XDG_CONFIG_HOME = path.join(paths.home, '.config')
  process.env.XDG_DATA_HOME = path.join(paths.home, '.local', 'share')
  process.env.XDG_CACHE_HOME = path.join(paths.home, '.cache')
  process.env.HOME = paths.home
  process.env.USERPROFILE = paths.home
  process.env.TMP = paths.ostmp
  process.env.TEMP = paths.ostmp
  process.env.TMPDIR = paths.ostmp
  process.env.TUSKS_SESSIONS_DIR = paths.sessions
  process.env.TUSKS_LORE_DIR = paths.lore
  process.env.TUSKS_VAULT_DIR = paths.vault
  // Fixed so the ffmpeg lookup at import time cannot vary by machine.
  process.env.FFMPEG_PATH = path.join(paths.ostmp, 'ffmpeg-placeholder')

  return {
    root,
    paths,
    restore: async () => {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      // allowlist:dangerous-fs-rm
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

const ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const MASKED_KEYS = new Set(['uptimeMs', 'serverNow', 'ts'])

function pathVariants(p: string): string[] {
  const fwd = p.split('\\').join('/')
  const back = p.split('/').join('\\')
  return Array.from(new Set([p, fwd, back]))
}

export function makeNormaliser(
  root: string,
  extra: Array<[string, string]> = [],
  opts: { maskIso?: boolean; digestOver?: number } = {},
) {
  const digestOver = opts.digestOver ?? 0
  const maskIso = opts.maskIso !== false
  const replacements: Array<[string, string]> = [[root, '<TMP>'], [REPO_ROOT, '<REPO>'], ...extra]
  const expanded: Array<[string, string]> = []
  for (const [from, to] of replacements) for (const v of pathVariants(from)) expanded.push([v, to])
  expanded.sort((a, b) => b[0].length - a[0].length)

  const str = (s: string): string => {
    let out = s
    let touched = false
    for (const [from, to] of expanded) {
      if (out.includes(from)) {
        out = out.split(from).join(to)
        touched = true
      }
    }
    if (touched) out = out.split('\\').join('/')
    out = (maskIso ? out.replace(ISO_RE, '<ISO>') : out).replace(UUID_RE, '<UUID>')
    if (digestOver > 0 && out.length > digestOver) {
      // Long prose (seed prompts, templates) is pinned by length + hash so the
      // snapshot stays reviewable while any change still fails the test.
      const sha = createHash('sha256').update(out).digest('hex').slice(0, 12)
      return `<text len=${out.length} sha256=${sha} head=${JSON.stringify(out.slice(0, 60))}>`
    }
    return out
  }
  /** Replace a run-specific value (a generated id) with a stable token. */
  const alias = (value: string, token: string): void => {
    if (!value) return
    for (const v of pathVariants(value)) expanded.push([v, token])
    expanded.sort((a, b) => b[0].length - a[0].length)
  }
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return str(v)
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const k of Object.keys(v as object).sort()) {
        const val = (v as Record<string, unknown>)[k]
        out[k] = MASKED_KEYS.has(k) && typeof val === 'number' ? '<N>' : walk(val)
      }
      return out
    }
    return v
  }
  return { str, walk, alias }
}

// ---------------------------------------------------------------------------
// HTTP client (node:http — global fetch is stubbed in the tests)
// ---------------------------------------------------------------------------

export type Reply = {
  status: number
  contentType: string | null
  headers: Record<string, string | string[] | undefined>
  raw: Buffer
  text: string
  json: unknown | undefined
}

export type RequestOpts = {
  json?: unknown
  rawBody?: string | Buffer
  contentType?: string
  headers?: Record<string, string>
  port: number
  hostHeader: string
  method: string
  path: string
  /** Abort the client side as soon as this returns true (polled every 5 ms). */
  abortWhen?: () => boolean
}

export function httpRequest(o: RequestOpts): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: o.hostHeader, ...(o.headers ?? {}) }
    let body: Buffer | undefined
    if (o.json !== undefined) {
      body = Buffer.from(JSON.stringify(o.json), 'utf8')
      headers['Content-Type'] = 'application/json'
    } else if (o.rawBody !== undefined) {
      body = Buffer.isBuffer(o.rawBody) ? o.rawBody : Buffer.from(o.rawBody, 'utf8')
      headers['Content-Type'] = o.contentType ?? 'text/plain'
    }
    if (body) headers['Content-Length'] = String(body.length)
    const req = http.request(
      { hostname: '127.0.0.1', port: o.port, method: o.method, path: o.path, headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const raw = Buffer.concat(chunks)
          const text = raw.toString('utf8')
          const ct = (res.headers['content-type'] as string | undefined) ?? null
          let json: unknown
          if (ct && ct.includes('application/json')) {
            try {
              json = JSON.parse(text)
            } catch {
              json = undefined
            }
          }
          resolve({ status: res.statusCode ?? 0, contentType: ct, headers: res.headers, raw, text, json })
        })
      },
    )
    req.on('error', (err) => {
      if (o.abortWhen) {
        resolve({ status: 0, contentType: null, headers: {}, raw: Buffer.alloc(0), text: '', json: undefined })
      } else {
        reject(err)
      }
    })
    if (o.abortWhen) {
      const poll = setInterval(() => {
        if (o.abortWhen!()) {
          clearInterval(poll)
          req.destroy()
        }
      }, 5)
    }
    if (body) req.write(body)
    req.end()
  })
}

export function multipartBody(
  field: string,
  filename: string,
  content: string,
  contentType = 'text/markdown',
): { body: Buffer; contentType: string } {
  const boundary = '----ttGoldenBoundary7d3'
  const body = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n` +
      `${content}\r\n--${boundary}--\r\n`,
    'utf8',
  )
  return { body, contentType: `multipart/form-data; boundary=${boundary}` }
}

export async function listen(handler: http.RequestListener): Promise<{
  port: number
  close: () => Promise<void>
}> {
  const server = http.createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}

// ---------------------------------------------------------------------------
// child_process.spawn capture (state on globalThis so it survives
// vi.resetModules(), which re-runs the vi.doMock factory)
// ---------------------------------------------------------------------------

export type SpawnOutcome = {
  code?: number | null
  stdout?: string
  stderr?: string
  /** Fire the lifecycle after this many ms instead of on the next microtask. */
  delayMs?: number
  /** Emit 'error' on the child (spawn failure). */
  emitError?: Error
  /** Emit 'error' on the child's stdin (CLI exited before draining). */
  stdinError?: Error
  /** Never emit anything (used to simulate a hung process). */
  hang?: boolean
}

export type SpawnRecord = {
  command: string
  args: string[]
  options: {
    shell?: unknown
    cwd?: string
    env?: Record<string, string | undefined>
    stdio?: unknown
    detached?: unknown
  }
  stdin: string
  stdinEnded: boolean
  killed: boolean
}

type SpawnState = {
  records: SpawnRecord[]
  handlers: Map<string, (rec: SpawnRecord) => SpawnOutcome>
}

const GKEY = '__ttGoldenSpawnState'
function state(): SpawnState {
  const g = globalThis as unknown as Record<string, SpawnState | undefined>
  if (!g[GKEY]) g[GKEY] = { records: [], handlers: new Map() }
  return g[GKEY]!
}

export const spawnCapture = {
  reset(): void {
    state().records.length = 0
    state().handlers.clear()
  },
  when(command: string, handler: (rec: SpawnRecord) => SpawnOutcome): void {
    state().handlers.set(command, handler)
  },
  records(): SpawnRecord[] {
    return state().records.slice()
  },
}

function makeChild(rec: SpawnRecord, outcome: SpawnOutcome) {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  const stdin = new EventEmitter() as EventEmitter & {
    write: (c: unknown) => boolean
    end: () => void
  }
  stdin.write = (c: unknown) => {
    rec.stdin += typeof c === 'string' ? c : Buffer.from(c as Uint8Array).toString('utf8')
    return true
  }
  stdin.end = () => {
    rec.stdinEnded = true
  }
  child.stdout = stdout
  child.stderr = stderr
  child.stdin = stdin
  child.pid = 4242
  child.unref = () => undefined
  child.kill = () => {
    rec.killed = true
    return true
  }
  const fire = () => {
    if (rec.killed || outcome.hang) return
    if (outcome.emitError) {
      child.emit('error', outcome.emitError)
      return
    }
    if (outcome.stdinError) {
      stdin.emit('error', outcome.stdinError)
      return
    }
    if (outcome.stdout) stdout.emit('data', Buffer.from(outcome.stdout))
    if (outcome.stderr) stderr.emit('data', Buffer.from(outcome.stderr))
    const code = outcome.code === undefined ? 0 : outcome.code
    child.emit('close', code, null)
    child.emit('exit', code, null)
  }
  if (outcome.delayMs && outcome.delayMs > 0) setTimeout(fire, outcome.delayMs)
  else queueMicrotask(fire)
  return child
}

function fakeSpawn(command: string, args: readonly string[] = [], options: Record<string, unknown> = {}) {
  const rec: SpawnRecord = {
    command,
    args: [...args],
    options: {
      shell: options.shell,
      cwd: options.cwd as string | undefined,
      env: options.env as Record<string, string | undefined> | undefined,
      stdio: options.stdio,
      detached: options.detached,
    },
    stdin: '',
    stdinEnded: false,
    killed: false,
  }
  state().records.push(rec)
  const handler = state().handlers.get(command)
  return makeChild(rec, handler ? handler(rec) : { code: 0 })
}

/** Factory for `vi.doMock('node:child_process', () => childProcessMock())`. */
export function childProcessMock() {
  const spawn = fakeSpawn
  const spawnSync = (command: string) => {
    state().records.push({
      command,
      args: [],
      options: {},
      stdin: '',
      stdinEnded: false,
      killed: false,
    })
    return { pid: 4242, status: 0, stdout: Buffer.from(''), stderr: Buffer.from(''), signal: null, output: [] }
  }
  return { spawn, spawnSync, default: { spawn, spawnSync } }
}
