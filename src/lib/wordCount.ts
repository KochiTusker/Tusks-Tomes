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
