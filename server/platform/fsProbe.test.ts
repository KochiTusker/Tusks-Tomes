import { describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureWritable } from './fsProbe.js'

describe('ensureWritable', () => {
  it('creates a missing directory, reports true and leaves no probe file', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'probe-'))
    const dir = path.join(root, 'a', 'b')
    expect(await ensureWritable(dir)).toBe(true)
    expect(await fs.readdir(dir)).toEqual([])
    await fs.rm(root, { recursive: true, force: true })
  })

  it('reports false when the path is a file', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'probe-'))
    const file = path.join(root, 'f')
    await fs.writeFile(file, 'x')
    expect(await ensureWritable(file)).toBe(false)
    await fs.rm(root, { recursive: true, force: true })
  })
})
