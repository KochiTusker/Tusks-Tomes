// Robust JSON extraction shared by the pipeline (per-chunk JSON phases) and
// the refusal-repair runner. LLMs wrap JSON in markdown fences or add stray
// prose around it; these helpers peel that off and pull out the first balanced
// JSON value so a single sloppy chunk doesn't break parsing.

/** Strip a leading/trailing ```json … ``` code fence, if present. */
export function stripCodeFences(s: string): string {
  return s
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim()
}

/** Return the first balanced JSON block (array or object) in `text`, honouring
 *  string literals + escapes so braces inside strings don't fool the matcher.
 *  Null when no complete block is found. */
export function extractFirstJsonBlock(text: string, opener: '[' | '{'): string | null {
  const closer = opener === '[' ? ']' : '}'
  const start = text.indexOf(opener)
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (escape) { escape = false; continue }
    if (ch === '\\') { escape = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    if (ch === opener) depth++
    else if (ch === closer) {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

/** Parse `raw` as JSON of shape T, tolerating code fences + surrounding prose.
 *  `opener` selects array vs object extraction. Null on failure. */
export function tryParseJson<T>(raw: string, opener: '[' | '{'): T | null {
  const stripped = stripCodeFences(raw)
  for (const candidate of [stripped, extractFirstJsonBlock(stripped, opener)]) {
    if (!candidate) continue
    try { return JSON.parse(candidate) as T } catch { /* try next */ }
  }
  return null
}
