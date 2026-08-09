// Browser-accessible pricing + cost-estimation for the pipeline.
//
// Mirrors the rates in scripts/safety-probe/cost.mjs (kept as separate
// module to avoid coupling a browser bundle to a script). When Google /
// Anthropic / OpenAI update prices, edit BOTH files — the drift-guard
// test in cost.test.mjs locks down the script-side shape; a TS test
// here would lock down this side.
//
// All rates are USD per million tokens. USD → GBP conversion is left to
// the UI (we don't ship a live FX feed; use a fixed conversion or just
// show USD).

import type { CloudProvider } from './profiles'
import type { GeminiTier } from './providers/gemini'
import { cloudProfileFor, cloudChunkSize, type CloudProfile } from './chunking'

export interface ModelRate {
  input: number
  output: number
  /** Cached prompt-prefix rate (Gemini explicit-cache; not all models have it). */
  cachedInput?: number
}

/** Per-million-token USD pricing for Gemini models. Paid only — Free is $0. */
export const GEMINI_PRICING: Record<'paid', Record<string, ModelRate>> = {
  paid: {
    'gemini-2.5-pro':         { input: 1.25, output: 10.00, cachedInput: 0.31 },
    'gemini-2.5-flash':       { input: 0.30, output:  2.50, cachedInput: 0.075 },
    'gemini-2.5-flash-lite':  { input: 0.10, output:  0.40, cachedInput: 0.025 },
    'gemini-2.0-flash':       { input: 0.10, output:  0.40 },
    'gemini-2.0-flash-lite':  { input: 0.075, output: 0.30 },
    'gemini-3-pro':           { input: 1.25, output: 10.00, cachedInput: 0.31 },
    'gemini-3.5-flash':       { input: 0.30, output:  2.50, cachedInput: 0.075 },
    'gemini-3.6-flash':       { input: 0.30, output:  2.50, cachedInput: 0.075 },
    // Floating aliases. Priced per TIER, so these track the newest model in
    // the tier at no extra cost — the substring fallback below would resolve
    // them anyway; listing them keeps known-model checks exact.
    'gemini-pro-latest':      { input: 1.25, output: 10.00, cachedInput: 0.31 },
    'gemini-flash-latest':    { input: 0.30, output:  2.50, cachedInput: 0.075 },
    'gemini-flash-lite-latest': { input: 0.10, output: 0.40, cachedInput: 0.025 },
  },
}

/** Claude rates (mirrors src/lib/providers/claude.ts:32). */
export const CLAUDE_PRICING: Record<string, ModelRate> = {
  'claude-opus-4-7':           { input: 15.00, output: 75.00 },
  'claude-opus-4-1':           { input: 15.00, output: 75.00 },
  'claude-sonnet-4-6':         { input:  3.00, output: 15.00 },
  'claude-sonnet-4-5':         { input:  3.00, output: 15.00 },
  'claude-haiku-4-5':          { input:  1.00, output:  5.00 },
}

/** OpenAI rates (mirrors src/lib/providers/openai.ts:204). */
export const OPENAI_PRICING: Record<string, ModelRate> = {
  'gpt-5':       { input: 2.50, output: 10.00 },
  'gpt-5-mini':  { input: 0.25, output:  2.00 },
  'gpt-5-nano':  { input: 0.10, output:  0.80 },
}

const FALLBACK_RATE: ModelRate = { input: 1.25, output: 10.00 }

export function rateFor(provider: CloudProvider, tier: GeminiTier | undefined, model: string): ModelRate {
  if (provider === 'gemini') {
    if (tier === 'free') return { input: 0, output: 0, cachedInput: 0 }
    const exact = GEMINI_PRICING.paid[model]
    if (exact) return exact
    const m = model.toLowerCase()
    if (m.includes('lite')) return GEMINI_PRICING.paid['gemini-2.5-flash-lite']
    if (m.includes('flash')) return GEMINI_PRICING.paid['gemini-2.5-flash']
    if (m.includes('pro')) return GEMINI_PRICING.paid['gemini-2.5-pro']
    return FALLBACK_RATE
  }
  if (provider === 'claude') return CLAUDE_PRICING[model] ?? CLAUDE_PRICING['claude-sonnet-4-6']
  if (provider === 'openai') return OPENAI_PRICING[model] ?? OPENAI_PRICING['gpt-5-mini']
  // Claude Code and Codex bill against the user's subscription, not
  // per-token API credit — surface $0 in the cost estimator rather than a
  // guessed rate.
  if (provider === 'claudeCode') return { input: 0, output: 0, cachedInput: 0 }
  if (provider === 'codex') return { input: 0, output: 0, cachedInput: 0 }
  return FALLBACK_RATE
}

