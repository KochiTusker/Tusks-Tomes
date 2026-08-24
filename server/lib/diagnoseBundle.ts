// Diagnosis bundle assembler. Builds a single structured markdown file
// the user (or any future Claude Code session) can read with ONE call
// to get full diagnostic context for a Tusk's Tomes bug.
//
// Architecture (one round-trip diagnosis):
//   1. Pipeline error fires (or soft-error signature matches) → client
//      POSTs to /api/diagnose/bundle with the browser ring + state.
//   2. This module merges client ring with server ring, reads probe
//      cache + routing + git state, runs softErrorSignatures, queries
//      graphify for the throw-site symbol.
//   3. Renders to markdown with predictable section headings.
//   4. Writes atomically to `.diagnose/latest.md` (in-repo, gitignored)
//      + a timestamped backup. Rotates backups to the most recent 10.
//   5. Returns paths so the API can echo them in the response.
//
// User then types `@.diagnose/latest.md what's wrong?` in Claude Code.
// One Read call, full context, no further questions.

import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { routingFile, readJson } from '../appData.js'
import { dumpRecent, type DiagnosticEntry } from './diagnosticsLog.js'
import { readAvailabilityCache } from '../api/modelProbe.js'
import {
  runSignatures,
  type Match,
  type ProbeSnapshot,
  type RefinementStateSnapshot,
  type RoutingSnapshot,
} from './softErrorSignatures.js'
import { affectedSlice, extractSymbolFromStack, isAvailable as graphifyAvailable } from './graphifyQuery.js'

export type BundleTrigger = 'hard_error' | 'soft_match' | 'manual'

export type BuildBundleInput = {
  trigger: BundleTrigger
  /** Browser-side ring entries — merged with server ring before signature
   *  scanning. The client POSTs `dumpRecentEvents({count: 80})` from
   *  verboseLog.ts. */
  browserRing?: DiagnosticEntry[]
  /** Hint from the client. When set, we'll query graphify for this
   *  symbol's neighbours. When unset, we try to extract a symbol from
   *  state.lastError's stack trace. */
  symbolHint?: string
  /** Snapshot of state.lastError, used to pull the throw site if no
   *  symbolHint was provided. */
  errorMessage?: string
  errorStack?: string
  /** Snapshot of the user-facing RefinementState. */
  currentState?: RefinementStateSnapshot
  /** Override for the repo root — tests use a tmpdir. Default: cwd. */
  repoRoot?: string
}

export type BuildBundleResult = {
  /** Markdown content that was written. */
  markdown: string
  /** Absolute path to .diagnose/latest.md (always the same per repo). */
  latestPath: string
  /** Absolute path to the timestamped backup (unique per call). */
  bundlePath: string
  /** Signatures that matched (also embedded in the markdown body). */
  signatures: Match[]
}

const BACKUP_LIMIT = 10

