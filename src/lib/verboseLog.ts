// Opt-in verbose diagnostic logger. Off by default; flip on via the
// Settings → Diagnostics toggle or via DevTools:
//
//   window.__tusk.setVerbose(true)             // browser console stream
//   window.__tusk.setTerminalForwarding(true)  // also POST to dev-server terminal
//   window.__tusk.setFileLogging(true)         // also write JSON Lines to disk
//   window.__tusk.dumpRecentEvents()                  // last 100 entries
//   window.__tusk.dumpRecentEvents({ count: 500 })    // last 500
//   window.__tusk.dumpRecentEvents({ cat: 'gemini' }) // filtered by category
//   window.__tusk.recentFromServer().then(console.table) // merged ring (server)
//   window.__tusk.clearLog()         // wipe the ring buffer
//
// The logger keeps a fixed-size in-memory ring (default 500 entries) so
// you can come back and inspect what happened even if `console.log` is
// scrolled off. The ring fills regardless of any flag — flipping a flag
// only controls each downstream output channel. This means if a bug
// happens, you can flip the flags ON afterward and still
// `dumpRecentEvents()` to see what just happened (browser-local) OR
// `recentFromServer()` to see the merged browser+server timeline.
//
// Sanitizer (forwarder side): any field named `apiKey`, `key`, `prompt`,
// `userPrompt`, `cacheablePrefix`, or `systemPrompt` is replaced with
// `[REDACTED]` before leaving the browser. Lengths preserved as
// `<field>_chars: N` so they remain diagnostically useful.

import { useEffect, useState } from 'react'

const LS_KEY = 'sbts:verbose'
const LS_TERMINAL_KEY = 'sbts:diagnostics-terminal'
const LS_FILE_KEY = 'sbts:diagnostics-file'
const LS_PERSIST_BLOCKED_CHUNKS_KEY = 'sbts:persist-blocked-chunks'
const RING_SIZE = 500
/** Debounce window for batched forwarder POSTs. Long enough to coalesce
 *  many rapid-fire events (per-chunk timing produces ~2 vlogs per chunk
 *  call), short enough to feel live in the terminal. */
const FORWARDER_DEBOUNCE_MS = 250
/** Hard cap on entries per POST. Matches the server-side MAX_BATCH_SIZE.
 *  If we ever overflow this window, multiple POSTs fire — never silently
 *  drop. */
const FORWARDER_MAX_BATCH = 500

export type LogCategory =
  | 'pipeline'      // PipelineEvent stream (phase_start, chunk_done, quota_exhausted, …)
  | 'chunk'         // per-chunk start/end/latency timing emitted from chunkedGenerate
  | 'provider'      // ProviderEvent stream (quota_exhausted, auto_fallback)
  | 'gemini'        // useFallback flips, hard-zero detection, exhaustion classification
  | 'sessions'      // buildSession warnings, perPhaseOverrides
  | 'routing'       // putRouting / getRouting transitions
  | 'refresh'       // refreshProviders singleton rebuilds
  | 'fallback'      // RateLimitDialog 'Switch to paid' sequence steps
  | 'cache'         // createPrefixCache / deletePrefixCache lifecycle
  | 'resume'        // resumeFromCheckpoint / planResumeAction dispatch

export type LogEntry = {
  /** ms since epoch */
  ts: number
  cat: LogCategory
  payload: unknown
}

let ring: LogEntry[] = []

/** True iff localStorage holds the verbose flag. SSR-safe (returns false
 *  when window is undefined). */
export function isVerbose(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(LS_KEY) === '1'
  } catch {
    // Storage access denied (private mode etc). Treat as off.
    return false
  }
}

/** Flip the verbose flag. Persists across reloads. */
export function setVerbose(on: boolean): void {
  if (typeof window === 'undefined') return
  try {
    if (on) window.localStorage.setItem(LS_KEY, '1')
    else window.localStorage.removeItem(LS_KEY)
  } catch {
    /* swallow — diagnostic only */
  }
  // Notify subscribers so the Settings toggle re-renders.
  try { window.dispatchEvent(new CustomEvent(VERBOSE_CHANGED_EVENT)) } catch { /* */ }
}

export const VERBOSE_CHANGED_EVENT = 'sbts:verbose-changed'

/** Append to the ring buffer; also print via `console.log` when verbose
 *  is on; also enqueue for the debounced server forwarder when terminal
 *  forwarding OR file logging is on. All three downstream paths are
 *  independently gated. The ring fills unconditionally so post-hoc
 *  `dumpRecentEvents()` always works. */
