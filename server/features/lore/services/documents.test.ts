import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import {
  clearDocCache,
  invalidateDocCache,
  listLoreDocuments,
  loadDocument,
  normalizeMigrationName,
  safeResolveInside,
} from './documents'
import { LORE_MARKER_FILENAME, LORE_MARKER_VERSION } from './detection'

// All filesystem-touching tests build a fresh temp lore root with a
// valid marker, then call listLoreDocuments / loadDocument against it.
// docCache is cleared in beforeEach so a stale entry from a prior test
// can't satisfy a request that should re-parse from disk.

describe('normalizeMigrationName', () => {
  // ───── Prove-It regression guard for commit 3b45cf8 ─────
  //
  // Before the fix, the POST /api/lore/documents JSON branch kept the
  // original extension on a doc named "Campaign Structure.docx", then
  // wrote UTF-8 plain text into that filename. Every subsequent
  // GET /documents tried to unzip the result via mammoth and threw
  // "Can't find end of central directory" for every migrated doc,
  // leaving the KB tab empty after refresh.
  //
  // This case is the ONE that has to stay green for that bug to stay
  // dead — if a future refactor lets it fall back to keeping `.docx`,
  // mammoth will start choking again exactly the same way.
  it('rewrites .docx → .txt (regression: commit 3b45cf8)', () => {
    expect(normalizeMigrationName('Campaign Structure.docx')).toBe('Campaign Structure.txt')
  })

  it('rewrites .pdf → .txt', () => {
    expect(normalizeMigrationName('Lore Compendium.pdf')).toBe('Lore Compendium.txt')
  })

  it('rewrites .md → .txt (lossy on purpose — body is plain text)', () => {
    expect(normalizeMigrationName('Players.md')).toBe('Players.txt')
  })

  it('keeps a .txt input untouched', () => {
    expect(normalizeMigrationName('Notes.txt')).toBe('Notes.txt')
  })

  it('appends .txt when there is no extension', () => {
    expect(normalizeMigrationName('Worldbuilding')).toBe('Worldbuilding.txt')
  })

  it('only strips the final extension when the name has multiple dots', () => {
    expect(normalizeMigrationName('Session-01-Cutscenes.docx')).toBe('Session-01-Cutscenes.txt')
  })

  it('handles uppercase extensions case-insensitively in the right way (replaces them)', () => {
    expect(normalizeMigrationName('Lore.DOCX')).toBe('Lore.txt')
  })
})

describe('safeResolveInside', () => {
  // The DELETE endpoint feeds user-supplied relPaths into this guard
  // before unlinking. Any future regression that lets a `../escape`
  // through would let an attacker delete arbitrary files relative to
  // the lore root.
  const root = path.join(tmpdir(), 'lore-root-test')

  it('resolves a plain filename inside the root', () => {
    expect(safeResolveInside(root, 'Characters.txt')).toBe(
      path.resolve(root, 'Characters.txt'),
    )
  })

  it('blocks single ../ traversal', () => {
    expect(safeResolveInside(root, '../escape.txt')).toBeNull()
  })

  it('blocks chained ../../ traversal hidden inside a subpath', () => {
    expect(safeResolveInside(root, 'sub/../../escape.txt')).toBeNull()
  })

  it('strips leading slashes (treats absolute-looking input as relative)', () => {
    expect(safeResolveInside(root, '/Characters.txt')).toBe(
      path.resolve(root, 'Characters.txt'),
    )
  })

  it('blocks an absolute Windows path injection', () => {
    expect(
      safeResolveInside(root, 'C:\\Windows\\System32\\drivers\\etc\\hosts'),
    ).toBeNull()
  })

  it('normalises backslashes to forward slashes before resolution', () => {
    expect(safeResolveInside(root, 'Sessions\\recap.md')).toBe(
      path.resolve(root, 'Sessions', 'recap.md'),
    )
  })
})

