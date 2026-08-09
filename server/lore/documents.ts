// Pure helpers for the /api/lore/documents surface. Extracted from the
// router so each piece can be unit-tested without spinning up an HTTP
// server. server/api/lore.ts imports from here; tests live alongside
// in documents.test.ts.

import path from 'node:path'
import { promises as fs } from 'node:fs'
import { parsePdf } from '../pdfParse.js'
import { LORE_MARKER_FILENAME } from './detection.js'
import { docxBufferToMarkdown } from './docxToMarkdown.js'

export const SUPPORTED_DOC_EXTS = new Set(['.md', '.txt', '.pdf', '.docx'])

export type LoreDocType = 'pdf' | 'docx' | 'txt' | 'md'

export const EXT_TO_TYPE: Record<string, LoreDocType> = {
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.txt': 'txt',
  '.md': 'md',
}

export type LoreDocumentRecord = {
  id: string
  name: string
  relPath: string
  type: LoreDocType
  text: string
  sizeBytes: number
  modifiedAt: string
}

// Cache parsed text keyed by absolute path; entries invalidate on mtime
// change. Avoids re-parsing the same 20 .docx chronicles on every refresh.
const docCache = new Map<string, { text: string; mtimeMs: number; sizeBytes: number }>()

/** Reset the in-memory parse cache. Tests use this to start from a clean
 *  state; production callers should prefer `invalidateDocCache` for a
 *  single file. */
export function clearDocCache(): void {
  docCache.clear()
}

/** Drop a single absPath from the parse cache. Called by the POST/DELETE
 *  routes after they write or remove a file so the next GET re-reads it.
 *  Also notifies any registered subscribers — the alias-index rebuild
 *  hooks in here so it stays decoupled from the HTTP router. */
export function invalidateDocCache(absPath: string): void {
  docCache.delete(absPath)
  for (const sub of invalidationSubscribers) {
    try {
      sub(absPath)
    } catch (err) {
      console.warn('[lore/documents] invalidation subscriber threw:', err)
    }
  }
}

type InvalidationSubscriber = (absPath: string) => void
const invalidationSubscribers = new Set<InvalidationSubscriber>()

/** Register a callback fired whenever a single doc's parse cache is
 *  invalidated. Used by the alias-index rebuild — kept generic so other
 *  consumers (e.g. future RAG indexes) can hook in the same way. */
export function onDocCacheInvalidated(handler: InvalidationSubscriber): () => void {
  invalidationSubscribers.add(handler)
  return () => invalidationSubscribers.delete(handler)
}

/**
 * Migration JSON path always lands on disk as .txt — the body's `text`
 * field is already-extracted plain text from the legacy localStorage KB.
 * Preserving the original extension (.docx, .pdf, ...) would write UTF-8
 * text inside a filename that downstream parsers (mammoth, pdf-parse)
 * will treat as binary and fail on. This bug shipped briefly in
 * f2bb9b0 and was fixed in 3b45cf8 — see documents.test.ts for the
 * regression guard.
 */
export function normalizeMigrationName(originalName: string): string {
  const base = originalName.replace(/\.[^./\\]+$/, '') || originalName
  return `${base}.txt`
}

export async function extractText(absPath: string, ext: string): Promise<string> {
  if (ext === '.md' || ext === '.txt') {
    return fs.readFile(absPath, 'utf8')
  }
  if (ext === '.pdf') {
    const buf = await fs.readFile(absPath)
    return parsePdf(buf)
  }
  if (ext === '.docx') {
    const buf = await fs.readFile(absPath)
    return docxBufferToMarkdown(buf)
  }
  return ''
}

export async function* walkFiles(
  dir: string,
  base: string,
): AsyncGenerator<{ absPath: string; relPath: string }> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    // Hidden files (incl. .git, .DS_Store) and the marker JSON are not lore.
    if (entry.name.startsWith('.')) continue
    if (dir === base && entry.name === LORE_MARKER_FILENAME) continue
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* walkFiles(abs, base)
    } else if (entry.isFile()) {
      const relPath = path.relative(base, abs).split(path.sep).join('/')
      yield { absPath: abs, relPath }
    }
  }
}

export async function loadDocument(
  absPath: string,
): Promise<{ text: string; sizeBytes: number; modifiedAt: string } | null> {
  const ext = path.extname(absPath).toLowerCase()
  if (!SUPPORTED_DOC_EXTS.has(ext)) return null
  const stat = await fs.stat(absPath)
  const cached = docCache.get(absPath)
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return {
      text: cached.text,
      sizeBytes: cached.sizeBytes,
      modifiedAt: stat.mtime.toISOString(),
    }
  }
  try {
    const text = await extractText(absPath, ext)
    docCache.set(absPath, { text, mtimeMs: stat.mtimeMs, sizeBytes: stat.size })
    return { text, sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString() }
  } catch (err) {
    console.error(`[api/lore/documents] failed to parse ${absPath}:`, err)
    return null
  }
}

/** Walk the lore root, parse every supported document, return them sorted
 *  by relPath. Empty files are dropped to avoid junk entries in the KB. */
export async function listLoreDocuments(loreRoot: string): Promise<LoreDocumentRecord[]> {
  const documents: LoreDocumentRecord[] = []
  for await (const { absPath, relPath } of walkFiles(loreRoot, loreRoot)) {
    const ext = path.extname(absPath).toLowerCase()
    if (!SUPPORTED_DOC_EXTS.has(ext)) continue
    const loaded = await loadDocument(absPath)
    if (!loaded) continue
    if (!loaded.text.trim()) continue
    documents.push({
      id: relPath,
      name: path.basename(relPath),
      relPath,
      type: EXT_TO_TYPE[ext],
      text: loaded.text,
      sizeBytes: loaded.sizeBytes,
      modifiedAt: loaded.modifiedAt,
    })
  }
  documents.sort((a, b) => a.relPath.localeCompare(b.relPath))
  return documents
}

// Re-export safeResolveInside from validators so existing imports of
// `safeResolveInside` from this module keep working. Single source of
// truth lives in server/lib/validators.ts.
export { safeResolveInside } from '../lib/validators.js'
