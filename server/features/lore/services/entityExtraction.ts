// Shared entity-extraction logic used by both the CLI migration helper
// (scripts/lore/extract-aliases.mjs — keeps its own copy as it must run
// without TS tooling) AND the server-side auto-frontmatter path that fires
// when a .docx is uploaded or bulk-converted.
//
// Detection rules (intentionally conservative — false positives are worse
// than false negatives for grounding accuracy):
//
//   - H1 headings (`# Entity Name`) become entity candidates, EXCEPT:
//       * The first H1 if it matches the filename (file-title intros).
//       * Any H1 matching SECTION_TITLE_PATTERNS / TIME_PERIOD_PATTERNS /
//         SESSION_MARKER_PATTERNS — those are navigation, not entities.
//   - The next ~20 lines after an H1 are scanned for "Character Alias:" /
//     "Alias:" / "**Alias**: x" lines. Comma-separated → aliases array.
//   - Affiliations are NOT auto-extracted — they require prose understanding
//     the user should validate manually.
//   - docType is inferred from filename (Characters.md → characters, etc.).
//   - Heading-promotion pre-pass: when the file has ZERO `#` headings,
//     promote Title-Case paragraphs that look like sections (handles docx
//     conversions that lost heading styles).

import { promoteHeadings } from './headingPromotion.js'

const H1_RE = /^# (.+?)\s*$/

const ALIAS_LINE_RE =
  /^(?:- *)?(?:\*\*)?(?:Character )?Alias(?:\*\*)?:\s*\*?\*?\s*(.+?)\s*\*?\*?\s*$/i

const SECTION_TITLE_PATTERNS = [
  /\boverview\b/i,
  /\bintroduction\b/i,
  /\bindex\b/i,
  /\bstructure\b/i,
  /\bremoved ideas\b/i,
  /\bsummary\b/i,
  /^session logs?$/i,
  /\bpolitics$/i,
  /\bplotline\b/i,
  /\bhistory$/i,
  /\bcredits$/i,
  /\bappendix\b/i,
]

const SESSION_MARKER_PATTERNS = [
  /^\s*(?:session|episode|chapter|part)\s+(?:\d+|[ivxlcdm]+)\s*$/i,
]

const TIME_PERIOD_PATTERNS = [
  /\b(?:BCE|CE|BC|AD)\b/,
  /\b\d{3,5}\b/,
  /\bage of\b/i,
  /\bera\b/i,
]

type DocTypeRule = {
  pattern: RegExp
  docType: string
  entityType: string
}

const DOC_TYPE_FROM_FILENAME: DocTypeRule[] = [
  { pattern: /^characters?\b/i, docType: 'characters', entityType: 'character' },
  { pattern: /^countries?\b/i, docType: 'countries', entityType: 'country' },
  { pattern: /^deities\b/i, docType: 'deities', entityType: 'deity' },
  { pattern: /^factions?\b/i, docType: 'factions', entityType: 'faction' },
  { pattern: /^patrons?\b/i, docType: 'patrons', entityType: 'patron' },
  { pattern: /^locations?\b/i, docType: 'locations', entityType: 'location' },
  { pattern: /^session[- _]?logs?\b/i, docType: 'sessions', entityType: 'other' },
  { pattern: /^timeline\b/i, docType: 'timeline', entityType: 'other' },
  { pattern: /^world\b/i, docType: 'world', entityType: 'other' },
]

export type ExtractedEntity = {
  name: string
  type: string
  aliases: string[]
  affiliations: string[]
  section: string
}

export type ExtractionResult = {
  docType: string
  entities: ExtractedEntity[]
  /** True if the input went through the heading-promotion pre-pass (i.e.
   *  no `#` headings were present in the original markdown). */
  promotedHeadings: boolean
}

export function inferDocType(filename: string): { docType: string; entityType: string } {
  for (const { pattern, docType, entityType } of DOC_TYPE_FROM_FILENAME) {
    if (pattern.test(filename)) return { docType, entityType }
  }
  return { docType: 'other', entityType: 'other' }
}

function looksLikeFileTitle(headingText: string, filename: string): boolean {
  const baseName = filename.replace(/\.md$/i, '').toLowerCase()
  const firstWord = baseName.split(/[-_\s]/)[0]
  const heading = headingText.toLowerCase()
  if (heading.startsWith(firstWord)) return true
  if (baseName.includes(heading) && heading.length >= 5) return true
  return SECTION_TITLE_PATTERNS.some((re) => re.test(headingText))
}