/** Render an integer count with English pluralisation: "1 chunk" / "2 chunks". */
function pluralise(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** Build the markdown body. Pure function over its inputs — no disk I/O. */
async function renderMarkdown(args: {
  trigger: BundleTrigger
  ring: DiagnosticEntry[]
  signatures: Match[]
  probeCache: ProbeSnapshot
  routing: RoutingSnapshot | null
  state: RefinementStateSnapshot | undefined
  errorMessage: string | undefined
  errorStack: string | undefined
  graphifySlice: string | null
  graphifyAvailableReason: string | null
  gitState: string
  symbol: string | null
}): Promise<string> {
  const {
    trigger,
    ring,
    signatures,
    probeCache,
    routing,
    state,
    errorMessage,
    errorStack,
    graphifySlice,
    graphifyAvailableReason,
    gitState,
    symbol,
  } = args
  const now = new Date().toISOString()

  // ─── 1. Header + current state ──────────────────────────────────────
  const headerLines: string[] = []
  headerLines.push(`# Tusk's Tomes — Diagnosis Bundle`)
  headerLines.push(`Generated: ${now}`)
  headerLines.push(`Trigger: ${trigger}`)
  if (symbol) headerLines.push(`Inferred throw-site symbol: \`${symbol}\``)
  headerLines.push('')

  // ─── 2. Section 1 — current state table ─────────────────────────────
  const stateLines: string[] = []
  stateLines.push('## 1. Current state (read this first)')
  stateLines.push('')
  stateLines.push('| field | value |')
  stateLines.push('|---|---|')
  stateLines.push(`| status | ${state?.status ?? '(unknown)'} |`)
  stateLines.push(`| current phase | ${state?.currentPhase ?? '(none)'} |`)
  stateLines.push(`| chunk | ${state?.currentChunkIndex ?? '?'} / ${state?.totalChunks ?? '?'} |`)
  stateLines.push(`| active provider | ${routing?.lastSelectedProvider ?? '(none)'}${routing?.geminiTier ? ` / ${routing.geminiTier}` : ''} |`)
  stateLines.push(`| output selection | chronicle:${state?.outputSelection?.chronicle ?? '?'} extras:${state?.outputSelection?.extras ?? '?'} condensed:${state?.outputSelection?.condensed ?? '?'} |`)
  if (errorMessage) {
    const shortError = errorMessage.split('\n')[0].slice(0, 240)
    stateLines.push(`| last error | \`${shortError.replace(/\|/g, '\\|')}\` |`)
  }
  stateLines.push('')

  // ─── 3. Section 2 — soft-error signatures ───────────────────────────
  const sigLines: string[] = []
  sigLines.push(`## 2. Soft-error signatures matched (${signatures.length})`)
  sigLines.push('')
  if (signatures.length === 0) {
    sigLines.push('_No soft-error signatures matched. The hard error (if any) is the primary lead._')
  } else {
    sigLines.push('| severity | id | hint | next step |')
    sigLines.push('|---|---|---|---|')
    for (const m of signatures) {
      const hint = m.hint.replace(/\|/g, '\\|')
      const next = (m.nextStep ?? '').replace(/\|/g, '\\|')
      sigLines.push(`| **${m.severity}** | \`${m.id}\` | ${hint} | ${next} |`)
    }
    sigLines.push('')
    // Evidence dump — collapsible details block per signature.
    for (const m of signatures) {
      if (!m.evidence) continue
      sigLines.push(`<details><summary>Evidence — \`${m.id}\`</summary>`)
      sigLines.push('')
      sigLines.push('```json')
      sigLines.push(JSON.stringify(m.evidence, null, 2))
      sigLines.push('```')
      sigLines.push('</details>')
      sigLines.push('')
    }
  }
  sigLines.push('')

  // ─── 4. Section 3 — last N events as JSON Lines ─────────────────────
  const ringLines: string[] = []
  ringLines.push(`## 3. Last ${ring.length} events (sanitized JSON Lines, newest last)`)
  ringLines.push('')
  ringLines.push('```jsonl')
  for (const e of ring) ringLines.push(JSON.stringify(e))
  ringLines.push('```')
  ringLines.push('')

  // ─── 5. Section 4 — graphify slice ──────────────────────────────────
  const graphLines: string[] = []
  graphLines.push('## 4. Graphify slice — blast radius for the throw site')
  graphLines.push('')
  if (graphifySlice) {
    graphLines.push(`Queried with: \`graphify affected "${symbol}" --depth 2 --budget 800\``)
    graphLines.push('')
    graphLines.push('```')
    graphLines.push(graphifySlice)
    graphLines.push('```')
  } else if (symbol === null) {
    graphLines.push('_No throw-site symbol could be inferred from the error stack. Section skipped._')
  } else {
    graphLines.push(
      `_(graphify slice unavailable — ${graphifyAvailableReason ?? 'graphify CLI returned no output'})_`,
    )
  }
  graphLines.push('')

  // ─── 6. Section 5 — probe cache snapshot ────────────────────────────
  const probeLines: string[] = []
  probeLines.push('## 5. Probe cache snapshot (fingerprints only, never raw keys)')
  probeLines.push('')
  probeLines.push('| slot | fingerprint | accessible / total | notable inaccessible |')
  probeLines.push('|---|---|---|---|')
  const slotOrder = ['gemini', 'geminiFallback', 'claude', 'openai'] as const
  for (const slot of slotOrder) {
    const data = probeCache[slot]
    if (!data) {
      probeLines.push(`| ${slot} | — | — (never probed) | — |`)
      continue
    }
    const probed = data.probed ?? []
    const accessibleCount = probed.filter((p) => p.accessible).length
    const inaccessible = probed
      .filter((p) => !p.accessible)
      .slice(0, 3)
      .map((p) => `${p.id} (${p.reason ?? '?'})`)
      .join('; ')
    probeLines.push(
      `| ${slot} | ${data.keyFingerprint ?? '—'} | ${accessibleCount} / ${probed.length} | ${inaccessible || '—'} |`,
    )
  }
  probeLines.push('')

  // ─── 7. Section 6 — routing snapshot ────────────────────────────────
  const routingLines: string[] = []
  routingLines.push('## 6. Routing snapshot')
  routingLines.push('')
  routingLines.push('```json')
  routingLines.push(JSON.stringify(routing ?? {}, null, 2))
  routingLines.push('```')
  routingLines.push('')

  // ─── 8. Section 7 — git state ───────────────────────────────────────
  const gitLines: string[] = []
  gitLines.push('## 7. Git state')
  gitLines.push('')
  gitLines.push('```')
  gitLines.push(gitState)
  gitLines.push('```')
  gitLines.push('')

  // ─── 9. Section 8 — recommended next steps ─────────────────────────
  const nextLines: string[] = []
  nextLines.push('## 8. Recommended next steps for Claude')
  nextLines.push('')
  if (signatures.length === 0 && !errorMessage) {
    nextLines.push('_No diagnostic priors. The user explicitly requested this bundle — interview them for symptoms._')
  } else {
    if (errorMessage) {
      nextLines.push(`1. Read the throw site${symbol ? ` (\`${symbol}\`)` : ''} and trace upstream.`)
      if (errorStack) {
        nextLines.push('   - Stack trace below — find the first frame in our code.')
      }
    }
    let n = errorMessage ? 2 : 1
    for (const m of signatures.slice(0, 5)) {
      const next = m.nextStep ?? `Investigate \`${m.id}\`.`
      nextLines.push(`${n}. **${m.severity.toUpperCase()}** [${m.id}]: ${next}`)
      n++
    }
    if (errorStack) {
      nextLines.push('')
      nextLines.push('<details><summary>Full stack trace</summary>')
      nextLines.push('')
      nextLines.push('```')
      nextLines.push(errorStack)
      nextLines.push('```')
      nextLines.push('</details>')
    }
  }
  nextLines.push('')
  // Tail-of-document instructions for any reading Claude.
  nextLines.push('---')
  nextLines.push('')
  nextLines.push('_For Claude: this bundle is auto-generated. Sections 1, 2, and 8 are usually the highest-signal. Section 3 (the event ring) is where the smoking gun lives when sections 1+2 are inconclusive._')

  return [
    ...headerLines,
    ...stateLines,
    ...sigLines,
    ...ringLines,
    ...graphLines,
    ...probeLines,
    ...routingLines,
    ...gitLines,
    ...nextLines,
  ].join('\n')
}

/** Read git state via shell-out. Returns a multi-line string (branch,
 *  working tree, last 5 commits). Falls back to "(unavailable)" if
 *  `git` isn't on PATH or this isn't a repo. */
async function readGitState(repoRoot: string): Promise<string> {
  async function git(args: string[]): Promise<string> {
    return new Promise<string>((resolve) => {
      let stdout = ''
      // AUDIT: `args` only called with hardcoded literals from this function's
      // three call sites (rev-parse / status / log). `shell: true` is for
      // Windows PATH lookup (resolves `git.exe`). No user input reaches shell.
      const child = spawn('git', args, { cwd: repoRoot, shell: true })
      child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
      child.on('error', () => resolve(''))
      child.on('exit', () => resolve(stdout.trim()))
      setTimeout(() => {
        try { child.kill() } catch { /* */ }
        resolve('')
      }, 3_000)
    })
  }
  const [branch, status, log] = await Promise.all([
    git(['rev-parse', '--abbrev-ref', 'HEAD']),
    git(['status', '--short']),
    git(['log', '--oneline', '-5']),
  ])
  if (!branch && !log) return '(git unavailable — not a repo or git not on PATH)'
  const lines: string[] = []
  if (branch) lines.push(`branch: ${branch}`)
  lines.push('')
  lines.push('## working tree (git status --short)')
  lines.push(status || '(clean)')
  lines.push('')
  lines.push('## last 5 commits')
  lines.push(log || '(no commits)')
  return lines.join('\n')
}

/** Prune `.diagnose/` to the most recent BACKUP_LIMIT timestamped bundles.
 *  `latest.md` is excluded — it's the always-overwritten copy. */
async function pruneBackups(diagnoseDir: string): Promise<void> {
  let entries: string[]
  try {
    entries = await fs.readdir(diagnoseDir)
  } catch {
    return
  }
  const backups = entries
    .filter((name) => /^diagnose-.+\.md$/.test(name))
    .map((name) => ({ name, path: path.join(diagnoseDir, name) }))
  if (backups.length <= BACKUP_LIMIT) return
  // Sort by name descending (filenames are ISO timestamps; lexicographic
  // sort = chronological sort).
  backups.sort((a, b) => b.name.localeCompare(a.name))
  const toDelete = backups.slice(BACKUP_LIMIT)
  await Promise.all(toDelete.map((b) => fs.unlink(b.path).catch(() => undefined)))
}

/** Build the full bundle. Side effects: writes two files in
 *  `.diagnose/`. Returns the markdown body + paths. */
export async function buildBundle(input: BuildBundleInput): Promise<BuildBundleResult> {
  const repoRoot = input.repoRoot ?? process.cwd()
  const diagnoseDir = path.join(repoRoot, '.diagnose')
  // Ensure dir exists (idempotent).
  await fs.mkdir(diagnoseDir, { recursive: true })

  // Merge browser + server rings, newest last.
  const serverRing = dumpRecent({ count: 80 })
  const mergedRing: DiagnosticEntry[] = [
    ...serverRing,
    ...(input.browserRing ?? []),
  ].sort((a, b) => a.ts - b.ts)
  // Cap to last 80 after merge to keep the markdown small.
  const cappedRing = mergedRing.slice(-80)

  // Read probe cache + routing.
  const probeCache = (await readAvailabilityCache().catch(() => ({}))) as ProbeSnapshot
  const routing = (await readJson<RoutingSnapshot | null>(routingFile(), null).catch(() => null))

  // Run signature scan.
  const signatures = runSignatures({
    ring: cappedRing,
    routing: routing ?? undefined,
    probeCache,
    state: input.currentState,
  })

  // Determine symbol for graphify. Prefer client-supplied hint; else
  // extract from the error stack.
  let symbol: string | null = null
  if (input.symbolHint) symbol = input.symbolHint
  else if (input.errorStack) symbol = extractSymbolFromStack(input.errorStack)

  let graphifySlice: string | null = null
  let graphifyReason: string | null = null
  if (symbol) {
    const avail = await graphifyAvailable({ repoRoot })
    if (avail.ok) {
      graphifySlice = await affectedSlice(symbol, { repoRoot })
      if (!graphifySlice) graphifyReason = 'graphify returned no output for this symbol'
    } else {
      graphifyReason = avail.reason ?? 'graphify CLI unavailable'
    }
  }

  // Read git state.
  const gitState = await readGitState(repoRoot)

  // Render markdown.
  const markdown = await renderMarkdown({
    trigger: input.trigger,
    ring: cappedRing,
    signatures,
    probeCache,
    routing,
    state: input.currentState,
    errorMessage: input.errorMessage,
    errorStack: input.errorStack,
    graphifySlice,
    graphifyAvailableReason: graphifyReason,
    gitState,
    symbol,
  })

  // Atomic write: write to .tmp, then rename. Same pattern as appData.writeJson.
  const isoStamp = new Date().toISOString().replace(/[:.]/g, '-')
  const bundlePath = path.join(diagnoseDir, `diagnose-${isoStamp}.md`)
  const latestPath = path.join(diagnoseDir, 'latest.md')

  await fs.writeFile(bundlePath + '.tmp', markdown, 'utf8')
  await fs.rename(bundlePath + '.tmp', bundlePath)
  await fs.writeFile(latestPath + '.tmp', markdown, 'utf8')
  await fs.rename(latestPath + '.tmp', latestPath)

  // Prune old backups.
  await pruneBackups(diagnoseDir)

  return { markdown, latestPath, bundlePath, signatures }
}

/** List recent backup bundles in `.diagnose/`, newest first. */
export async function listRecentBundles(repoRoot: string = process.cwd()): Promise<Array<{
  filename: string
  path: string
  size: number
  modifiedAt: string
}>> {
  const diagnoseDir = path.join(repoRoot, '.diagnose')
  let entries: string[]
  try {
    entries = await fs.readdir(diagnoseDir)
  } catch {
    return []
  }
  const candidates = entries.filter((name) => /^diagnose-.+\.md$|^latest\.md$/.test(name))
  const stats = await Promise.all(
    candidates.map(async (filename) => {
      const fullPath = path.join(diagnoseDir, filename)
      const stat = await fs.stat(fullPath).catch(() => null)
      if (!stat) return null
      return {
        filename,
        path: fullPath,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      }
    }),
  )
  return stats
    .filter((s): s is NonNullable<typeof s> => s !== null)
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
}
