// Server-side ring buffer + pretty-printer + opt-in file writer for the
// deep diagnostic log. Merges browser-forwarded events (via
// /api/diagnostics/log) and server-side `slog()` calls into a single
// chronological stream so the user can see the full pipeline timeline in
// one place — terminal stdout for live observation, JSON Lines on disk
// for grep/jq forensics, and `GET /api/diagnostics/recent` for the UI.
//
// Per-user scope choices (locked in the plan):
//   - Pretty colored text in terminal (no `chalk` dep; ANSI escapes inline).
//   - JSON Lines on disk: one `{ts, source, cat, payload}` object per line.
//   - Persistence is on-toggle from the Diagnostics card; file appends until
//     the user clicks "Clear log file". No automatic rotation.

import { createWriteStream, type WriteStream } from 'node:fs'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { configDir, ensureDir, readJson, writeJson } from '../appData.js'

const RING_SIZE = 500

/** Category labels mirror the browser-side `LogCategory` in src/lib/verboseLog.ts
 *  PLUS the server-specific `'server'` category for slog() calls and
 *  `'chunk'` for per-chunk pipeline timing (added in Phase 3). Untyped
 *  string is accepted so forward-compat: a new browser category lands here
 *  without a server-side schema bump. */
export type LogSource = 'browser' | 'server'

export type DiagnosticEntry = {
  /** ms since epoch */
  ts: number
  source: LogSource
  cat: string
  payload: unknown
}

export type DiagnosticsConfig = {
  terminal: boolean
  file: boolean
}

// Lazy path getters — configDir() is mockable in tests, and we want the
// override to take effect even when this module is imported before the
// test's vi.mock(). Computing the path on every call costs nothing (it's
// just a join).
function configPath(): string {
  return path.join(configDir(), 'diagnostics-config.json')
}
function logPath(): string {
  return path.join(configDir(), 'diagnostics.log')
}

/** In-memory ring. New entries push; oldest dropped when full. */
let ring: DiagnosticEntry[] = []

/** Output toggles. Initialised from disk on first ingest; mutated via
 *  setForwarding() (which persists). */
let config: DiagnosticsConfig | null = null
let configLoaded = false

/** Lazy write stream for the JSON Lines file. Opened on first write when
 *  `config.file === true`; closed when toggle flips off or on shutdown. */
let fileStream: WriteStream | null = null

/** ANSI escape helpers — keeps this module dependency-free (no chalk). */
const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  // Foreground colors.
  gray: '\x1b[90m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  brightCyan: '\x1b[96m',
  brightYellow: '\x1b[93m',
  brightRed: '\x1b[91m',
} as const

const CATEGORY_COLOR: Record<string, string> = {
  pipeline: ANSI.cyan,
  provider: ANSI.magenta,
  gemini: ANSI.blue,
  sessions: ANSI.yellow,
  routing: ANSI.green,
  refresh: ANSI.brightCyan,
  fallback: ANSI.brightRed,
  cache: ANSI.gray,
  resume: ANSI.brightYellow,
  chunk: ANSI.cyan,
  server: ANSI.white,
  http: ANSI.gray,
}

const PAYLOAD_PREVIEW_LIMIT = 200

/** Read the persisted config from disk on first use; defaults to both off
 *  so a fresh install never spams stdout or writes the file. */
async function loadConfig(): Promise<DiagnosticsConfig> {
  if (config) return config
  config = await readJson<DiagnosticsConfig>(configPath(), { terminal: false, file: false })
  configLoaded = true
  return config
}

/** Pretty-print one entry to a single line of colored text. Used for the
 *  terminal stdout stream. Falls back gracefully on unknown categories. */
export function formatPretty(entry: DiagnosticEntry): string {
  const tsStr = new Date(entry.ts).toISOString().slice(11, 23) // HH:mm:ss.SSS
  const catColor = CATEGORY_COLOR[entry.cat] ?? ANSI.white
  const sourcePrefix = entry.source === 'browser' ? '' : ` ${ANSI.dim}(server)${ANSI.reset}`
  const tag = `${catColor}${ANSI.bold}[tusk:${entry.cat}]${ANSI.reset}`
  const payloadStr = flattenPayload(entry.payload)
  return `${ANSI.gray}[${tsStr}]${ANSI.reset} ${tag}${sourcePrefix} ${payloadStr}`
}

