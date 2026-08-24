// Side-by-side LLM quality run: Tusks-Lore vs. Obsidian vault — MULTI-CHUNK.
//
// Faithfully simulates the pipeline's per-phase chunking on a real transcript
// excerpt, once per lore source, identical model + structure (only the lore
// source varies):
//   - Phase 1 (ground): chunk at P1_SIZE; per chunk apply the source's alias
//     index via preGround (deterministic) + annotateChunk (fuzzy), then the
//     real phase1GroundParts prompt → provider. Concat grounded.
//   - Phase 3 (chronicle): re-chunk the grounded text at P3_SIZE; per chunk the
//     real phase3Chronicle prompt with prior-tail threading → provider. Concat.
//
// Output → .diagnose/eval-quality-<tag>/ (gitignored). No repo writes of
// transcript-derived content.
//
// Env: QUALITY_FIXTURE (path), QUALITY_TAG, EVAL_MODEL, P1_SIZE, P3_SIZE.
// Run with:  npx tsx scripts/lore/eval-quality.ts   (dev server must be on :3001)

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setGlobalDispatcher, Agent } from 'undici'

// The Claude Code CLI can take minutes on a 12k+ char grounding chunk; Node's
// default fetch headers/body timeout (~5 min) can cut a slow-but-valid response
// off. Raise both to 15 min so the provider call isn't the bottleneck.
setGlobalDispatcher(new Agent({ headersTimeout: 900_000, bodyTimeout: 900_000 }))
import { compactKb } from '../../src/lib/kbCompact.js'
import { phase1GroundParts, phase3Chronicle } from '../../src/lib/prompts.js'
import { annotateChunk, aliasIndexToSafeReplacements } from '../../src/lib/aliasMatch.js'
import { buildObsidianKbConcat } from '../../server/lore/obsidian/vaultKb.js'
import { buildObsidianAliasIndex } from '../../server/lore/obsidian/vaultAdapter.js'
import type { AliasIndex } from '../../server/lore/aliasTypes.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..')
const FIXTURE =
  process.env.QUALITY_FIXTURE ??
  path.join(REPO_ROOT, 'scripts', 'playwright-matrix', 'real-session-bakeoff2.sbv')
const TAG = process.env.QUALITY_TAG ?? path.basename(FIXTURE, '.sbv')

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

const TUSKS_LORE = requireEnv('TUSKS_LORE_DIR')
const VAULT_PATH = requireEnv('OBSIDIAN_VAULT')
const SERVER = process.env.SERVER ?? 'http://127.0.0.1:3001'
const MODEL = process.env.EVAL_MODEL ?? 'sonnet'
// Target a fixed number of Phase-1 chunks (default 4, per the requested test);
// the per-chunk size is derived from the transcript so we get exactly N chunks.
const P1_CHUNKS = Number(process.env.P1_CHUNKS ?? 4)
const P3_SIZE = Number(process.env.P3_SIZE ?? 40_000) // Claude P3 chunk

const FRONTMATTER_FENCE_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n+/
const stripFm = (t: string) => t.replace(FRONTMATTER_FENCE_RE, '')
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function sbvToText(sbv: string): string {
  return sbv
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/^\d+:\d\d:\d\d\.\d+,/.test(l))
    .join('\n')
}

/** Greedy line-boundary chunker approximating the pipeline's chunkText. */
function chunkBySize(text: string, size: number): string[] {
  const lines = text.split('\n')
  const chunks: string[] = []
  let cur = ''
  for (const ln of lines) {
    if (cur && cur.length + ln.length + 1 > size) {
      chunks.push(cur)
      cur = ''
    }
    cur += (cur ? '\n' : '') + ln
  }
  if (cur.trim()) chunks.push(cur)
  return chunks
}

async function readTusksLoreDocs(root: string): Promise<Array<{ name: string; text: string }>> {
  const docs: Array<{ name: string; text: string }> = []
  async function walk(rel: string) {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(path.join(root, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const relChild = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (!e.name.startsWith('.') && e.name !== 'Sessions') await walk(relChild)
      } else if (e.isFile() && !e.name.startsWith('.')) {
        const lower = e.name.toLowerCase()
        if (lower.endsWith('.bak') || lower.endsWith('.bak2')) continue
        if (!lower.endsWith('.md') && !lower.endsWith('.txt')) continue
        try {
          docs.push({ name: e.name, text: await fs.readFile(path.join(root, relChild), 'utf8') })
        } catch {
          /* skip */
        }
      }
    }
  }
  await walk('')
  return docs
}

const concat = (docs: Array<{ name: string; text: string }>) =>
  docs.map((d) => `### ${d.name}\n${stripFm(d.text)}`.trim()).join('\n\n---\n\n')

