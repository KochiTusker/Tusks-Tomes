#!/usr/bin/env node
// hybrid-validate.mjs — end-to-end validation of the Gemini Paid+Free
// hybrid pipeline. Runs a 11.5KB synthetic D&D fixture through Phase 1
// (ground) → Phase 2 (audit) → Phase 3 (chronicle) → Phase 4 (extras)
// against a chosen tier configuration. Captures per-chunk tokens +
// dispatched tier, computes cost via the meter, scores lore accuracy
// via the harness, and writes a JSON report to
// .diagnose/hybrid-validation-<config>-<ISO>.json.
//
// Usage:
//   npm run hybrid-validate -- --config paid           # T4.1 — Paid-only baseline
//   npm run hybrid-validate -- --config auto           # T4.2 — Auto (no fallback expected)
//   npm run hybrid-validate -- --config manual         # T4.3 — Manual per-phase (Free P1+P2, Paid P3+P4)
//   npm run hybrid-validate -- --config single         # T2.x — Single chunk dispatch verification
//   npm run hybrid-validate -- --config single --tier free --model gemini-2.5-flash
//
// Outputs:
//   .diagnose/hybrid-validation-<config>-<ISO>.json
//
// Keys: loaded via /api/provider-keys from running dev server, .env fallback.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  phase1Ground,
  phase2Audit,
  phase3Chronicle,
  phase4Extras,
} from './prompts.mjs'
import { FIXTURE_E2E, SEEDED_ENTITIES, fixtureStats } from './fixtures-e2e.mjs'
import { aggregate, costForCell, formatDollars } from './cost.mjs'
import { scoreRun } from './lore-accuracy.mjs'

/** The four routing configurations under test. */
const CONFIGS = {
  paid: {
    label: 'Paid-only (T4.1 baseline)',
    perPhase: {
      phase1_ground:    { tier: 'paid', model: 'gemini-2.5-pro' },
      phase2_audit:     { tier: 'paid', model: 'gemini-2.5-pro' },
      phase3_chronicle: { tier: 'paid', model: 'gemini-2.5-pro' },
      phase4_extras:    { tier: 'paid', model: 'gemini-2.5-pro' },
    },
    chunkSizeChars: 30_000,
  },
  auto: {
    label: 'Auto (T4.2)',
    perPhase: {
      // Same as paid — auto only differs at runtime in the real provider
      // (it flips on quota errors). For our test which has Paid quota
      // healthy, auto should dispatch identically to paid.
      phase1_ground:    { tier: 'paid', model: 'gemini-2.5-pro' },
      phase2_audit:     { tier: 'paid', model: 'gemini-2.5-pro' },
      phase3_chronicle: { tier: 'paid', model: 'gemini-2.5-pro' },
      phase4_extras:    { tier: 'paid', model: 'gemini-2.5-pro' },
    },
    chunkSizeChars: 30_000,
    autoMode: true, // mark in the output so the report knows
  },
  manual: {
    label: 'Manual per-phase (T4.3 headline — user actual config)',
    perPhase: {
      phase1_ground:    { tier: 'free', model: 'gemini-2.5-flash' },
      phase2_audit:     { tier: 'free', model: 'gemini-2.5-flash' },
      phase3_chronicle: { tier: 'paid', model: 'gemini-2.5-pro' },
      phase4_extras:    { tier: 'paid', model: 'gemini-2.5-flash-lite' },
    },
    chunkSizeChars: 8_000, // sized for Free Flash
  },
}

const VALID_TIERS = ['paid', 'free']

