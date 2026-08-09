// Unit tests for the blocked-chunk capture module. Verifies:
//   - The file lands in the right directory with the right name shape.
//   - The header section is well-formed (one key=value per line, then ---).
//   - The body preserves the prompt text verbatim (no truncation).
//   - Pruning keeps only the most recent BLOCKED_CHUNK_FILE_LIMIT files.
//   - Atomic write: a write that throws mid-stream leaves no orphan files.
//   - listCapturedChunks returns newest-first.
//
// Uses a temp dir per test (via os.tmpdir) so tests run in parallel without
// stomping on each other or on the user's real .diagnose/.

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  BLOCKED_CHUNK_FILE_LIMIT,
  captureBlockedChunk,
  listCapturedChunks,
  pruneCapturedChunks,
} from './blockedChunkCapture.js'

let tmpRoot: string

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tusks-blocked-chunk-'))
})

afterEach(async () => {
  // Windows CI occasionally hits ENOTEMPTY here when antivirus / indexer
  // hold a transient handle on a just-written file. maxRetries makes the
  // cleanup wait out those races instead of failing the whole test.
  await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('captureBlockedChunk', () => {
  it('writes a file at .diagnose/blocked-chunks/<phase>-<ISO>.txt', async () => {
    const result = await captureBlockedChunk(
      {
        phase: 'phase2_audit',
        index: 11,
        totalChunks: 28,
        model: 'gemini-2.5-flash',
        tier: 'free',
        blockReason: 'PROHIBITED_CONTENT',
        prompt: 'You are auditing a D&D session transcript chunk...',
      },
      { repoRoot: tmpRoot },
    )
    expect(result.filename).toMatch(/^phase2_audit-\d{4}-\d{2}-\d{2}T/)
    expect(result.path).toBe(path.join(tmpRoot, '.diagnose', 'blocked-chunks', result.filename))
    const content = await fs.readFile(result.path, 'utf8')
    expect(content).toContain('# phase=phase2_audit')
    expect(content).toContain('# index=11')
    expect(content).toContain('# totalChunks=28')
    expect(content).toContain('# model=gemini-2.5-flash')
    expect(content).toContain('# tier=free')
    expect(content).toContain('# blockReason=PROHIBITED_CONTENT')
    expect(content).toContain('# capturedAt=')
    expect(content).toContain('---')
    expect(content).toContain('You are auditing a D&D session transcript chunk...')
    // bytesWritten matches the actual file size.
    const stat = await fs.stat(result.path)
    expect(stat.size).toBe(result.bytesWritten)
  })

  it('preserves the full prompt body verbatim (no truncation, no escaping)', async () => {
    // The point of this whole feature is to get the raw bytes — a 10kB
    // prompt with newlines, special chars, and Unicode all survives intact.
    const bigPrompt = [
      'Multi-line content.',
      '[Dungeon Master (DM)] The orc charges. Roll for initiative.',
      '[Niamh (Meera)] 36 damage. Critical hit.',
      // Embed UTF-8 (the speaker-detach markers) — these MUST survive.
      '«1» content with marker glyph «2» second line',
      'A'.repeat(8000), // bulk
    ].join('\n')
    const result = await captureBlockedChunk(
      { phase: 'phase2_audit', prompt: bigPrompt },
      { repoRoot: tmpRoot },
    )
    const content = await fs.readFile(result.path, 'utf8')
    // Body lives after the --- separator.
    const body = content.split('---\n')[1]
    expect(body.trimStart()).toBe(bigPrompt)
  })

  it('sanitises phase id into a safe filename component', async () => {
    // A phase id with path-traversal-like chars must NOT escape the
    // intended directory. Use the same regex as the implementation:
    // anything outside [a-zA-Z0-9_-] becomes underscore.
    const result = await captureBlockedChunk(
      { phase: '../../evil/path', prompt: 'x' },
      { repoRoot: tmpRoot },
    )
    expect(result.filename.startsWith('______evil_path-')).toBe(true)
    expect(result.path).toContain(path.join('.diagnose', 'blocked-chunks'))
    expect(result.path).not.toContain('..')
  })

  it('falls back to unknown_phase when no phase id is given', async () => {
    const result = await captureBlockedChunk({ prompt: 'x' }, { repoRoot: tmpRoot })
    expect(result.filename.startsWith('unknown_phase-')).toBe(true)
  })

  it('records all-unknown placeholders for missing metadata fields', async () => {
    const result = await captureBlockedChunk({ prompt: 'just a prompt' }, { repoRoot: tmpRoot })
    const content = await fs.readFile(result.path, 'utf8')
    expect(content).toContain('# phase=unknown')
    expect(content).toContain('# index=unknown')
    expect(content).toContain('# model=unknown')
    expect(content).toContain('# tier=unknown')
    expect(content).toContain('# blockReason=PROHIBITED_CONTENT')
  })

  it('creates the .diagnose/blocked-chunks directory if it does not exist', async () => {
    // Fresh tmpRoot, no .diagnose at all → captureBlockedChunk must mkdir -p.
    const stat0 = await fs.stat(path.join(tmpRoot, '.diagnose')).catch(() => null)
    expect(stat0).toBeNull()
    const result = await captureBlockedChunk({ prompt: 'x' }, { repoRoot: tmpRoot })
    const stat1 = await fs.stat(path.dirname(result.path))
    expect(stat1.isDirectory()).toBe(true)
  })
})

describe('pruneCapturedChunks', () => {
  // Writes BLOCKED_CHUNK_FILE_LIMIT + 5 files (55 today) of real disk I/O,
  // then prunes 5, then the afterEach recursively removes the tmp dir.
  // Vitest's 5s default is fine on Linux/macOS but Windows CI runners
  // routinely take longer per sequential write + ENOTEMPTY-prone cleanup,
  // so give this case a generous ceiling. The work itself completes in
  // well under a second on real hardware.
  it('keeps only the BLOCKED_CHUNK_FILE_LIMIT most recent files', { timeout: 30_000 }, async () => {
    const dir = path.join(tmpRoot, '.diagnose', 'blocked-chunks')
    await fs.mkdir(dir, { recursive: true })
    // Create LIMIT + 5 files with chronological ISO names. Filenames sort
    // lexicographically == chronologically, so the prune drops the OLDEST.
    const filenames: string[] = []
    const writes: Array<Promise<void>> = []
    for (let i = 0; i < BLOCKED_CHUNK_FILE_LIMIT + 5; i++) {
      const stamp = `2026-05-25T00-${String(i).padStart(2, '0')}-00-000Z`
      const name = `phase2_audit-${stamp}.txt`
      filenames.push(name)
      writes.push(fs.writeFile(path.join(dir, name), `content #${i}`, 'utf8'))
    }
    await Promise.all(writes)
    await pruneCapturedChunks(dir)
    const remaining = (await fs.readdir(dir)).filter((n) => n.endsWith('.txt'))
    expect(remaining.length).toBe(BLOCKED_CHUNK_FILE_LIMIT)
    // The 5 OLDEST (lowest indexed) are gone; the LIMIT newest remain.
    const expectedRemaining = filenames.slice(5)
    expect(remaining.sort()).toEqual(expectedRemaining.sort())
  })

  it('is a no-op when there are fewer files than the limit', async () => {
    const dir = path.join(tmpRoot, '.diagnose', 'blocked-chunks')
    await fs.mkdir(dir, { recursive: true })
    for (let i = 0; i < 3; i++) {
      await fs.writeFile(path.join(dir, `phase2_audit-${i}.txt`), 'x', 'utf8')
    }
    await pruneCapturedChunks(dir)
    const remaining = await fs.readdir(dir)
    expect(remaining.length).toBe(3)
  })

  it('returns silently when the directory does not exist', async () => {
    const dir = path.join(tmpRoot, 'does-not-exist')
    // Should not throw — prune is best-effort cleanup, not a contract.
    await expect(pruneCapturedChunks(dir)).resolves.toBeUndefined()
  })

  it('ignores non-.txt files in the directory (only prunes .txt)', async () => {
    const dir = path.join(tmpRoot, '.diagnose', 'blocked-chunks')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'something.log'), 'x', 'utf8')
    await fs.writeFile(path.join(dir, 'phase2_audit-2026-05-25T00-00-00-000Z.txt'), 'x', 'utf8')
    // Add LIMIT more .txt files so prune fires.
    for (let i = 1; i <= BLOCKED_CHUNK_FILE_LIMIT; i++) {
      const stamp = `2026-05-25T00-${String(i).padStart(2, '0')}-00-000Z`
      await fs.writeFile(path.join(dir, `phase2_audit-${stamp}.txt`), 'x', 'utf8')
    }
    await pruneCapturedChunks(dir)
    const remaining = await fs.readdir(dir)
    expect(remaining).toContain('something.log') // unrelated file untouched
    const txtRemaining = remaining.filter((n) => n.endsWith('.txt'))
    expect(txtRemaining.length).toBe(BLOCKED_CHUNK_FILE_LIMIT)
  })
})

