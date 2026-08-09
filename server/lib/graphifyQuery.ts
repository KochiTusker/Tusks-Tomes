// Subprocess wrapper around the locally-installed `graphify` CLI
// (https://github.com/safishamsi/graphify). Used by the diagnose bundle
// assembler to embed a "blast radius" slice for the throw-site symbol —
// callers + callees + same-community siblings — so the user (or a
// future Claude session) can see what else might be affected by the bug.
//
// Graceful degradation: if `graphify` isn't on PATH OR
// `graphify-out/graph.json` doesn't exist, every function returns null
// and the bundle includes a one-line "(graphify slice unavailable)"
// instead of failing.
//
// Why subprocess vs. reading graph.json directly: graphify already has
// a well-tested BFS + ranking implementation we'd otherwise have to
// reimplement. The 30-50ms subprocess overhead is fine for the
// once-per-bundle case (typical diagnosis is one bundle per error).

import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'

/** Cached availability — `which graphify` is expensive on Windows and
 *  the answer never changes during a process lifetime. Set on first
 *  isAvailable() call; the value is the path-or-null. */
let availabilityCache: { ok: boolean; reason?: string } | null = null

/** Check whether `graphify` is on PATH AND `graphify-out/graph.json`
 *  exists. Both must be true for any slice query to succeed. */
export async function isAvailable(opts: { repoRoot?: string } = {}): Promise<{
  ok: boolean
  reason?: string
}> {
  if (availabilityCache) return availabilityCache
  // Check CLI presence first.
  const cliOk = await new Promise<boolean>((resolve) => {
    // AUDIT: hardcoded command name + single literal flag. No user input
    // reaches the shell. `shell: true` is used for Windows PATH lookup
    // (resolves `graphify.exe` / `graphify.cmd` shims from `pipx install`).
    const child = spawn('graphify', ['--version'], { shell: true })
    child.on('error', () => resolve(false))
    child.on('exit', (code) => resolve(code === 0))
    // Safety timeout — 3s.
    setTimeout(() => {
      try { child.kill() } catch { /* */ }
      resolve(false)
    }, 3_000)
  })
  if (!cliOk) {
    availabilityCache = { ok: false, reason: 'graphify CLI not on PATH (install via `pip install graphifyy`)' }
    return availabilityCache
  }
  // Check graph.json exists in the repo root.
  const repoRoot = opts.repoRoot ?? process.cwd()
  const graphPath = path.join(repoRoot, 'graphify-out', 'graph.json')
  try {
    await fs.stat(graphPath)
  } catch {
    availabilityCache = { ok: false, reason: `graph.json missing at ${graphPath} — run \`graphify update .\` from the repo root` }
    return availabilityCache
  }
  availabilityCache = { ok: true }
  return availabilityCache
}

/** Reset the availability cache. Test seam — production code never
 *  calls this. */
export function _resetAvailabilityCacheForTests(): void {
  availabilityCache = null
}

/** Run `graphify affected "<symbol>" --depth N --budget M` and return
 *  stdout as a string. Returns null when graphify is unavailable. The
 *  caller is responsible for embedding the string into the bundle.
 *  Sanitises the symbol to avoid shell injection — only [\w._-] allowed. */
export async function affectedSlice(
  symbol: string,
  opts: { depth?: number; budget?: number; repoRoot?: string } = {},
): Promise<string | null> {
  const avail = await isAvailable({ repoRoot: opts.repoRoot })
  if (!avail.ok) return null
  // Sanitise: graphify accepts arbitrary identifiers but we never want
  // shell metacharacters here even though spawn() doesn't go through a
  // shell. Defence in depth.
  const safe = symbol.match(/^[\w.:_-]{1,200}$/) ? symbol : null
  if (!safe) return null
  const depth = opts.depth ?? 2
  const budget = opts.budget ?? 800
  const repoRoot = opts.repoRoot ?? process.cwd()
  const graphPath = path.join(repoRoot, 'graphify-out', 'graph.json')

  return new Promise<string | null>((resolve) => {
    let stdout = ''
    let stderr = ''
    // AUDIT: `safe` passed through /^[\w.:_-]{1,200}$/ regex (no shell metas).
    // depth/budget are stringified numbers, graphPath is path.join of trusted
    // constants. `shell: true` is for Windows PATH lookup (graphify.cmd shim).
    const child = spawn(
      'graphify',
      ['affected', safe, '--depth', String(depth), '--budget', String(budget), '--graph', graphPath],
      { cwd: repoRoot, shell: true },
    )
    child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', () => resolve(null))
    child.on('exit', (code) => {
      if (code !== 0) {
        // Surface stderr to the caller in case it's useful for the
        // bundle's "graphify failed for this reason" line.
        resolve(stderr ? `(graphify exit ${code}): ${stderr.slice(0, 500)}` : null)
        return
      }
      resolve(stdout.trim() || null)
    })
    // Safety timeout — 10s. Most slices return in < 1s on this codebase.
    setTimeout(() => {
      try { child.kill() } catch { /* */ }
      resolve(null)
    }, 10_000)
  })
}

/** Try to extract a meaningful symbol from a JavaScript stack trace.
 *  Returns the first frame that looks like a function name (camelCase
 *  or PascalCase), or null if nothing usable is found.
 *
 *  Example input:
 *    `Error: boom
 *     at handlePipelineError (src/components/RefinementTool.tsx:281:7)
 *     at runWithSession (src/components/RefinementTool.tsx:300:11)`
 *  Returns: `handlePipelineError` */
export function extractSymbolFromStack(stack: string | undefined): string | null {
  if (!stack) return null
  // Match "at <name>" lines. Skip anonymous frames.
  const re = /\bat\s+([A-Za-z_$][\w.$]*)\s*\(/g
  for (let m = re.exec(stack); m !== null; m = re.exec(stack)) {
    const name = m[1]
    // Skip Promise / native / build artefacts.
    if (
      name === 'Object' ||
      name === 'process' ||
      name.startsWith('Promise') ||
      name.length < 3
    ) continue
    return name
  }
  return null
}
