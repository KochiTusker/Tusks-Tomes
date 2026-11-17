// Word-count utility used by:
//   - <CondenseSlider /> live-preview ("X% ≈ Y words" estimate).
//   - sessions.ts session-build-time target computation for Phase 6.
//
// Whitespace-split, filter empty. Same shape as splitWords() in
// transcriptCleanup.ts (intentional duplication: this utility is a pure
// public-facing primitive, the cleanup version handles a richer token
// model for its own internals).

export function countWords(text: string): number {
  if (!text) return 0
  return text.split(/\s+/).filter(Boolean).length
}

/** Compute the target word count for a Phase 6 condense pass, given the
 *  chronicle's word count and the user's chosen percentage from the
 *  Condense Slider (0-100 in 5% increments). Returns the rounded
 *  integer the prompt should target. */
export function computeCondenseTarget(chronicleWordCount: number, percentage: number): number {
  if (chronicleWordCount <= 0 || percentage <= 0) return 0
  if (percentage >= 100) return chronicleWordCount
  return Math.round((chronicleWordCount * percentage) / 100)
}

/** Split a whole-output condense target across one chunk by its share of the
 *  total. Phase 6 condenses per-chunk and concatenates the results, so each
 *  chunk must target only its proportional slice — otherwise the total scales
 *  with the (provider/model-dependent) chunk count and the same slider value
 *  yields different lengths on different providers.
 *
 *  Returns the passed-through target unchanged when there's nothing to split
 *  (no target, or zero total) so single-chunk and legacy callers are
 *  byte-identical. Always at least 1 word for a non-empty target. */
export function proportionalChunkTarget(
  targetWordCount: number | undefined,
  chunkChars: number,
  totalChars: number,
): number | undefined {
  if (!targetWordCount || targetWordCount <= 0) return targetWordCount
  if (totalChars <= 0) return targetWordCount
  return Math.max(1, Math.round(targetWordCount * (chunkChars / totalChars)))
}

/** Phase 3 chronicle length as a fraction of the grounded transcript it was
 *  written from, in words.
 *
 *  Phase 3 is exhaustive rather than a summary (prompts.ts: "roughly the same
 *  level of detail as the transcript itself"), which makes 1:1 a tempting
 *  assumption — and it is the one the Condense Slider preview shipped with.
 *  It is wrong by a wide margin. Measured over sixteen completed runs in a
 *  real chronicle library, the ratio sits at 0.39 mean / 0.39 median, spread
 *  0.22-0.78. Two things pull it well below 1.0 that "exhaustive" doesn't
 *  cancel: narration drops the disfluencies, repetitions and cross-talk that
 *  make up much of spoken dialogue, and a grounded transcript from an SBV
 *  source still carries timestamp and speaker tokens that countWords() counts
 *  as words.
 *
 *  0.40 is that central value rounded. At 1.0 the preview overstated the
 *  target by 187% on average; at 0.40 it lands within 30%. The spread is
 *  irreducible — it tracks how verbose Phase 3 was on a given session — so
 *  this stays a labelled estimate, never a promise. Phase 6 computes the real
 *  target from the real chronicle. */
export const CHRONICLE_TO_TRANSCRIPT_WORD_RATIO = 0.4

/** Estimate the not-yet-written chronicle's word count from the grounded
 *  transcript, for the Condense Slider's "X% ≈ Y words" preview at
 *  OutputPicker time (Phase 2 done, Phase 3 not yet run).
 *
 *  Callers that hold the actual chronicle text — the Reforge panel, and every
 *  Phase 6 entry point — must use countWords() on it directly instead. This
 *  is only for the window where the chronicle does not exist yet. */
export function estimateChronicleWords(groundedTranscriptWordCount: number): number {
  if (groundedTranscriptWordCount <= 0) return 0
  return Math.round(groundedTranscriptWordCount * CHRONICLE_TO_TRANSCRIPT_WORD_RATIO)
}
