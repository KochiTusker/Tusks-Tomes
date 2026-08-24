// Per-provider, per-model-tier chunk sizing for the pipeline.
//
// Cloud chunk sizes vary by provider because the binding constraint is
// TPM, not context window. Gemini's 1M context + multi-MTPM paid budget
// absorbs larger chunks without quality drop, halving round-trips.
// Claude/OpenAI's smaller context windows + tighter TPM budgets favour
// keeping chunks closer to current sizes.
//
// They also vary by *model tier* within a provider. Fast-tier models
// (Flash, Haiku, gpt-5-mini/nano) are cheaper per token but degrade on
// long inputs faster than flagship models, so we run them on smaller
// chunks. Frontier models (Opus) keep flagship-sized chunks.
//
// Phases 1-2 stay smaller everywhere because grounding/audit accuracy
// degrades on long input regardless of context window size.
//
// Local models stay at conservative sizes — users pair them with smaller
// models on consumer GPUs and the cost of getting it wrong (truncation
// or hallucination) outweighs the speed gain from larger chunks.

import type { CloudProvider } from './profiles'
import type { GeminiTier } from './providers/gemini'
import type { ModelTier } from './modelTier'

export type ChunkPhase = 'p1' | 'p2' | 'p3' | 'p4' | 'p5' | 'p6'

/** Cloud provider + Gemini-tier collapsed into a single sizing key. */
export type CloudProfile = 'geminiPaid' | 'geminiFree' | 'claude' | 'openai'

/** Full sizing key including model tier. */
export type CloudSizingKey = `${CloudProfile}:${ModelTier}`

/** Resolve which sizing profile applies for a cloud-provider + Gemini tier. */
export function cloudProfileFor(
  provider: CloudProvider,
  geminiTier: GeminiTier | undefined,
): CloudProfile {
  if (provider === 'gemini') {
    // 'auto' treats as paid for sizing — when paid is configured, auto
    // prefers it, and the free fallback is a safety net rather than the
    // intended path.
    return geminiTier === 'free' ? 'geminiFree' : 'geminiPaid'
  }
  // Claude Code runs Claude models via the user's subscription, so it keeps
  // the Claude chunk-size row even though the direct Claude key is gone —
  // the sizing describes the model family, not the billing route.
  if (provider === 'claudeCode') return 'claude'
  // Codex runs GPT-family models via the user's ChatGPT subscription, and
  // keeps the OpenAI row for the same reason.
  if (provider === 'codex') return 'openai'
  // OpenRouter fronts models from 8k to 1M context, so no single provider row
  // describes it. This is a FLOOR, not a match: the OpenAI row is the smallest
  // cloud profile, so it is safe for any model in the catalogue. Callers that
  // know the model consult its context_length and size up from here.
  if (provider === 'openrouter') return 'openai'
  // Every CloudProvider must be named above. This used to be a bare
  // `return 'openai'`, which meant any provider added to the union without a
  // branch here silently inherited OpenAI's chunk sizes — no compile error, no
  // runtime warning, no failing test. Sizes are wrong-by-default for anything
  // that is not GPT-shaped, so make the omission a build failure instead.
  return assertUnreachableProvider(provider)
}

function assertUnreachableProvider(provider: never): never {
  throw new Error(`cloudProfileFor: unhandled CloudProvider ${String(provider)}`)
}

/** Compose the full (profile, tier) sizing key. */
export function cloudSizingKeyFor(
  provider: CloudProvider,
  geminiTier: GeminiTier | undefined,
  modelTier: ModelTier,
): CloudSizingKey {
  return `${cloudProfileFor(provider, geminiTier)}:${modelTier}`
}

/**
 * Cloud chunk sizes (chars). One entry per (profile, tier, phase). Phase 5
 * is local-only so it isn't represented here. `frontier` mirrors flagship
 * for now — Opus has comparable context but is slow and expensive, so we
 * don't push chunks larger than flagship until we have data.
 */
