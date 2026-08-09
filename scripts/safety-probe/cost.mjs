// Cost meter for hybrid-validation tests. Pure JS, no pipeline coupling.
//
// Inputs: a list of chunk-finished records that each carry `{phase, tier,
// model, usage: {inputTokens, outputTokens, cachedInputTokens?}}`. The
// shape matches the `chunk_finished` vlog payload from
// `src/lib/pipeline.ts:390-398` so the meter doubles as a downstream
// helper for the diagnose bundle / safety probe.
//
// Pricing: hand-maintained table of Gemini per-million-token rates.
// Free-tier counts as $0 — that's the entire reason hybrid is interesting.
//
// Source for the rates: https://ai.google.dev/pricing (as of 2025-05-25).
// If Google updates the rates, edit GEMINI_PRICING below; no other code
// needs to change. The drift-guard test in cost.test.mjs locks down the
// shape so a malformed edit fails loud.

/**
 * Per-million-token USD pricing for Gemini models.
 * Free-tier rows are explicitly $0 — Free quota is free in dollars
 * (it costs us in daily allowance, but that's a different axis).
 *
 * Paid-tier prices reflect the public pay-as-you-go rates for the
 * generativelanguage.googleapis.com API as of mid-2025. The official
 * rates are split by prompt-size band for some models (e.g. ≤128K vs
 * >128K). We use the lower band — our chunks live well below 128K.
 *
 * @typedef {{ input: number; output: number; cachedInput?: number }} ModelRate
 * @typedef {'paid' | 'free' | 'auto'} GeminiTier
 */
export const GEMINI_PRICING = {
  paid: {
    'gemini-2.5-pro':         { input: 1.25, output: 10.00, cachedInput: 0.31 },
    'gemini-2.5-flash':       { input: 0.30, output:  2.50, cachedInput: 0.075 },
    'gemini-2.5-flash-lite':  { input: 0.10, output:  0.40, cachedInput: 0.025 },
    'gemini-2.0-flash':       { input: 0.10, output:  0.40 },
    'gemini-2.0-flash-lite':  { input: 0.075, output: 0.30 },
    'gemini-3-pro':           { input: 1.25, output: 10.00, cachedInput: 0.31 },
    'gemini-3.5-flash':       { input: 0.30, output:  2.50, cachedInput: 0.075 },
  },
  free: {
    // Every model is $0 on Free — quota is the cost axis, not dollars.
    // Wildcard handled by costForCell() when the tier is 'free'.
  },
}

/** Token-bucket fallback when a model id isn't in the table. Pessimistic:
 *  assume Pro rates. Logs once per missing model to surface drift. */
const FALLBACK_RATE = { input: 1.25, output: 10.00 }
const _missingModelsLogged = new Set()
function rateFor(tier, model) {
  if (tier === 'free') return { input: 0, output: 0, cachedInput: 0 }
  const table = GEMINI_PRICING[tier === 'auto' ? 'paid' : tier] ?? GEMINI_PRICING.paid
  const exact = table[model]
  if (exact) return exact
  // Heuristic fallback for unknown model strings (e.g. preview models)
  const m = String(model || '').toLowerCase()
  if (m.includes('lite')) return table['gemini-2.5-flash-lite'] ?? FALLBACK_RATE
  if (m.includes('flash')) return table['gemini-2.5-flash'] ?? FALLBACK_RATE
  if (m.includes('pro')) return table['gemini-2.5-pro'] ?? FALLBACK_RATE
  if (!_missingModelsLogged.has(model)) {
    _missingModelsLogged.add(model)
    console.warn(`[cost] no rate for "${model}" on tier ${tier}; using Pro fallback`)
  }
  return FALLBACK_RATE
}

