#!/usr/bin/env node
// Migration helper — scans the Tusks-Lore folder, proposes YAML frontmatter
// for every *.md file that doesn't already have one, and (in --apply mode)
// writes the frontmatter in place. Each modified file gets a .bak sibling
// so the user can revert per-file via the Tome of Lore UI.
//
// Default run = DRY (proposes only). Pass --apply to write.
//
// Detection rules (intentionally conservative):
//   - H1 headings ("# Entity Name") become entity candidates, EXCEPT the
//     first H1 if it looks like a file-title (e.g. "# Characters Overview"
//     for Characters.md).
//   - The next ~20 lines after an H1 are scanned for "Character Alias:"
//     / "Alias:" lines. Comma-separated values become the aliases array.
//   - Affiliations are NOT auto-extracted — they require prose understanding
//     the user should validate. They start empty in the migration.
//   - docType is inferred from filename (Characters.md → characters, etc.).
//
// Output:
//   - Per-file backup at <file>.bak (always written on apply).
//   - A migration report at <loreRoot>/.tusks-lore-migration.json with:
//     { migratedAt, files: [{ relPath, action, entitiesAdded, hadFrontmatter }] }
//
// Safety: never modifies files that already have a `---\n…\n---` frontmatter
// block. Re-running on a fully-migrated tree is a no-op.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n/
const H1_RE = /^# (.+?)\s*$/
// Alias accepts: "- Character Alias: x", "- Alias: x", "Alias: x" (no dash),
// "**Alias**: x" (bold + colon outside the asterisks), "**Alias:** x" (colon
// inside). The asterisks are optional.
const ALIAS_LINE_RE = /^(?:- *)?(?:\*\*)?(?:Character )?Alias(?:\*\*)?:\s*\*?\*?\s*(.+?)\s*\*?\*?\s*$/i

// Headings that are file-section titles (intros), not entities. Matched
// case-insensitively against the H1 text.
const SECTION_TITLE_PATTERNS = [
  /\boverview\b/i,
  /\bintroduction\b/i,
  /\bindex\b/i,
  /\bstructure\b/i,
  /\bremoved ideas\b/i,
  /\bsummary\b/i,
  /^session logs?$/i, // file-title for Session Logs docs
  /\bpolitics$/i, // "Faction Politics", "Court Politics"
  /\bplotline\b/i, // "Major Plotline – History"
  /\bhistory$/i, // "Major Plotline – History" / "House History"
  /\bcredits$/i,
  /\bappendix\b/i,
]

// Chronological / session-boundary markers — useful for navigation but not
// entities the AI should ground against. "# SESSION 23", "Session 14",
// "Episode 7", "Chapter 12", "Part III" etc.
const SESSION_MARKER_PATTERNS = [
  /^\s*(?:session|episode|chapter|part)\s+(?:\d+|[ivxlcdm]+)\s*$/i,
]

// Headings that look like time periods rather than entities (Timeline.md
// uses "# The Reset – 10,000 BCE" style). Filter these out — they're
// chronological labels, not lore entities to ground against.
const TIME_PERIOD_PATTERNS = [
  /\b(?:BCE|CE|BC|AD)\b/,
  /\b\d{3,5}\b/, // a year-shaped number alone is enough signal
  /\bage of\b/i,
  /\bera\b/i,
]

