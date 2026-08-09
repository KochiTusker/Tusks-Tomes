// Read-only adapter: Obsidian vault notes → Knowledge-Base prose.
//
// Assembles note bodies into the same `### Name\n<body>` blocks that
// src/lib/pipeline.ts buildKbConcat() produces for Tusks-Lore docs, so the
// full-prose phases (3/6) and the compactKb extractor consume Obsidian lore
// with zero downstream change.
//
// Two levers the flat-folder source can't offer:
//   - resolveWikilinks(): `[[Target|Alias]]` → `Alias`, `[[Target]]` → `Target`,
//     and strips Obsidian callout markers, so the prose reads naturally.
//   - Mode-B enrichment: prepend a one-line relationship header synthesised
//     from each note's frontmatter (affiliations / related / patron / enemies),
//     injecting the vault's typed graph as compact context.
//
// STRICTLY READ-ONLY — never writes into the vault.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { walkVaultNotes } from './vaultAdapter.js'

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/

/** Resolve Obsidian wikilinks and callouts to readable plaintext.
 *  `[[A|B]]` → `B`, `[[A]]` → `A`, `> [!note] ...` callout marker stripped. */
export function resolveWikilinks(body: string): string {
  return body
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, (_m, _target, alias) => alias.trim())
    .replace(/\[\[([^\]]+)\]\]/g, (_m, target) => String(target).split('/').pop()!.trim())
    .replace(/^>\s*\[![a-zA-Z]+\][-+]?\s*/gm, '> ')
}

/** Strip the leading YAML frontmatter fence from a note. */
function stripFrontmatter(raw: string): string {
  return raw.replace(FRONTMATTER_RE, '')
}

/** Frontmatter keys whose wikilink values describe relationships worth
 *  surfacing in the Mode-B header, in display order. */
const RELATION_KEYS = ['affiliations', 'related', 'patron', 'allied-with', 'enemies-with', 'origin', 'part-of']

/** Extract a compact relationship header from a note's frontmatter. Pulls
 *  wikilink targets out of the RELATION_KEYS fields. Returns '' when none. */
export function buildModeBHeader(raw: string, name: string, typeRaw: string | undefined): string {
  const fm = raw.match(FRONTMATTER_RE)
  if (!fm) return ''
  const lines = fm[1].split(/\r?\n/)
  const rels: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const scalar = lines[i].match(/^([A-Za-z_][\w-]*):\s*(.*)$/)
    if (!scalar) continue
    const key = scalar[1].toLowerCase()
    if (!RELATION_KEYS.includes(key)) continue
    // Collect wikilink targets from this line and any following block-list items.
    const collected: string[] = [...scalar[2].matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)].map((m) => m[1].split('/').pop()!.trim())
    for (let j = i + 1; j < lines.length; j++) {
      const item = lines[j].match(/^\s*-\s+(.*)$/)
      if (!item) break
      const links = [...item[1].matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)].map((m) => m[1].split('/').pop()!.trim())
      collected.push(...links)
    }
    const uniq = [...new Set(collected.filter(Boolean))]
    if (uniq.length) rels.push(`${key}: ${uniq.join(', ')}`)
  }
  if (rels.length === 0) return ''
  const typeLabel = typeRaw ? ` (${typeRaw})` : ''
  return `> ${name}${typeLabel} — ${rels.join('; ')}.`
}

function readTypeFromFrontmatter(raw: string): string | undefined {
  const fm = raw.match(FRONTMATTER_RE)
  if (!fm) return undefined
  const m = fm[1].match(/^type:\s*(.+)$/m)
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : undefined
}

export type VaultKbResult = {
  /** Concatenated KB string in the buildKbConcat() format. */
  text: string
  /** Notes included. */
  noteCount: number
}

export type VaultKbOptions = {
  /** Prepend the Mode-B relationship header per note. Default false. */
  modeB?: boolean
}

/** A note rendered as a Knowledge-Base document, shaped like
 *  server/lore/documents.ts LoreDocumentRecord so the same /api/lore/documents
 *  consumer code handles it unchanged. */
export type VaultDocument = {
  id: string
  name: string
  relPath: string
  type: 'md'
  text: string
  sizeBytes: number
  modifiedAt: string
}

/** List the vault's notes as KB documents (one per note), wikilink-resolved
 *  and optionally Mode-B enriched. Mirrors listLoreDocuments() output shape.
 *  Read-only. */
export async function listObsidianDocuments(
  vaultPath: string,
  opts: VaultKbOptions = {},
): Promise<VaultDocument[]> {
  const docs: VaultDocument[] = []
  for await (const { absPath, relPath } of walkVaultNotes(vaultPath)) {
    let raw: string
    let stat: import('node:fs').Stats
    try {
      ;[raw, stat] = await Promise.all([fs.readFile(absPath, 'utf8'), fs.stat(absPath)])
    } catch {
      continue
    }
    const name = path.basename(relPath, '.md')
    const bodyPlain = resolveWikilinks(stripFrontmatter(raw)).trim()
    if (!bodyPlain) continue
    const header = opts.modeB ? buildModeBHeader(raw, name, readTypeFromFrontmatter(raw)) : ''
    const text = (header ? `${header}\n${bodyPlain}` : bodyPlain).trim()
    docs.push({
      id: relPath,
      name,
      relPath,
      type: 'md',
      text,
      sizeBytes: Buffer.byteLength(text, 'utf8'),
      modifiedAt: stat.mtime.toISOString(),
    })
  }
  docs.sort((a, b) => a.relPath.localeCompare(b.relPath))
  return docs
}

/** Build the full KB concat string from an Obsidian vault's notes. Mirrors
 *  src/lib/pipeline.ts buildKbConcat(): `### Name\n<body>` blocks joined by
 *  `\n\n---\n\n`. Read-only. */
export async function buildObsidianKbConcat(
  vaultPath: string,
  opts: VaultKbOptions = {},
): Promise<VaultKbResult> {
  const blocks: string[] = []
  let noteCount = 0
  for await (const { absPath, relPath } of walkVaultNotes(vaultPath)) {
    let raw: string
    try {
      raw = await fs.readFile(absPath, 'utf8')
    } catch {
      continue
    }
    const name = path.basename(relPath, '.md')
    const bodyPlain = resolveWikilinks(stripFrontmatter(raw)).trim()
    if (!bodyPlain) continue
    noteCount++
    const parts = [`### ${name}`]
    if (opts.modeB) {
      const header = buildModeBHeader(raw, name, readTypeFromFrontmatter(raw))
      if (header) parts.push(header)
    }
    parts.push(bodyPlain)
    blocks.push(parts.join('\n').trim())
  }
  return { text: blocks.join('\n\n---\n\n'), noteCount }
}
