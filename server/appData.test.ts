// K.3.5 — appData atomic-write tests.
//
// `writeJson` writes to a `<absPath>.<hex>.tmp` sibling and then renames
// onto the target. The contract: if rename fails (cross-device move,
// EACCES, target is a directory, etc.) the temp file must NOT be left
// on disk to accumulate as junk. A user whose disk fills up because of
// a permission glitch shouldn't see hundreds of orphaned `.tmp` files
// in `%APPDATA%\tusks-tomes\Config\` (Roaming on Windows; env-paths convention).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { readJson, writeJson } from './appData'

let WORK: string

beforeEach(async () => {
  WORK = await fs.mkdtemp(path.join(tmpdir(), 'appdata-test-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(WORK, { recursive: true, force: true })
})

async function listTmpFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir)
  return entries.filter((name) => name.endsWith('.tmp'))
}

describe('writeJson — happy path', () => {
  it('writes the value to disk atomically (no orphan .tmp left)', async () => {
    const target = path.join(WORK, 'config.json')
    await writeJson(target, { hello: 'world' })

    const written = await fs.readFile(target, 'utf8')
    expect(JSON.parse(written)).toEqual({ hello: 'world' })

    const orphans = await listTmpFiles(WORK)
    expect(orphans).toEqual([])
  })

  it('creates the parent directory if it does not exist', async () => {
    const nested = path.join(WORK, 'subdir', 'nested', 'file.json')
    await writeJson(nested, { ok: true })
    const written = await readJson<{ ok: boolean }>(nested, { ok: false })
    expect(written.ok).toBe(true)
  })

  it('overwrites an existing file atomically', async () => {
    const target = path.join(WORK, 'file.json')
    await writeJson(target, { version: 1 })
    await writeJson(target, { version: 2 })
    const final = await readJson<{ version: number }>(target, { version: 0 })
    expect(final.version).toBe(2)
    expect(await listTmpFiles(WORK)).toEqual([])
  })

  it('serializes with 2-space indentation (pretty-print contract)', async () => {
    const target = path.join(WORK, 'pretty.json')
    await writeJson(target, { a: 1, b: 2 })
    const body = await fs.readFile(target, 'utf8')
    // Verify the file isn't a single-line dump.
    expect(body).toMatch(/^\{\n  "a": 1/)
  })
})

describe('writeJson — atomic-rename mid-failure cleanup', () => {
  it('does NOT leave an orphan .tmp file when rename throws', async () => {
    const target = path.join(WORK, 'will-fail.json')

    // Spy on fs.promises.rename to make it throw the first time.
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementationOnce(async () => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    })

    await expect(writeJson(target, { payload: 'x' })).rejects.toThrow(/EACCES/)

    // The fix's contract: temp file must be unlinked after the rename
    // failure so we don't accumulate orphans across repeated failures.
    const orphans = await listTmpFiles(WORK)
    expect(orphans).toEqual([])

    // And the target file must not exist (the write didn't land).
    await expect(fs.access(target)).rejects.toThrow()

    renameSpy.mockRestore()
  })

  it('does NOT leave an orphan .tmp file when writeFile throws', async () => {
    const target = path.join(WORK, 'will-fail-2.json')

    const writeFileSpy = vi.spyOn(fs, 'writeFile').mockImplementationOnce(async () => {
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
    })

    await expect(writeJson(target, { payload: 'y' })).rejects.toThrow(/ENOSPC/)

    const orphans = await listTmpFiles(WORK)
    expect(orphans).toEqual([])

    writeFileSpy.mockRestore()
  })

  it('survives ten consecutive failed writes without accumulating .tmp orphans', async () => {
    const target = path.join(WORK, 'flaky.json')
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async () => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
    })

    for (let i = 0; i < 10; i++) {
      await expect(writeJson(target, { attempt: i })).rejects.toThrow()
    }

    const orphans = await listTmpFiles(WORK)
    expect(orphans).toEqual([])

    renameSpy.mockRestore()
  })

  it('re-throws the original error after cleanup (caller-visible failure preserved)', async () => {
    const target = path.join(WORK, 'will-fail-3.json')
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementationOnce(async () => {
      throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' })
    })

    await expect(writeJson(target, { payload: 'z' })).rejects.toThrow(/EXDEV/)
    renameSpy.mockRestore()
  })

  it('cleanup is best-effort: unlink failure does NOT mask the original error', async () => {
    const target = path.join(WORK, 'will-fail-4.json')

    const renameSpy = vi.spyOn(fs, 'rename').mockImplementationOnce(async () => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
    })
    // The cleanup unlink will itself fail (e.g., file was already gone) —
    // the contract is "swallow unlink errors; surface the rename error".
    const unlinkSpy = vi.spyOn(fs, 'unlink').mockImplementationOnce(async () => {
      throw Object.assign(new Error('ENOENT: file disappeared'), { code: 'ENOENT' })
    })

    await expect(writeJson(target, { payload: 'q' })).rejects.toThrow(/EACCES/)

    renameSpy.mockRestore()
    unlinkSpy.mockRestore()
  })
})

describe('readJson', () => {
  it('returns the parsed contents on success', async () => {
    const target = path.join(WORK, 'in.json')
    await fs.writeFile(target, JSON.stringify({ k: 'v' }))
    expect(await readJson<{ k: string }>(target, { k: 'default' })).toEqual({ k: 'v' })
  })

  it('returns the default value when the file does not exist (ENOENT)', async () => {
    const target = path.join(WORK, 'missing.json')
    const result = await readJson<{ default: boolean }>(target, { default: true })
    expect(result).toEqual({ default: true })
  })

  it('rethrows non-ENOENT errors (e.g. malformed JSON)', async () => {
    const target = path.join(WORK, 'bad.json')
    await fs.writeFile(target, '{not valid')
    await expect(readJson(target, {})).rejects.toThrow()
  })
})