const DOC_TYPE_FROM_FILENAME = [
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

function inferDocType(filename) {
  for (const { pattern, docType, entityType } of DOC_TYPE_FROM_FILENAME) {
    if (pattern.test(filename)) return { docType, entityType }
  }
  return { docType: 'other', entityType: 'other' }
}

function looksLikeFileTitle(headingText, filename) {
  // Either the heading starts with the first word of the filename, OR it
  // appears as a substring of the filename (case-insensitive), OR it
  // matches a common section-title pattern (Overview / Index / etc.).
  const baseName = path.basename(filename, '.md').toLowerCase()
  const firstWord = baseName.split(/[-_\s]/)[0]
  const heading = headingText.toLowerCase()
  if (heading.startsWith(firstWord)) return true
  // The filename "Too Many Bruisers - Session Logs.md" contains "session logs"
  // → any heading that's a substring of the filename is treated as the
  // file's own title.
  if (baseName.includes(heading) && heading.length >= 5) return true
  return SECTION_TITLE_PATTERNS.some((re) => re.test(headingText))
}

function looksLikeTimePeriod(headingText) {
  return TIME_PERIOD_PATTERNS.some((re) => re.test(headingText))
}

function looksLikeSessionMarker(headingText) {
  return SESSION_MARKER_PATTERNS.some((re) => re.test(headingText))
}

function parseAliases(rawValue) {
  // Comma-separated; trims, drops empties.
  return rawValue
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** Detect markdown content that came from a docx→md conversion where the
 *  source styled headings as bold/big text rather than Word "Heading"
 *  styles. Mammoth preserves only marked-up headings, so the resulting
 *  markdown has zero `#` lines despite the source having clear sections.
 *  Returns the content with detected heading-shaped paragraphs promoted
 *  to `# Heading`. Conservative — when in doubt, do nothing.
 *
 *  A line is treated as a heading when:
 *    - Short (≤ 60 chars)
 *    - Title Case or all caps
 *    - No terminal punctuation (`.,;!?:`)
 *    - Not inside a list (no leading `-`, `*`, `1.`, `>`)
 *    - Not a key:value line (no `:` in the line)
 *    - Preceded by a blank line OR file start
 *    - Followed by a blank line + a longer content paragraph
 *
 *  Only applied when the source contains ZERO `#` / `##` lines — files
 *  that already have markdown headings keep their author-chosen structure
 *  untouched.
 */
function promoteHeadings(content) {
  // Bail when any markdown heading is already present — author intent wins.
  if (/^#{1,6} /m.test(content)) return content
  const lines = content.split(/\r?\n/)
  const out = []
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

// Structural keys that strongly indicate the line ABOVE is a section
// heading even when that line wouldn't otherwise look like one (e.g. a
// short heading followed by "Capital: None" instead of a prose paragraph).
const STRUCTURAL_FOLLOWUP_KEYS = [
  'Capital', 'Capitals', 'Location', 'Locations', 'Population',
  'Government', 'Geography', 'Founded', 'Founder', 'Race', 'Class',
  'Domain', 'Domains', 'Alias', 'Aliases', 'Symbol', 'Theme',
  'Worshippers', 'Alignment',
]
const STRUCTURAL_FOLLOWUP_RE = new RegExp(
  `^(?:\\*\\*)?(?:${STRUCTURAL_FOLLOWUP_KEYS.join('|')})(?:\\*\\*)?:`,
)

function isHeadingShaped(line, i, lines) {
  const trimmed = line.trim()
  if (trimmed.length < 2 || trimmed.length > 60) return false
  if (/^[-*>]\s|^\d+\.\s/.test(trimmed)) return false // list item
  if (/[:.,;!?]$/.test(trimmed)) return false // sentence/key-value
  if (trimmed.includes(':')) return false // "Capital: None" style
  // Title Case or all caps — first letter of each word capital, or whole
  // line uppercase. Allow short connecting words (of/the/and/or/in/at).
  const words = trimmed.split(/\s+/)
  if (words.length > 8) return false // too long to be a heading
  const titleish = words.every((w, idx) => {
    if (idx > 0 && /^(?:of|the|and|or|in|at|de|der|von|to|a|an)$/i.test(w)) return true
    return /^[A-Z]/.test(w)
  })
  if (!titleish) return false
  const prevLine = i === 0 ? '' : lines[i - 1]
  const nextLine = i + 1 < lines.length ? lines[i + 1] : ''
  // Require blank-before (or start of file).
  if (i > 0 && prevLine.trim().length > 0) return false
  // Require blank-after AND meaningful content two lines down. Meaningful =
  // either a long prose paragraph (≥ 40 chars) OR a structural-key line
  // that confirms this is a section heading ("Capital: …", "Location: …").
  // The structural-key path is what recovers countries whose section starts
  // straight with key:value metadata instead of a descriptive paragraph.
  if (nextLine.trim().length !== 0) return false
  const contentLine = i + 2 < lines.length ? lines[i + 2] : ''
  const contentTrim = contentLine.trim()
  if (contentTrim.length >= 40) return true
  if (STRUCTURAL_FOLLOWUP_RE.test(contentTrim)) return true
  return false
}

function extractEntities(content, filename) {
  const { entityType } = inferDocType(filename)
  // Run the heading-promotion pre-pass FIRST so the H1 regex below picks up
  // sections from docx→md files where the original heading styling was
  // lost. No-op when the file already has `#` headings.
  const promoted = promoteHeadings(content)
  const lines = promoted.split(/\r?\n/)
  const entities = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(H1_RE)
    if (!m) continue
    const name = m[1].trim()
    // ANY heading that looks like a file title — start of filename match OR
    // substring of filename — is filtered. Not just the first heading: the
    // file "Too Many Bruisers - Session Logs.md" has "# Session Logs" + "# Too
    // Many Tonies" inside, both of which should be skipped as file titles.
    if (looksLikeFileTitle(name, filename)) continue
    if (SECTION_TITLE_PATTERNS.some((re) => re.test(name))) continue
    if (looksLikeTimePeriod(name)) continue
    if (looksLikeSessionMarker(name)) continue
    // Scan the next ~20 lines for an Alias / Character Alias line. Stop
    // at the next H1 / H2 so we don't bleed into a neighbouring entity.
    let aliases = []
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
  return entities
}

function yamlInlineList(items) {
  if (items.length === 0) return '[]'
  // Quote items that contain commas or special characters.
  const needsQuote = (s) => /[,:#"'\[\]]/.test(s) || s.startsWith(' ') || s.endsWith(' ')
  const formatted = items.map((s) => (needsQuote(s) ? `"${s.replace(/"/g, '\\"')}"` : s))
  return `[${formatted.join(', ')}]`
}

function renderFrontmatter(filename, entities) {
  const { docType } = inferDocType(filename)
  const lines = ['---', 'schema: 1', `docType: ${docType}`]
  if (entities.length > 0) {
    lines.push('entities:')
    for (const ent of entities) {
      lines.push(`  - name: ${ent.name}`)
      lines.push(`    type: ${ent.type}`)
      lines.push(`    aliases: ${yamlInlineList(ent.aliases)}`)
      lines.push(`    affiliations: ${yamlInlineList(ent.affiliations)}`)
      lines.push(`    section: "${ent.section.replace(/"/g, '\\"')}"`)
    }
  } else {
    lines.push('entities: []')
  }
  lines.push('---', '')
  return lines.join('\n')
}

async function walk(dir, base) {
  const out = []
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const abs = path.join(dir, e.name)
    if (e.isDirectory()) {
      out.push(...(await walk(abs, base)))
    } else if (e.isFile() && abs.toLowerCase().endsWith('.md')) {
      out.push({ absPath: abs, relPath: path.relative(base, abs) })
    }
  }
  return out
}

async function main() {
  const args = process.argv.slice(2)
  const loreRootArg = args.find((a) => !a.startsWith('--')) ?? null
  const apply = args.includes('--apply')

  let loreRoot
  if (loreRootArg) {
    loreRoot = path.resolve(loreRootArg)
  } else {
    // Default: D:\Tusks-Lore (matches the user's setup) or sibling of repo.
    const sibling = path.resolve(__dirname, '..', '..', '..', 'Tusks-Lore')
    try {
      await fs.access(sibling)
      loreRoot = sibling
    } catch {
      console.error('No lore root provided and the sibling Tusks-Lore folder was not found.')
      console.error('Usage: node scripts/lore/extract-aliases.mjs <loreRoot> [--apply]')
      process.exit(2)
    }
  }

  const files = await walk(loreRoot, loreRoot)
  const report = { migratedAt: new Date().toISOString(), loreRoot, apply, files: [] }

  for (const { absPath, relPath } of files) {
    const content = await fs.readFile(absPath, 'utf8')
    if (FRONTMATTER_RE.test(content)) {
      report.files.push({ relPath, action: 'skipped', reason: 'has-frontmatter', entitiesAdded: 0 })
      continue
    }
    const entities = extractEntities(content, path.basename(absPath))
    if (entities.length === 0) {
      report.files.push({ relPath, action: 'skipped', reason: 'no-headings', entitiesAdded: 0 })
      continue
    }
    const frontmatter = renderFrontmatter(path.basename(absPath), entities)
    const next = frontmatter + content
    report.files.push({
      relPath,
      action: apply ? 'applied' : 'proposed',
      entitiesAdded: entities.length,
      entityNames: entities.map((e) => e.name),
      proposedFrontmatter: frontmatter,
    })
    if (apply) {
      await fs.writeFile(`${absPath}.bak`, content, 'utf8')
      await fs.writeFile(absPath, next, 'utf8')
    }
  }

  const reportPath = path.join(loreRoot, '.tusks-lore-migration.json')
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8')

  const applied = report.files.filter((f) => f.action === 'applied').length
  const proposed = report.files.filter((f) => f.action === 'proposed').length
  const skipped = report.files.filter((f) => f.action === 'skipped').length
  const totalEntities = report.files.reduce((s, f) => s + (f.entitiesAdded ?? 0), 0)

  console.log(`Migration report → ${reportPath}`)
  console.log(`  applied: ${applied}, proposed: ${proposed}, skipped: ${skipped}`)
  console.log(`  total entities ${apply ? 'written' : 'proposed'}: ${totalEntities}`)
  if (!apply && proposed > 0) {
    console.log('\nDRY RUN — pass --apply to write frontmatter (originals will be backed up to *.bak).')
  }
}

main().catch((err) => {
  console.error('extract-aliases failed:', err)
  process.exit(1)
})