const CLOUD_CHUNK_SIZES: Record<CloudSizingKey, Record<Exclude<ChunkPhase, 'p5'>, number>> = {
  // Gemini paid (Pro / Flash / Opus-equivalent).
  'geminiPaid:flagship': { p1: 30_000, p2: 30_000, p3: 60_000, p4: 60_000, p6: 100_000 },
  'geminiPaid:fast':     { p1: 15_000, p2: 15_000, p3: 30_000, p4: 30_000, p6: 50_000 },
  'geminiPaid:frontier': { p1: 30_000, p2: 30_000, p3: 60_000, p4: 60_000, p6: 100_000 },
  // Gemini free.
  'geminiFree:flagship': { p1: 15_000, p2: 15_000, p3: 35_000, p4: 35_000, p6: 60_000 },
  'geminiFree:fast':     { p1: 8_000,  p2: 8_000,  p3: 18_000, p4: 18_000, p6: 30_000 },
  'geminiFree:frontier': { p1: 15_000, p2: 15_000, p3: 35_000, p4: 35_000, p6: 60_000 },
  // Claude (Sonnet / Haiku / Opus).
  'claude:flagship':     { p1: 20_000, p2: 20_000, p3: 40_000, p4: 40_000, p6: 60_000 },
  'claude:fast':         { p1: 10_000, p2: 10_000, p3: 20_000, p4: 20_000, p6: 30_000 },
  'claude:frontier':     { p1: 20_000, p2: 20_000, p3: 40_000, p4: 40_000, p6: 60_000 },
  // OpenAI (gpt-5 / gpt-5-mini-or-nano / gpt-5 equivalent).
  'openai:flagship':     { p1: 15_000, p2: 15_000, p3: 30_000, p4: 30_000, p6: 50_000 },
  'openai:fast':         { p1: 8_000,  p2: 8_000,  p3: 15_000, p4: 15_000, p6: 25_000 },
  'openai:frontier':     { p1: 15_000, p2: 15_000, p3: 30_000, p4: 30_000, p6: 50_000 },
}

/**
 * Local chunk sizes (chars). Tight on purpose — small models on consumer
 * GPUs lose accuracy on long contexts and we don't want to spend effort
 * tuning per-model. Conservative is safe.
 */
const LOCAL_CHUNK_SIZES: Record<ChunkPhase, number> = {
  p1: 5_000,
  p2: 5_000,
  p3: 8_000,
  p4: 8_000,
  p5: 6_000,
  p6: 10_000,
}

/**
 * When every phase of the run resolves to a fast-tier model (Flash, Haiku,
 * gpt-mini/nano), there's no flagship phase to anchor narrative continuity
 * — the chronicle phase passes summary state to itself across boundaries,
 * and Flash drift compounds. Applying an extra shrink keeps per-chunk
 * context small enough for Flash to keep working memory coherent.
 *
 * 0.7 was picked over 0.5 because:
 *   - Flash on the `:fast` row is already half of `:flagship` — going
 *     0.5 again would put Phase 3 at ~9k chars, which is small enough to
 *     break narrative flow more than it helps Flash focus.
 *   - 0.7 gives ~30% safety margin; rounded to nearest 1k for readability.
 */
export const ALL_FAST_SHRINK_FACTOR = 0.7

/** Resolve the right chunk size for a phase given the active routing. */
export function chunkSizeFor(args: {
  phase: ChunkPhase
  isLocal: boolean
  cloudProvider?: CloudProvider
  geminiTier?: GeminiTier
  /** Optional — defaults to 'flagship' so existing callers stay byte-for-byte. */
  modelTier?: ModelTier
  /** True iff every phase in the active run resolves to a fast-tier model.
   *  When set, the resolved size is multiplied by ALL_FAST_SHRINK_FACTOR
   *  and rounded to the nearest 1000 for readability in diagnostics. */
  allPhasesFast?: boolean
}): number {
  if (args.isLocal) return LOCAL_CHUNK_SIZES[args.phase]
  if (args.phase === 'p5') return LOCAL_CHUNK_SIZES.p5 // p5 is local-only by design
  const key = cloudSizingKeyFor(
    args.cloudProvider ?? 'gemini',
    args.geminiTier,
    args.modelTier ?? 'flagship',
  )
  const base = CLOUD_CHUNK_SIZES[key][args.phase]
  if (!args.allPhasesFast) return base
  return Math.round((base * ALL_FAST_SHRINK_FACTOR) / 1000) * 1000
}

/** Direct-access helpers — useful when the caller already knows the profile. */
export function cloudChunkSize(
  profile: CloudProfile,
  phase: Exclude<ChunkPhase, 'p5'>,
  modelTier: ModelTier = 'flagship',
): number {
  return CLOUD_CHUNK_SIZES[`${profile}:${modelTier}`][phase]
}

export function localChunkSize(phase: ChunkPhase): number {
  return LOCAL_CHUNK_SIZES[phase]
}
