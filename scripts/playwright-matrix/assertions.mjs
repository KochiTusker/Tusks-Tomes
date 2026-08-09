// Pure-function assertion suite for the Playwright matrix.
//
// Input: the captured run JSON (refinementState, tokenUsage, settings, routing).
// Output: { passed: string[], warnings: string[], failed: string[] }.
//
// Re-runnable against archived JSON without re-driving the browser. No I/O.

import { SEEDED_ENTITIES } from './scenarios.mjs'

/**
 * @param {Object} capture
 * @param {Object} capture.refinementState - LS_REFINEMENT contents after status === 'done'
 * @param {Array<Object>} capture.tokenUsage - per-call { phase, model, tier, inputTokens, outputTokens, costUsd } entries
 * @param {Object} capture.settings - /api/settings response
 * @param {Object} capture.routing - /api/routing response
 * @param {import('./scenarios.mjs').Scenario} scenario
 * @returns {{ passed: string[], warnings: string[], failed: string[] }}
 */
export function assertRun(capture, scenario) {
  const passed = []
  const warnings = []
  const failed = []
  const state = capture.refinementState ?? {}
  const tokens = capture.tokenUsage ?? []

  function ok(id, msg) { passed.push(`${id}: ${msg}`) }
  function warn(id, msg) { warnings.push(`${id}: ${msg}`) }
  function fail(id, msg) { failed.push(`${id}: ${msg}`) }

  // A1: run reached `done`
  if (state.status === 'done') ok('A1', 'status === done')
  else fail('A1', `status === '${state.status}' (expected 'done')`)

  // A2: chronicle non-empty
  const chronicle = String(state.chronicle ?? '')
  if (chronicle.length > 1000) ok('A2', `chronicle.length=${chronicle.length}`)
  else fail('A2', `chronicle.length=${chronicle.length} (expected > 1000)`)

  // A3: seeded entities present (≥ ~half of canonical names — proxy for grounding quality)
  const total = SEEDED_ENTITIES.length
  const threshold = Math.ceil(total * 0.5)
  const found = SEEDED_ENTITIES.filter(e =>
    new RegExp(e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(chronicle)
  )
  if (found.length >= threshold) ok('A3', `${found.length}/${total} seeded entities present: ${found.join(', ')}`)
  else fail('A3', `only ${found.length}/${total} seeded entities found (threshold ${threshold}): ${found.join(', ')}`)

  // A4: extras has at least one quote
  const extras = state.extras ?? null
  const quoteCount = extras?.quotes?.length ?? 0
  if (extras && quoteCount >= 1) ok('A4', `extras.quotes.length=${quoteCount}`)
  else fail('A4', `extras=${extras ? 'non-null' : 'null'}, quotes=${quoteCount}`)

  // A5: condensed.narrative ≥ 1500 words
  const condensed = state.condensed ?? null
  const narrative = condensed?.narrative ?? ''
  const wc = narrative.trim() ? narrative.trim().split(/\s+/).length : 0
  if (condensed && wc >= 1500) ok('A5', `condensed narrative wc=${wc}`)
  else if (condensed && wc >= 1200) warn('A5', `condensed narrative wc=${wc} (below 1500 floor; tolerable)`)
  else fail('A5', `condensed=${condensed ? 'present' : 'null'}, wc=${wc} (expected >= 1500)`)

  // A6: no prohibited_content escalations
  const prohibitedEvents = tokens.filter(t => t.fallbackReason === 'prohibited_content' || t.event === 'auto_fallback')
  if (prohibitedEvents.length === 0) ok('A6', 'no prohibited_content escalations')
  else if (scenario.hardFails?.prohibitedContent) {
    fail('A6', `${prohibitedEvents.length} prohibited_content events (HARD FAIL for this scenario)`)
  } else {
    warn('A6', `${prohibitedEvents.length} prohibited_content events (recovery worked — warning only for Smart Budget)`)
  }

  // A7: no chunk_fusion_recovered events
  const fusionEvents = tokens.filter(t => t.event === 'chunk_fusion_recovered' || t.fallbackReason === 'chunk_fusion')
  if (fusionEvents.length === 0) ok('A7', 'no chunk fusion recoveries')
  else warn('A7', `${fusionEvents.length} chunk fusion recoveries (safety net engaged — informational)`)

  // A8: no lastError on the run
  if (!state.lastError) ok('A8', 'no lastError')
  else fail('A8', `lastError: ${typeof state.lastError === 'string' ? state.lastError : JSON.stringify(state.lastError).slice(0, 200)}`)

  // A9: cost within band (warning only)
  const totalCost = tokens.reduce((s, t) => s + (t.costUsd ?? 0), 0)
  const [lo, hi] = scenario.costBand ?? [0, Infinity]
  const wider = [lo * 0.5, hi * 1.5]
  if (totalCost >= lo && totalCost <= hi) ok('A9', `cost $${totalCost.toFixed(4)} in band [$${lo}, $${hi}]`)
  else if (totalCost >= wider[0] && totalCost <= wider[1]) {
    warn('A9', `cost $${totalCost.toFixed(4)} outside narrow band [$${lo}, $${hi}] but within ±50% wider band`)
  } else {
    warn('A9', `cost $${totalCost.toFixed(4)} far outside expected band [$${lo}, $${hi}]`)
  }

  // Per-scenario model assertions
  if (scenario.expectedModels) {
    for (const [phase, expected] of Object.entries(scenario.expectedModels)) {
      const calls = tokens.filter(t => t.phase === phase)
      if (calls.length === 0) {
        warn(`M-${phase}`, `no token records for ${phase} (run may have skipped or capture missed)`)
        continue
      }
      const wrong = calls.filter(c => c.model !== expected.model)
      if (wrong.length === 0) ok(`M-${phase}`, `${phase} used ${expected.model} for all ${calls.length} call(s)`)
      else fail(`M-${phase}`, `${phase} expected ${expected.model}, got ${wrong.map(c => c.model).join(', ')}`)
    }
  }

  // Per-scenario settings echo (verifies the POST took effect)
  if (scenario.settingsPatch) {
    for (const [k, v] of Object.entries(scenario.settingsPatch)) {
      const actual = capture.settings?.[k]
      const same = JSON.stringify(actual) === JSON.stringify(v)
      if (same) ok(`S-${k}`, `settings.${k} = ${JSON.stringify(v)}`)
      else warn(`S-${k}`, `settings.${k} expected ${JSON.stringify(v)}, got ${JSON.stringify(actual)}`)
    }
  }

  return { passed, warnings, failed }
}

/** Aggregate per-call token usage into a per-phase summary. */
export function summarizeUsage(tokenUsage) {
  const byPhase = {}
  for (const t of tokenUsage ?? []) {
    const key = t.phase ?? 'unknown'
    if (!byPhase[key]) byPhase[key] = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, models: new Set() }
    byPhase[key].calls += 1
    byPhase[key].inputTokens += t.inputTokens ?? 0
    byPhase[key].outputTokens += t.outputTokens ?? 0
    byPhase[key].costUsd += t.costUsd ?? 0
    if (t.model) byPhase[key].models.add(t.model)
  }
  for (const k of Object.keys(byPhase)) byPhase[k].models = Array.from(byPhase[k].models)
  return byPhase
}
