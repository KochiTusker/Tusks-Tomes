// Pure alias-index types + assembly. NO I/O, no heavy imports.
//
// Split out of aliasIndex.ts so that alternative lore sources (the Obsidian
// vault adapter in server/lore/obsidian/) can produce a canonical AliasIndex
// without dragging in the PDF/DOCX parsers that aliasIndex.ts → documents.ts
// pulls transitively. aliasIndex.ts re-exports everything here, so existing
// `from './aliasIndex.js'` importers are unaffected.

export const ALIAS_INDEX_SCHEMA = 1

export type EntityType =
  | 'character'
  | 'country'
  | 'deity'
  | 'faction'
  | 'patron'
  | 'location'
  | 'other'

export type EntityRecord = {
  /** Canonical name (the one the AI should always output). */
  name: string
  type: EntityType
  aliases: string[]
  affiliations: string[]
  /** Heading anchor inside the source file (typically the H1/H2 text). */
  section: string
  /** Source file's relative path from the lore root, e.g. "Characters.md". */
  file: string
}

export type AliasIndex = {
  schema: typeof ALIAS_INDEX_SCHEMA
  builtAt: string
  /** Canonical name → entity. */
  byEntity: Record<string, EntityRecord>
  /** Lowercased alias (or canonical name) → canonical name. Many-to-one. */
  aliases: Record<string, string>
  /** Type bucket → array of canonical names. */
  byType: Record<EntityType, string[]>
  /** Files that contributed at least one entity via frontmatter. */
  filesWithFrontmatter: string[]
  /** Files scanned but lacking parseable frontmatter — pipeline still
   *  works on these via the compactKb fallback. Reported to the UI so
   *  the user knows which docs would benefit from migration. */
  filesWithoutFrontmatter: string[]
}

export const KNOWN_ENTITY_TYPES = new Set<EntityType>([
  'character',
  'country',
  'deity',
  'faction',
  'patron',
  'location',
  'other',
])

/** Coerce an arbitrary type string into a known EntityType bucket. Unknown
 *  values land in 'other' so a typo in the frontmatter doesn't crash the
 *  build. */
export function coerceEntityType(value: string | undefined): EntityType {
  if (!value) return 'other'
  const lower = value.toLowerCase()
  return KNOWN_ENTITY_TYPES.has(lower as EntityType) ? (lower as EntityType) : 'other'
}

/** Assemble a finished AliasIndex from already-built EntityRecords. Pure —
 *  builds the byEntity / aliases / byType maps and sorts them. Shared by the
 *  Tusks-Lore frontmatter parser (buildAliasIndex) and the Obsidian vault
 *  adapter (server/lore/obsidian/vaultAdapter.ts), so the alias-map shape
 *  and ordering live in exactly one place. The caller supplies the source
 *  file lists for the UI's "which docs lack frontmatter" diagnostics. */
export function assembleIndex(
  records: EntityRecord[],
  files: { withFrontmatter: string[]; withoutFrontmatter: string[] },
): AliasIndex {
  const byEntity: Record<string, EntityRecord> = {}
  const aliases: Record<string, string> = {}
  const byType: Record<EntityType, string[]> = {
    character: [],
    country: [],
    deity: [],
    faction: [],
    patron: [],
    location: [],
    other: [],
  }
  for (const record of records) {
    if (!record.name) continue
    byEntity[record.name] = record
    byType[record.type].push(record.name)
    // Canonical name maps to itself; every alias maps to canonical.
    aliases[record.name.toLowerCase()] = record.name
    for (const alias of record.aliases) {
      if (!alias.trim()) continue
      aliases[alias.toLowerCase()] = record.name
    }
  }
  for (const type of Object.keys(byType) as EntityType[]) {
    byType[type].sort((a, b) => a.localeCompare(b))
  }
  return {
    schema: ALIAS_INDEX_SCHEMA,
    builtAt: new Date().toISOString(),
    byEntity,
    aliases,
    byType,
    filesWithFrontmatter: [...files.withFrontmatter].sort(),
    filesWithoutFrontmatter: [...files.withoutFrontmatter].sort(),
  }
}
