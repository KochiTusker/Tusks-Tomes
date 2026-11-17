import { describe, it, expect, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { anyFileExists, createStatusCache, ensureSandboxDir, stripEnvKeys } from './cliSubscription.js'

describe('stripEnvKeys', () => {
  it('removes the named variables whatever their case and keeps the rest', () => {
    const out = stripEnvKeys({ openai_api_key: 'a', OPENAI_BASE_URL: 'b', PATH: 'p', Keep: 'k' }, ['OPENAI_API_KEY', 'OPENAI_BASE_URL'])
    expect(out).toEqual({ PATH: 'p', Keep: 'k' })
  })
})

describe('createStatusCache', () => {
  it('serves a cached value until it expires or is forced', async () => {
    vi.useFakeTimers()
    try {
      const cached = createStatusCache<number>(5000)
      let n = 0
      const compute = async () => ++n
      expect(await cached(false, compute)).toBe(1)
      expect(await cached(false, compute)).toBe(1)
      expect(await cached(true, compute)).toBe(2)
      vi.advanceTimersByTime(5001)
      expect(await cached(false, compute)).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('anyFileExists and ensureSandboxDir', () => {
  it('finds an existing file among missing ones, and creates the sandbox', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-'))
    const file = path.join(root, 'creds.json')
    await fs.writeFile(file, '{}')
    expect(await anyFileExists([path.join(root, 'none'), file])).toBe(true)
    expect(await anyFileExists([path.join(root, 'none')])).toBe(false)
    const dir = path.join(root, 'box')
    expect(await ensureSandboxDir(dir)).toBe(dir)
    expect(await ensureSandboxDir(file)).toBeUndefined()
    await fs.rm(root, { recursive: true, force: true })
  })
})