/** Flatten an arbitrary payload to a compact `key=value key.nested=value`
 *  string. Long strings get truncated to PAYLOAD_PREVIEW_LIMIT chars with a
 *  `…` suffix so the terminal stays readable. The full JSON is what lands
 *  in the file via formatJsonLine — terminal trades fidelity for scanability. */
export function flattenPayload(payload: unknown, prefix = ''): string {
  if (payload === null || payload === undefined) {
    return prefix ? `${prefix}=null` : 'null'
  }
  if (typeof payload === 'string') {
    const trunc = payload.length > PAYLOAD_PREVIEW_LIMIT
      ? `${payload.slice(0, PAYLOAD_PREVIEW_LIMIT)}…`
      : payload
    // Escape backslashes so the terminal doesn't interpret an embedded \n.
    const safe = trunc.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')
    return prefix ? `${prefix}=${JSON.stringify(safe)}` : JSON.stringify(safe)
  }
  if (typeof payload === 'number' || typeof payload === 'boolean') {
    return prefix ? `${prefix}=${String(payload)}` : String(payload)
  }
  if (Array.isArray(payload)) {
    // Arrays render as JSON for compactness, truncated like strings.
    const json = JSON.stringify(payload)
    const trunc = json.length > PAYLOAD_PREVIEW_LIMIT ? `${json.slice(0, PAYLOAD_PREVIEW_LIMIT)}…` : json
    return prefix ? `${prefix}=${trunc}` : trunc
  }
  // Object — recurse into each field. event field comes first for grep-friendliness.
  const obj = payload as Record<string, unknown>
  const keys = Object.keys(obj)
  // Put 'event' first if present so the eye finds the most identifying field
  // at the start of the line.
  keys.sort((a, b) => {
    if (a === 'event' && b !== 'event') return -1
    if (b === 'event' && a !== 'event') return 1
    return 0
  })
  return keys
    .map((k) => flattenPayload(obj[k], prefix ? `${prefix}.${k}` : k))
    .join(' ')
}

/** Format an entry as a single JSON Line for the disk log. */
export function formatJsonLine(entry: DiagnosticEntry): string {
  return JSON.stringify(entry) + '\n'
}

/** Open the file stream lazily. Idempotent — second call returns the
 *  existing stream. Ensures configDir exists first. */
async function openFileStream(): Promise<WriteStream> {
  if (fileStream) return fileStream
  await ensureDir(configDir())
  fileStream = createWriteStream(logPath(), { flags: 'a' })
  fileStream.on('error', (err) => {
    // Surface to stdout so the user notices, but don't crash the server.
    // Re-attempts happen on next ingest (we null the stream).
    console.error(`[diagnostics] write stream error: ${err.message}`)
    fileStream = null
  })
  return fileStream
}

/** Close the file stream cleanly. Idempotent. */
async function closeFileStream(): Promise<void> {
  if (!fileStream) return
  const stream = fileStream
  fileStream = null
  await new Promise<void>((resolve) => {
    stream.end(() => resolve())
  })
}

/** Loose shape accepted by `ingest()` — `ts`, `source`, and `payload`
 *  are optional. Server backfills missing `ts` with `Date.now()`, missing
 *  `source` with the `defaultSource` argument, and treats missing
 *  `payload` as undefined. Callers that have a precise `DiagnosticEntry`
 *  can pass it as-is. */
export type DiagnosticEntryInput = {
  ts?: number
  source?: LogSource
  cat: string
  payload?: unknown
}

/** Ingest a batch of entries into the ring, optionally print to stdout,
 *  optionally append to the disk file. Both outputs gate on the persisted
 *  config; the ring fills unconditionally so post-hoc inspection via
 *  GET /api/diagnostics/recent is always possible. */
