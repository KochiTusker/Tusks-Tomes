// Static guard against the class of bug that deleted a user's
// Tusks-Lore folder: an `fs.rm(path, { recursive: true, force: true })`
// call where `path` is not visibly rooted in an OS temp directory.
//
// The original offender was server/lore/detection.test.ts: a test ran
// createLoreFolder() (which wrote to <worktree>/../Tusks-Lore — the
// REAL sibling lore folder), then a `finally` block did
// `fs.rm(first.loreRoot, { recursive: true, force: true })`. Running
// the full test suite invoked it and nuked the user's actual data.
//
// This audit is a heuristic, not a complete proof. It scans every
// tracked .ts file for matches of the recursive+force `fs.rm` shape
// and requires that, somewhere in the same file, the path being
// removed is sourced from `mkdtemp`, `tmpdir(`, or an allowlisted
// constant. New files that pull in `fs.rm({recursive,force})` against
// a fresh path source must add an entry to ALLOWLIST below with a
// one-line justification.

import { describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')

const SCAN_DIRS = ['server', 'src', 'scripts']

// Files we've audited and confirmed safe even though they don't match
// the heuristic. Each entry needs a one-line justification.
const ALLOWLIST = [
  // server/appData.ts has a cross-device-rename fallback that does
  // `fs.rm(src, { recursive, force })` after a successful `fs.cp`. The
  // src is the legacy app-data path the user owns; the alternative is
  // leaking dangling files on filesystem-boundary moves. Acknowledged.
  {
    file: 'server/appData.ts',
    reason: 'cross-device rename fallback after successful cp; src is the legacy app-data path',
  },
  // sessionManifest.ts cleans up *one session subtree* under sessionsRoot().
  // The path is `sessionsRoot()/{sessionId}`, the sessionId is hard-validated
  // by assertValidSessionId() (rejects "..", absolute paths, traversal chars)
  // before the path is composed, so the rm cannot escape sessionsRoot().
  {
    file: 'server/sessions/sessionManifest.ts',
    reason: 'sessionDir(id) is rooted in sessionsRoot() with assertValidSessionId; cannot traverse',
  },
  // extractMultitrack.ts has two recursive+force rm sites:
  //   1. session-dir rollback when the FIRST upload batch produces nothing
  //      — same sessionDir(sessionId) shape, same validator guard as above.
  //   2. zip extraction workdirs created with `unzip-<randomUUID()>` inside
  //      the multer upload tree; cleaned up in a `finally`. App-owned.
  {
    file: 'server/upload/extractMultitrack.ts',
    reason: 'session rollback (validated sessionId) + app-owned unzip workdirs cleaned in finally',
  },
]

// Per-call regex: captures the path argument so we can verify IT (not
// just "the file contains an mkdtemp somewhere") looks temp-rooted.
// Matches `fs.rm(<PATH>, { ... recursive: true ... force: true ... })`.
const DANGEROUS_PATTERN =
  /\bfs(?:\.promises)?\.rm\s*\(\s*([^,)]+?)\s*,\s*\{[^}]*\brecursive\s*:\s*true\b[^}]*\bforce\s*:\s*true\b[^}]*\}/gs

// The path arg itself must reference a variable / call that lineage-traces
// to a tmpdir-rooted value. We can't do full dataflow without an AST, but
// requiring the path expression's *text* to mention one of these tokens
// catches both inline expressions (`mkdtemp('foo')`) and named locals
// (`WORK`, `tmpDir`, etc.) — and most importantly is NOT satisfied by an
// unrelated mkdtemp elsewhere in the file.
const SAFE_PATH_TOKENS = [
  /\bmkdtemp\b/,
  /\btmpdir\(\)/,
  /\bos\.tmpdir\b/,
  /\bWORK\b/, // common convention in our tests for the temp work dir
  /\btmpDir\b/i,
  /\btempDir\b/i,
  /\btmpRoot\b/i,
  /\btempRoot\b/i,
]

// Per-call escape hatch — put `// allowlist:dangerous-fs-rm` on the LINE
// IMMEDIATELY before an fs.rm call to acknowledge it's intentional. The
// escape hatch is per-call (not per-file) so it doesn't accidentally
// vouch for unrelated rm calls that share the same file.
const PER_CALL_ESCAPE = /\/\/\s*allowlist:dangerous-fs-rm\b/