function looksLikeTimePeriod(headingText: string): boolean {
  return TIME_PERIOD_PATTERNS.some((re) => re.test(headingText))
}

function looksLikeSessionMarker(headingText: string): boolean {
  return SESSION_MARKER_PATTERNS.some((re) => re.test(headingText))
}

function parseAliases(rawValue: string): string[] {
  return rawValue
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** Extract entity candidates from a markdown document. Pure function —
 *  passes the input through heading-promotion when needed, scans H1s,
 *  filters section/time/session noise, and lifts inline Alias lines. */
export function extractEntities(content: string, filename: string): ExtractionResult {
  const { docType, entityType } = inferDocType(filename)
  const had_headings = /^#{1,6} /m.test(content)
  const promoted = had_headings ? content : promoteHeadings(content)
  const lines = promoted.split(/\r?\n/)
  const entities: ExtractedEntity[] = []

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(H1_RE)
    if (!m) continue
    const name = m[1].trim()
    if (looksLikeFileTitle(name, filename)) continue
    if (SECTION_TITLE_PATTERNS.some((re) => re.test(name))) continue
    if (looksLikeTimePeriod(name)) continue
    if (looksLikeSessionMarker(name)) continue
    let aliases: string[] = []
    for (let j = i + 1; j < Math.min(lines.length, i + 25); j++) {
      const line = lines[j]
      if (/^#{1,2} /.test(line)) break
      const am = line.match(ALIAS_LINE_RE)
      if (am) {
        aliases = parseAliases(am[1])
        break
      }
    }
    entities.push({
      name,
      type: entityType,
      aliases,
      affiliations: [],
      section: name,
    })
  }
  return { docType, entities, promotedHeadings: !had_headings }
}

function yamlInlineList(items: string[]): string {
  if (items.length === 0) return '[]'
  const needsQuote = (s: string) =>
    /[,:#"'\[\]]/.test(s) || s.startsWith(' ') || s.endsWith(' ')
  const formatted = items.map((s) =>
    needsQuote(s) ? `"${s.replace(/"/g, '\\"')}"` : s,
  )
  return `[${formatted.join(', ')}]`
}

/** Render an ExtractionResult as a YAML frontmatter block (including the
 *  enclosing `---` fences and trailing newline). Compatible with the
 *  parser in aliasIndex.ts. */
export function renderFrontmatter(result: ExtractionResult): string {
  const lines: string[] = ['---', 'schema: 1', `docType: ${result.docType}`]
  if (result.entities.length === 0) {
    lines.push('entities: []')
  } else {
    lines.push('entities:')
    for (const ent of result.entities) {
      lines.push(`  - name: ${ent.name}`)
      lines.push(`    type: ${ent.type}`)
      lines.push(`    aliases: ${yamlInlineList(ent.aliases)}`)
      lines.push(`    affiliations: ${yamlInlineList(ent.affiliations)}`)
      lines.push(`    section: "${ent.section.replace(/"/g, '\\"')}"`)
    }
  }
  lines.push('---', '')
  return lines.join('\n')
}

const FRONTMATTER_FENCE_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n/

/** Top-level helper used by the docx upload + bulk-convert paths.
 *  Returns the markdown with auto-generated frontmatter prepended, plus
 *  the extraction result for UI feedback. No-op (returns input unchanged
 *  + zero entities) if the markdown already has a frontmatter fence. */
export function autoApplyFrontmatter(
  markdown: string,
  filename: string,
): { markdown: string; result: ExtractionResult; skipped: boolean } {
  if (FRONTMATTER_FENCE_RE.test(markdown)) {
    return {
      markdown,
      result: { docType: 'other', entities: [], promotedHeadings: false },
      skipped: true,
    }
  }
  const result = extractEntities(markdown, filename)
  if (result.entities.length === 0) {
    // Nothing to add — return the markdown untouched. The pipeline still
    // works on this file via the compactKb proper-noun extractor.
    return { markdown, result, skipped: false }
  }
  const frontmatter = renderFrontmatter(result)
  return { markdown: frontmatter + markdown, result, skipped: false }
}