/** Parse CLI flags. */
export function parseArgs(argv) {
  const out = {
    config: 'paid',
    tier: null,
    model: null,
    output: null,
    maxOutputTokens: 8000,
    dryRun: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const next = argv[i + 1]
    if (flag === '--config') {
      if (!['paid', 'auto', 'manual', 'single'].includes(next)) {
        throw new Error(`--config must be one of: paid, auto, manual, single`)
      }
      out.config = next
      i++
    } else if (flag === '--tier') {
      if (!VALID_TIERS.includes(next)) throw new Error(`--tier must be paid or free`)
      out.tier = next
      i++
    } else if (flag === '--model') {
      out.model = next
      i++
    } else if (flag === '--output') {
      out.output = next
      i++
    } else if (flag === '--max-output-tokens') {
      const n = parseInt(next, 10)
      if (!Number.isFinite(n) || n < 1) throw new Error(`--max-output-tokens must be positive`)
      out.maxOutputTokens = n
      i++
    } else if (flag === '--dry-run') {
      out.dryRun = true
    } else if (flag === '--help' || flag === '-h') {
      out.help = true
    } else {
      throw new Error(`Unknown flag: ${flag}`)
    }
  }
  return out
}

/** Load keys from dev server, .env fallback. Returns
 *  { paidKey, freeKey, paidFingerprint, freeFingerprint }. */
async function loadKeys() {
  let paidKey = null
  let freeKey = null
  try {
    const res = await fetch('http://127.0.0.1:5173/api/provider-keys', {
      signal: AbortSignal.timeout(2000),
    })
    if (res.ok) {
      const body = await res.json()
      paidKey = typeof body.gemini === 'string' ? body.gemini : null
      freeKey = typeof body.geminiFallback === 'string' ? body.geminiFallback : null
    }
  } catch {/* server down — fall through */}
  if (!paidKey) paidKey = process.env.PAID_GEMINI_API_KEY ?? null
  if (!freeKey) freeKey = process.env.VITE_GEMINI_API_KEY ?? null
  return {
    paidKey,
    freeKey,
    paidFingerprint: paidKey ? await fingerprint(paidKey) : null,
    freeFingerprint: freeKey ? await fingerprint(freeKey) : null,
  }
}

/** 6-char SHA-256 prefix of a key — same convention as the rest of the
 *  codebase (gemini.ts:activeKeyFingerprint). */
async function fingerprint(key) {
  const crypto = await import('node:crypto')
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 6)
}

/** Resolve the key + fingerprint for a tier. Returns { key, fingerprint }. */
function keyForTier(tier, keys) {
  if (tier === 'paid') return { key: keys.paidKey, fingerprint: keys.paidFingerprint }
  if (tier === 'free') return { key: keys.freeKey, fingerprint: keys.freeFingerprint }
  throw new Error(`Unknown tier: ${tier}`)
}

/** Send a prompt to Gemini, return { text, usage, latencyMs, error? }. */
async function callGemini({ apiKey, model, prompt, maxOutputTokens, signal }) {
  const t0 = Date.now()
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            maxOutputTokens,
            temperature: 0.3, // slightly creative for chronicle prose
          },
          safetySettings: [
            { category: 'HARM_CATEGORY_HARASSMENT',         threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_HATE_SPEECH',        threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',  threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT',  threshold: 'BLOCK_NONE' },
          ],
        }),
        signal,
      },
    )
    const latencyMs = Date.now() - t0
    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      return {
        text: '',
        usage: { inputTokens: 0, outputTokens: 0 },
        latencyMs,
        error: `HTTP ${res.status}: ${errBody.slice(0, 300)}`,
      }
    }
    const json = await res.json()
    const text = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
    const usage = {
      inputTokens: json?.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: json?.usageMetadata?.candidatesTokenCount ?? 0,
      cachedInputTokens: json?.usageMetadata?.cachedContentTokenCount ?? undefined,
    }
    // Classify block reasons for downstream reporting
    const blockReason = json?.promptFeedback?.blockReason ?? json?.candidates?.[0]?.finishReason
    return {
      text,
      usage,
      latencyMs,
      blockReason: typeof blockReason === 'string' && blockReason !== 'STOP' ? blockReason : undefined,
    }
  } catch (err) {
    return {
      text: '',
      usage: { inputTokens: 0, outputTokens: 0 },
      latencyMs: Date.now() - t0,
      error: `Network: ${err?.message ?? String(err)}`,
    }
  }
}

/** Chunk text on character count + sentence-end boundaries. Very simple —
 *  not byte-identical to the canonical chunker but good enough for the
 *  end-to-end product check (the user cares about OUTPUT, not the path). */
