import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readVaultReadiness, RECOMMENDED_PLUGINS } from './vaultTools.js'

describe('readVaultReadiness', () => {
  let vault: string
  beforeAll(async () => {
    vault = await fs.mkdtemp(path.join(os.tmpdir(), 'obs-ready-'))
    await fs.mkdir(path.join(vault, '.obsidian'), { recursive: true })
    await fs.mkdir(path.join(vault, '_system'), { recursive: true })
    // Enabled community plugins: two of the recommended ones present.
    await fs.writeFile(
      path.join(vault, '.obsidian', 'community-plugins.json'),
      JSON.stringify(['dataview', 'obsidian-linter', 'tag-wrangler']),
    )
    await fs.writeFile(path.join(vault, '_system', 'entity-index.json'), '{"entities":[]}')
  })
  afterAll(async () => {
    await fs.rm(vault, { recursive: true, force: true })
  })

  it('detects entity-index and recommended-plugin presence from the vault', async () => {
    const r = await readVaultReadiness(vault)
    expect(r.hasEntityIndex).toBe(true)
    expect(r.graphifyOutPresent).toBe(false)
    const present = new Map(r.plugins.map((p) => [p.id, p.present]))
    expect(present.get('dataview')).toBe(true)
    expect(present.get('obsidian-linter')).toBe(true)
    expect(present.get('templater-obsidian')).toBe(false)
    // Every recommended plugin is reported (present or not).
    expect(r.plugins).toHaveLength(RECOMMENDED_PLUGINS.length)
  })

  it('degrades gracefully when there is no .obsidian config', async () => {
    const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'obs-bare-'))
    const r = await readVaultReadiness(bare)
    expect(r.hasEntityIndex).toBe(false)
    expect(r.plugins.every((p) => !p.present)).toBe(true)
    await fs.rm(bare, { recursive: true, force: true })
  })
})
