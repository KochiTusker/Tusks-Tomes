// Alias-index for the Tusks-Lore folder.
//
// Reads YAML frontmatter from each *.md file in the lore root, builds a
// structured index of entities (characters, factions, locations, etc.)
// with their canonical names, aliases, affiliations, and the source
// section anchor. Emits a hidden `.tusks-lore.index.json` file next to
// the lore docs so the client can fetch it cheaply via /api/lore/index.
//
// The pipeline uses this index for:
//   - Phase 1 fuzzy candidate annotation (Levenshtein against alias list)
//   - Phase 3 KB retrieval (find the right doc section per chunk)
//
// Graceful degradation: docs WITHOUT frontmatter still work — the pipeline
// falls back to the proper-noun regex extractor in `src/lib/kbCompact.ts`.
// This file is a precision boost, not a precondition.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { walkFiles, SUPPORTED_DOC_EXTS } from './documents.js'
import {
  ALIAS_INDEX_SCHEMA,
  assembleIndex,
  coerceEntityType,
  type AliasIndex,
  type EntityRecord,
  type EntityType,
} from './aliasTypes.js'

// Re-exported for back-compat: callers historically import these from
// './aliasIndex.js'. The definitions now live in the dependency-light
// ./aliasTypes.js so alternative lore sources can reuse them.
export {
  ALIAS_INDEX_SCHEMA,
  assembleIndex,
  coerceEntityType,
  type AliasIndex,
  type EntityRecord,
  type EntityType,
}

export const ALIAS_INDEX_FILENAME = '.tusks-lore.index.json'

// ─────────────────────────────────────────────────────────────────────────────
// Minimal YAML parser — tailored to the alias-index schema only.
// Handles: top-level scalars, top-level `entities:` block of `- name:` items,
// inline `[a, b, c]` arrays, double-quoted strings. Does NOT handle anchors,
// merge keys, multi-line scalars, or anything else esoteric — by design.
// ─────────────────────────────────────────────────────────────────────────────

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/

export type ParsedFrontmatter = {
  schema?: number
  docType?: string
  entities: Array<{
    name?: string
    type?: string
    aliases?: string[]
    affiliations?: string[]
    section?: string
  }>
}

/** Parse the YAML frontmatter block (everything between the leading and
 *  closing `---` fences). Returns an empty result when no fence is present
 *  or the block doesn't parse — callers treat that as "no frontmatter,
 *  fall back to compactKb". Throws only on egregious shape errors. */
export function parseFrontmatter(rawFile: string): ParsedFrontmatter | null {
  const match = rawFile.match(FRONTMATTER_RE)
  if (!match) return null
  const body = match[1]
  const lines = body.split(/\r?\n/)
  const out: ParsedFrontmatter = { entities: [] }
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim() || line.trimStart().startsWith('#')) {
      i += 1
      continue
    }
    const scalarMatch = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/)
    if (scalarMatch && !line.startsWith(' ')) {
      const [, key, valueRaw] = scalarMatch
      const value = valueRaw.trim()
      if (key === 'entities') {
        // Consume the indented block that follows.
        const [entities, consumed] = parseEntitiesBlock(lines, i + 1)
        out.entities = entities
        i += 1 + consumed
        continue
      }
      // Top-level scalar.
      if (key === 'schema') out.schema = Number(value) || undefined
      else if (key === 'docType') out.docType = stripQuotes(value)
      // Unknown top-level keys are ignored on purpose — future-proofing.
      i += 1
      continue
    }
    i += 1
  }
  return out
}

function parseEntitiesBlock(
  lines: string[],
  startIdx: number,
): [ParsedFrontmatter['entities'], number] {
  const entities: ParsedFrontmatter['entities'] = []
  let i = startIdx
  let current: ParsedFrontmatter['entities'][number] | null = null
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i += 1
      continue
    }
    // New entity row: "  - name: Durgin Ironheart"
    const itemMatch = line.match(/^\s+-\s+([A-Za-z_][\w-]*):\s*(.*)$/)
    if (itemMatch) {
      const [, key, valueRaw] = itemMatch
      if (current) entities.push(current)
      current = {}
      assignField(current, key, valueRaw)
      i += 1
      continue
    }
    // Continuation field: "    type: character"
    const fieldMatch = line.match(/^\s+([A-Za-z_][\w-]*):\s*(.*)$/)
    if (fieldMatch && current) {
      const [, key, valueRaw] = fieldMatch
      assignField(current, key, valueRaw)
      i += 1
      continue
    }
    // Anything else terminates the entities block.
    break
  }
  if (current) entities.push(current)
  return [entities, i - startIdx]
}

