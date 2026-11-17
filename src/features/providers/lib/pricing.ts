// Browser-accessible pricing + cost-estimation for the pipeline.
//
// Mirrors the rates in scripts/safety-probe/cost.mjs (kept as separate
// module to avoid coupling a browser bundle to a script). When Google /
// Anthropic / OpenAI update prices, edit BOTH files — the drift-guard
// test in cost.test.mjs locks down the script-side shape; a TS test
// here would lock down this side.
//
// All rates are USD per million tokens, the currency they are quoted and
// billed in. No exchange-rate conversion is applied anywhere.

import type { CloudProvider } from './profiles'
import type { GeminiTier } from './providers/gemini'
import { cloudProfileFor, cloudChunkSize, type CloudProfile } from '../../pipeline/lib/chunking'
import { MAX_OUTPUT_TOKENS } from './constants'
import type { LiveRateResolver } from './liveRates'
import { DEFAULT_RETRIEVAL_MAX_CHARS, COMPACT_KB_MAX_CHARS } from '@/features/lore'
import { GEMINI_FLASH, GEMINI_FLASH_LITE, GEMINI_PRO } from '@shared/models/catalogue'

export interface ModelRate {
  input: number
  output: number
  /** Cached prompt-prefix rate (Gemini explicit-cache; not all models have it). */
  cachedInput?: number
}

