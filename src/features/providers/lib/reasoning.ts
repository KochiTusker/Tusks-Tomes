// Reasoning models (Qwen QwQ, DeepSeek R1, OpenAI o-series, etc.) emit their
// internal chain-of-thought wrapped in a tag pair before the actual answer.
// Different vendors use different tags — strip all known variants so the
// chronicle / JSON / SBV cue output never contains the model's deliberation.

const PATTERNS: RegExp[] = [
  /<think>[\s\S]*?<\/think>\s*/gi,
  /<thinking>[\s\S]*?<\/thinking>\s*/gi,
  /<reasoning>[\s\S]*?<\/reasoning>\s*/gi,
  /<\|thinking\|>[\s\S]*?<\|\/thinking\|>\s*/gi,
  /<reflection>[\s\S]*?<\/reflection>\s*/gi,
]

/**
 * Strip well-formed reasoning blocks from model output. Handles the common
 * vendor variants. If a block was opened but never closed (mid-truncation),
 * we leave it alone rather than guessing where the answer started — better
 * to surface obviously-broken output than to silently slice it wrongly.
 */
export function stripReasoningBlocks(text: string): string {
  let out = text
  for (const re of PATTERNS) {
    out = out.replace(re, '')
  }
  return out.trim()
}

/**
 * Untagged chain-of-thought preambles.
 *
 * Some models write their deliberation as ordinary prose with no tag at all,
 * so the tag-based stripper above cannot see it. Measured against the live API
 * on 2026-08-18: two models returned roughly twelve times the expected length
 * this way, opening "Here's a thinking process:" and "We need to correct
 * misheard proper nouns...". Neither `reasoning: {exclude: true}` nor a lower
 * effort setting reliably suppressed it.
 *
 * Left in place, that lands directly in a chronicle.
 */
const UNTAGGED_PREAMBLE_OPENERS: RegExp[] = [
  /^\s*here(?:'|’)?s (?:my |a |the )?(?:thinking|thought)(?:\s+process)?\s*:/i,
  /^\s*(?:my |the )?(?:thinking|thought)(?:\s+process)?\s*:/i,
  /^\s*let me (?:think|work through|start by|begin by|analyse|analyze)\b/i,
  /^\s*we need to\b/i,
  /^\s*first,? (?:i|we|let)(?:'|’)?(?:ll|s)?\b/i,
  /^\s*okay,? (?:so )?(?:let(?:'|’)?s|i|we)\b/i,
]

/**
 * Markers a model may emit between deliberation and answer. When present one
 * is a far more reliable cut point than any heuristic, so they are tried first.
 */
const ANSWER_MARKERS: RegExp[] = [
  /\n\s*(?:final answer|final output|corrected transcript|here is the corrected[^\n]*)\s*:?\s*\n/i,
  /\n\s*-{3,}\s*\n/,
]

export interface StripResult {
  text: string
  stripped: boolean
}

/**
 * Remove an untagged reasoning preamble, when one is clearly present.
 *
 * Deliberately conservative. Cutting in the wrong place would silently delete
 * the beginning of a chronicle, which is far worse than leaving a preamble in
 * where a human notices it immediately. So a cut only happens when the text
 * opens with a recognised deliberation marker AND there is a plausible
 * boundary to cut at; otherwise the text is returned untouched.
 *
 * `expectedShape` lets a caller say what the real output should look like. For
 * Ground that is speaker-tagged text, and for the JSON phases an array or
 * object — both far safer anchors than prose heuristics alone.
 */
export function stripUntaggedReasoning(
  text: string,
  opts: { expectedShape?: 'speaker-tagged' | 'json' } = {},
): StripResult {
  const trimmed = text.trim()
  if (!trimmed) return { text: trimmed, stripped: false }

  if (!UNTAGGED_PREAMBLE_OPENERS.some((re) => re.test(trimmed))) {
    return { text: trimmed, stripped: false }
  }

  // Best case: the model signposted where the answer starts.
  for (const marker of ANSWER_MARKERS) {
    const m = marker.exec(trimmed)
    if (m && m.index > 0) {
      const after = trimmed.slice(m.index + m[0].length).trim()
      if (after.length > 0) return { text: after, stripped: true }
    }
  }

  // Next best: the output has a known shape, so find where that shape starts.
  if (opts.expectedShape === 'speaker-tagged') {
    const m = /\n[ \t]*(?:\[[^\]\n]{1,60}\]|«\d+»)/.exec(trimmed)
    if (m && m.index > 0) return { text: trimmed.slice(m.index).trim(), stripped: true }
  }
  if (opts.expectedShape === 'json') {
    const m = /[[{]/.exec(trimmed)
    if (m && m.index > 0) return { text: trimmed.slice(m.index).trim(), stripped: true }
  }

  // A preamble was recognised but there is no safe cut point. Leave it — a
  // visible preamble is a reportable bug; a wrongly-truncated chronicle is a
  // silent one.
  return { text: trimmed, stripped: false }
}

/** Both passes, in the order that matters. */
export function stripAllReasoning(
  text: string,
  opts: { expectedShape?: 'speaker-tagged' | 'json' } = {},
): StripResult {
  const tagged = stripReasoningBlocks(text)
  return stripUntaggedReasoning(tagged, opts)
}
