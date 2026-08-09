// scripts/safety-probe.mjs — empirical safety probe CLI.
//
// No shebang line: scripts/safety-probe.test.mjs imports parseArgs from
// this file, and vitest's esbuild transform crashes with
// "SyntaxError: Invalid or unexpected token" when an imported .mjs has a
// shebang (Windows CI under Node 20 in particular). The npm script
// invokes via `node scripts/safety-probe.mjs`, so the shebang served no
// runtime purpose anyway.
//
// Runs a curated set of D&D content fixtures through the user's configured
// Gemini Paid + Free keys (or just one tier, via --tier), under three prompt
// variants (V0 baseline / V1 TTRPG framing / V2 V1 + meta-framing). Writes
// the matrix to .diagnose/safety-probe-<ISO>.md.
//
// Decision rule: if a variant reduces block-rate ≥ 30pp vs V0 averaged
// across all (tier, model) pairs, the script recommends shipping that
// variant as the TTRPG framing for Gemini. Otherwise it recommends
// shipping the per-phase model recommendation banner.
//
// Usage:
//   npm run safety-probe                                 # default: both tiers, all variants, all fixtures
//   npm run safety-probe -- --tier paid                  # paid only
//   npm run safety-probe -- --tier free --variant V1     # free, V1 only
//   npm run safety-probe -- --phase phase2               # phase 2 only
//   npm run safety-probe -- --max-tokens 32              # per-call token cap (default 64)
//   npm run safety-probe -- --fixture f01_clean,f06_gore # subset of fixtures
//   npm run safety-probe -- --output /tmp/probe.md       # override output path
//   npm run safety-probe -- --models gemini-2.5-flash    # only test this model (default: all probed accessible)
//
// Keys: loaded from running dev server's /api/provider-keys, with .env
// fallback (PAID_GEMINI_API_KEY + VITE_GEMINI_API_KEY).

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runProbe, renderProbeMarkdown, writeProbeMarkdown } from './safety-probe/core.mjs'
import { VARIANTS } from './safety-probe/fixtures.mjs'

const VALID_TIERS = ['paid', 'free', 'both']
const VALID_PHASES = ['phase2', 'phase4', 'both']

/** Parse CLI flags. Returns {tier, variant, phase, fixtures, models, output, maxTokens}. */
export function parseArgs(argv) {
  const out = {
    tier: 'both',
    variants: [...VARIANTS],
    phases: ['phase2', 'phase4'],
    fixtureIds: null,
    models: null,
    output: null,
    maxTokens: 64,
  }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const next = argv[i + 1]
    if (flag === '--tier') {
      if (!VALID_TIERS.includes(next)) throw new Error(`--tier must be one of: ${VALID_TIERS.join(', ')}`)
      out.tier = next
      i++
    } else if (flag === '--variant') {
      if (next === 'all') out.variants = [...VARIANTS]
      else if (VARIANTS.includes(next)) out.variants = [next]
      else throw new Error(`--variant must be one of: V0, V1, V2, all`)
      i++
    } else if (flag === '--phase') {
      if (!VALID_PHASES.includes(next)) throw new Error(`--phase must be one of: ${VALID_PHASES.join(', ')}`)
      out.phases = next === 'both' ? ['phase2', 'phase4'] : [next]
      i++
    } else if (flag === '--fixture' || flag === '--fixtures') {
      out.fixtureIds = next.split(',').map((s) => s.trim()).filter(Boolean)
      i++
    } else if (flag === '--models' || flag === '--model') {
      out.models = next.split(',').map((s) => s.trim()).filter(Boolean)
      i++
    } else if (flag === '--output') {
      out.output = next
      i++
    } else if (flag === '--max-tokens') {
      const n = parseInt(next, 10)
      if (!Number.isFinite(n) || n < 1) throw new Error(`--max-tokens must be a positive integer`)
      out.maxTokens = n
      i++
    } else if (flag === '--help' || flag === '-h') {
      out.help = true
    } else {
      throw new Error(`Unknown argument: ${flag}`)
    }
  }
  return out
}

const HELP_TEXT = `
Safety probe — empirical test of Gemini's PROHIBITED_CONTENT filter on D&D content.

Usage:
  npm run safety-probe [-- <flags>]

Flags:
  --tier paid|free|both     (default: both)
  --variant V0|V1|V2|all    (default: all)
  --phase phase2|phase4|both (default: both)
  --fixture <id1,id2,...>   (default: all 10 fixtures)
  --models <id1,id2,...>    (default: all probed-accessible Gemini models)
  --output <path>           (default: .diagnose/safety-probe-<ISO>.md)
  --max-tokens <n>          (default: 64)
  --help                    show this message

Examples:
  npm run safety-probe
  npm run safety-probe -- --tier paid
  npm run safety-probe -- --variant V1 --fixture f03_graphic_combat,f06_gore
`

/** Load Gemini keys + accessible models. First try the running dev
 *  server's /api/provider-keys; fall back to .env. Returns models as
 *  [{tier, modelId, apiKey}, ...] ready for runProbe. */
