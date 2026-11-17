/** Remove one matching pair of surrounding quotes, single or double. */
export function stripQuotes(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1)
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1)
  }
  return s
}

export interface InlineListOptions {
  /**
   * Drop an item that is empty once its surrounding quotes are removed
   * (`['']`). The folder lore index keeps it as an empty string, as it always
   * has; the vault reader drops it. Double-quoted empties never reach this
   * point either way, because double quotes are consumed by the splitter.
   */
  skipEmptyUnquoted?: boolean
}

/**
 * Parse an inline frontmatter list: `[a, b, "c, d"]` gives `["a","b","c, d"]`.
 * A naive splitter that respects double-quoted items. Returns [] for a missing
 * or bracketless value.
 */
export function parseInlineList(raw: string, opts: InlineListOptions = {}): string[] {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return []
  const inner = trimmed.slice(1, -1).trim()
  if (!inner) return []
  const out: string[] = []
  const push = (item: string): void => {
    const v = item.trim()
    if (!v) return
    const value = stripQuotes(v)
    if (opts.skipEmptyUnquoted && !value) return
    out.push(value)
  }
  let buf = ''
  let inQuote = false
  for (const c of inner) {
    if (c === '"') {
      inQuote = !inQuote
      continue
    }
    if (c === ',' && !inQuote) {
      push(buf)
      buf = ''
      continue
    }
    buf += c
  }
  push(buf)
  return out
}
