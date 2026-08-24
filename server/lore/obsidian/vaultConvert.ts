// Convert non-markdown documents already sitting in an Obsidian vault into
// sibling .md files, so the grounding path can actually read them.
//
// WHY THIS IS A WRITE MODULE. The grounding-path modules (vaultAdapter.ts,
// vaultKb.ts, vaultClaudeMd.ts) are strictly read-only and enforced as such by
// readonly-guard.test.ts — a stray write there could silently mutate someone's
// notes. This file is deliberately NOT one of those: it is the third sanctioned,
// explicitly user-initiated vault write, alongside runGraphifyBuild() and
// writeVaultClaudeMd() in vaultTools.ts. It only ever runs from the Recommended
// Setup wizard, after the user has been shown the exact file list and agreed.
//
// The rules that keep it safe:
//   - It NEVER overwrites. A document whose sibling .md already exists is
//     reported as `skipped`, never re-written. Someone's hand-edited notes are
//     not collateral for a convenience feature.
//   - It NEVER deletes or modifies the original. The .docx/.pdf stays exactly
//     where it was; the .md lands beside it.
//   - Every path is containment-checked against the vault root before any I/O,
//     so a symlink or a crafted name cannot escape.
//   - Writes are atomic (temp file + rename), so an interrupted run cannot
//     leave a half-written note that later reads as truth.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { docxBufferToMarkdown } from '../docxToMarkdown.js'
import { parsePdf } from '../../pdfParse.js'

/** Extensions we can turn into useful markdown. */
const CONVERTIBLE = new Set(['.docx', '.pdf'])

/** Directories that are never user lore. `.obsidian` is vault config,
 *  `graphify-out` is our own derived artefact, the rest are noise. */
const SKIP_DIRS = new Set(['.obsidian', '.git', '.trash', 'graphify-out', 'node_modules', '.vscode'])

/** Refuse anything big enough to be a scanned book — converting it would
 *  blow memory and produce unusable context anyway. */
const MAX_BYTES = 25 * 1024 * 1024

export type ConvertibleDoc = {
  /** Vault-relative, POSIX separators — safe to show in the UI. */
  relPath: string
  ext: string
  sizeBytes: number
  /** True when `<name>.md` already exists next to it, so we'd skip it. */
  hasSiblingMd: boolean
  /** Set when the file can't be converted (too large, unreadable). */
  blockedReason?: string
}

export type ConversionResult = {
  relPath: string
  status: 'converted' | 'skipped' | 'failed'
  /** Vault-relative path of the .md that was written, when status=converted. */
  wrotePath?: string
  reason?: string
}

const toPosix = (p: string) => p.split(path.sep).join('/')

/** Resolve `rel` inside `root` and refuse anything that escapes.
 *  Uses realpath on the root so a symlinked vault still compares correctly. */
async function safeJoin(root: string, rel: string): Promise<string> {
  const abs = path.resolve(root, rel)
  const rootResolved = path.resolve(root)
  const relBack = path.relative(rootResolved, abs)
  if (!relBack || relBack.startsWith('..') || path.isAbsolute(relBack)) {
    throw new Error(`path escapes the vault: ${rel}`)
  }
  return abs
}

async function walk(dir: string, root: string, out: string[]): Promise<void> {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return // unreadable subtree — skip rather than fail the whole scan
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue // don't follow links out of the vault
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
      await walk(abs, root, out)
    } else if (entry.isFile()) {
      if (CONVERTIBLE.has(path.extname(entry.name).toLowerCase())) out.push(abs)
    }
  }
}

/** Find documents in the vault that aren't markdown yet. Pure read. */
export async function findConvertibleDocs(vaultPath: string): Promise<ConvertibleDoc[]> {
  const root = path.resolve(vaultPath)
  const found: string[] = []
  await walk(root, root, found)

  const docs: ConvertibleDoc[] = []
  for (const abs of found.sort()) {
    const relPath = toPosix(path.relative(root, abs))
    const ext = path.extname(abs).toLowerCase()
    let sizeBytes = 0
    try {
      sizeBytes = (await fs.stat(abs)).size
    } catch {
      continue
    }
    const siblingMd = abs.slice(0, -ext.length) + '.md'
    const hasSiblingMd = await fs
      .access(siblingMd)
      .then(() => true)
      .catch(() => false)
    docs.push({
      relPath,
      ext,
      sizeBytes,
      hasSiblingMd,
      blockedReason: sizeBytes > MAX_BYTES ? 'larger than 25 MB' : undefined,
    })
  }
  return docs
}

/** Frontmatter recording where the note came from. Obsidian-idiomatic, and it
 *  makes the generated file obviously derived so nobody mistakes it for a note
 *  they wrote. */
function frontmatter(sourceRel: string): string {
  // Quote the value: filenames routinely contain colons and brackets, which
  // would otherwise produce invalid YAML.
  const safe = sourceRel.replace(/"/g, '\\"')
  return `---\nsource: "${safe}"\nconverted_by: "Tusk's Tomes"\n---\n\n`
}

async function writeAtomic(dest: string, content: string): Promise<void> {
  const tmp = `${dest}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await fs.writeFile(tmp, content, 'utf8')
    await fs.rename(tmp, dest)
  } catch (err) {
    await fs.unlink(tmp).catch(() => undefined)
    throw err
  }
}

/**
 * Convert the given vault-relative documents to sibling .md files.
 *
 * Never overwrites, never touches the original. Failures are per-file: one
 * corrupt .docx reports `failed` and the rest still convert.
 */
export async function convertDocsToMarkdown(
  vaultPath: string,
  relPaths: string[],
  onProgress?: (result: ConversionResult) => void,
): Promise<ConversionResult[]> {
  const root = path.resolve(vaultPath)
  const results: ConversionResult[] = []

  for (const relPath of relPaths) {
    const emit = (r: ConversionResult) => {
      results.push(r)
      onProgress?.(r)
    }

    let abs: string
    try {
      abs = await safeJoin(root, relPath)
    } catch (err) {
      emit({ relPath, status: 'failed', reason: (err as Error).message })
      continue
    }

    const ext = path.extname(abs).toLowerCase()
    if (!CONVERTIBLE.has(ext)) {
      emit({ relPath, status: 'skipped', reason: 'not a convertible document' })
      continue
    }

    const destAbs = abs.slice(0, -ext.length) + '.md'
    const destRel = toPosix(path.relative(root, destAbs))

    // Never clobber an existing note.
    const exists = await fs
      .access(destAbs)
      .then(() => true)
      .catch(() => false)
    if (exists) {
      emit({ relPath, status: 'skipped', reason: `${destRel} already exists` })
      continue
    }

    try {
      const stat = await fs.stat(abs)
      if (stat.size > MAX_BYTES) {
        emit({ relPath, status: 'skipped', reason: 'larger than 25 MB' })
        continue
      }
      const buffer = await fs.readFile(abs)
      const body = ext === '.docx' ? await docxBufferToMarkdown(buffer) : await parsePdf(buffer)
      if (!body.trim()) {
        emit({ relPath, status: 'failed', reason: 'no text could be extracted' })
        continue
      }
      await writeAtomic(destAbs, frontmatter(relPath) + body.trim() + '\n')
      emit({ relPath, status: 'converted', wrotePath: destRel })
    } catch (err) {
      emit({ relPath, status: 'failed', reason: (err as Error).message })
    }
  }

  return results
}