export async function loadModels({ tier, requestedModels, fetchImpl }) {
  const fetchFn = fetchImpl ?? fetch
  let paidKey = null
  let freeKey = null
  let paidAccessible = null // list of model ids accessible to paid key
  let freeAccessible = null

  // Try the dev server first. The /api/provider-keys endpoint returns
  // keys as direct strings keyed by provider name (gemini = paid,
  // geminiFallback = free), not nested objects. The .apiKey chain
  // tolerates the alternate shape just in case the endpoint format
  // changes.
  try {
    const res = await fetchFn('http://127.0.0.1:5173/api/provider-keys', {
      signal: AbortSignal.timeout(2000),
    })
    if (res.ok) {
      const body = await res.json()
      if (body && typeof body === 'object') {
        paidKey =
          (typeof body.gemini === 'string' && body.gemini) ||
          body.geminiPaid?.apiKey ||
          body.gemini?.apiKey ||
          null
        freeKey =
          (typeof body.geminiFallback === 'string' && body.geminiFallback) ||
          body.geminiFree?.apiKey ||
          body.geminiFallback?.apiKey ||
          null
      }
    }
  } catch {
    // dev server not running — fall through to .env
  }

  // Fallback to env.
  if (!paidKey) paidKey = process.env.PAID_GEMINI_API_KEY ?? null
  if (!freeKey) freeKey = process.env.VITE_GEMINI_API_KEY ?? null

  // Try to load accessible-models from the probe cache (.diagnose-adjacent
  // file at the platform config dir). If that fails, fall back to a small
  // default set covering the models most users have.
  const fallbackModels = [
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
  ]
  if (!paidAccessible) paidAccessible = fallbackModels
  if (!freeAccessible) freeAccessible = fallbackModels

  // Filter to requested models if --models given.
  const filter = (list) =>
    requestedModels ? list.filter((m) => requestedModels.includes(m)) : list

  const out = []
  if ((tier === 'paid' || tier === 'both') && paidKey) {
    for (const modelId of filter(paidAccessible)) {
      out.push({ tier: 'paid', modelId, apiKey: paidKey })
    }
  }
  if ((tier === 'free' || tier === 'both') && freeKey) {
    for (const modelId of filter(freeAccessible)) {
      out.push({ tier: 'free', modelId, apiKey: freeKey })
    }
  }
  return out
}

/** Simple CLI progress reporter. */
function makeProgressReporter() {
  return (cell, completed, total) => {
    const isBlock =
      cell.outcome === 'prohibited_content' ||
      cell.outcome === 'blocklist' ||
      cell.outcome === 'spii'
    const symbol = isBlock ? '✗' : cell.outcome === 'pass' ? '✓' : '~'
    const summary = `${cell.tier}/${cell.model}/${cell.variant}/${cell.phase}/${cell.fixtureId}`
    process.stdout.write(`[${completed}/${total}] ${symbol} ${cell.outcome} ${summary} (${cell.latencyMs}ms)\n`)
  }
}

async function main() {
  const argv = process.argv.slice(2)
  let args
  try {
    args = parseArgs(argv)
  } catch (err) {
    console.error(`error: ${err.message}`)
    console.error(HELP_TEXT)
    process.exit(2)
  }
  if (args.help) {
    console.log(HELP_TEXT)
    return
  }

  process.stdout.write('Loading Gemini keys (dev server first, .env fallback)…\n')
  const models = await loadModels({ tier: args.tier, requestedModels: args.models })
  if (models.length === 0) {
    console.error(
      'No Gemini keys configured. Either start the dev server (npm run dev) so the probe can read keys from /api/provider-keys, or set PAID_GEMINI_API_KEY / VITE_GEMINI_API_KEY in .env',
    )
    process.exit(1)
  }
  const tiers = [...new Set(models.map((m) => m.tier))]
  const modelIds = [...new Set(models.map((m) => m.modelId))]
  process.stdout.write(
    `Loaded ${models.length} (tier, model) pairs: tiers=[${tiers.join(',')}] models=[${modelIds.join(',')}]\n`,
  )

  const totalCells = models.length * args.variants.length * args.phases.length * (args.fixtureIds?.length ?? 10)
  const estFreeCells = models.filter((m) => m.tier === 'free').length * args.variants.length * args.phases.length * (args.fixtureIds?.length ?? 10)
  process.stdout.write(
    `Planned cells: ${totalCells} (~${estFreeCells} free-tier paced @ 6s = ${(estFreeCells * 6 / 60).toFixed(1)}min minimum)\n\n`,
  )

  const startedAt = new Date().toISOString()
  const controller = new AbortController()
  process.on('SIGINT', () => {
    process.stdout.write('\nReceived SIGINT — finishing current cell and writing partial result…\n')
    controller.abort()
  })

  let result
  try {
    result = await runProbe({
      models,
      variants: args.variants,
      phases: args.phases,
      fixtureIds: args.fixtureIds,
      maxOutputTokens: args.maxTokens,
      onProgress: makeProgressReporter(),
      signal: controller.signal,
    })
  } catch (err) {
    if (err?.name === 'AbortError') {
      process.stdout.write('Aborted before any cell completed.\n')
      process.exit(130)
    }
    throw err
  }

  const finishedAt = new Date().toISOString()
  const partial = controller.signal.aborted
  const markdown = renderProbeMarkdown({ result, startedAt, finishedAt, partial })
  let written
  if (args.output) {
    await fs.writeFile(args.output + '.tmp', markdown, 'utf8')
    await fs.rename(args.output + '.tmp', args.output)
    written = { path: path.resolve(args.output), filename: path.basename(args.output) }
  } else {
    const __filename = fileURLToPath(import.meta.url)
    const repoRoot = path.resolve(path.dirname(__filename), '..')
    written = await writeProbeMarkdown(markdown, { repoRoot, partial })
  }

  process.stdout.write(`\n✓ Probe complete. Result: ${written.path}\n`)
  process.stdout.write(`Recommendation: ${result.recommendation.decision}\n`)
  process.stdout.write(`Reasoning: ${result.recommendation.reasoning}\n`)
}

// Run as CLI only when invoked directly (not when imported as a module
// for testing).
const __filename = fileURLToPath(import.meta.url)
const isCliEntry = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)
if (isCliEntry) {
  main().catch((err) => {
    console.error(`Probe failed: ${err.message ?? err}`)
    if (err.stack) console.error(err.stack)
    process.exit(1)
  })
}