export function vlog(cat: LogCategory, payload: unknown): void {
  const entry: LogEntry = { ts: Date.now(), cat, payload }
  ring.push(entry)
  if (ring.length > RING_SIZE) ring.shift()
  if (isVerbose()) {
    const tsStr = new Date(entry.ts).toISOString().slice(11, 23) // HH:mm:ss.SSS
    // eslint-disable-next-line no-console
    console.log(
      `%c[tusk:${cat}]%c ${tsStr}`,
      'color:#888;font-weight:bold',
      'color:inherit',
      payload,
    )
  }
  if (isTerminalForwarding() || isFileLogging()) {
    enqueueForward(entry)
  }
}

/** Read recent ring-buffer entries. Optional filter by category and/or
 *  count cap. Default: latest 100, all categories. */
export function dumpRecentEvents(
  opts?: { count?: number; cat?: LogCategory },
): LogEntry[] {
  const filtered = opts?.cat ? ring.filter((e) => e.cat === opts.cat) : ring
  const count = Math.max(1, opts?.count ?? 100)
  return filtered.slice(-count)
}

/** Wipe the ring buffer. Useful when reproducing a bug — clear, then
 *  trigger the failing action, then `dumpRecentEvents()` for a clean
 *  trace of just that interaction. */
export function clearLog(): void {
  ring = []
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase-3 additions: browser→server forwarder + sanitizer + new toggle flags.
// ─────────────────────────────────────────────────────────────────────────────

/** Field names that the sanitizer redacts before forwarding. The list is
 *  exhaustive on purpose — if a future vlog call accidentally includes a
 *  raw key or prompt, the redaction acts as defense-in-depth. */
const SENSITIVE_KEYS = new Set([
  'apiKey',
  'apikey',
  'key',
  'prompt',
  'userPrompt',
  'cacheablePrefix',
  'systemPrompt',
  'rawTranscript',
  'groundedTranscript',
])

/** Recursively walk a payload and replace sensitive string values with
 *  `[REDACTED]`. The length is preserved as `<field>_chars: N` so the
 *  field is still diagnostically meaningful — e.g. a 0-char prompt means
 *  empty input, a 50000-char one means "this was a huge call." */
export function sanitizeForForwarding(input: unknown): unknown {
  if (input === null || typeof input !== 'object') return input
  if (Array.isArray(input)) return input.map(sanitizeForForwarding)
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(key) && typeof value === 'string') {
      out[key] = '[REDACTED]'
      out[`${key}_chars`] = value.length
    } else if (value !== null && typeof value === 'object') {
      out[key] = sanitizeForForwarding(value)
    } else {
      out[key] = value
    }
  }
  return out
}

/** Forwarder state — the pending batch + the active debounce timer. */
let pendingBatch: LogEntry[] = []
let debounceTimer: ReturnType<typeof setTimeout> | null = null

/** Read the terminal-forwarding flag from localStorage. */
export function isTerminalForwarding(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(LS_TERMINAL_KEY) === '1'
  } catch {
    return false
  }
}

/** Read the file-logging flag from localStorage. */
export function isFileLogging(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(LS_FILE_KEY) === '1'
  } catch {
    return false
  }
}

/** Read the persist-blocked-chunks flag from localStorage. When ON, the
 *  pipeline's soft-skip path POSTs the rejected chunk's FULL prompt body
 *  to `.diagnose/blocked-chunks/<phase>-<ISO>.txt`. Opt-in only — the
 *  default OFF means user content never leaves the live ring. Surfaced
 *  via the DiagnosticsCard alongside the terminal + file toggles. */
export function isPersistingBlockedChunks(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(LS_PERSIST_BLOCKED_CHUNKS_KEY) === '1'
  } catch {
    return false
  }
}

export const TERMINAL_FORWARDING_CHANGED_EVENT = 'sbts:terminal-forwarding-changed'
export const FILE_LOGGING_CHANGED_EVENT = 'sbts:file-logging-changed'
export const PERSIST_BLOCKED_CHUNKS_CHANGED_EVENT = 'sbts:persist-blocked-chunks-changed'

/** Flip the terminal-forwarding flag. Also calls the server-side
 *  `POST /api/diagnostics/config` so the server side persists its half
 *  (terminal: true|false). The browser flag controls whether vlog
 *  forwards at all; the server flag controls whether the server prints
 *  to stdout. Both must be on for terminal output. */
export async function setTerminalForwarding(on: boolean): Promise<void> {
  if (typeof window === 'undefined') return
  try {
    if (on) window.localStorage.setItem(LS_TERMINAL_KEY, '1')
    else window.localStorage.removeItem(LS_TERMINAL_KEY)
  } catch {
    /* swallow */
  }
  try {
    await fetch('/api/diagnostics/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terminal: on }),
    })
  } catch (err) {
    console.warn('[verboseLog] failed to persist terminal-forwarding config:', err)
  }
  try { window.dispatchEvent(new CustomEvent(TERMINAL_FORWARDING_CHANGED_EVENT)) } catch { /* */ }
}

