import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { repoRoot } from './repoRoot'

describe('repoRoot', () => {
  it('finds the real repository root', () => {
    const root = repoRoot()
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
    expect(pkg.name).toBe('tusks-tomes')
    expect(fs.existsSync(path.join(root, 'server', 'index.ts'))).toBe(true)
  })

  it('caches the result', () => {
    expect(repoRoot()).toBe(repoRoot())
  })
})
