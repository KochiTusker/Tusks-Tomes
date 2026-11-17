// SBV (YouTube subtitle) format helpers.
//
// SBV cues look like:
//   0:00:00.000,0:00:03.500
//   speaker text on one or more lines
//   <blank line>

export type SbvCue = {
  startMs: number
  endMs: number
  /** Original timestamp strings — preserved verbatim for round-trip output. */
  startStr: string
  endStr: string
  /** Cue body. May contain internal newlines if the original cue spanned lines. */
  text: string
}

const TIMESTAMP_LINE_RE =
  /^\s*(\d+:\d{2}:\d{2}\.\d{3})\s*,\s*(\d+:\d{2}:\d{2}\.\d{3})\s*$/

export function isSbv(raw: string): boolean {
  const head = raw.slice(0, 4096)
  return head.split(/\r?\n/).some((line) => TIMESTAMP_LINE_RE.test(line))
}

function tsToMs(ts: string): number {
  const [h, m, sFull] = ts.split(':')
  const [s, ms] = sFull.split('.')
  return (
    Number(h) * 3_600_000 +
    Number(m) * 60_000 +
    Number(s) * 1_000 +
    Number(ms)
  )
}

/** Plain-text reduction (used by the existing free-text refinement flow). */
export function sbvToText(raw: string): string {
  return parseSbv(raw)
    .map((c) => c.text.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n')
}

/** Heuristic: a line looks like a timestamp ATTEMPT (has at least two digit-
 *  colon-digit groups + a comma separator) but didn't match the strict
 *  TIMESTAMP_LINE_RE. Used by parseSbvWithStats to count malformed
 *  timestamps without flagging genuinely-blank gap lines as errors. */
const TIMESTAMP_ATTEMPT_RE = /\d:\d.*,\d:\d/

/** Parse SBV into structured cues, preserving original timestamp strings.
 *  This thin wrapper around parseSbvWithStats keeps existing callers
 *  unchanged while letting the Caption Repair UI access the malformed-line
 *  count when it wants to surface a warning. */
export function parseSbv(raw: string): SbvCue[] {
  return parseSbvWithStats(raw).cues
}

/** Like parseSbv, but also reports how many lines that LOOKED like
 *  timestamp attempts couldn't be parsed. Useful for warning the user
 *  when an SBV file is partially malformed — without this, the parser
 *  silently skips the bad lines and the user can't tell whether their
 *  file was healthy or whether half of it was dropped. */
export function parseSbvWithStats(raw: string): { cues: SbvCue[]; malformedLineCount: number } {
  const lines = raw.split(/\r?\n/)
  const cues: SbvCue[] = []
  let malformedLineCount = 0

  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const tsMatch = line.match(TIMESTAMP_LINE_RE)
    if (!tsMatch) {
      // Distinguish "blank gap" from "malformed timestamp": if the line is
      // non-empty AND matches the loose attempt pattern but not the strict
      // one, it's a malformed timestamp the user should be told about.
      if (line.trim().length > 0 && TIMESTAMP_ATTEMPT_RE.test(line)) {
        malformedLineCount++
      }
      i++
      continue
    }
    const startStr = tsMatch[1]
    const endStr = tsMatch[2]
    i++
    // Collect text lines until blank line, EOF, or next timestamp.
    const textLines: string[] = []
    while (i < lines.length) {
      const next = lines[i]
      if (!next.trim()) {
        i++
        break
      }
      if (TIMESTAMP_LINE_RE.test(next)) break
      textLines.push(next)
      i++
    }
    const text = textLines.join('\n').trim()
    if (text) {
      cues.push({
        startMs: tsToMs(startStr),
        endMs: tsToMs(endStr),
        startStr,
        endStr,
        text,
      })
    }
  }

  return { cues, malformedLineCount }
}

/** Serialize cues back to SBV text. Uses original timestamp strings verbatim. */
export function formatSbv(cues: SbvCue[]): string {
  return cues.map((c) => `${c.startStr},${c.endStr}\n${c.text}`).join('\n\n') + '\n'
}