async function walk(dir, out) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'dist-server') continue
    if (entry.name.startsWith('.')) continue
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await walk(abs, out)
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx') || entry.name.endsWith('.mjs'))) {
      if (entry.name.endsWith('.d.ts')) continue
      // Skip the audit file itself so its regex string doesn't self-trigger.
      if (abs.endsWith('audit-dangerous-fs-rm.test.mjs')) continue
      out.push(abs)
    }
  }
}

describe('audit: fs.rm({recursive, force}) only runs against temp paths', () => {
  it('every recursive+force fs.rm call is scoped to a tmpdir-sourced path', async () => {
    const files = []
    for (const dir of SCAN_DIRS) {
      await walk(path.join(REPO_ROOT, dir), files)
    }

    const violations = []
    for (const file of files) {
      const body = await fs.readFile(file, 'utf8')
      const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/')
      const fileAllowlisted = ALLOWLIST.some((a) => a.file === rel)
      // Use matchAll so we check EVERY call site in the file, not just the
      // first one (a file may contain both safe and unsafe rm calls).
      // The regex needs the `g` flag for matchAll; reset lastIndex defensively.
      DANGEROUS_PATTERN.lastIndex = 0
      const matches = [...body.matchAll(DANGEROUS_PATTERN)]
      for (const match of matches) {
        if (fileAllowlisted) continue
        const pathArg = (match[1] ?? '').trim()
        const lineStart = body.lastIndexOf('\n', (match.index ?? 0) - 1) + 1
        const lineNum = body.slice(0, match.index ?? 0).split('\n').length
        const lineText = body.slice(lineStart).split('\n')[0]
        // Skip matches that live entirely inside a `//` line comment —
        // documentation explaining the audit shouldn't trigger the audit.
        if (/^\s*(?:\/\/|\*)/.test(lineText)) continue
        // Per-call escape hatch: check the line immediately before this call.
        const linesBefore = body.slice(0, match.index ?? 0).split('\n')
        const prevLine = linesBefore[linesBefore.length - 2] ?? ''
        if (PER_CALL_ESCAPE.test(prevLine)) continue
        // The path expression itself must contain a recognised temp-source
        // token, OR the same file must assign that variable from mkdtemp /
        // tmpdir somewhere. Variable-assignment check is bounded: we look
        // up only the rightmost identifier in the path expression, so a
        // computed expression like `path.join(ROOT, 'x')` resolves on
        // ROOT (not the static path.join token).
        if (SAFE_PATH_TOKENS.some((re) => re.test(pathArg))) continue
        const identMatch = pathArg.match(/[A-Za-z_$][A-Za-z0-9_$]*$/)
        if (identMatch) {
          const ident = identMatch[0]
          const assignedFromTemp = new RegExp(
            `\\b${ident}\\b\\s*=\\s*(?:await\\s+)?(?:fs\\.)?(?:promises\\.)?mkdtemp\\b`,
          )
          if (assignedFromTemp.test(body)) continue
        }
        violations.push({
          file: rel,
          line: lineNum,
          pathArg,
          snippet: match[0].slice(0, 200),
        })
      }
    }

    if (violations.length > 0) {
      const lines = violations.map(
        (v) =>
          `  ${v.file}:${v.line} — path arg "${v.pathArg}"\n` +
          `      ${v.snippet.replace(/\s+/g, ' ').slice(0, 160)}\n` +
          `      ↑ path arg doesn't visibly trace to a temp dir. Fix one of:\n` +
          `        - assign it from mkdtemp / tmpdir() and use that variable\n` +
          `        - rename the local var to include "tmp" / "temp" / "WORK"\n` +
          `        - add the file to ALLOWLIST with a written justification\n` +
          `        - put '// allowlist:dangerous-fs-rm' on the line immediately above`,
      )
      throw new Error(
        `Dangerous fs.rm calls found:\n${lines.join('\n\n')}\n\n` +
          `See scripts/audit-dangerous-fs-rm.test.mjs for context. The original incident: ` +
          `a test called fs.rm on the user's real Tusks-Lore sibling folder and deleted it.`,
      )
    }
    expect(violations).toEqual([])
    // Generous timeout on purpose. This test reads every source file under
    // server/, src/ and scripts/ — it takes ~90ms on an idle machine, but its
    // duration is bound by disk contention, not by anything it asserts. Under
    // the full suite (135+ files in parallel) it was intermittently blowing
    // the default 5s limit and reporting as a failure, which is the fastest
    // way to teach everyone to ignore a safety test.
  }, 60_000)
})
