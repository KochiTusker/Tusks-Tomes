// Shared security-sensitive validators. Centralised here so every
// path-traversal / SSRF / filesystem-safety guard in the codebase shares
// a single implementation — a single regex to audit, a single allowlist
// to keep in sync.
//
// Group 1: id validators (sessions, runs, anything that ends up in a
//          path.join). Conservative slug; rejects `..`, slashes, dots,
//          spaces.
// Group 2: path-containment (resolve a relative path inside a root,
//          refuse traversal).
// Group 3: filesystem-safe name segments (campaign / file labels) —
//          strips characters that break Win32 + POSIX, rejects Windows
//          reserved device names.
// Group 4: local-LLM base-URL validation (SSRF defence) — the Express
//          server proxies the browser to local runners (Ollama, LM
//          Studio, Unsloth), and a careless allowlist becomes an
//          open-proxy gadget.

import path from 'node:path'
import dns from 'node:dns'
import type { Response } from 'express'

// ============================================================================
// Group 1: id validators
// ============================================================================

/** Conservative slug regex: alphanumerics, underscore, dash, 1–64 chars.
 *  Covers UUIDv4 (with dashes), nanoid (URL-safe), and the legacy IDs
 *  the codebase already minted. Crucially rejects `.`, `/`, `\`, `..`,
 *  null bytes, percent-encoding, and anything URL-decoded by Express's
 *  path-to-regexp on `:id` segments. */
const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/

export function isValidId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id)
}

// Same shape today; aliased so callers read self-documenting at the use
// site (and so future divergence is a one-line edit).
export const isValidSessionId = isValidId
export const isValidRunId = isValidId

export class InvalidIdError extends Error {
  statusCode = 400
  constructor(kind: string, id: unknown) {
    super(`invalid ${kind}: ${String(id).slice(0, 64)}`)
    this.name = 'InvalidIdError'
  }
}

/** Fail-closed assertion. Use at the *definition* of any function that
 *  composes the id into a filesystem path (e.g. `sessionDir(id)`) — that
 *  way a future caller that forgets the route-level guard still can't
 *  traverse out. */
export function assertValidSessionId(id: unknown): asserts id is string {
  if (!isValidSessionId(id)) throw new InvalidIdError('session id', id)
}

/** Same fail-closed pattern for run ids. Use at the definition of any
 *  function that composes a runId into a path (e.g. runCheckpointFile). */
export function assertValidRunId(id: unknown): asserts id is string {
  if (!isValidRunId(id)) throw new InvalidIdError('run id', id)
}

/** Route-level guard: returns `true` AND writes a 400 to `res` if the
 *  id is invalid. Single source of truth for the response shape so
 *  every route reports the same error.
 *
 *  Usage:
 *      if (rejectInvalidId(req.params.id, res)) return
 *      // …safe to use req.params.id as a string from here on…
 */
export function rejectInvalidId(id: unknown, res: Response): boolean {
  if (!isValidSessionId(id)) {
    res.status(400).json({ error: 'invalid session id' })
    return true
  }
  return false
}

// ============================================================================
// Group 2: path containment
// ============================================================================

/** Resolve a user-supplied relPath to an absolute path inside `root`.
 *  Returns null if traversal escapes the root. Use when the relPath
 *  comes from a request body (DELETE /lore/documents, etc.) and we
 *  need to refuse `../` traversal but still permit arbitrary depth
 *  inside the root.
 *
 *  Lifted from server/lore/documents.ts so non-lore callers can share. */
export function safeResolveInside(root: string, relPath: string): string | null {
  // Reject Windows-drive-letter absolute paths (`C:\`, `c:/`) before
  // they reach path.resolve. On Windows path.resolve recognises them
  // as absolute and the suffix check below catches it; on POSIX it
  // does not, so `C:/foo` is treated as a relative segment and a
  // `<root>/C:/foo` directory gets quietly resolved inside the root.
  // Refuse them on every platform — a request body that contains a
  // drive-letter path is either confused or hostile.
  if (/^[a-z]:[/\\]/i.test(relPath)) return null
  const cleaned = relPath.replace(/\\/g, '/').replace(/^\/+/, '')
  const abs = path.resolve(root, cleaned)
  const resolvedRoot = path.resolve(root)
  if (abs !== resolvedRoot && !abs.startsWith(resolvedRoot + path.sep)) return null
  return abs
}

// ============================================================================
// Group 3: filesystem-safe name segments
// ============================================================================

// Windows reserved device names. Accessing one by basename (even from
// inside a different directory) opens the device — `NUL` silently
// swallows writes; `CON` echoes them to the console. Reject case-
// insensitively with or without an extension suffix (`NUL.txt` also
// opens NUL on most Win32 APIs).
const WINDOWS_RESERVED_RE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i

export function isWindowsReservedName(name: string): boolean {
  return WINDOWS_RESERVED_RE.test(name)
}

/** Coerce a user-supplied label (campaign name, filename root) into a
 *  filesystem-safe segment. Keeps spaces, dashes, apostrophes — those
 *  are readable and valid on all major OSes. Returns '' if the result
 *  would be empty, all-dots, or a Windows reserved name; callers should
 *  treat '' as "reject this request". */