function chunkText(text, targetSize) {
  if (text.length <= targetSize) return [text]
  const chunks = []
  let cursor = 0
  while (cursor < text.length) {
    let end = Math.min(cursor + targetSize, text.length)
    if (end < text.length) {
      // Look back up to 500 chars for a sentence end (".\n", "?\n", "!\n", or "\n\n")
      const lookback = text.slice(Math.max(cursor, end - 500), end)
      const m = lookback.match(/[.!?]\n|\n\n/g)
      if (m) {
        const lastBoundary = lookback.lastIndexOf(m[m.length - 1])
        end = Math.max(cursor, end - 500) + lastBoundary + m[m.length - 1].length
      }
    }
    chunks.push(text.slice(cursor, end))
    cursor = end
  }
  return chunks
}

/** Run the full pipeline against the fixture for a given config. */
async function runPipeline({ config, keys, maxOutputTokens, dryRun }) {
  const cells = []
  const log = (msg) => process.stdout.write(`  ${msg}\n`)

  // ── Phase 1 — Ground ──────────────────────────────────────────────
  const p1Config = config.perPhase.phase1_ground
  const { key: p1Key, fingerprint: p1Fp } = keyForTier(p1Config.tier, keys)
  if (!p1Key) throw new Error(`No ${p1Config.tier} key configured — cannot run Phase 1`)
  log(`Phase 1 (ground): tier=${p1Config.tier} model=${p1Config.model} fp=${p1Fp}`)
  const p1Chunks = chunkText(FIXTURE_E2E, config.chunkSizeChars)
  log(`  ${p1Chunks.length} chunk(s) at ${config.chunkSizeChars} chars each`)
  let groundedTranscript = ''
  for (let i = 0; i < p1Chunks.length; i++) {
    const prompt = phase1Ground({
      chunk: p1Chunks[i],
      kbConcat: '',
      index: i,
      total: p1Chunks.length,
    })
    if (dryRun) {
      log(`  [DRY] chunk ${i+1}/${p1Chunks.length} would call ${p1Config.model} (${prompt.length} chars)`)
      groundedTranscript += p1Chunks[i]
      continue
    }
    const result = await callGemini({
      apiKey: p1Key,
      model: p1Config.model,
      prompt,
      // Phase 1 outputs a near-1:1 corrected transcript — output token
      // count is roughly proportional to input. The canonical pipeline
      // uses MAX_OUTPUT_TOKENS = 32_768. Use that here so Phase 1 doesn't
      // truncate (which was the MAX_TOKENS issue on the first run).
      maxOutputTokens: 32_000,
    })
    cells.push({
      phase: 'phase1_ground',
      tier: p1Config.tier,
      model: p1Config.model,
      keyFingerprint: p1Fp,
      index: i,
      totalChunks: p1Chunks.length,
      usage: result.usage,
      latencyMs: result.latencyMs,
      error: result.error,
      blockReason: result.blockReason,
      outputChars: result.text.length,
    })
    log(`  ✓ chunk ${i+1}/${p1Chunks.length} — ${result.usage.inputTokens}+${result.usage.outputTokens} tok, ${result.latencyMs}ms${result.error ? ' (ERROR: ' + result.error.slice(0, 60) + ')' : ''}${result.blockReason ? ' [' + result.blockReason + ']' : ''}`)
    groundedTranscript += (result.text || p1Chunks[i]) + '\n\n'
  }

  // ── Phase 2 — Audit ───────────────────────────────────────────────
  const p2Config = config.perPhase.phase2_audit
  const { key: p2Key, fingerprint: p2Fp } = keyForTier(p2Config.tier, keys)
  if (!p2Key) throw new Error(`No ${p2Config.tier} key configured — cannot run Phase 2`)
  log(`Phase 2 (audit): tier=${p2Config.tier} model=${p2Config.model} fp=${p2Fp}`)
  const p2Chunks = chunkText(groundedTranscript, config.chunkSizeChars)
  const allQuestions = []
  for (let i = 0; i < p2Chunks.length; i++) {
    const prompt = phase2Audit({
      rawChunk: p2Chunks[i],
      groundedChunk: p2Chunks[i],
      index: i,
      total: p2Chunks.length,
    })
    if (dryRun) {
      log(`  [DRY] chunk ${i+1}/${p2Chunks.length} would call ${p2Config.model}`)
      continue
    }
    const result = await callGemini({
      apiKey: p2Key,
      model: p2Config.model,
      prompt,
      maxOutputTokens: 2000, // Phase 2 produces JSON arrays, much smaller
    })
    cells.push({
      phase: 'phase2_audit',
      tier: p2Config.tier,
      model: p2Config.model,
      keyFingerprint: p2Fp,
      index: i,
      totalChunks: p2Chunks.length,
      usage: result.usage,
      latencyMs: result.latencyMs,
      error: result.error,
      blockReason: result.blockReason,
      outputChars: result.text.length,
    })
    log(`  ✓ chunk ${i+1}/${p2Chunks.length} — ${result.usage.inputTokens}+${result.usage.outputTokens} tok, ${result.latencyMs}ms${result.blockReason ? ' [' + result.blockReason + ']' : ''}`)
    // Parse questions from JSON (best-effort — Phase 2 typically returns [] for clean content)
    try {
      const parsed = JSON.parse(result.text.trim())
      if (Array.isArray(parsed)) allQuestions.push(...parsed)
    } catch {/* not JSON or empty — proceed without questions */}
  }
  log(`  Phase 2 surfaced ${allQuestions.length} clarification question(s)`)

  // ── Phase 3 — Chronicle ───────────────────────────────────────────
  const p3Config = config.perPhase.phase3_chronicle
  const { key: p3Key, fingerprint: p3Fp } = keyForTier(p3Config.tier, keys)
  if (!p3Key) throw new Error(`No ${p3Config.tier} key configured — cannot run Phase 3`)
  log(`Phase 3 (chronicle): tier=${p3Config.tier} model=${p3Config.model} fp=${p3Fp}`)
  // Chronicle uses a larger chunk size (60K on Paid Pro, 35K on Free Flash)
  const p3ChunkSize = p3Config.tier === 'paid' && p3Config.model.includes('pro') ? 60_000 : 30_000
  const p3Chunks = chunkText(groundedTranscript, p3ChunkSize)
  let chronicleText = ''
  for (let i = 0; i < p3Chunks.length; i++) {
    const priorTail = i > 0 ? chronicleText.slice(-2000) : ''
    const prompt = phase3Chronicle({
      groundedChunk: p3Chunks[i],
      dmAnswers: {},
      dmQuestions: allQuestions,
      index: i,
      total: p3Chunks.length,
      priorTail,
    })
    if (dryRun) {
      log(`  [DRY] chunk ${i+1}/${p3Chunks.length} would call ${p3Config.model}`)
      continue
    }
    const result = await callGemini({
      apiKey: p3Key,
      model: p3Config.model,
      prompt,
      maxOutputTokens: 16000, // Chronicle is the largest output
    })
    cells.push({
      phase: 'phase3_chronicle',
      tier: p3Config.tier,
      model: p3Config.model,
      keyFingerprint: p3Fp,
      index: i,
      totalChunks: p3Chunks.length,
      usage: result.usage,
      latencyMs: result.latencyMs,
      error: result.error,
      blockReason: result.blockReason,
      outputChars: result.text.length,
    })
    log(`  ✓ chunk ${i+1}/${p3Chunks.length} — ${result.usage.inputTokens}+${result.usage.outputTokens} tok, ${result.latencyMs}ms${result.blockReason ? ' [' + result.blockReason + ']' : ''}`)
    chronicleText += (result.text || '') + '\n\n'
  }

  // ── Phase 4 — Extras ──────────────────────────────────────────────
  const p4Config = config.perPhase.phase4_extras
  const { key: p4Key, fingerprint: p4Fp } = keyForTier(p4Config.tier, keys)
  if (!p4Key) throw new Error(`No ${p4Config.tier} key configured — cannot run Phase 4`)
  log(`Phase 4 (extras): tier=${p4Config.tier} model=${p4Config.model} fp=${p4Fp}`)
  // Phase 4 also uses larger chunks
  const p4ChunkSize = p4Config.tier === 'paid' && p4Config.model.includes('lite') ? 30_000 : 60_000
  const p4Chunks = chunkText(groundedTranscript, p4ChunkSize)
  const extras = { jests: [], gore: [], quotes: [] }
  for (let i = 0; i < p4Chunks.length; i++) {
    const prompt = phase4Extras({
      groundedChunk: p4Chunks[i],
      dmAnswers: {},
      index: i,
      total: p4Chunks.length,
    })
    if (dryRun) {
      log(`  [DRY] chunk ${i+1}/${p4Chunks.length} would call ${p4Config.model}`)
      continue
    }
    const result = await callGemini({
      apiKey: p4Key,
      model: p4Config.model,
      prompt,
      maxOutputTokens: 4000,
    })
    cells.push({
      phase: 'phase4_extras',
      tier: p4Config.tier,
      model: p4Config.model,
      keyFingerprint: p4Fp,
      index: i,
      totalChunks: p4Chunks.length,
      usage: result.usage,
      latencyMs: result.latencyMs,
      error: result.error,
      blockReason: result.blockReason,
      outputChars: result.text.length,
    })
    log(`  ✓ chunk ${i+1}/${p4Chunks.length} — ${result.usage.inputTokens}+${result.usage.outputTokens} tok, ${result.latencyMs}ms${result.blockReason ? ' [' + result.blockReason + ']' : ''}`)
    try {
      const parsed = JSON.parse(result.text.trim())
      if (Array.isArray(parsed?.jests)) extras.jests.push(...parsed.jests.filter(Boolean))
      if (Array.isArray(parsed?.gore)) extras.gore.push(...parsed.gore.filter(Boolean))
      if (Array.isArray(parsed?.quotes)) extras.quotes.push(...parsed.quotes.filter((q) => q?.speaker && q?.line))
    } catch {/* not JSON, skip */}
  }

  return {
    cells,
    chronicleText: chronicleText.trim(),
    extras,
    questions: allQuestions,
  }
}