export async function ingest(
  entries: ReadonlyArray<DiagnosticEntryInput>,
  defaultSource: LogSource,
): Promise<{ accepted: number }> {
  const cfg = await loadConfig()
  let accepted = 0
  for (const partial of entries) {
    const full: DiagnosticEntry = {
      ts: typeof partial.ts === 'number' ? partial.ts : Date.now(),
      source: partial.source ?? defaultSource,
      cat: String(partial.cat ?? 'unknown'),
      payload: partial.payload,
    }
    ring.push(full)
    if (ring.length > RING_SIZE) ring.shift()
    if (cfg.terminal) {
      // eslint-disable-next-line no-console
      console.log(formatPretty(full))
    }
    if (cfg.file) {
      try {
        const stream = await openFileStream()
        stream.write(formatJsonLine(full))
      } catch (err) {
        // File error already logged by the 'error' handler. Continue
        // ingesting the rest of the batch — the ring still gets them.
        console.error(`[diagnostics] file write failed: ${(err as Error).message}`)
      }
    }
    accepted += 1
  }
  return { accepted }
}

/** Snapshot of the ring, with optional count cap + category filter. */
export function dumpRecent(opts?: { count?: number; cat?: string }): DiagnosticEntry[] {
  const filtered = opts?.cat ? ring.filter((e) => e.cat === opts.cat) : ring
  const count = Math.max(1, opts?.count ?? 100)
  return filtered.slice(-count)
}

/** Replace the toggles + persist. Closes the file stream when file logging
 *  flips off so the file handle isn't leaked. Re-opens lazily on next
 *  ingest if file flips back on. */
export async function setForwarding(next: Partial<DiagnosticsConfig>): Promise<DiagnosticsConfig> {
  const cur = await loadConfig()
  const merged: DiagnosticsConfig = {
    terminal: next.terminal ?? cur.terminal,
    file: next.file ?? cur.file,
  }
  config = merged
  await ensureDir(configDir())
  await writeJson(configPath(), merged)
  if (!merged.file) {
    await closeFileStream()
  }
  return merged
}

/** Read the persisted config. Used by `GET /api/diagnostics/config`. */
export async function getForwarding(): Promise<DiagnosticsConfig> {
  return loadConfig()
}

/** Truncate the on-disk log file. Used by the Diagnostics card's "Clear
 *  log file" button. If file logging is on, closes + reopens the stream
 *  so subsequent writes go to the fresh file. */
export async function clearLogFile(): Promise<void> {
  await closeFileStream()
  try {
    await fs.truncate(logPath(), 0)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') throw err
    // File doesn't exist yet — nothing to clear.
  }
  // Don't reopen here — next ingest will lazy-open if file logging is on.
}

/** Wipe the in-memory ring. Useful when reproducing a bug — clear, then
 *  trigger the failing action, then dumpRecent() for a clean trace. */
export function clearRing(): void {
  ring = []
}

/** Path to the on-disk log file. Exposed so the Diagnostics card can show
 *  it (with a Copy button) and tests can read it. */
export function logFilePath(): string {
  return logPath()
}

/** Path to the persisted config file (diagnostics-config.json). Exposed for
 *  tests; the runtime reads/writes it via setForwarding/getForwarding. */
export function configFilePath(): string {
  return configPath()
}

/** Test seam — resets module-level state. Lets each test start from a
 *  known state without process restart. */
export async function _resetForTests(): Promise<void> {
  await closeFileStream()
  ring = []
  config = null
  configLoaded = false
}

/** Register a clean-shutdown handler so SIGINT / SIGTERM flush + close
 *  the file stream before exiting. Without this the last few writes can
 *  be lost. Idempotent — safe to call multiple times. */
let shutdownInstalled = false
export function installShutdownHandlers(): void {
  if (shutdownInstalled) return
  shutdownInstalled = true
  const handler = async () => {
    await closeFileStream()
  }
  process.once('SIGINT', () => { void handler() })
  process.once('SIGTERM', () => { void handler() })
  process.once('beforeExit', () => { void handler() })
}

// Eagerly install shutdown handlers on first import. Tests that need to
// avoid the handlers should mock process.once or call _resetForTests().
installShutdownHandlers()
// Mark `configLoaded` as referenced to placate the noUnusedLocals checker
// without changing its purpose (used by tests).
void configLoaded
