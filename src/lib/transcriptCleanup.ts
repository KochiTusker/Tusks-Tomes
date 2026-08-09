// Deterministic transcript cleanup. Runs BEFORE pre-grounding.
//
// Goals:
//  - Strip non-speech markers added by auto-captioning ([Music], [Applause], etc.)
//  - Collapse runaway filler ("um um um" → "um")
//  - Normalize quotes/dashes/whitespace so prompts and chunks behave consistently
//
// All operations are CONSERVATIVE — they never touch substantive content.

export type CleanupReport = {
  markersStripped: number
  fillersCollapsed: number
  whitespaceNormalized: boolean
}

export type CleanupResult = {
  text: string
  report: CleanupReport
}

// Non-speech markers commonly inserted by YouTube and other auto-captioners.
// Anything in square brackets that's a single descriptive word (Music, Laughter,
// Applause, etc.) is fair game. Stricter than a blanket "strip [...]" because
// some legitimate content might be bracketed.
const MARKER_RE =
  /\[\s*(music|applause|laughter|laughs|laughing|coughing|cough|sighs|sigh|crosstalk|silence|inaudible|background\s+noise|pause|cheering|clapping|whispering|whispers)\s*\]/gi

// Filler runs we'll collapse: "um um um" / "uh uh uh" / "like like like"
// Only collapse 2+ identical filler tokens in a row.
const FILLER_RUN_RE = /\b(um+|uh+|er+|ah+|hmm+|like|yeah|so)(\s+\1\b)+/gi

// Common stutter run: "I I I" / "the the the" — collapse exact repeats.
// Conservative: only when a short word repeats 2+ times.
const STUTTER_RE = /\b([A-Za-z]{1,5})(?:\s+\1\b){1,4}/gi

/**
 * Apply deterministic cleanup. Returns cleaned text + a brief report.
 */
export function cleanupTranscript(input: string): CleanupResult {
  let text = input
  let markersStripped = 0
  let fillersCollapsed = 0

  // 1. Strip non-speech markers, leave whitespace placeholder.
  text = text.replace(MARKER_RE, () => {
    markersStripped++
    return ' '
  })

  // 2. Collapse filler runs (preserve a single instance).
  text = text.replace(FILLER_RUN_RE, (_full, first: string) => {
    fillersCollapsed++
    return first
  })

  // 3. Collapse short-word stutters ("the the the" → "the").
  text = text.replace(STUTTER_RE, (full, first: string) => {
    // Only collapse if the repeated word appears at least 3 times in a row;
    // 2x stutter ("I I") is too common in real speech to risk.
    const tokens = full.split(/\s+/)
    if (tokens.length >= 3 && tokens.every((t) => t.toLowerCase() === first.toLowerCase())) {
      fillersCollapsed++
      return first
    }
    return full
  })

  // 4. Normalize smart quotes and en/em dashes to ASCII equivalents.
  const before = text
  text = text
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/–/g, '-') // en dash
    .replace(/—/g, '--') // em dash
    .replace(/…/g, '...') // ellipsis
    .replace(/ /g, ' ') // non-breaking space

  // 5. Normalize whitespace: trim trailing spaces per line, collapse 3+
  //    blank lines to 2, trim outer whitespace.
  text = text
    .split(/\r?\n/)
    .map((l) => l.replace(/[ \t]+$/g, '').replace(/[ \t]{2,}/g, ' '))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return {
    text,
    report: {
      markersStripped,
      fillersCollapsed,
      whitespaceNormalized: text !== before,
    },
  }
}