async function generate(prompt: string): Promise<{ text: string; cost: number }> {
  const r = await fetch(`${SERVER}/api/claude-code/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, prompt }),
  })
  if (!r.ok) throw new Error(`generate ${r.status}: ${(await r.text()).slice(0, 300)}`)
  const j = (await r.json()) as { text: string; costUsd?: number }
  return { text: j.text ?? '', cost: j.costUsd ?? 0 }
}

function preGroundLite(text: string, rules: Array<{ from: string; to: string }>): string {
  let out = text
  for (const r of rules) {
    if (!r.from || r.from.toLowerCase() === r.to.toLowerCase()) continue
    const re = new RegExp(`(^|[^A-Za-z0-9])(${escapeRe(r.from)})(?=[^A-Za-z0-9]|$)`, 'g')
    out = out.replace(re, (_m, pre) => `${pre}${r.to}`)
  }
  return out
}

async function runSource(
  label: string,
  fullKb: string,
  index: AliasIndex | null,
  transcript: string,
  p1Size: number,
) {
  const compact = compactKb(fullKb).text
  const rules = aliasIndexToSafeReplacements(index)

  // ── Phase 1: ground each chunk ──
  const p1Chunks = chunkBySize(transcript, p1Size)
  const grounded: string[] = []
  let cost = 0
  let subs = 0
  let hints = 0
  for (let i = 0; i < p1Chunks.length; i++) {
    const pre = preGroundLite(p1Chunks[i], rules)
    const ann = annotateChunk(pre, index)
    hints += ann.candidates.length
    if (pre !== p1Chunks[i]) subs++
    const p1 = phase1GroundParts({ chunk: ann.annotated, kbConcat: compact, index: i, total: p1Chunks.length })
    const out = await generate(`${p1.cacheablePrefix}\n\n${p1.userPrompt}`)
    grounded.push(out.text)
    cost += out.cost
    console.log(`[${label}] P1 chunk ${i + 1}/${p1Chunks.length} grounded (${ann.candidates.length} hints)`)
  }
  const groundedFull = grounded.join('\n')

  // ── Phase 3: chronicle each grounded chunk with prior-tail threading ──
  const p3Chunks = chunkBySize(groundedFull, P3_SIZE)
  const chronicle: string[] = []
  for (let i = 0; i < p3Chunks.length; i++) {
    const priorTail = chronicle.join('\n\n').slice(-2000)
    const prompt = phase3Chronicle({
      groundedChunk: p3Chunks[i],
      dmAnswers: {},
      dmQuestions: [],
      index: i,
      total: p3Chunks.length,
      priorTail,
    })
    const out = await generate(prompt)
    chronicle.push(out.text)
    cost += out.cost
    console.log(`[${label}] P3 chunk ${i + 1}/${p3Chunks.length} chronicled`)
  }

  return {
    groundedFull,
    chronicleFull: chronicle.join('\n\n'),
    cost,
    p1ChunkCount: p1Chunks.length,
    p3ChunkCount: p3Chunks.length,
    subs,
    hints,
  }
}

async function main() {
  const transcript = sbvToText(await fs.readFile(FIXTURE, 'utf8'))
  const p1Size = Math.ceil(transcript.length / P1_CHUNKS)
  console.log(
    `Fixture: ${path.basename(FIXTURE)} | spoken ${transcript.length} chars | model ${MODEL} | targeting ${P1_CHUNKS} P1 chunks (~${p1Size} chars each)`,
  )

  const baseKb = concat(await readTusksLoreDocs(TUSKS_LORE))
  const obsKb = (await buildObsidianKbConcat(VAULT_PATH, { modeB: true })).text
  let baseIndex: AliasIndex | null = null
  try {
    baseIndex = JSON.parse(await fs.readFile(path.join(TUSKS_LORE, '.tusks-lore.index.json'), 'utf8')) as AliasIndex
  } catch {
    /* optional */
  }
  const obsIndex = (await buildObsidianAliasIndex(VAULT_PATH)).index

  const base = await runSource('Tusks-Lore', baseKb, baseIndex, transcript, p1Size)
  const obs = await runSource('Obsidian', obsKb, obsIndex, transcript, p1Size)

  const outDir = path.join(REPO_ROOT, '.diagnose', `eval-quality-${TAG}`)
  await fs.mkdir(outDir, { recursive: true })
  await fs.writeFile(path.join(outDir, 'tusks-lore.ground.md'), base.groundedFull, 'utf8')
  await fs.writeFile(path.join(outDir, 'tusks-lore.chronicle.md'), base.chronicleFull, 'utf8')
  await fs.writeFile(path.join(outDir, 'obsidian.ground.md'), obs.groundedFull, 'utf8')
  await fs.writeFile(path.join(outDir, 'obsidian.chronicle.md'), obs.chronicleFull, 'utf8')

  const cmp = [
    `# Quality run (${TAG}) — Tusks-Lore vs. Obsidian`,
    '',
    `Model: ${MODEL}. Transcript: ${transcript.length} spoken chars → P1 ${base.p1ChunkCount} chunks (~${p1Size}), P3 ${base.p3ChunkCount} chunks (@${P3_SIZE}).`,
    '',
    '| | Tusks-Lore | Obsidian |',
    '|---|---|---|',
    `| P1 chunks w/ alias subs | ${base.subs}/${base.p1ChunkCount} | ${obs.subs}/${obs.p1ChunkCount} |`,
    `| Fuzzy hints total | ${base.hints} | ${obs.hints} |`,
    `| Grounded chars | ${base.groundedFull.length} | ${obs.groundedFull.length} |`,
    `| Chronicle chars | ${base.chronicleFull.length} | ${obs.chronicleFull.length} |`,
    `| Cost USD | ${base.cost.toFixed(4)} | ${obs.cost.toFixed(4)} |`,
    '',
    `Files: .diagnose/eval-quality-${TAG}/{tusks-lore,obsidian}.{ground,chronicle}.md`,
  ].join('\n')
  await fs.writeFile(path.join(outDir, 'COMPARE.md'), cmp, 'utf8')
  console.log('\n' + cmp)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
