// Is this file actually text a person could have transcribed?
//
// Found in QA: a binary file with a .txt name (a PDF, a zip, an image
// someone renamed) loaded 10,240 characters of mojibake straight into the
// transcript box, enabled Run, and would have billed a full six-phase
// pipeline on noise. Nobody chooses that — it is always a mistake, and
// the cheapest place to catch it is the moment the file is read.
//
// Deliberately a heuristic over decoded text rather than a magic-number
// sniff: the app accepts a plain-text transcript from any source, so
// there is no allowlist of formats to check against. What it can say is
// whether the decoded result reads like prose.
//
// Written with character codes rather than a regex on purpose — the
// escapes for a control-character class are easy to mangle when this file
// is edited by a tool, and a silently-wrong class here would either wave
// binary through or reject real transcripts.

export type TextFileVerdict = { ok: true } | { ok: false; reason: string }

const NUL = 0
const TAB = 9
const LINE_FEED = 10
const CARRIAGE_RETURN = 13
const FIRST_PRINTABLE = 32
/** What a UTF-8 decoder emits for bytes it cannot represent — the clearest
 *  signal that whatever this was, it was never text. */
const REPLACEMENT_CHAR = 0xfffd

/** Above this share of the sample, the file is not a transcript. Prose
 *  contains none of these; a couple of stray ones (a smart quote mangled
 *  by a bad export) should not block a real file, so the bar is
 *  deliberately not zero. */
const SUSPICIOUS_SHARE = 0.02

export function looksLikeText(content: string): TextFileVerdict {
  if (content.length === 0) return { ok: false, reason: 'that file is empty' }

  // Sampling the head is enough: a real transcript is text from its first
  // character, and a binary file betrays itself immediately.
  const sample = content.slice(0, 4000)
  let suspicious = 0

  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i)
    if (code === NUL) {
      // A single NUL is conclusive — no text file contains one.
      return { ok: false, reason: 'it contains binary data, not text' }
    }
    if (code === TAB || code === LINE_FEED || code === CARRIAGE_RETURN) continue
    if (code < FIRST_PRINTABLE || code === REPLACEMENT_CHAR) suspicious++
  }

  if (suspicious / sample.length > SUSPICIOUS_SHARE) {
    return { ok: false, reason: 'it does not decode as readable text' }
  }
  return { ok: true }
}