async function main() {
  const argv = process.argv.slice(2)
  let args
  try {
    args = parseArgs(argv)
  } catch (err) {
    console.error(`error: ${err.message}`)
    process.exit(2)
  }
  if (args.help) {
    console.log(`hybrid-validate — Phase 8 hybrid Gemini empirical validation

Usage:
  npm run hybrid-validate -- --config <paid|auto|manual|single>

Flags:
  --config <name>            paid | auto | manual | single
  --tier <paid|free>         (single config only) which tier to dispatch to
  --model <id>               (single config only) which model to use
  --output <path>            override output path
  --max-output-tokens <n>    per-call output cap (default 8000)
  --dry-run                  print what would be called, don't actually call
  --help                     this message
`)
    return
  }

  const keys = await loadKeys()
  process.stdout.write(`Keys loaded: paid=${keys.paidFingerprint ?? '(missing)'}, free=${keys.freeFingerprint ?? '(missing)'}\n`)

  const stats = fixtureStats()
  process.stdout.write(`Fixture: ${stats.chars} chars, ${stats.seededEntityCount} seeded entities\n`)

  if (args.config === 'single') {
    // Single-chunk dispatch verification (T2.x)
    const tier = args.tier ?? 'paid'
    const model = args.model ?? 'gemini-2.5-pro'
    const { key, fingerprint: fp } = keyForTier(tier, keys)
    if (!key) {
      console.error(`No ${tier} key configured`)
      process.exit(1)
    }
    process.stdout.write(`\nT2.x — Single-chunk dispatch: tier=${tier} model=${model} fp=${fp}\n`)
    const chunk = chunkText(FIXTURE_E2E, 30_000)[0]
    const prompt = phase1Ground({ chunk, kbConcat: '', index: 0, total: 1 })
    const result = await callGemini({ apiKey: key, model, prompt, maxOutputTokens: args.maxOutputTokens })
    process.stdout.write(`Result: ${result.usage.inputTokens}+${result.usage.outputTokens} tokens, ${result.latencyMs}ms${result.error ? ' ERROR: ' + result.error : ''}${result.blockReason ? ' blockReason=' + result.blockReason : ''}\n`)
    process.stdout.write(`Cost: ${formatDollars(costForCell({ tier, model, usage: result.usage }))}\n`)
    return
  }

  const config = CONFIGS[args.config]
  if (!config) {
    console.error(`Unknown config: ${args.config}`)
    process.exit(1)
  }

  process.stdout.write(`\n══ Config: ${config.label} ══\n\n`)
  const startedAt = new Date().toISOString()
  const { cells, chronicleText, extras, questions } = await runPipeline({
    config,
    keys,
    maxOutputTokens: args.maxOutputTokens,
    dryRun: args.dryRun,
  })
  const finishedAt = new Date().toISOString()

  if (args.dryRun) {
    process.stdout.write('\n[DRY RUN] Skipping cost + accuracy aggregation.\n')
    return
  }

  // Aggregate cost
  const costReport = aggregate(cells)
  // Score accuracy
  const accuracyReport = scoreRun({
    chronicleText,
    extras,
    seeded: SEEDED_ENTITIES,
  })

  const report = {
    config: args.config,
    label: config.label,
    startedAt,
    finishedAt,
    fixture: {
      chars: FIXTURE_E2E.length,
      seededEntities: SEEDED_ENTITIES,
    },
    perPhase: config.perPhase,
    cells,
    cost: costReport,
    accuracy: accuracyReport,
    chronicle: {
      chars: chronicleText.length,
      text: chronicleText,
    },
    extras,
    questions,
  }

  // Write output
  const isoStamp = new Date().toISOString().replace(/[:.]/g, '-')
  const __filename = fileURLToPath(import.meta.url)
  // __filename = D:/Tusks-Tomes/scripts/safety-probe/hybrid-validate.mjs
  // dirname    = D:/Tusks-Tomes/scripts/safety-probe
  // ../../    = D:/Tusks-Tomes (the repo root)
  const repoRoot = path.resolve(path.dirname(__filename), '..', '..')
  const outPath = args.output ?? path.join(repoRoot, '.diagnose', `hybrid-validation-${args.config}-${isoStamp}.json`)
  await fs.mkdir(path.dirname(outPath), { recursive: true })
  await fs.writeFile(outPath + '.tmp', JSON.stringify(report, null, 2), 'utf8')
  await fs.rename(outPath + '.tmp', outPath)

  // Print summary
  process.stdout.write('\n══ Summary ══\n')
  process.stdout.write(`Cost: ${formatDollars(costReport.totals.dollars)} (${costReport.totals.inputTokens}+${costReport.totals.outputTokens} tokens)\n`)
  for (const phase of costReport.perPhase) {
    process.stdout.write(`  ${phase.phase}: ${phase.chunks} chunk(s), ${formatDollars(phase.dollars)} (${phase.tiers.join('+')} via ${phase.models.join('+')})\n`)
  }
  process.stdout.write(`\nAccuracy:\n`)
  process.stdout.write(`  Speakers: ${(accuracyReport.chronicle.speakerScore * 100).toFixed(0)}% (${Object.entries(accuracyReport.chronicle.details.speakers).filter(([, v]) => v).map(([k]) => k).join(', ')})\n`)
  process.stdout.write(`  Entities: ${(accuracyReport.chronicle.entityScore * 100).toFixed(0)}% (${Object.entries(accuracyReport.chronicle.details.entities).filter(([, v]) => v).map(([k]) => k).join(', ')})\n`)
  process.stdout.write(`  Chronicle: ${chronicleText.length} chars\n`)
  process.stdout.write(`  Extras: ${extras.jests.length} jests, ${extras.gore.length} gore, ${extras.quotes.length} quotes\n`)
  process.stdout.write(`  Composite accuracy: ${(accuracyReport.finalAccuracy * 100).toFixed(1)}%\n`)
  process.stdout.write(`\nReport: ${outPath}\n`)
}

const __filename = fileURLToPath(import.meta.url)
const isCliEntry = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)
if (isCliEntry) {
  main().catch((err) => {
    console.error(`hybrid-validate failed: ${err.message ?? err}`)
    if (err.stack) console.error(err.stack)
    process.exit(1)
  })
}