export function sanitizeSegment(raw: string): string {
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    if (code < 0x20) continue // control chars (incl. NUL, \r, \n, \t)
    const ch = raw[i]
    if (
      ch === '\\' || ch === '/' || ch === ':' || ch === '*' || ch === '?' ||
      ch === '"' || ch === '<' || ch === '>' || ch === '|'
    ) continue
    out += ch
  }
  // Trim whitespace first so trailing-dot stripping reaches a sequence
  // like "name...   " (which would otherwise leave the dots in place
  // because they're not the final characters).
  out = out.trim().replace(/\.+$/g, '').trim()
  if (!out) return ''
  if (isWindowsReservedName(out)) return ''
  return out
}

// ============================================================================
// Group 4: local-LLM base-URL validation (SSRF defence)
// ============================================================================

// Dotted-decimal IPv4 — strict. Rejects 0x7f.0.0.1 (hex), 2130706433
// (decimal integer), 017700000001 (octal). Each octet 0–255.
const IPV4_DOTTED_RE =
  /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/

function isPrivateIPv4(ip: string): boolean {
  if (!IPV4_DOTTED_RE.test(ip)) return false
  const [a, b] = ip.split('.').map(Number)
  if (a === 127) return true        // 127.0.0.0/8 loopback
  if (a === 10) return true         // 10.0.0.0/8
  if (a === 192 && b === 168) return true  // 192.168.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
  return false
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase()
  if (lower === '::1') return true                 // loopback
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true // fc00::/7 ULA
  if (
    lower.startsWith('fe8') || lower.startsWith('fe9') ||
    lower.startsWith('fea') || lower.startsWith('feb')
  ) return true                                    // fe80::/10 link-local
  // IPv4-mapped (::ffff:1.2.3.4) — extract the dotted form and check.
  if (lower.startsWith('::ffff:')) {
    const tail = lower.slice('::ffff:'.length)
    if (IPV4_DOTTED_RE.test(tail)) return isPrivateIPv4(tail)
  }
  return false
}

/** True if the hostname is a literal we treat as private (loopback /
 *  RFC1918 IPv4 / ULA / link-local IPv6 / `localhost`). Hostnames
 *  resolved via DNS are NOT handled here — see validateLocalBaseUrl. */
export function isPrivateHost(hostname: string): boolean {
  if (!hostname) return false
  let h = hostname.toLowerCase()
  // URL.hostname keeps the surrounding brackets on IPv6 literals
  // (`new URL('http://[::1]/').hostname === '[::1]'`). Strip them so
  // downstream literal comparisons against `::1` etc. work.
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1)
  if (h === 'localhost') return true
  if (IPV4_DOTTED_RE.test(h)) return isPrivateIPv4(h)
  if (h.includes(':')) return isPrivateIPv6(h)
  return false
}

// 60s DNS lookup cache. Re-resolution on every proxy hit is wasted I/O,
// and the cache size is bounded by the small set of names a user would
// have configured for local LLMs. Plain Map (no LRU) is fine.
type DnsCacheEntry = { isPrivate: boolean; expiresAt: number }
const dnsCache = new Map<string, DnsCacheEntry>()

async function resolvesToPrivateAddress(hostname: string): Promise<boolean> {
  const now = Date.now()
  const cached = dnsCache.get(hostname)
  if (cached && cached.expiresAt > now) return cached.isPrivate
  try {
    const { address } = await dns.promises.lookup(hostname, { family: 0 })
    const isPrivate = isPrivateHost(address)
    dnsCache.set(hostname, { isPrivate, expiresAt: now + 60_000 })
    return isPrivate
  } catch {
    return false
  }
}

/** For tests — reset the DNS lookup cache between cases. */
export function _resetDnsCache(): void {
  dnsCache.clear()
}

/** Validate a user-supplied baseUrl for the local-LLM proxy / probe.
 *  Returns the normalised `${protocol}//${host}` string or throws.
 *
 *  Rejects:
 *    - any non-http(s) scheme
 *    - empty / unparseable URL
 *    - userinfo bypass (`http://1.2.3.4@127.0.0.1/`)
 *    - IPv4 in octal / hex / decimal-integer notation
 *    - AWS / GCP / Azure metadata IPs (169.254.169.254 etc.) — not in
 *      any private range, so the host check catches them naturally
 *    - hostnames that resolve to a public IP
 *
 *  Note: there's still a TOCTOU window between this check and the
 *  actual fetch (DNS-rebinding can re-point a hostname to a public IP
 *  between calls). Mitigated by `dnsCache` 60s TTL keeping a stable
 *  answer and by the proxy being mounted only for local-LLM use; full
 *  defence would pin to the resolved IP at fetch time. */
export async function validateLocalBaseUrl(raw: unknown): Promise<string> {
  if (typeof raw !== 'string' || !raw) {
    throw new Error('baseUrl is required')
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`baseUrl is not a valid URL: ${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`baseUrl protocol must be http(s), got: ${url.protocol}`)
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('baseUrl must not contain userinfo (user:pass@)')
  }
  const hostname = url.hostname.toLowerCase()
  if (!hostname) throw new Error('baseUrl host is empty')

  if (isPrivateHost(hostname)) {
    return `${url.protocol}//${url.host}`
  }
  if (await resolvesToPrivateAddress(hostname)) {
    return `${url.protocol}//${url.host}`
  }
  throw new Error(
    `Refusing to proxy to non-local host "${url.hostname}". ` +
      `Only localhost / private LAN addresses are allowed.`,
  )
}