describe('loadDocument + listLoreDocuments', () => {
  let ROOT: string

  beforeEach(async () => {
    ROOT = await fs.mkdtemp(path.join(tmpdir(), 'lore-docs-'))
    await fs.writeFile(
      path.join(ROOT, LORE_MARKER_FILENAME),
      JSON.stringify({
        version: LORE_MARKER_VERSION,
        createdAt: new Date().toISOString(),
      }),
    )
    clearDocCache()
    // Silence the deliberate parse-failure log line in the bad-docx case.
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(async () => {
    clearDocCache()
    vi.restoreAllMocks()
    await fs.rm(ROOT, { recursive: true, force: true })
  })

  it('lists .md and .txt files with their parsed text', async () => {
    await fs.writeFile(path.join(ROOT, 'Characters.txt'), 'PC roster\n')
    await fs.writeFile(path.join(ROOT, 'Lore.md'), '# Lore\nstuff')

    const docs = await listLoreDocuments(ROOT)
    expect(docs).toHaveLength(2)
    expect(docs.find((d) => d.relPath === 'Characters.txt')?.text).toBe('PC roster\n')
    expect(docs.find((d) => d.relPath === 'Lore.md')?.type).toBe('md')
  })

  it('skips the tusks-lore.json marker so it never appears as a KB doc', async () => {
    await fs.writeFile(path.join(ROOT, 'Doc.txt'), 'body')
    const docs = await listLoreDocuments(ROOT)
    expect(docs.map((d) => d.relPath)).toEqual(['Doc.txt'])
  })

  it('skips hidden files (.git, .DS_Store, .hidden.txt)', async () => {
    await fs.writeFile(path.join(ROOT, '.hidden.txt'), 'shh')
    await fs.writeFile(path.join(ROOT, '.DS_Store'), 'meta')
    await fs.writeFile(path.join(ROOT, 'visible.txt'), 'hi')
    const docs = await listLoreDocuments(ROOT)
    expect(docs.map((d) => d.relPath)).toEqual(['visible.txt'])
  })

  it('skips unsupported extensions (.png, .json beyond marker)', async () => {
    await fs.writeFile(path.join(ROOT, 'image.png'), 'PNG bytes')
    await fs.writeFile(path.join(ROOT, 'config.json'), '{}')
    await fs.writeFile(path.join(ROOT, 'doc.txt'), 'real doc')
    const docs = await listLoreDocuments(ROOT)
    expect(docs.map((d) => d.relPath)).toEqual(['doc.txt'])
  })

  it('walks subdirectories recursively and joins paths with /', async () => {
    await fs.mkdir(path.join(ROOT, 'Sessions', 'Krome'), { recursive: true })
    await fs.writeFile(path.join(ROOT, 'Sessions', 'Krome', 'recap.md'), '# Recap')
    const docs = await listLoreDocuments(ROOT)
    expect(docs).toHaveLength(1)
    expect(docs[0].relPath).toBe('Sessions/Krome/recap.md')
  })

  it('drops empty files (whitespace-only text)', async () => {
    await fs.writeFile(path.join(ROOT, 'empty.txt'), '   \n')
    await fs.writeFile(path.join(ROOT, 'real.txt'), 'content')
    const docs = await listLoreDocuments(ROOT)
    expect(docs.map((d) => d.relPath)).toEqual(['real.txt'])
  })

  it('sorts results by relPath for deterministic UI ordering', async () => {
    await fs.writeFile(path.join(ROOT, 'zebra.txt'), 'z')
    await fs.writeFile(path.join(ROOT, 'apple.txt'), 'a')
    await fs.writeFile(path.join(ROOT, 'mango.txt'), 'm')
    const docs = await listLoreDocuments(ROOT)
    expect(docs.map((d) => d.relPath)).toEqual(['apple.txt', 'mango.txt', 'zebra.txt'])
  })

  it('returns null when a .docx file is not a valid ZIP (the user-facing bug from commit 3b45cf8)', async () => {
    // This is exactly the on-disk state the buggy migration left behind:
    // a file with .docx extension whose contents are UTF-8 plain text.
    // The listing endpoint must skip it gracefully (not crash the route).
    await fs.writeFile(path.join(ROOT, 'fake.docx'), 'this is not a real zip\n')
    await fs.writeFile(path.join(ROOT, 'real.txt'), 'good doc')

    const docs = await listLoreDocuments(ROOT)
    expect(docs.map((d) => d.relPath)).toEqual(['real.txt'])
  })

  it('mtime-caches parse results — new mtime → re-parse', async () => {
    const file = path.join(ROOT, 'mtime.txt')
    await fs.writeFile(file, 'v1')
    const first = await loadDocument(file)
    expect(first?.text).toBe('v1')

    // Wait a tick to guarantee a different mtime on Windows (which has
    // 16 ms FAT resolution but >100 ms NTFS in practice), then rewrite.
    await new Promise((r) => setTimeout(r, 50))
    await fs.writeFile(file, 'v2')

    const second = await loadDocument(file)
    expect(second?.text).toBe('v2')
  })

  it('invalidateDocCache forces a re-parse on the next read', async () => {
    const file = path.join(ROOT, 'invalidated.txt')
    await fs.writeFile(file, 'a')
    expect((await loadDocument(file))?.text).toBe('a')

    const stat = await fs.stat(file)
    await fs.writeFile(file, 'b')
    await fs.utimes(file, stat.atime, stat.mtime)
    // Without invalidation, this would still return 'a' (mtime cache hit).
    invalidateDocCache(file)
    expect((await loadDocument(file))?.text).toBe('b')
  })

  it('returns null for an unsupported extension', async () => {
    const file = path.join(ROOT, 'binary.bin')
    await fs.writeFile(file, 'unsupported')
    expect(await loadDocument(file)).toBeNull()
  })
})
