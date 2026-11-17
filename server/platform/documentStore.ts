import type { Request, Response } from 'express'
import { readJson, writeJson } from './appData.js'
import { slog } from './slog.js'

/**
 * A persisted JSON document: load or seed, sanitize, save. The per-document
 * differences are options rather than branches in each router:
 *
 * - `persistSeedOnRead`: whether reading an absent file writes the seed to disk
 *   (default true). A document the user could lose to a missing file keeps the
 *   seed in memory only, so a plain GET never writes over anything.
 * - `write`: how the document is saved (default `writeJson`); a document that
 *   would hurt to lose passes the backed-up writer.
 * - `migrate`: an old on-disk shape rewritten before sanitizing. When it reports
 *   a change the document is saved once, after `onChanged` has logged it.
 */
export interface DocumentStoreOptions<T> {
  file: () => string
  seed: () => T
  sanitize: (input: unknown) => T
  persistSeedOnRead?: boolean
  write?: (file: string, doc: unknown) => Promise<void>
  migrate?: (existing: T) => { doc: T; changed: boolean; onChanged?: () => void }
}

export interface DocumentStore<T> {
  /** The document on disk, sanitized; the seed when the file is absent. */
  load(): Promise<T>
  save(doc: T): Promise<void>
}

export function createDocumentStore<T>(opts: DocumentStoreOptions<T>): DocumentStore<T> {
  const write = opts.write ?? writeJson
  const persistSeedOnRead = opts.persistSeedOnRead ?? true
  return {
    async load() {
      const file = opts.file()
      // readJson returns null ONLY when the file is absent (it rethrows on
      // parse and permission errors), so an absent file is the sole path to the seed.
      const existing = await readJson<T | null>(file, null)
      if (!existing) {
        const seed = opts.seed()
        if (persistSeedOnRead) await write(file, seed)
        return seed
      }
      if (!opts.migrate) return opts.sanitize(existing)
      const { doc, changed, onChanged } = opts.migrate(existing)
      if (changed) {
        onChanged?.()
        await write(file, doc)
      }
      return opts.sanitize(doc)
    },
    async save(doc) {
      await write(opts.file(), doc)
    },
  }
}

/**
 * Answer 400 and return true when a PUT body is not a JSON object, so the
 * caller can `return`. `slogName` is both the log channel and, capitalised, the
 * event (`glossary` logs `putGlossary_rejected`).
 */
export function rejectNonObjectBody(req: Request, res: Response, slogName: string): boolean {
  if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) return false
  slog(slogName, {
    event: `put${slogName.charAt(0).toUpperCase()}${slogName.slice(1)}_rejected`,
    field: '_root',
    received: typeof req.body,
  })
  res.status(400).json({
    error: 'Request body must be a JSON object',
    field: '_root',
    received: typeof req.body,
  })
  return true
}