/** Compute the USD cost of a single cell. Returns 0 for Free tier. */
export function costForCell({ tier, model, usage }) {
  if (!usage) return 0
  const rate = rateFor(tier, model)
  const inputTok = usage.inputTokens ?? 0
  const cachedTok = usage.cachedInputTokens ?? 0
  const outputTok = usage.outputTokens ?? 0
  // Cached input is billed at the cachedInput rate; uncached input at the
  // input rate. If the model has no cachedInput rate, treat all input as
  // uncached.
  const cachedRate = rate.cachedInput ?? rate.input
  const uncachedTok = Math.max(0, inputTok - cachedTok)
  const dollars =
    (uncachedTok * rate.input + cachedTok * cachedRate + outputTok * rate.output) /
    1_000_000
  return dollars
}

/** Aggregate a list of cells by phase, returning per-phase totals + grand
 *  total. Each cell must carry `{phase, tier, model, usage}`. The phase
 *  field is the canonical PipelineEvent phase id ('phase1_ground',
 *  'phase2_audit', etc.). */
export function aggregate(cells) {
  const byPhase = new Map()
  let totalDollars = 0
  let totalInput = 0
  let totalOutput = 0
  let totalCached = 0
  for (const cell of cells) {
    if (!cell?.usage) continue
    const phase = cell.phase ?? 'unknown'
    const tier = cell.tier ?? 'unknown'
    const model = cell.model ?? 'unknown'
    const dollars = costForCell(cell)
    let bucket = byPhase.get(phase)
    if (!bucket) {
      bucket = {
        phase,
        chunks: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        dollars: 0,
        tiers: new Set(),
        models: new Set(),
      }
      byPhase.set(phase, bucket)
    }
    bucket.chunks += 1
    bucket.inputTokens += cell.usage.inputTokens ?? 0
    bucket.outputTokens += cell.usage.outputTokens ?? 0
    bucket.cachedInputTokens += cell.usage.cachedInputTokens ?? 0
    bucket.dollars += dollars
    bucket.tiers.add(tier)
    bucket.models.add(model)
    totalDollars += dollars
    totalInput += cell.usage.inputTokens ?? 0
    totalOutput += cell.usage.outputTokens ?? 0
    totalCached += cell.usage.cachedInputTokens ?? 0
  }
  // Sort buckets by phase name (phase1 → phase6) for stable output
  const perPhase = [...byPhase.values()]
    .map((b) => ({
      phase: b.phase,
      chunks: b.chunks,
      inputTokens: b.inputTokens,
      outputTokens: b.outputTokens,
      cachedInputTokens: b.cachedInputTokens,
      dollars: b.dollars,
      tiers: [...b.tiers],
      models: [...b.models],
    }))
    .sort((a, b) => a.phase.localeCompare(b.phase))
  return {
    perPhase,
    totals: {
      chunks: cells.filter((c) => c?.usage).length,
      inputTokens: totalInput,
      outputTokens: totalOutput,
      cachedInputTokens: totalCached,
      dollars: totalDollars,
    },
  }
}

/** Scrape `chunk_finished` events out of a vlog ring snapshot and shape
 *  them into the cells aggregate() expects. The ring is the output of
 *  `window.__tusk.dumpRecentEvents()` or the merged ring inside a
 *  diagnose bundle.
 *
 *  Ring entry shape: { ts, source, cat, payload }. `payload.event ===
 *  'chunk_finished'` with `payload.usage` populated.
 */
export function cellsFromRing(ring) {
  const cells = []
  for (const entry of ring) {
    if (entry?.cat !== 'chunk') continue
    const p = entry.payload
    if (!p || p.event !== 'chunk_finished') continue
    cells.push({
      phase: p.phase ?? 'unknown',
      tier: p.tier ?? 'unknown',
      model: p.model ?? 'unknown',
      usage: p.usage,
      index: p.index,
      latencyMs: p.latencyMs,
    })
  }
  return cells
}

/** Format dollars as a short USD string for human-readable output.
 *  $0.00012345 → '$0.0001'; $0.45 → '$0.45'; $123.456 → '$123.46'. */
export function formatDollars(d) {
  if (!Number.isFinite(d)) return '$?'
  if (d < 0.01) return `$${d.toFixed(4)}`
  if (d < 1) return `$${d.toFixed(3)}`
  return `$${d.toFixed(2)}`
}