/** Flip the file-logging flag. Calls the server-side
 *  `POST /api/diagnostics/config` to update its persisted state. */
export async function setFileLogging(on: boolean): Promise<void> {
  if (typeof window === 'undefined') return
  try {
    if (on) window.localStorage.setItem(LS_FILE_KEY, '1')
    else window.localStorage.removeItem(LS_FILE_KEY)
  } catch {
    /* swallow */
  }
  try {
    await fetch('/api/diagnostics/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: on }),
    })
  } catch (err) {
    console.warn('[verboseLog] failed to persist file-logging config:', err)
  }
  try { window.dispatchEvent(new CustomEvent(FILE_LOGGING_CHANGED_EVENT)) } catch { /* */ }
}

/** Flip the persist-blocked-chunks flag. Unlike terminal + file logging
 *  this flag is purely client-side — the server endpoint that writes the
 *  chunk is unconditionally available behind loopbackOnly; the toggle
 *  just gates whether the pipeline calls it. */
export function setPersistBlockedChunks(on: boolean): void {
  if (typeof window === 'undefined') return
  try {
    if (on) window.localStorage.setItem(LS_PERSIST_BLOCKED_CHUNKS_KEY, '1')
    else window.localStorage.removeItem(LS_PERSIST_BLOCKED_CHUNKS_KEY)
  } catch {
    /* swallow */
  }
  try { window.dispatchEvent(new CustomEvent(PERSIST_BLOCKED_CHUNKS_CHANGED_EVENT)) } catch { /* */ }
}

/** Flush the pending batch via fetch. Returns immediately on no-op;
 *  swallows network errors (the ring still has the entries locally). */
async function flushBatch(): Promise<void> {
  if (pendingBatch.length === 0) return
  const batch = pendingBatch
  pendingBatch = []
  debounceTimer = null
  // Sanitize at the boundary — never forward sensitive bytes.
  const sanitized = batch.map((e) => ({
    ts: e.ts,
    cat: e.cat,
    payload: sanitizeForForwarding(e.payload),
  }))
  // Slice into chunks of FORWARDER_MAX_BATCH so a long debounce window
  // never silently drops entries.
  for (let i = 0; i < sanitized.length; i += FORWARDER_MAX_BATCH) {
    const slice = sanitized.slice(i, i + FORWARDER_MAX_BATCH)
    try {
      await fetch('/api/diagnostics/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries: slice }),
        // Keep this alive across navigation; the ring will still have the
        // entries if the network call fails.
        keepalive: true,
      })
    } catch (err) {
      // Last-ditch — log to console only. The ring still has the entries.
      console.warn('[verboseLog] forwarder POST failed:', err)
    }
  }
}

/** Schedule a debounced flush. Called from `vlog()` when either flag is on. */
function scheduleFlush(): void {
  if (debounceTimer !== null) return
  debounceTimer = setTimeout(() => { void flushBatch() }, FORWARDER_DEBOUNCE_MS)
}

/** Enqueue an entry into the pending batch. Idempotent on the debounce
 *  timer — multiple calls within FORWARDER_DEBOUNCE_MS coalesce into one
 *  POST. */
function enqueueForward(entry: LogEntry): void {
  pendingBatch.push(entry)
  scheduleFlush()
}

/** Synchronous flush via `navigator.sendBeacon` — used in `beforeunload`
 *  so pending entries reach the server even when the page is closing.
 *  fetch() would be canceled by the browser at unload; sendBeacon is
 *  guaranteed to land (best-effort, no response). */
function flushViaBeacon(): void {
  if (pendingBatch.length === 0) return
  const batch = pendingBatch
  pendingBatch = []
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  const sanitized = batch.map((e) => ({
    ts: e.ts,
    cat: e.cat,
    payload: sanitizeForForwarding(e.payload),
  }))
  try {
    const blob = new Blob([JSON.stringify({ entries: sanitized })], {
      type: 'application/json',
    })
    navigator.sendBeacon?.('/api/diagnostics/log', blob)
  } catch {
    /* swallow — sendBeacon is best-effort by design */
  }
}

/** Fetch the merged server ring (server-side events + previously
 *  forwarded browser events). Used by the Diagnostics card's "Show
 *  server ring" button and exposed on window.__tusk for DevTools. */
export async function recentFromServer(opts?: {
  count?: number
  cat?: LogCategory | 'all'
}): Promise<unknown[]> {
  const params = new URLSearchParams()
  if (opts?.count) params.set('count', String(opts.count))
  if (opts?.cat && opts.cat !== 'all') params.set('cat', opts.cat)
  const res = await fetch(`/api/diagnostics/recent?${params.toString()}`)
  if (!res.ok) throw new Error(`GET /api/diagnostics/recent failed: HTTP ${res.status}`)
  const body = await res.json()
  return body.entries as unknown[]
}

