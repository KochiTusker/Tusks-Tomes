// Deterministic lore-source bake-off: Tusks-Lore folder vs. Obsidian vault.
//
// Run with:  npx tsx scripts/lore/eval-lore-source.ts
//
// Measures, on a real truncated session transcript, for BOTH lore sources:
//   - KB token cost per phase (compact for P1/2/4, full prose for P3/6),
//   - spoken-entity recognition recall vs. the vault as ground truth,
//   - deterministic + fuzzy grounding correction counts.
//
// No LLM calls — fully deterministic. Output quality (the LLM-judged part)
// is produced separately via the Playwright run. Real transcripts and the
// report are written to gitignored locations only.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { compactKb } from '../../src/lib/kbCompact.js'
import { annotateChunk, aliasIndexToSafeReplacements } from '../../src/lib/aliasMatch.js'
import { buildObsidianAliasIndex } from '../../server/lore/obsidian/vaultAdapter.js'
import { buildObsidianKbConcat } from '../../server/lore/obsidian/vaultKb.js'
import type { AliasIndex } from '../../server/lore/aliasTypes.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..')


/** Dev-eval scripts read their inputs from the environment. They deliberately
 *  have NO path defaults: a fallback would either encode one machine's drive
 *  layout into public source, or silently evaluate the wrong corpus on
 *  someone else's. Fail loudly instead. */
function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(
      `${name} is not set. Point it at the directory to evaluate, e.g. ` +
        `${name}="/path/to/target" npx tsx ${process.argv[1] ?? 'this script'}`,
    )
  }
  return value
}

const VAULT_PATH = requireEnv('OBSIDIAN_VAULT')
const TUSKS_LORE = requireEnv('TUSKS_LORE_DIR')
// No default: the previous fallback named a specific private session
// recording by UUID from the author's own machine.
const SESSION_SBV = requireEnv('SESSION_SBV')
const FIXTURE = path.join(REPO_ROOT, 'scripts', 'playwright-matrix', 'real-session-bakeoff.sbv')

// Claude profile (active provider = claudeCode → claude): Phase-1 chunk = 20k chars.
const P1_CHUNK_CHARS = 20_000
const N_CHUNKS = 2
const TRUNCATE_CHARS = P1_CHUNK_CHARS * N_CHUNKS // 40,000

const tokens = (s: string) => Math.ceil(s.length / 3.5) // mirrors estimateTokensFromChars

const FRONTMATTER_FENCE_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n+/
const stripFm = (t: string) => t.replace(FRONTMATTER_FENCE_RE, '')

// ── 1. Build the truncated 2-chunk transcript fixture (gitignored) ──────────
async function buildFixture(): Promise<string> {
  const raw = await fs.readFile(SESSION_SBV, 'utf8')
  let slice = raw.slice(0, TRUNCATE_CHARS)
  // Trim back to the last complete cue (last blank-line boundary).
  const lastBreak = slice.lastIndexOf('\n\n')
  if (lastBreak > 0) slice = slice.slice(0, lastBreak) + '\n'
  await fs.writeFile(FIXTURE, slice, 'utf8')
  return slice
}

/** Extract spoken text from SBV: drop timestamp lines + blanks, and strip the
 *  leading `[Speaker (Player)]` bracket from each line — the real pipeline
 *  detaches speaker tags before grounding, so this models the grounding input
 *  (in-dialogue entity mentions remain). */
function sbvToText(sbv: string): string {
  return sbv
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/^\d+:\d\d:\d\d\.\d+,/.test(l))
    .map((l) => l.replace(/^\s*\[[^\]]+\]\s*/, ''))
    .join('\n')
}

/** Compact one-line record per entity — the unit a per-chunk retrieval mode
 *  would inject instead of the full 200-term glossary. */
function compactRecordsFor(index: AliasIndex | null, canonicals: string[]): string {
  if (!index) return ''
  const lines = ['# RELEVANT CANONICAL NAMES & TERMS']
  for (const c of canonicals) {
    const ent = index.byEntity[c]
    if (!ent) continue
    const al = (ent.aliases ?? []).length ? ` (aka ${ent.aliases.join(', ')})` : ''
    lines.push(`- **${ent.name}**${al}`)
  }
  return lines.join('\n')
}

// ── 2. Baseline: Tusks-Lore folder ─────────────────────────────────────────
async function readTusksLoreDocs(root: string): Promise<Array<{ name: string; text: string }>> {
  const docs: Array<{ name: string; text: string }> = []
  async function walk(rel: string) {
    const dirAbs = path.join(root, rel)
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dirAbs, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const relChild = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || e.name === 'Sessions') continue
        await walk(relChild)
      } else if (e.isFile()) {
        const lower = e.name.toLowerCase()
        if (e.name.startsWith('.')) continue
        if (lower.endsWith('.bak') || lower.endsWith('.bak2')) continue
        if (!lower.endsWith('.md') && !lower.endsWith('.txt')) continue
        try {
          const text = await fs.readFile(path.join(dirAbs, e.name), 'utf8')
          docs.push({ name: e.name, text })
        } catch {
          /* skip */
        }
      }
    }
  }
  await walk('')
  return docs
}

