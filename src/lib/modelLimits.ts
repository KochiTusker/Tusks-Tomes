// Per-model request limits.
//
// The pipeline asks for MAX_OUTPUT_TOKENS (32,768) on every call
// (pipeline.ts:355, :415) and every provider passes that straight through
// unclamped — openai.ts:141 `max_output_tokens`, claude.ts:186 `max_tokens`,
// gemini.ts:709 `maxOutputTokens`. That is fine for the three providers we
// shipped with, whose models all advertise a ceiling well above it.
//
// It stops being fine the moment the model is chosen from a catalogue. On the
// OpenRouter catalogue as of 2026-08-18, 81 of 407 models advertise a
// max_completion_tokens BELOW 32,768 — a fifth of the list. Asking one of them
// for 32,768 is not a request that gets truncated, it is a request that is
// invalid, and the user sees a 400 rather than a chronicle.
//
// Worth being precise about what this does and does not fix: it prevents the
// invalid request. It does not make a small-output model suitable for a phase
// whose output is ~1:1 with its input — for that, see the sizing work, which
// bounds the CHUNK so the expected output fits underneath the ceiling.

/** Rough chars-per-token used when reasoning about output volume. Matches
 *  src/lib/pricing.ts; src/lib/rateLimit.ts uses 3.5 for pacing. */
const CHARS_PER_TOKEN = 4

export interface ClampResult {
  /** The value to actually send. */
  tokens: number
  /** True when the model's ceiling, not our default, decided the number. */
  clamped: boolean
  /** The model ceiling that bound, when one did. */
  modelCeiling?: number
}

/**
 * Clamp a requested output budget to what the model will actually accept.
 *
 * `modelCeiling` is null/undefined when the catalogue does not declare one —
 * in that case we send the request unchanged rather than guessing a limit,
 * because inventing a ceiling would silently truncate output on models that
 * have none.
 */
export function clampMaxOutputTokens(
  requested: number,
  modelCeiling: number | null | undefined,
): ClampResult {
  if (typeof modelCeiling !== 'number' || !Number.isFinite(modelCeiling) || modelCeiling <= 0) {
    return { tokens: requested, clamped: false }
  }
  if (modelCeiling >= requested) return { tokens: requested, clamped: false }
  return { tokens: modelCeiling, clamped: true, modelCeiling }
}

/**
 * Largest chunk (in characters) whose expected output still fits under the
 * model's output ceiling, given how much output the phase produces relative to
 * its input.
 *
 * Phase 1 grounding emits a near 1:1 corrected copy (prompts.ts:389) and Phase
 * 3 is explicitly exhaustive (prompts.ts:577), so on those phases the chunk
 * size is what governs whether the output ceiling binds at all. Phases that
 * emit small JSON are unaffected in practice, but the same maths applies.
 *
 * Returns null when there is no ceiling to respect, meaning "keep the
 * configured chunk size".
 */
export function maxChunkCharsForOutputCeiling(
  modelCeiling: number | null | undefined,
  outputRatio: number,
  /** Head-room factor. Output volume varies chunk to chunk; leaving margin is
   *  cheaper than discovering the variance as a truncated chronicle. */
  safety = 0.8,
): number | null {
  if (typeof modelCeiling !== 'number' || !Number.isFinite(modelCeiling) || modelCeiling <= 0) {
    return null
  }
  if (!Number.isFinite(outputRatio) || outputRatio <= 0) return null
  return Math.floor(((modelCeiling * safety) / outputRatio) * CHARS_PER_TOKEN)
}

/**
 * Does one call's input fit the model's context window?
 *
 * Note this is genuinely separate from cost. Prompt caching (Gemini's
 * CachedContent, Anthropic's cache_control) elides the UPLOAD of a repeated
 * prefix and discounts it heavily, but the cached tokens still occupy their
 * full footprint in the window on every call. So caching can never rescue a
 * model whose window is too small — only sending less can.
 */
export function inputFitsContext(args: {
  contextLength: number
  chunkChars: number
  kbChars: number
  overheadChars: number
  /** Reserve room for the response as well as the prompt. */
  expectedOutputTokens?: number
}): boolean {
  if (!Number.isFinite(args.contextLength) || args.contextLength <= 0) return true
  const inputTokens = Math.ceil(
    (args.chunkChars + args.kbChars + args.overheadChars) / CHARS_PER_TOKEN,
  )
  return inputTokens + (args.expectedOutputTokens ?? 0) <= args.contextLength
}

/** Why retrieval was or was not applied, for logging and for telling the user. */
export type RetrievalReason =
  /** The user turned it on. */
  | 'user-enabled'
  /** The whole knowledge base does not fit this model's context window. */
  | 'context-overflow'
  /** It fits, and the user did not ask for it. */
  | 'fits'
  /** No context length known for the model, so nothing to decide against. */
  | 'unknown-context'

/**
 * Should Phase 6 send a retrieved subset of the vault rather than all of it?
 *
 * Phase 6 is the only cloud phase handed the entire knowledge base
 * (pipeline.ts:2257). On the reference vault that is ~557k tokens per call,
 * which fits a 1M-context model and no smaller one. Retrieval narrows it by
 * ~92% with the referenced entities retained.
 *
 * The important asymmetry: prompt caching cannot substitute for this. Caching
 * elides the upload and discounts the tokens, but cached tokens still occupy
 * their full share of the context window on every call. So on a model whose
 * window is too small, retrieval is not an optimisation — it is the only thing
 * that makes the phase run at all.
 *
 * Auto-enabling only on overflow is deliberate. Someone on a 1M-context model
 * with a small glossary should see no change in behaviour they did not ask for;
 * retrieval is a trade, and trading is only obviously right when the
 * alternative is failure.
 */
export function shouldRetrieveVaultKb(args: {
  /** The user's explicit setting. */
  userEnabled: boolean
  kbChars: number
  chunkChars: number
  overheadChars: number
  /** Model context window in tokens, or null when unknown. */
  contextLength: number | null
  expectedOutputTokens?: number
}): { retrieve: boolean; reason: RetrievalReason } {
  if (args.userEnabled) return { retrieve: true, reason: 'user-enabled' }
  if (args.contextLength === null || !Number.isFinite(args.contextLength)) {
    return { retrieve: false, reason: 'unknown-context' }
  }
  const fits = inputFitsContext({
    contextLength: args.contextLength,
    chunkChars: args.chunkChars,
    kbChars: args.kbChars,
    overheadChars: args.overheadChars,
    expectedOutputTokens: args.expectedOutputTokens,
  })
  return fits ? { retrieve: false, reason: 'fits' } : { retrieve: true, reason: 'context-overflow' }
}
