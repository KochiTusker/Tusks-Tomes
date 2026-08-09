// Read-only adapter: Obsidian vault → canonical AliasIndex.
//
// Maps an Obsidian vault's one-note-per-entity convention onto the same
// AliasIndex shape the pipeline already consumes (server/lore/aliasTypes.ts),
// so the downstream grounding code (src/lib/aliasMatch.ts) is unchanged.
//
// Primary path: read `_system/entity-index.json` — a curated, typed,
// alias-bearing entity list the vault maintains. Each entry already carries
// { name, aliases[], type, path }, so we get canonical name, aliases, type,
// and source file for free.
//
// Fallback path: when there's no entity-index.json, walk `.md` notes and read
// each note's top-level YAML frontmatter (`type:`, `aliases:`) — the Obsidian
// flat-per-note convention, distinct from the Tusks-Lore nested `entities:`
// block that aliasIndex.ts parses.
//
// STRICTLY READ-ONLY: this module never writes into the vault. Any derived
// index is persisted by the caller into the app's cacheDir, never vaultPath.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  assembleIndex,
  type AliasIndex,
  type EntityRecord,
  type EntityType,
} from '../aliasTypes.js'

export const ENTITY_INDEX_RELPATH = '_system/entity-index.json'

/** Folders that hold meta/scaffolding, not lore entities. Excluded from the
 *  fallback note walk. Vault-relative path prefixes (POSIX separators). */
export const VAULT_EXCLUDE_DIRS = [
  '_system',
  'Templates',
  '.obsidian',
  '.trash',
  '_MOCs',
  '13 - Planning',
  '14 - Ideas',
  // graphify writes its derived graph here when the user runs a build into the
  // vault — it's tooling output, not lore, so never index/concat it.
  'graphify-out',
]

/** Dev / non-lore files that may sit in a vault root but must never be indexed
 *  as lore entities or concatenated into the KB. Compared case-insensitively on
 *  the basename (separator-agnostic — Windows-safe). Includes CLAUDE.md so the
 *  vault-navigation guide the add-on can generate (and any hand-written one)
 *  never grounds as an entity, plus the usual repo-root scaffolding. */
export const VAULT_EXCLUDE_FILES = new Set([
  'claude.md',
  'readme.md',
  'readme.txt',
  'license',
  'license.md',
  'contributing.md',
])

/** Obsidian's entity types are richer than the closed EntityType union the
 *  pipeline uses. Coerce into existing buckets — grounding only needs
 *  names/aliases, so losing mystery/plot-thread granularity is acceptable
 *  for v1. (Extending EntityType is a documented follow-up.) */
export function mapObsidianType(raw: string | undefined): EntityType {
  switch ((raw ?? '').toLowerCase()) {
    case 'npc':
    case 'pc':
    case 'creature':
      return 'character'
    case 'location':
    case 'era':
      return 'location'
    case 'faction':
      return 'faction'
    case 'deity':
      return 'deity'
    case 'patron':
      return 'patron'
    case 'country':
      return 'country'
    default:
      // concept, mystery, plot-thread, foreshadowing, encounter-reference, …
      return 'other'
  }
}

type EntityIndexEntry = {
  name?: unknown
  aliases?: unknown
  type?: unknown
  path?: unknown
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
}

/** Parse `_system/entity-index.json` into EntityRecords. Returns null when the
 *  file is missing or unparseable so the caller can fall back to a note walk. */
export async function readEntityIndex(
  vaultPath: string,
): Promise<{ records: EntityRecord[]; sourceFiles: string[] } | null> {
  const abs = path.join(vaultPath, ENTITY_INDEX_RELPATH)
  let raw: string
  try {
    raw = await fs.readFile(abs, 'utf8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const entries: EntityIndexEntry[] = Array.isArray(parsed)
    ? (parsed as EntityIndexEntry[])
    : Array.isArray((parsed as { entities?: unknown }).entities)
      ? ((parsed as { entities: EntityIndexEntry[] }).entities)
      : []
  if (entries.length === 0) return null

  const records: EntityRecord[] = []
  const sourceFiles = new Set<string>()
  for (const entry of entries) {
    const name = typeof entry.name === 'string' ? entry.name.trim() : ''
    if (!name) continue
    const file = typeof entry.path === 'string' ? entry.path : ''
    records.push({
      name,
      type: mapObsidianType(typeof entry.type === 'string' ? entry.type : undefined),
      aliases: asStringArray(entry.aliases),
      affiliations: [],
      section: name,
      file,
    })
    if (file) sourceFiles.add(file)
  }
  return { records, sourceFiles: [...sourceFiles] }
}

const OBSIDIAN_FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/

/** Parse the flat top-level frontmatter of a single Obsidian note. Reads
 *  `type:` and `aliases:` (inline `[a, b]` or block `- a` list forms). The
 *  note's canonical name is the filename stem (Obsidian's title convention).
 *  Returns null when there's no frontmatter fence. */
export function parseObsidianNote(
  raw: string,
  nameStem: string,
): { name: string; type: EntityType; aliases: string[] } | null {
  const match = raw.match(OBSIDIAN_FRONTMATTER_RE)
  if (!match) return null
  const body = match[1]
  const lines = body.split(/\r?\n/)
  let typeRaw: string | undefined
  const aliases: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const scalar = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/)
    if (!scalar) continue
    const key = scalar[1].toLowerCase()
    const value = scalar[2].trim()
    if (key === 'type') {
      typeRaw = stripQuotes(value)
    } else if (key === 'aliases') {
      if (value.startsWith('[')) {
        aliases.push(...parseInlineList(value))
      } else if (value) {
        aliases.push(stripQuotes(value))
      } else {
        // Block list: consume following `  - item` lines.
        for (let j = i + 1; j < lines.length; j++) {
          const item = lines[j].match(/^\s*-\s+(.*)$/)
          if (!item) break
          const v = stripQuotes(item[1].trim())
          if (v) aliases.push(v)
        }
      }
    }
  }
  return { name: nameStem, type: mapObsidianType(typeRaw), aliases }
}

