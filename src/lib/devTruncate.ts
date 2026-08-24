// Dev test mode helper — truncate a transcript at a clean line boundary
// before the pipeline sees it. Used only when the user opts in via the
// dev-mode-gated Settings card.
//
// Strategy: slice to first `maxChars`, then backtrack to the nearest
// newline within the last 30 % of the slice. If no newline lands inside
// that window, accept the raw slice (rare for Tomes transcripts which
// are line-per-utterance). Always returns a non-empty string when input
// is non-empty — falling back to the full text when maxChars is larger
// than input.

export type TruncationResult = {
  /** The (possibly truncated) text the pipeline should process. */
  text: string
  /** Whether truncation actually happened (false when input was already
   *  within the limit). */
  truncated: boolean
  /** Original input length in chars (for the UI banner). */
  originalChars: number
  /** Truncated output length in chars (for the UI banner). */
  outputChars: number
}

const BACKTRACK_WINDOW_FRACTION = 0.3

export function truncateAtLineBoundary(text: string, maxChars: number): TruncationResult {
  if (typeof maxChars !== 'number' || maxChars <= 0) {
    return { text, truncated: false, originalChars: text.length, outputChars: text.length }
  }
  if (text.length <= maxChars) {
    return { text, truncated: false, originalChars: text.length, outputChars: text.length }
  }
  const hardSlice = text.slice(0, maxChars)
  const minLineCut = Math.floor(maxChars * (1 - BACKTRACK_WINDOW_FRACTION))
  const lastNewline = hardSlice.lastIndexOf('\n')
  if (lastNewline >= minLineCut) {
    const out = hardSlice.slice(0, lastNewline)
    return { text: out, truncated: true, originalChars: text.length, outputChars: out.length }
  }
  // No clean line boundary in the backtrack window — fall through to the
  // hard cut. Better to ship 1 extra mid-line character than to silently
  // discard a chunk's worth of usable transcript.
  return {
    text: hardSlice,
    truncated: true,
    originalChars: text.length,
    outputChars: hardSlice.length,
  }
}
