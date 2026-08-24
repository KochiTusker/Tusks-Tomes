// Promote heading-shaped paragraphs to markdown H1s in a body of text.
//
// Mammoth + turndown produces plain paragraphs for docx content that was
// styled visually (bold / large font) rather than via Word's Heading styles.
// This loses the document structure the AI needs to ground against. This
// helper runs over the converted markdown and inserts `# Heading` for
// paragraphs that look like section titles.
//
// Conservative — only fires when the file has ZERO existing `#` headings,
// so files where the author DID use proper Heading styles are untouched.
//
// Mirrors the same heuristic used by scripts/lore/extract-aliases.mjs:
// short Title-Case line, no terminal punctuation, blank-before, blank-after,
// followed by either a long prose paragraph (≥ 40 chars) or a structural
// key:value line ("Capital: …", "Location: …") that confirms it's a header.

const STRUCTURAL_FOLLOWUP_KEYS = [
  'Capital', 'Capitals', 'Location', 'Locations', 'Population',
  'Government', 'Geography', 'Founded', 'Founder', 'Race', 'Class',
  'Domain', 'Domains', 'Alias', 'Aliases', 'Symbol', 'Theme',
  'Worshippers', 'Alignment',
]
const STRUCTURAL_FOLLOWUP_RE = new RegExp(
  `^(?:\\*\\*)?(?:${STRUCTURAL_FOLLOWUP_KEYS.join('|')})(?:\\*\\*)?:`,
)

function isHeadingShaped(line: string, i: number, lines: string[]): boolean {
  const trimmed = line.trim()
  if (trimmed.length < 2 || trimmed.length > 60) return false
  if (/^[-*>]\s|^\d+\.\s/.test(trimmed)) return false
  if (/[:.,;!?]$/.test(trimmed)) return false
  if (trimmed.includes(':')) return false
  const words = trimmed.split(/\s+/)
  if (words.length > 8) return false
  const titleish = words.every((w, idx) => {
    if (idx > 0 && /^(?:of|the|and|or|in|at|de|der|von|to|a|an)$/i.test(w)) return true
    return /^[A-Z]/.test(w)
  })
  if (!titleish) return false
  const prevLine = i === 0 ? '' : lines[i - 1]
  const nextLine = i + 1 < lines.length ? lines[i + 1] : ''
  if (i > 0 && prevLine.trim().length > 0) return false
  if (nextLine.trim().length !== 0) return false
  const contentLine = i + 2 < lines.length ? lines[i + 2] : ''
  const contentTrim = contentLine.trim()
  if (contentTrim.length >= 40) return true
  if (STRUCTURAL_FOLLOWUP_RE.test(contentTrim)) return true
  return false
}

export function promoteHeadings(markdown: string): string {
  // Bail when any markdown heading is already present — author intent wins.
  if (/^#{1,6} /m.test(markdown)) return markdown
  const lines = markdown.split(/\r?\n/)
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (isHeadingShaped(line, i, lines)) {
      out.push(`# ${line.trim()}`)
    } else {
      out.push(line)
    }
  }
  return out.join('\n')
}
