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
import { readJson, writeJson, writeJsonBackedUp } from './appData'

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

    // Spy on fs.promises.rename to make it throw every time (Windows retries
    // EACCES, so a single failure would let the write land).
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async () => {
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

    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async () => {
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

// Two saves of the same document at the same instant can make Windows refuse
// the rename for a moment (EPERM / EBUSY / EACCES). writeJson retries those on
// Windows only. `process.platform` is stubbed so these run the same everywhere.
describe('writeJson — retrying a briefly blocked rename on Windows', () => {
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

  function setPlatform(value: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { ...realPlatform, value })
  }

  afterEach(() => {
    Object.defineProperty(process, 'platform', realPlatform)
  })

  const renameError = (code: string) =>
    Object.assign(new Error(`${code}: rename failed`), { code })

  it('lands the write when the rename succeeds after a few blocked attempts', async () => {
    setPlatform('win32')
    const target = path.join(WORK, 'retried.json')
    await fs.writeFile(target, JSON.stringify({ version: 1 }))

    // Three blocked attempts, then the spy falls through to the real rename.
    // That real rename can only succeed if the temp file was kept between tries.
    const renameSpy = vi
      .spyOn(fs, 'rename')
      .mockImplementationOnce(async () => {
        throw renameError('EPERM')
      })
      .mockImplementationOnce(async () => {
        throw renameError('EBUSY')
      })
      .mockImplementationOnce(async () => {
        throw renameError('EACCES')
      })

    await writeJson(target, { version: 2 })

    expect(renameSpy).toHaveBeenCalledTimes(4)
    expect(await readJson(target, { version: 0 })).toEqual({ version: 2 })
    expect(await listTmpFiles(WORK)).toEqual([])
  })

  it('gives up after five attempts, then removes the temp file and rethrows', async () => {
    setPlatform('win32')
    const target = path.join(WORK, 'stays-blocked.json')
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async () => {
      throw renameError('EPERM')
    })
    const unlinkSpy = vi.spyOn(fs, 'unlink')

    await expect(writeJson(target, { payload: 'x' })).rejects.toMatchObject({ code: 'EPERM' })

    expect(renameSpy).toHaveBeenCalledTimes(5)
    // The temp file is cleaned up once, and only after the last attempt.
    expect(unlinkSpy).toHaveBeenCalledTimes(1)
    expect(unlinkSpy.mock.invocationCallOrder[0]).toBeGreaterThan(
      Math.max(...renameSpy.mock.invocationCallOrder),
    )
    expect(await listTmpFiles(WORK)).toEqual([])
    await expect(fs.access(target)).rejects.toThrow()
  })

  it.each(['EXDEV', 'ENOENT', 'EISDIR'])('does not retry %s', async (code) => {
    setPlatform('win32')
    const target = path.join(WORK, `no-retry-${code}.json`)
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async () => {
      throw renameError(code)
    })

    await expect(writeJson(target, { payload: 'y' })).rejects.toMatchObject({ code })

    expect(renameSpy).toHaveBeenCalledTimes(1)
    expect(await listTmpFiles(WORK)).toEqual([])
  })

  it('does not retry on other platforms, where these codes mean a real permission problem', async () => {
    setPlatform('linux')
    const target = path.join(WORK, 'posix.json')
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async () => {
      throw renameError('EPERM')
    })

    await expect(writeJson(target, { payload: 'z' })).rejects.toMatchObject({ code: 'EPERM' })

    expect(renameSpy).toHaveBeenCalledTimes(1)
    expect(await listTmpFiles(WORK)).toEqual([])
  })

  it('writeJsonBackedUp keeps a backup and lands the write through the retry', async () => {
    setPlatform('win32')
    const target = path.join(WORK, 'backed-up.json')
    await fs.writeFile(target, JSON.stringify({ version: 1 }))
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementationOnce(async () => {
      throw renameError('EPERM')
    })

    await writeJsonBackedUp(target, { version: 2 })

    expect(renameSpy).toHaveBeenCalledTimes(2)
    expect(await readJson(target, { version: 0 })).toEqual({ version: 2 })
    const backups = await fs.readdir(path.join(WORK, '.backups'))
    expect(backups).toHaveLength(1)
    const backup = await fs.readFile(path.join(WORK, '.backups', backups[0]), 'utf8')
    expect(JSON.parse(backup)).toEqual({ version: 1 })
    expect(await listTmpFiles(WORK)).toEqual([])
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