function assignField(
  obj: ParsedFrontmatter['entities'][number],
  key: string,
  rawValue: string,
): void {
  const value = rawValue.trim()
  if (key === 'aliases') obj.aliases = parseInlineList(value)
  else if (key === 'affiliations') obj.affiliations = parseInlineList(value)
  else if (key === 'name') obj.name = stripQuotes(value)
  else if (key === 'type') obj.type = stripQuotes(value)
  else if (key === 'section') obj.section = stripQuotes(value)
}

/** Parse `[a, b, "c, d"]` → ["a","b","c, d"]. Returns [] for missing /
 *  bracketless values. */
export function parseInlineList(raw: string): string[] {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return []
  const inner = trimmed.slice(1, -1).trim()
  if (!inner) return []
  // Naive splitter that respects double-quoted items.
  const out: string[] = []
  let buf = ''
  let inQuote = false
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]
    if (c === '"') {
      inQuote = !inQuote
      continue
    }
    if (c === ',' && !inQuote) {
      const v = buf.trim()
      if (v) out.push(stripQuotes(v))
      buf = ''
      continue
    }
    buf += c
  }
  const tail = buf.trim()
  if (tail) out.push(stripQuotes(tail))
  return out
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1)
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1)
  }
  return s
}

// ─────────────────────────────────────────────────────────────────────────────
// Index build pipeline
// ─────────────────────────────────────────────────────────────────────────────

/** Build the AliasIndex from a parsed lore root. Pure function — pass in
 *  the file contents you already have; the function does no I/O. */
export function buildAliasIndex(
  parsed: Array<{ relPath: string; content: string }>,
): AliasIndex {
  const records: EntityRecord[] = []
  const filesWithFrontmatter: string[] = []
  const filesWithoutFrontmatter: string[] = []

  for (const { relPath, content } of parsed) {
    const fm = parseFrontmatter(content)
    if (!fm || !fm.entities || fm.entities.length === 0) {
      filesWithoutFrontmatter.push(relPath)
      continue
    }
    filesWithFrontmatter.push(relPath)
    for (const ent of fm.entities) {
      if (!ent.name) continue
      records.push({
        name: ent.name,
        type: coerceEntityType(ent.type),
        aliases: ent.aliases ?? [],
        affiliations: ent.affiliations ?? [],
        section: ent.section ?? ent.name,
        file: relPath,
      })
    }
  }
  return assembleIndex(records, {
    withFrontmatter: filesWithFrontmatter,
    withoutFrontmatter: filesWithoutFrontmatter,
  })
}

/** Walk the lore root, read every supported markdown file, and build the
 *  alias index. Reads-only — does not write the index file (use writeAliasIndex
 *  for that). */
export async function readAndBuildAliasIndex(loreRoot: string): Promise<AliasIndex> {
  const parsed: Array<{ relPath: string; content: string }> = []
  for await (const { absPath, relPath } of walkFiles(loreRoot, loreRoot)) {
    const ext = path.extname(absPath).toLowerCase()
    // Only markdown / text can carry frontmatter in a meaningful way — PDFs
    // and DOCX have their own metadata systems and aren't in scope.
    if (ext !== '.md' && ext !== '.txt') continue
    if (!SUPPORTED_DOC_EXTS.has(ext)) continue
    try {
      const content = await fs.readFile(absPath, 'utf8')
      parsed.push({ relPath, content })
    } catch {
      // Unreadable files are silently skipped; listLoreDocuments would have
      // already surfaced a more verbose error elsewhere.
    }
  }
  return buildAliasIndex(parsed)
}

/** Write the alias index to <loreRoot>/<ALIAS_INDEX_FILENAME>. Atomic
 *  rename-from-tmp so concurrent reads never see a half-written file. */
export async function writeAliasIndex(loreRoot: string, index: AliasIndex): Promise<void> {
  const target = path.join(loreRoot, ALIAS_INDEX_FILENAME)
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`
  await fs.writeFile(tmp, JSON.stringify(index, null, 2), 'utf8')
  await fs.rename(tmp, target)
}

/** Convenience: build + write in one call. Used by the rebuild hook and
 *  by the boot-time loader. */
export async function rebuildAliasIndex(loreRoot: string): Promise<AliasIndex> {
  const index = await readAndBuildAliasIndex(loreRoot)
  await writeAliasIndex(loreRoot, index)
  return index
}

/** Read the persisted alias index. Returns null when missing or unparseable
 *  — callers either trigger a rebuild or proceed with no index (graceful
 *  degradation back to compactKb-only). */
export async function readAliasIndex(loreRoot: string): Promise<AliasIndex | null> {
  const target = path.join(loreRoot, ALIAS_INDEX_FILENAME)
  try {
    const raw = await fs.readFile(target, 'utf8')
    const parsed = JSON.parse(raw) as AliasIndex
    if (parsed.schema !== ALIAS_INDEX_SCHEMA) return null
    return parsed
  } catch {
    return null
  }
}