// ────────────────────────────────────────────────────────────────────
// Per-run cost estimation. Heuristic — assumes typical content density
// and provider-side prompt-cache hit rates. Rounds liberally so users
// don't read it as a guarantee.
// ────────────────────────────────────────────────────────────────────

const CHARS_PER_TOKEN = 4 // English average; off by 10-15% on punctuation-heavy text

/** Output tokens as a fraction of the TRANSCRIPT-CHUNK token count
 *  (NOT the full per-call input — that's dominated by KB on Phase 3).
 *  Measured against actual Session 24 runs:
 *    - Phase 1 outputs grounded text ≈ input transcript size (~1.0)
 *    - Phase 2 audit JSON is tiny (~0.02)
 *    - Phase 3 chronicle prose ≈ 5-10% of transcript char count
 *      (Notebook-LM-style condensed — much shorter than raw transcript)
 *    - Phase 4 extras (jests/gore/quotes JSON) ~ 0.05
 *    - Phase 6 condense reads chronicle (not transcript) and outputs
 *      ~25% of THAT — but since chronicle is ~10% of transcript, the
 *      effective ratio vs transcript is ~0.025 */
const PHASE_OUTPUT_RATIO_VS_TRANSCRIPT: Record<string, number> = {
  phase1_ground:    1.00,
  phase2_audit:     0.02,
  phase3_chronicle: 0.10,
  phase4_extras:    0.05,
  phase6_condense:  0.025,
}

/** Approximate KB inclusion per phase for CLOUD providers (local
 *  providers ship compact KB on every phase for spelling discipline).
 *  Empirically verified from src/lib/prompts.ts:
 *    - Phase 1 cloud: ships compact glossary (~10% of full KB)
 *    - Phase 2 cloud: ships compact glossary (~10% of full KB)
 *    - Phase 3 cloud: ships NO KB — Phase 1 already grounded names
 *      (verified by reading phase3ChronicleParts — cacheable prefix
 *       has DM clarifications + speaker rules + chronicle rules only)
 *    - Phase 4 cloud: ships compact glossary (~10%)
 *    - Phase 6 cloud: ships NO KB (Chronicle has already been ground)
 *  Earlier versions of this table set phase3_chronicle: 1.00 which
 *  inflated Phase 3 estimates by ~$0.60 — corrected based on direct
 *  prompt-source inspection. */
const PHASE_KB_RATIO: Record<string, number> = {
  phase1_ground:    0.10,
  phase2_audit:     0.10,
  phase3_chronicle: 0.00,
  phase4_extras:    0.10,
  phase6_condense:  0.00,
}

/** Phase 6 input is the chronicle (not the transcript). Chronicle is
 *  roughly 10% of transcript char count (per Session 24 measurement).
 *  Phase 6 chunks process this smaller corpus. */
const PHASE6_INPUT_RATIO_OF_TRANSCRIPT = 0.10

export interface PhaseRouting {
  provider: CloudProvider
  /** Gemini-only; non-Gemini providers can omit. */
  tier?: GeminiTier | 'paid'
  model: string
}

export interface PhaseCostEstimate {
  phase: string
  chunks: number
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  dollars: number
  model: string
  tier: string
}

export interface RunCostEstimate {
  perPhase: PhaseCostEstimate[]
  totalDollars: number
  totalInputTokens: number
  totalOutputTokens: number
}

const PHASE_TO_CHUNK_PHASE: Record<string, 'p1' | 'p2' | 'p3' | 'p4' | 'p6'> = {
  phase1_ground:    'p1',
  phase2_audit:     'p2',
  phase3_chronicle: 'p3',
  phase4_extras:    'p4',
  phase6_condense:  'p6',
}

/** Heuristic cost estimate for a full pipeline run. Inputs are byte-count
 *  measurements you already have at run-build time. Returns per-phase +
 *  total breakdown in USD. ~10-20% error vs actual. */
