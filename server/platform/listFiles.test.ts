import { describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { listFilesNewestFirst } from './listFiles.js'

describe('listFilesNewestFirst', () => {
  it('filters by name, sorts newest first and reports size and path', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'list-'))
    await fs.writeFile(path.join(dir, 'old.txt'), 'a')
    await fs.writeFile(path.join(dir, 'new.txt'), 'bb')
    await fs.writeFile(path.join(dir, 'skip.md'), 'c')
    await fs.utimes(path.join(dir, 'old.txt'), new Date(2020, 0, 1), new Date(2020, 0, 1))
    await fs.utimes(path.join(dir, 'new.txt'), new Date(2024, 0, 1), new Date(2024, 0, 1))
    const out = await listFilesNewestFirst(dir, (n) => n.endsWith('.txt'))
    expect(out.map((e) => e.filename)).toEqual(['new.txt', 'old.txt'])
    expect(out[0]).toMatchObject({ size: 2, path: path.join(dir, 'new.txt') })
    expect(out[0].modifiedAt).toBe(new Date(2024, 0, 1).toISOString())
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('returns an empty list for a missing directory', async () => {
    expect(await listFilesNewestFirst(path.join(os.tmpdir(), 'no-such-dir-xyz'), () => true)).toEqual([])
  })
})