function buildKbConcat(docs: Array<{ name: string; text: string }>): string {
  return docs.map((d) => `### ${d.name}\n${stripFm(d.text)}`.trim()).join('\n\n---\n\n')
}

async function loadBaselineIndex(root: string): Promise<AliasIndex | null> {
  try {
    const raw = await fs.readFile(path.join(root, '.tusks-lore.index.json'), 'utf8')
    return JSON.parse(raw) as AliasIndex
  } catch {
    return null
  }
}

// ── 3. Ground truth from the vault entity-index ─────────────────────────────
type GtEntity = { canonical: string; forms: string[] }
async function loadGroundTruth(vaultPath: string): Promise<GtEntity[]> {
  const raw = await fs.readFile(path.join(vaultPath, '_system/entity-index.json'), 'utf8')
  const parsed = JSON.parse(raw)
  const arr: Array<{ name: string; aliases?: string[] }> = Array.isArray(parsed) ? parsed : parsed.entities
  return arr
    .filter((e) => e?.name)
    .map((e) => ({ canonical: e.name, forms: [e.name, ...(e.aliases ?? [])].filter(Boolean) }))
}

const wholeWord = (form: string, textLower: string): boolean => {
  const esc = form.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[^a-z0-9])${esc}(?:[^a-z0-9]|$)`).test(textLower)
}

/** Set of every lowercased form a source index recognizes (canonicals + aliases). */
function sourceForms(index: AliasIndex | null): Set<string> {
  const s = new Set<string>()
  if (!index) return s
  for (const k of Object.keys(index.aliases ?? {})) s.add(k)
  for (const k of Object.keys(index.byEntity ?? {})) s.add(k.toLowerCase())
  return s
}

function byTypeCounts(index: AliasIndex | null): string {
  if (!index) return '—'
  return Object.entries(index.byType ?? {})
    .filter(([, v]) => (v as string[]).length)
    .map(([k, v]) => `${k}:${(v as string[]).length}`)
    .join(' ')
}

function fuzzySample(index: AliasIndex | null, text: string, n: number): string[] {
  if (!index) return []
  const { candidates } = annotateChunk(text, index)
  const seen = new Set<string>()
  const out: string[] = []
  for (const c of candidates) {
    const key = `${c.text}→${c.canonical}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(`"${c.text}" → ${c.canonical} (${Math.round(c.similarity * 100)}%)`)
    if (out.length >= n) break
  }
  return out
}