/** Install the beforeunload handler that beacons pending entries when
 *  the tab closes. Idempotent. */
function installBeforeUnloadFlush(): void {
  if (typeof window === 'undefined') return
  window.addEventListener('beforeunload', () => {
    if (isTerminalForwarding() || isFileLogging()) flushViaBeacon()
  })
}
installBeforeUnloadFlush()

/** React hook for the "Forward to dev-server terminal" toggle. */
export function useTerminalForwarding(): [boolean, (on: boolean) => void] {
  const [flag, setFlag] = useState(() => isTerminalForwarding())
  useEffect(() => {
    if (typeof window === 'undefined') return
    function onChange() { setFlag(isTerminalForwarding()) }
    window.addEventListener(TERMINAL_FORWARDING_CHANGED_EVENT, onChange)
    window.addEventListener('storage', onChange)
    return () => {
      window.removeEventListener(TERMINAL_FORWARDING_CHANGED_EVENT, onChange)
      window.removeEventListener('storage', onChange)
    }
  }, [])
  return [flag, (on: boolean) => { void setTerminalForwarding(on); setFlag(on) }]
}

/** React hook for the "Also write to diagnostics.log" toggle. */
export function useFileLogging(): [boolean, (on: boolean) => void] {
  const [flag, setFlag] = useState(() => isFileLogging())
  useEffect(() => {
    if (typeof window === 'undefined') return
    function onChange() { setFlag(isFileLogging()) }
    window.addEventListener(FILE_LOGGING_CHANGED_EVENT, onChange)
    window.addEventListener('storage', onChange)
    return () => {
      window.removeEventListener(FILE_LOGGING_CHANGED_EVENT, onChange)
      window.removeEventListener('storage', onChange)
    }
  }, [])
  return [flag, (on: boolean) => { void setFileLogging(on); setFlag(on) }]
}

/** React hook for the "Persist blocked-chunk text" toggle. */
export function usePersistBlockedChunks(): [boolean, (on: boolean) => void] {
  const [flag, setFlag] = useState(() => isPersistingBlockedChunks())
  useEffect(() => {
    if (typeof window === 'undefined') return
    function onChange() { setFlag(isPersistingBlockedChunks()) }
    window.addEventListener(PERSIST_BLOCKED_CHUNKS_CHANGED_EVENT, onChange)
    window.addEventListener('storage', onChange)
    return () => {
      window.removeEventListener(PERSIST_BLOCKED_CHUNKS_CHANGED_EVENT, onChange)
      window.removeEventListener('storage', onChange)
    }
  }, [])
  return [flag, (on: boolean) => { setPersistBlockedChunks(on); setFlag(on) }]
}

/** Expose helpers on `window.__tusk` for DevTools console access.
 *  Idempotent — safe to call multiple times on module import. */
function installGlobalHandle(): void {
  if (typeof window === 'undefined') return
  const w = window as unknown as {
    __tusk?: {
      setVerbose: typeof setVerbose
      isVerbose: typeof isVerbose
      setTerminalForwarding: typeof setTerminalForwarding
      isTerminalForwarding: typeof isTerminalForwarding
      setFileLogging: typeof setFileLogging
      isFileLogging: typeof isFileLogging
      setPersistBlockedChunks: typeof setPersistBlockedChunks
      isPersistingBlockedChunks: typeof isPersistingBlockedChunks
      dumpRecentEvents: typeof dumpRecentEvents
      recentFromServer: typeof recentFromServer
      clearLog: typeof clearLog
      sanitizeForForwarding: typeof sanitizeForForwarding
    }
  }
  w.__tusk = {
    setVerbose,
    isVerbose,
    setTerminalForwarding,
    isTerminalForwarding,
    setFileLogging,
    isFileLogging,
    setPersistBlockedChunks,
    isPersistingBlockedChunks,
    dumpRecentEvents,
    recentFromServer,
    clearLog,
    sanitizeForForwarding,
  }
}
installGlobalHandle()

/** React hook for the Settings toggle. Re-renders on flag change so the
 *  UI checkbox stays in sync if someone flips it via DevTools. */
export function useVerboseFlag(): [boolean, (on: boolean) => void] {
  const [flag, setFlag] = useState(() => isVerbose())
  useEffect(() => {
    if (typeof window === 'undefined') return
    function onChange() {
      setFlag(isVerbose())
    }
    window.addEventListener(VERBOSE_CHANGED_EVENT, onChange)
    // Also re-sync on storage events (other tab flipped it).
    window.addEventListener('storage', onChange)
    return () => {
      window.removeEventListener(VERBOSE_CHANGED_EVENT, onChange)
      window.removeEventListener('storage', onChange)
    }
  }, [])
  return [flag, (on: boolean) => { setVerbose(on); setFlag(on) }]
}