function stripQuotes(s: string): string {
  const t = s.trim()
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1)
  }
  return t
}

/** Parse `[a, b, "c, d"]` → ["a","b","c, d"]. */
function parseInlineList(raw: string): string[] {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return []
  const inner = trimmed.slice(1, -1).trim()
  if (!inner) return []
  const out: string[] = []
  let buf = ''
  let inQuote = false
  for (const c of inner) {
    if (c === '"') {
      inQuote = !inQuote
      continue
    }
    if (c === ',' && !inQuote) {
      const v = stripQuotes(buf.trim())
      if (v) out.push(v)
      buf = ''
      continue
    }
    buf += c
  }
  const tail = stripQuotes(buf.trim())
  if (tail) out.push(tail)
  return out
}

/** Recursively yield every `.md` note's vault-relative POSIX path, skipping
 *  the meta folders in VAULT_EXCLUDE_DIRS and any dot-directory. Read-only. */
export async function* walkVaultNotes(
  vaultPath: string,
  rel = '',
): AsyncGenerator<{ absPath: string; relPath: string }> {
  const dirAbs = path.join(vaultPath, rel)
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dirAbs, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const relChild = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.')) continue
      if (VAULT_EXCLUDE_DIRS.some((d) => relChild === d || relChild.startsWith(`${d}/`))) continue
      yield* walkVaultNotes(vaultPath, relChild)
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      // Skip dotfiles (symmetry with the dot-directory skip above) and the
      // dev/non-lore files in VAULT_EXCLUDE_FILES so a generated CLAUDE.md,
      // README, etc. is never walked into the index or KB.
      if (entry.name.startsWith('.')) continue
      if (VAULT_EXCLUDE_FILES.has(entry.name.toLowerCase())) continue
      yield { absPath: path.join(dirAbs, entry.name), relPath: relChild }
    }
  }
}

export type VaultIndexResult = {
  index: AliasIndex
  /** How the entities were sourced. */
  source: 'entity-index' | 'note-walk'
  /** Total notes scanned in the fallback walk (0 on the primary path). */
  notesScanned: number
}

/** Build a canonical AliasIndex from an Obsidian vault. Prefers the curated
 *  `_system/entity-index.json`; falls back to walking note frontmatter.
 *  Pure read — never writes into the vault. */
export async function buildObsidianAliasIndex(vaultPath: string): Promise<VaultIndexResult> {
  const fromIndex = await readEntityIndex(vaultPath)
  if (fromIndex) {
    return {
      index: assembleIndex(fromIndex.records, {
        withFrontmatter: fromIndex.sourceFiles,
        withoutFrontmatter: [],
      }),
      source: 'entity-index',
      notesScanned: 0,
    }
  }

  // Fallback: walk every note, read its frontmatter.
  const records: EntityRecord[] = []
  const withFrontmatter: string[] = []
  const withoutFrontmatter: string[] = []
  let notesScanned = 0
  for await (const { absPath, relPath } of walkVaultNotes(vaultPath)) {
    notesScanned++
    let content: string
    try {
      content = await fs.readFile(absPath, 'utf8')
    } catch {
      continue
    }
    const stem = path.basename(relPath, '.md')
    const parsed = parseObsidianNote(content, stem)
    if (!parsed || (parsed.type === 'other' && parsed.aliases.length === 0 && !/^type:/m.test(content))) {
      withoutFrontmatter.push(relPath)
      continue
    }
    withFrontmatter.push(relPath)
    records.push({
      name: parsed.name,
      type: parsed.type,
      aliases: parsed.aliases,
      affiliations: [],
      section: parsed.name,
      file: relPath,
    })
  }
  return {
    index: assembleIndex(records, { withFrontmatter, withoutFrontmatter }),
    source: 'note-walk',
    notesScanned,
  }
}