async function main() {
  const sbvSlice = await buildFixture()
  const transcript = sbvToText(sbvSlice)
  const transcriptLower = transcript.toLowerCase()

  // Sources.
  const baselineDocs = await readTusksLoreDocs(TUSKS_LORE)
  const baselineKb = buildKbConcat(baselineDocs)
  const baselineIndex = await loadBaselineIndex(TUSKS_LORE)

  const obs = await buildObsidianAliasIndex(VAULT_PATH)
  const obsKbPlain = (await buildObsidianKbConcat(VAULT_PATH, { modeB: false })).text
  const obsKbModeB = await buildObsidianKbConcat(VAULT_PATH, { modeB: true })

  // Ground truth + spoken-entity detection.
  const gt = await loadGroundTruth(VAULT_PATH)
  const present: Array<{ canonical: string; matchedForm: string }> = []
  for (const e of gt) {
    const matched = e.forms.find((f) => wholeWord(f, transcriptLower))
    if (matched) present.push({ canonical: e.canonical, matchedForm: matched })
  }

  const baseForms = sourceForms(baselineIndex)
  const obsForms = sourceForms(obs.index)
  const recognizedBy = (forms: Set<string>) =>
    present.filter((p) => forms.has(p.matchedForm.toLowerCase()) || forms.has(p.canonical.toLowerCase())).length

  const baseRecognized = recognizedBy(baseForms)
  const obsRecognized = recognizedBy(obsForms)

  // KB token costs.
  const baseCompact = compactKb(baselineKb)
  const obsCompact = compactKb(obsKbModeB.text)
  const baseFullTok = tokens(baselineKb)
  const obsFullTok = tokens(obsKbModeB.text)

  // Deterministic correction rules that would fire (literal alias→canonical
  // present in the transcript).
  const litRules = (index: AliasIndex | null) =>
    aliasIndexToSafeReplacements(index).filter((r) => wholeWord(r.from, transcriptLower)).length

  const lines: string[] = []
  const L = (s = '') => lines.push(s)
  L('# Lore-source bake-off — Tusks-Lore vs. Obsidian vault')
  L('')
  L(`Transcript: most recent Whisper session, truncated to ${N_CHUNKS} × ${P1_CHUNK_CHARS} = ${TRUNCATE_CHARS.toLocaleString()} chars (Claude P1 chunk).`)
  L(`Fixture: ${path.relative(REPO_ROOT, FIXTURE)} (gitignored). Spoken text: ${transcript.length.toLocaleString()} chars.`)
  L('')
  L('## Source coverage')
  L('')
  L('| Metric | Tusks-Lore (baseline) | Obsidian vault |')
  L('|---|---|---|')
  L(`| Entities | ${Object.keys(baselineIndex?.byEntity ?? {}).length} | ${Object.keys(obs.index.byEntity).length} |`)
  L(`| Alias-map keys | ${Object.keys(baselineIndex?.aliases ?? {}).length} | ${Object.keys(obs.index.aliases).length} |`)
  L(`| Source | ${baselineIndex ? 'frontmatter index' : '(none)'} | ${obs.source} |`)
  L(`| By type | ${byTypeCounts(baselineIndex)} | ${byTypeCounts(obs.index)} |`)
  L('')
  L('## KB token cost (per phase)')
  L('')
  L('| Phase(s) | KB form | Tusks-Lore tokens | Obsidian tokens | Δ |')
  L('|---|---|---|---|---|')
  L(`| 1·2·4 | compact glossary | ${tokens(baseCompact.text).toLocaleString()} | ${tokens(obsCompact.text).toLocaleString()} | ${(tokens(obsCompact.text) - tokens(baseCompact.text)).toLocaleString()} |`)
  L(`| 3·6 | full prose | ${baseFullTok.toLocaleString()} | ${obsFullTok.toLocaleString()} | ${(obsFullTok - baseFullTok).toLocaleString()} |`)
  L('')
  L(`Compact-glossary terms: baseline ${baseCompact.termCount} vs Obsidian ${obsCompact.termCount}. `)
  L(`Obsidian full-prose Mode-B note count: ${obsKbModeB.noteCount}; plain-vs-ModeB tokens: ${tokens(obsKbPlain).toLocaleString()} → ${obsFullTok.toLocaleString()}.`)
  L('')
  L('### Per-chunk retrieval (the efficiency lever — Obsidian-only)')
  L('')
  const retrievalKb = compactRecordsFor(obs.index, present.map((p) => p.canonical))
  const retrievalTok = tokens(retrievalKb)
  L(`Only the **${present.length}** entities actually mentioned in this slice are injected, instead of the full 200-term glossary:`)
  L('')
  L('| KB form (compact phases) | Tokens | vs full glossary |')
  L('|---|---|---|')
  L(`| Full glossary (cached once, then ~10%/chunk) | ${tokens(obsCompact.text).toLocaleString()} | — |`)
  L(`| Per-chunk retrieval (uncached, every chunk) | ${retrievalTok.toLocaleString()} | ${pct(retrievalTok, tokens(obsCompact.text))} of full |`)
  L('')
  L('> Caching caveat: the full glossary is byte-identical across chunks, so it sits in the')
  L('> provider cached prefix (~10% price after chunk 1). Per-chunk retrieval varies per chunk,')
  L('> so it pays full price every chunk. It only needs the vault\'s structured entity graph —')
  L('> the heuristic baseline has no entity boundaries to retrieve by, so this lever is')
  L('> Obsidian-exclusive.')
  L('')
  L('## Grounding accuracy (transcript vs. vault ground truth)')
  L('')
  L(`Ground-truth entities mentioned in this transcript slice: **${present.length}**.`)
  L('')
  L('| Metric | Tusks-Lore | Obsidian |')
  L('|---|---|---|')
  L(`| Spoken entities recognized | ${baseRecognized}/${present.length} (${pct(baseRecognized, present.length)}) | ${obsRecognized}/${present.length} (${pct(obsRecognized, present.length)}) |`)
  L(`| Literal alias→canonical corrections fired | ${litRules(baselineIndex)} | ${litRules(obs.index)} |`)
  L(`| Fuzzy hints inserted (annotateChunk) | ${annotateChunk(transcript, baselineIndex).candidates.length} | ${annotateChunk(transcript, obs.index).candidates.length} |`)
  L('')
  L('### Spoken entities NOT recognized by baseline (Obsidian would add):')
  const missingBase = present.filter((p) => !(baseForms.has(p.matchedForm.toLowerCase()) || baseForms.has(p.canonical.toLowerCase())))
  L(missingBase.length ? missingBase.map((p) => `- ${p.canonical} (heard as "${p.matchedForm}")`).join('\n') : '- (none)')
  L('')
  L('### Fuzzy-hint sample — baseline:')
  L(fuzzySample(baselineIndex, transcript, 12).map((s) => `- ${s}`).join('\n') || '- (none)')
  L('')
  L('### Fuzzy-hint sample — Obsidian:')
  L(fuzzySample(obs.index, transcript, 12).map((s) => `- ${s}`).join('\n') || '- (none)')
  L('')

  const report = lines.join('\n')
  const outDir = path.join(REPO_ROOT, '.diagnose')
  await fs.mkdir(outDir, { recursive: true }).catch(() => {})
  const outPath = path.join(outDir, 'eval-lore-bakeoff.md')
  await fs.writeFile(outPath, report, 'utf8')
  console.log(report)
  console.log(`\n[written] ${path.relative(REPO_ROOT, outPath)}`)
}

function pct(n: number, d: number): string {
  return d === 0 ? '—' : `${Math.round((n / d) * 100)}%`
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
