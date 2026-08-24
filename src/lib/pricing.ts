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
import type { LiveRateResolver } from './liveRates'

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

/** OpenAI rates (mirrors src/lib/providers/openai.ts:204). */

const FALLBACK_RATE: ModelRate = { input: 1.25, output: 10.00 }

/** rateFor, upgraded with catalogue awareness (see liveRates.ts for the
 *  resolver and the mapping rules). Identical to the static rateFor when
 *  `resolver` is null or has no answer — the offline path must not drift,
 *  and the characterisation test holds it there. */
export function liveRateFor(
  resolver: LiveRateResolver | null,
  provider: CloudProvider,
  tier: GeminiTier | undefined,
  model: string,
): ModelRate {
  if (provider === 'gemini' && tier === 'free') return { input: 0, output: 0, cachedInput: 0 }
  if (provider === 'claudeCode' || provider === 'codex') {
    return { input: 0, output: 0, cachedInput: 0 }
  }
  if (resolver) {
    if (provider === 'openrouter') {
      const hit = resolver.openrouter(model)
      if (hit) return hit
    }
    if (provider === 'gemini') {
      const hit = resolver.gemini(model)
      if (hit) return hit
    }
  }
  return rateFor(provider, tier, model)
}

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

/** Output tokens as a fraction of THIS PHASE'S per-chunk corpus (not the full
 *  per-call input, which includes the KB).
 *    - Phase 1 outputs grounded text ≈ its input. prompts.ts:389 rule 4:
 *      "Output a near 1:1 corrected version".
 *    - Phase 2 audit JSON is tiny, usually an empty array.
 *    - Phase 3 is EXHAUSTIVE, not a summary. prompts.ts:577 rule 1: "Do NOT
 *      compress to save space ... roughly the same level of detail as the
 *      transcript itself, not as a summary of it." This was 0.10 until
 *      2026-08-18, which understated a Pro run by roughly 2x; the corrected
 *      model reproduces the ~$4.85/session a real all-Pro run bills, where the
 *      old one gave well under a dollar.
 *    - Phase 4 extras (jests/gore/quotes JSON) stays small.
 *    - Phase 6's corpus is already the chronicle (see PHASE6_INPUT_RATIO
 *      below), so this ratio is output-vs-chronicle, ~30%. The old 0.025
 *      double-discounted: it was derived as 0.25 x 0.10 "vs transcript" but
 *      applied to a corpus that was already the chronicle. */
const PHASE_OUTPUT_RATIO_VS_CORPUS: Record<string, number> = {
  phase1_ground:    1.00,
  phase2_audit:     0.02,
  phase3_chronicle: 0.90,
  phase4_extras:    0.05,
  phase6_condense:  0.30,
}

/** Fraction of the full KB each CLOUD phase ships. Verified against the actual
 *  prompt builders, not against the comments describing them:
 *    - Phase 1: compactKb, ~10% of the full KB (pipeline.ts:1386).
 *    - Phase 2: NOTHING. runPhase2 takes no `kb` and phase2Audit
 *      (prompts.ts:405) has no KB parameter.
 *    - Phase 3: NOTHING on cloud. phase3ChronicleParts' prefix is DM Q&A +
 *      speaker rules + chronicle rules only.
 *    - Phase 4: NOTHING. runPhase4 takes no `kb`.
 *    - Phase 6: the FULL vault. pipeline.ts:2257 — "Phase 6 is the only cloud
 *      phase handed the FULL vault ... ~557k tokens per call". This was 0.00
 *      until 2026-08-18, which omitted the single largest input in the run.
 *      When retrieveVaultKb is on, callers should pass the RETRIEVED kb size
 *      as kbChars rather than the whole vault. */
const PHASE_KB_RATIO: Record<string, number> = {
  phase1_ground:    0.10,
  phase2_audit:     0.00,
  phase3_chronicle: 0.00,
  phase4_extras:    0.00,
  phase6_condense:  1.00,
}

/** Phase 2 ships the raw chunk AND the grounded chunk in the same prompt
 *  (prompts.ts:412-421, built at pipeline.ts:1686-1691), so its per-chunk
 *  corpus input is double. Every other phase sends one copy. */
const PHASE_CORPUS_MULTIPLIER: Record<string, number> = {
  phase2_audit: 2,
}

/**
 * Thinking tokens per call, by phase, expressed as a multiple of the phase's
 * VISIBLE output.
 *
 * Reconciled against real billing on 2026-08-18. Two sessions of the balanced
 * preset (Claude Code on the mechanical phases, Gemini Pro on the chronicle,
 * Flash on extras and condense) billed GBP 2.562 and GBP 2.279 of Gemini API
 * usage. The model as it then stood predicted GBP 0.54 — an underestimate of
 * about 4.5x.
 *
 * The whole of that gap is thinking. Working backwards, the unexplained spend
 * implies roughly 29,800 extra output-billed tokens on each chronicle call,
 * against a documented dynamic thinking budget that caps at 32,768 — so the
 * chronicle phase is running thinking at close to its ceiling on every call,
 * and none of it was being counted.
 *
 * Thinking is on by default for every phase, and hardcoded on for the
 * chronicle with no user override (pipeline.ts resolveThinkingBudget), so
 * these are the defaults a user actually gets rather than a worst case.
 *
 * A ratio of 0 means thinking is off or negligible for that phase.
 */