/** Per-million-token USD pricing for Gemini models. Paid only — Free is $0. */
export const GEMINI_PRICING: Record<'paid', Record<string, ModelRate>> = {
  paid: {
    [GEMINI_PRO]:         { input: 1.25, output: 10.00, cachedInput: 0.31 },
    [GEMINI_FLASH]:       { input: 0.30, output:  2.50, cachedInput: 0.075 },
    [GEMINI_FLASH_LITE]:  { input: 0.10, output:  0.40, cachedInput: 0.025 },
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
    if (m.includes('lite')) return GEMINI_PRICING.paid[GEMINI_FLASH_LITE]
    if (m.includes('flash')) return GEMINI_PRICING.paid[GEMINI_FLASH]
    if (m.includes('pro')) return GEMINI_PRICING.paid[GEMINI_PRO]
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
 *    - Phase 3 and Phase 6 are MEASURED, not reasoned about. See the note
 *      below — every previous value for Phase 3 was an argument from what the
 *      prompt asks for, and the prompt is not the output.
 *    - Phase 4 extras (jests/gore/quotes JSON) stays small.
 *
 *  Phase 3 and Phase 6, measured over completed runs held in a real chronicle
 *  library, each entry storing both the grounded transcript and the chronicle
 *  written from it:
 *
 *    chronicle ÷ grounded transcript   0.319 mean, 0.318 median (n=16)
 *    condense output ÷ chronicle       0.227 mean, 0.169 median (n=18)
 *
 *  Phase 3 sat at 0.90 before this, on the reasoning that the prompt tells the
 *  model not to summarise ("roughly the same level of detail as the transcript
 *  itself"). That instruction is honoured and the ratio is still ~0.32,
 *  because narration drops what makes spoken dialogue long: disfluency,
 *  repetition, cross-talk, and — when the source was an SBV — timestamps and
 *  speaker tags. An exhaustive retelling of three hours of speech is simply
 *  much shorter than the speech.
 *
 *  Phase 6's 0.22 is the measured mean, and it agrees with the product default:
 *  the Condense Slider ships at 20% (types.ts DEFAULT_OUTPUT_SELECTION), which
 *  is what most of those runs asked for. The spread is wide (0.11-0.63) because
 *  users move that slider, not because the model is inconsistent. */
const PHASE_OUTPUT_RATIO_VS_CORPUS: Record<string, number> = {
  phase1_ground:    1.00,
  phase2_audit:     0.02,
  phase3_chronicle: 0.32,
  phase4_extras:    0.05,
  phase6_condense:  0.22,
}

/** Fraction of the full KB each CLOUD phase ships. Verified against the actual
 *  prompt builders, not against the comments describing them:
 *    - Phases 1, 2 and 4: compactKb, ~10% of the full KB (kbForPhase in
 *      kbCompact.ts).
 *    - Phase 3: the FULL lore in the cacheable prefix, narrowed by retrieval
 *      when it would not fit, so the payload never exceeds the retrieval
 *      budget. PHASE_KB_CAP_CHARS applies that ceiling below.
 *    - Phase 6: the FULL vault. This was 0.00 until 2026-08-18, which omitted
 *      the single largest input in the run. When retrieveVaultKb is on,
 *      callers should pass the RETRIEVED kb size as kbChars rather than the
 *      whole vault. */
const PHASE_KB_RATIO: Record<string, number> = {
  phase1_ground:    0.10,
  phase2_audit:     0.10,
  phase3_chronicle: 1.00,
  phase4_extras:    0.10,
  phase6_condense:  1.00,
}

/**
 * Upper bound on the lore a phase carries, where the pipeline enforces one.
 *
 * The ratios above are linear and two of the three mechanisms they stand for
 * are not. Ground, Audit and Extras send the compact glossary, which stops
 * growing at a fixed number of terms; Chronicle retrieves rather than
 * overflow. Without these ceilings a vault-sized lore source was billed as
 * though every phase scaled with it, which overstated the estimate by more
 * than half on the reference vault — and the estimate is what the user reads
 * before deciding to spend the money.
 */
const PHASE_KB_CAP_CHARS: Record<string, number> = {
  phase1_ground: COMPACT_KB_MAX_CHARS,
  phase2_audit: COMPACT_KB_MAX_CHARS,
  phase4_extras: COMPACT_KB_MAX_CHARS,
  phase3_chronicle: DEFAULT_RETRIEVAL_MAX_CHARS,
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
 * These came out of the billing reconciliation of 2026-08-18 as the residual
 * that closed a 4.5x gap, and they are still the least-measured numbers in
 * this file. Two things now bound them, because a residual with nothing
 * holding it is how a different error hid here for months:
 *
 *   1. MAX_OUTPUT_TOKENS (constants.ts) is sent as maxOutputTokens on every
 *      call, so no single call can bill more output than that. The estimate
 *      clamps to it rather than taking the ratio on trust. Under the ratios
 *      shipped before 2026-09-16 a chronicle call modelled 71,775 output
 *      tokens against a 32,768 ceiling — 2.2x more than the pipeline will
 *      accept. Nothing caught it, because the total still matched billing:
 *      the corpus ratio was ~2.8x high and this residual had absorbed it.
 *      The clamp is what makes that contradiction visible next time.
 *   2. The corpus ratios above are measured now, so this residual is no
 *      longer free to move to cover an error in them.
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

/** Phase 6 input is the chronicle, not the transcript. Same measurement as
 *  PHASE_OUTPUT_RATIO_VS_CORPUS.phase3_chronicle above, and necessarily the
 *  same number — Phase 6's corpus IS Phase 3's output, so the two cannot
 *  disagree. They did: this was 0.90 while Phase 3's output ratio was also
 *  0.90, which was at least consistent, but both described a chronicle 2.8x
 *  longer than the ones on disk. Keep them equal. */
const PHASE6_INPUT_RATIO_OF_TRANSCRIPT = 0.32

/** Billed tokens per token the chunk plan implies.
 *
 *  A run bills for attempts, not for chunks. Retries after a transient 5xx or
 *  timeout re-send the whole prompt and re-generate the whole output, and a
 *  session re-run bills again from scratch; neither appears in a chunk count.
 *  The pipeline retries every phase (MAX_RETRIES in constants.ts) and the
 *  diagnose suite carries a signature for retry storms precisely because they
 *  happen without being visible — see softErrorSignatures.ts:hidden_500_retries.
 *
 *  This is the one term here still fitted rather than measured, and it exists
 *  because the alternative was worse. With the measured corpus ratios and the
 *  per-call output ceiling both enforced, a single pass over the planned
 *  chunks cannot reach the billing on record: even on the longest real
 *  transcript the ceiling caps Phase 3 well below the observed bills. No
 *  thinking ratio can close that, because the ceiling binds first. Extra
 *  billed calls are the only mechanism left.
 *
 *  2.0 is deliberately a round number. What it needs to be depends on how long
 *  the billed sessions' transcripts were, and that was not recorded — across
 *  the real range it spans roughly 1.8x (a long session) to 4.2x (a short
 *  one). 2.0 reproduces the observed bill for a session in the upper third of
 *  that range, which is where the observed bills most plausibly sat. Treat it as an order of magnitude, not a measurement, and do not tune
 *  it to make some other number come out right — that is the mistake this
 *  file is recovering from. */
export const BILLED_TOKENS_PER_PLANNED_TOKEN = 2.0

export interface PhaseRouting {
  provider: CloudProvider
  /** Gemini-only; non-Gemini providers can omit. */
  tier?: GeminiTier | 'paid'
  model: string
}

export interface PhaseCostEstimate {
  phase: string
  /** Chunks the run PLANS to process. Not the number of calls it will bill —
   *  see BILLED_TOKENS_PER_PLANNED_TOKEN. Summed by callsForRun against a
   *  daily request cap, and shown in the picker as "chunks per phase". */
  chunks: number
  /** Token counts are what the phase is expected to BILL, retry and re-run
   *  overhead included, so they line up with a provider dashboard rather than
   *  with the chunk plan. */
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
    const kbCharsThisPhase = Math.min(
      args.kbChars * (PHASE_KB_RATIO[phase] ?? 0),
      PHASE_KB_CAP_CHARS[phase] ?? Number.POSITIVE_INFINITY,
    )
    const perChunkInputChars =
      perChunkCorpusChars * (PHASE_CORPUS_MULTIPLIER[phase] ?? 1) +
      kbCharsThisPhase +
      2000 // prompt overhead (system + DM Q&A + prior tail)
    const perChunkInputTokens = Math.ceil(perChunkInputChars / CHARS_PER_TOKEN)

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
    // Thinking bills at the output rate. Ignoring it understated real spend by
    // ~4.5x against measured billing — see PHASE_THINKING_RATIO_VS_OUTPUT.
    //
    // Clamped to what one call can actually bill. The pipeline sends
    // maxOutputTokens = MAX_OUTPUT_TOKENS on every request, so a per-call
    // figure above it describes a call the provider would have truncated. An
    // unclamped ratio let this file carry a chronicle call of 71,775 output
    // tokens for months; the clamp turns that class of error into a visible
    // shortfall against billing instead of a silent match.
    const thinkingRatio = args.thinkingEnabled === false
      ? 0
      : (PHASE_THINKING_RATIO_VS_OUTPUT[phase] ?? 0)
    const perChunkThinkingTokens = Math.ceil(perChunkOutputTokens * thinkingRatio)
    const perChunkBilledOutput = Math.min(
      MAX_OUTPUT_TOKENS,
      perChunkOutputTokens + perChunkThinkingTokens,
    )

    // Retries and re-runs bill again for the same chunk, on both sides of the
    // call. `chunks` stays the PLANNED count — it is what the UI means by
    // "chunks per phase" and what callsForRun (runPreflight.ts) counts against
    // a daily request cap — so the overhead lands on tokens only.
    const billed = (n: number) => Math.round(n * BILLED_TOKENS_PER_PLANNED_TOKEN)
    const billedInputTokens = billed(perChunkInputTokens * chunks)
    const billedCachedInputTokens = billed(cachedInputTokens)
    const billedOutputTokens = billed(perChunkBilledOutput * chunks)

    const rate = liveRateFor(args.liveRates ?? null, route.provider, route.tier as GeminiTier | undefined, route.model)
    const cachedRate = rate.cachedInput ?? rate.input
    const uncachedInputTokens = Math.max(0, billedInputTokens - billedCachedInputTokens)
    const dollars =
      (uncachedInputTokens * rate.input +
        billedCachedInputTokens * cachedRate +
        billedOutputTokens * rate.output) /
      1_000_000

    perPhase.push({
      phase,
      chunks,
      inputTokens: billedInputTokens,
      outputTokens: billedOutputTokens,
      cachedInputTokens: billedCachedInputTokens,
      dollars,
      model: route.model,
      tier: String(route.tier ?? 'paid'),
    })
    totalDollars += dollars
    totalInputTokens += billedInputTokens
    totalOutputTokens += billedOutputTokens
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
 * Costs are shown in USD throughout, the currency every rate here is quoted
 * and billed in. A converted figure would multiply a real number by a rate
 * that cannot stay current, and would not match the provider's dashboard.
 */