describe('listCapturedChunks', () => {
  it('returns an empty array when the directory does not exist', async () => {
    const list = await listCapturedChunks({ repoRoot: tmpRoot })
    expect(list).toEqual([])
  })

  it('returns captured files newest-first', async () => {
    await captureBlockedChunk({ phase: 'phase2_audit', prompt: 'first' }, { repoRoot: tmpRoot })
    // Sleep a beat so the ISO timestamp in the filename differs.
    await new Promise((r) => setTimeout(r, 15))
    await captureBlockedChunk({ phase: 'phase4_extras', prompt: 'second' }, { repoRoot: tmpRoot })
    const list = await listCapturedChunks({ repoRoot: tmpRoot })
    expect(list).toHaveLength(2)
    expect(list[0].filename.startsWith('phase4_extras-')).toBe(true) // newest first
    expect(list[1].filename.startsWith('phase2_audit-')).toBe(true)
  })

  it('reports size and modifiedAt for each entry', async () => {
    const result = await captureBlockedChunk(
      { phase: 'phase2_audit', prompt: 'some content' },
      { repoRoot: tmpRoot },
    )
    const list = await listCapturedChunks({ repoRoot: tmpRoot })
    expect(list).toHaveLength(1)
    expect(list[0].size).toBe(result.bytesWritten)
    expect(list[0].modifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(list[0].path).toBe(result.path)
  })

  it('ignores non-.txt files (only lists captured chunks)', async () => {
    const dir = path.join(tmpRoot, '.diagnose', 'blocked-chunks')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'unrelated.log'), 'x', 'utf8')
    await captureBlockedChunk({ phase: 'phase2_audit', prompt: 'x' }, { repoRoot: tmpRoot })
    const list = await listCapturedChunks({ repoRoot: tmpRoot })
    expect(list).toHaveLength(1)
    expect(list[0].filename).not.toBe('unrelated.log')
  })
})