const PHASE_THINKING_RATIO_VS_OUTPUT: Record<string, number> = {
  // Mechanical phases. Thinking is on by default but the task is shallow, so
  // the model spends little on it. Users who enable the
  // disableThinkingOnGrounding toggle get 0 here.
  phase1_ground: 0.3,
  // Tiny output, but the comparison itself invites deliberation, so thinking
  // dwarfs the few tokens of JSON that come out.
  phase2_audit: 4.0,
  // The expensive one, and the one that cannot be turned off. Derived from the
  // billing reconciliation above.
  phase3_chronicle: 4.8,
  phase4_extras: 2.0,
  phase6_condense: 1.5,
}

/** Phase 6 input is the chronicle, not the transcript. Because Phase 3 is
 *  exhaustive rather than condensing (see PHASE_OUTPUT_RATIO_VS_CORPUS), the
 *  chronicle lands near the transcript's own size — not the ~10% assumed
 *  before 2026-08-18. */
const PHASE6_INPUT_RATIO_OF_TRANSCRIPT = 0.90

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
  /** Set false for a provider or routing where reasoning is switched off.
   *  Defaults to true, matching the pipeline's own defaults. */
  thinkingEnabled?: boolean
  /** Catalogue-backed rates (see liveRates.ts). When present, OpenRouter
   *  models price at their real catalogue rate and Gemini models at the
   *  catalogue's google/ rates — the operator's decision of 2026-08-19.
   *  When absent, the static tables above apply unchanged. */
  liveRates?: LiveRateResolver | null
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

    // Phase 6 processes the chronicle, not the transcript. Other phases
    // process the transcript itself.
    const phaseInputCorpusChars =
      phase === 'phase6_condense'
        ? args.transcriptChars * PHASE6_INPUT_RATIO_OF_TRANSCRIPT
        : args.transcriptChars
    const chunks = Math.max(1, Math.ceil(phaseInputCorpusChars / chunkSize))

    // Per-chunk input = corpus portion (doubled on Phase 2, which ships raw
    // AND grounded) + KB portion + static prompt overhead.
    const perChunkCorpusChars = Math.min(chunkSize, phaseInputCorpusChars / chunks)
    const kbCharsThisPhase = args.kbChars * (PHASE_KB_RATIO[phase] ?? 0)
    const perChunkInputChars =
      perChunkCorpusChars * (PHASE_CORPUS_MULTIPLIER[phase] ?? 1) +
      kbCharsThisPhase +
      2000 // prompt overhead (system + DM Q&A + prior tail)
    const perChunkInputTokens = Math.ceil(perChunkInputChars / CHARS_PER_TOKEN)
    const inputTokens = perChunkInputTokens * chunks

    // Cached input applies to phases that ship a cacheablePrefix and run more
    // than one chunk — 1, 3 and 6 (pipeline.ts:345-400 creates the lease only
    // when chunksRemaining > 1 and the prefix is non-empty). Phases 2 and 4
    // send no prefix at all, so they hit the `empty_prefix` skip and never
    // cache. Before 2026-08-18 this was gated on Phase 3 alone, whose KB ratio
    // is 0.00 — so cachedInputTokens evaluated to 0 for every phase and prompt
    // caching went entirely unmodelled.
    const CACHEABLE_PHASES = new Set(['phase1_ground', 'phase3_chronicle', 'phase6_condense'])
    const cacheablePrefixChars = kbCharsThisPhase + (CACHEABLE_PHASES.has(phase) ? 2000 : 0)
    const cachedInputTokens =
      CACHEABLE_PHASES.has(phase) && chunks > 1
        ? Math.ceil(cacheablePrefixChars / CHARS_PER_TOKEN) * Math.floor(chunks * cacheHit)
        : 0

    // Output is a fraction of this phase's corpus portion, not of the full
    // per-call input (which the KB dominates on Phase 6).
    const perChunkOutputTokens = Math.ceil(
      (perChunkCorpusChars / CHARS_PER_TOKEN) * (PHASE_OUTPUT_RATIO_VS_CORPUS[phase] ?? 0.05),
    )
    const visibleOutputTokens = perChunkOutputTokens * chunks

    // Thinking bills at the output rate. Ignoring it understated real spend by
    // ~4.5x against measured billing — see PHASE_THINKING_RATIO_VS_OUTPUT.
    const thinkingRatio = args.thinkingEnabled === false
      ? 0
      : (PHASE_THINKING_RATIO_VS_OUTPUT[phase] ?? 0)
    const thinkingTokens = Math.ceil(visibleOutputTokens * thinkingRatio)
    const outputTokens = visibleOutputTokens + thinkingTokens

    const rate = liveRateFor(args.liveRates ?? null, route.provider, route.tier as GeminiTier | undefined, route.model)
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

/*
 * There was a formatPounds() here, converting at a hardcoded 0.79.
 *
 * Every rate this file holds is quoted by the provider in USD, so showing
 * pounds meant multiplying a real number by a guess and presenting the
 * result as if it were also real. The guess had no way to stay current, and
 * a user comparing the estimate against their provider dashboard would see
 * two different figures with no explanation for the gap.
 *
 * Costs are shown in USD throughout, which is the currency they are
 * actually billed in.
 */