export function estimateRunCost(args: {
  routing: Record<string, PhaseRouting>
  transcriptChars: number
  kbChars: number
  /** Phase 3 prompt-cache hit ratio. Gemini explicit-cache amortises the
   *  KB across chunks. Default 0.85 — first chunk fills the cache, rest
   *  hit it. Override to 0 to disable cache for a worst-case estimate. */
  cacheHitRatio?: number
}): RunCostEstimate {
  const cacheHit = args.cacheHitRatio ?? 0.85
  const perPhase: PhaseCostEstimate[] = []
  let totalDollars = 0
  let totalInputTokens = 0
  let totalOutputTokens = 0

  for (const [phase, route] of Object.entries(args.routing)) {
    const chunkPhase = PHASE_TO_CHUNK_PHASE[phase]
    if (!chunkPhase) continue

    const profile: CloudProfile = cloudProfileFor(route.provider, route.tier as GeminiTier | undefined)
    // Use flagship sizing as the default — accurate enough for an estimate
    const chunkSize = profile.startsWith('gemini')
      ? cloudChunkSize(profile, chunkPhase, route.model.toLowerCase().includes('flash') ? 'fast' : 'flagship')
      : cloudChunkSize(profile, chunkPhase, 'flagship')

    // Phase 6 processes the chronicle (~10% of transcript), not the
    // transcript itself. Other phases process the transcript.
    const phaseInputCorpusChars =
      phase === 'phase6_condense'
        ? args.transcriptChars * PHASE6_INPUT_RATIO_OF_TRANSCRIPT
        : args.transcriptChars
    const chunks = Math.max(1, Math.ceil(phaseInputCorpusChars / chunkSize))

    // Per-chunk input = transcript-chunk portion + KB portion + overhead
    const perChunkCorpusChars = Math.min(chunkSize, phaseInputCorpusChars / chunks)
    const perChunkInputChars =
      perChunkCorpusChars +
      args.kbChars * (PHASE_KB_RATIO[phase] ?? 0) +
      2000 // prompt overhead (system + DM Q&A + prior tail)
    const perChunkInputTokens = Math.ceil(perChunkInputChars / CHARS_PER_TOKEN)
    const inputTokens = perChunkInputTokens * chunks

    // Cached input applies to the KB portion of Phase 3 only (the prefix
    // that repeats across chunks). Other phases either don't have an
    // expensive prefix or the cache benefit is negligible.
    const cachedInputTokens =
      phase === 'phase3_chronicle' && chunks > 1
        ? Math.ceil((args.kbChars * (PHASE_KB_RATIO[phase] ?? 0)) / CHARS_PER_TOKEN) *
          Math.floor(chunks * cacheHit)
        : 0

    // Output is a fraction of the TRANSCRIPT portion only (not full
    // input). Most outputs are small relative to KB-laden input.
    const perChunkOutputTokens = Math.ceil(
      (perChunkCorpusChars / CHARS_PER_TOKEN) * (PHASE_OUTPUT_RATIO_VS_TRANSCRIPT[phase] ?? 0.05),
    )
    const outputTokens = perChunkOutputTokens * chunks

    const rate = rateFor(route.provider, route.tier as GeminiTier | undefined, route.model)
    const cachedRate = rate.cachedInput ?? rate.input
    const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens)
    const dollars =
      (uncachedInputTokens * rate.input +
        cachedInputTokens * cachedRate +
        outputTokens * rate.output) /
      1_000_000

    perPhase.push({
      phase,
      chunks,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      dollars,
      model: route.model,
      tier: String(route.tier ?? 'paid'),
    })
    totalDollars += dollars
    totalInputTokens += inputTokens
    totalOutputTokens += outputTokens
  }

  perPhase.sort((a, b) => a.phase.localeCompare(b.phase))
  return { perPhase, totalDollars, totalInputTokens, totalOutputTokens }
}

/** Format dollars as a short USD string. */
export function formatDollars(d: number): string {
  if (!Number.isFinite(d)) return '$?'
  if (d < 0.01) return `$${d.toFixed(4)}`
  if (d < 1) return `$${d.toFixed(2)}`
  return `$${d.toFixed(2)}`
}

/** USD → GBP at a fixed conservative rate. UI may override. */
export function dollarsToPounds(d: number, rate = 0.79): number {
  return d * rate
}

export function formatPounds(d: number, rate?: number): string {
  const gbp = dollarsToPounds(d, rate)
  if (gbp < 0.01) return `£${gbp.toFixed(4)}`
  if (gbp < 1) return `£${gbp.toFixed(2)}`
  return `£${gbp.toFixed(2)}`
}
