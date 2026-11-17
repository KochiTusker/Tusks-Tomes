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

/** Repair the two malformations models most often emit in long JSON prose: a
 *  raw control character inside a string literal (a literal line break between
 *  paragraphs) and a trailing comma before a closing bracket. Both have exactly
 *  one sensible reading. An unescaped quote inside a string does not, so it is
 *  left for callers that know the shape they expect. */
export function repairJson(text: string): string {
  let out = ''
  let inString = false
  let escape = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escape) { escape = false; out += ch; continue }
      if (ch === '\\') { escape = true; out += ch; continue }
      if (ch === '"') { inString = false; out += ch; continue }
      const code = ch.charCodeAt(0)
      if (code < 0x20) {
        out += ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : ch === '\t' ? '\\t' : `\\u${code.toString(16).padStart(4, '0')}`
        continue
      }
      out += ch
      continue
    }
    if (ch === '"') { inString = true; out += ch; continue }
    if (ch === ',') {
      let j = i + 1
      while (j < text.length && /\s/.test(text[j])) j++
      if (text[j] === '}' || text[j] === ']') continue
    }
    out += ch
  }
  return out
}

/** Parse `raw` as JSON of shape T, tolerating code fences, surrounding prose,
 *  and the malformations {@link repairJson} fixes. `opener` selects array vs
 *  object extraction. Null on failure. */
export function tryParseJson<T>(raw: string, opener: '[' | '{'): T | null {
  const stripped = stripCodeFences(raw)
  const block = extractFirstJsonBlock(stripped, opener)
  // Repaired forms come last so well-formed output is parsed exactly as the
  // model wrote it.
  for (const candidate of [stripped, block, block && repairJson(block), repairJson(stripped)]) {
    if (!candidate) continue
    try { return JSON.parse(candidate) as T } catch { /* try next */ }
  }
  return null
}
