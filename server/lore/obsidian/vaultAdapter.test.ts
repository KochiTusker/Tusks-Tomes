import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  mapObsidianType,
  parseObsidianNote,
  readEntityIndex,
  buildObsidianAliasIndex,
} from './vaultAdapter.js'

describe('mapObsidianType', () => {
  it('coerces Obsidian types into the closed EntityType union', () => {
    expect(mapObsidianType('npc')).toBe('character')
    expect(mapObsidianType('pc')).toBe('character')
    expect(mapObsidianType('creature')).toBe('character')
    expect(mapObsidianType('location')).toBe('location')
    expect(mapObsidianType('era')).toBe('location')
    expect(mapObsidianType('faction')).toBe('faction')
    expect(mapObsidianType('deity')).toBe('deity')
    expect(mapObsidianType('patron')).toBe('patron')
    // Unknown / meta types fall into 'other'.
    expect(mapObsidianType('mystery')).toBe('other')
    expect(mapObsidianType('plot-thread')).toBe('other')
    expect(mapObsidianType(undefined)).toBe('other')
  })
})

describe('parseObsidianNote', () => {
  it('reads top-level type + inline aliases, names from the stem', () => {
    const raw = `---\ntype: npc\naliases: [Merr, Pernille]\nstatus: alive\n---\n\n# Body`
    const r = parseObsidianNote(raw, 'Pernille Corvel')
    expect(r).toEqual({ name: 'Pernille Corvel', type: 'character', aliases: ['Merr', 'Pernille'] })
  })

  it('reads block-list aliases', () => {
    const raw = `---\ntype: faction\naliases:\n  - The Accord\n  - Dustvale\n---\nbody`
    const r = parseObsidianNote(raw, 'The Dustvale Accord')
    expect(r?.aliases).toEqual(['The Accord', 'Dustvale'])
    expect(r?.type).toBe('faction')
  })

  it('returns null when there is no frontmatter fence', () => {
    expect(parseObsidianNote('# Just a note', 'X')).toBeNull()
  })
})

describe('vault adapter against a synthetic fixture vault', () => {
  let vault: string
  beforeAll(async () => {
    vault = await fs.mkdtemp(path.join(os.tmpdir(), 'obs-vault-'))
    await fs.mkdir(path.join(vault, '_system'), { recursive: true })
    await fs.mkdir(path.join(vault, '02 - NPCs'), { recursive: true })
    await fs.writeFile(
      path.join(vault, '_system', 'entity-index.json'),
      JSON.stringify({
        entities: [
          { name: 'Pernille Corvel', aliases: ['Merr', 'Pernille'], type: 'pc', path: 'PCs/Pernille Corvel.md' },
          { name: 'Morvan Vayne', aliases: ['Gravedust'], type: 'npc', path: '02 - NPCs/Morvan Vayne.md' },
          { name: 'Dirge Chain', aliases: [], type: 'concept', path: '05 - Lore/Dirge Chain.md' },
        ],
      }),
    )
  })
  afterAll(async () => {
    await fs.rm(vault, { recursive: true, force: true })
  })

  it('builds an AliasIndex from entity-index.json (primary path)', async () => {
    const { index, source } = await buildObsidianAliasIndex(vault)
    expect(source).toBe('entity-index')
    expect(Object.keys(index.byEntity)).toHaveLength(3)
    // canonical + aliases all map to canonical, lowercased.
    expect(index.aliases['pernille']).toBe('Pernille Corvel')
    expect(index.aliases['gravedust']).toBe('Morvan Vayne')
    expect(index.aliases['pernille corvel']).toBe('Pernille Corvel')
    // type coercion
    expect(index.byEntity['Pernille Corvel'].type).toBe('character')
    expect(index.byEntity['Dirge Chain'].type).toBe('other')
    // file carried through from the entity-index path
    expect(index.byEntity['Morvan Vayne'].file).toBe('02 - NPCs/Morvan Vayne.md')
  })

  it('readEntityIndex returns null when absent', async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'obs-empty-'))
    expect(await readEntityIndex(empty)).toBeNull()
    await fs.rm(empty, { recursive: true, force: true })
  })

  it('falls back to walking note frontmatter when no entity-index.json', async () => {
    const v2 = await fs.mkdtemp(path.join(os.tmpdir(), 'obs-walk-'))
    await fs.mkdir(path.join(v2, '02 - NPCs'), { recursive: true })
    await fs.writeFile(
      path.join(v2, '02 - NPCs', 'Morvan Vayne.md'),
      `---\ntype: npc\naliases: [Gravedust]\n---\nbody`,
    )
    const { index, source } = await buildObsidianAliasIndex(v2)
    expect(source).toBe('note-walk')
    expect(index.byEntity['Morvan Vayne']?.aliases).toEqual(['Gravedust'])
    expect(index.aliases['gravedust']).toBe('Morvan Vayne')
    await fs.rm(v2, { recursive: true, force: true })
  })

  it('excludes dev/non-lore root files (CLAUDE.md, README, dotfiles) from the note walk', async () => {
    const v3 = await fs.mkdtemp(path.join(os.tmpdir(), 'obs-excl-'))
    await fs.mkdir(path.join(v3, '02 - NPCs'), { recursive: true })
    // A real lore note that SHOULD index.
    await fs.writeFile(
      path.join(v3, '02 - NPCs', 'Morvan Vayne.md'),
      `---\ntype: npc\naliases: [Gravedust]\n---\nbody`,
    )
    // Dev / scaffolding files that LOOK like frontmatter-bearing notes but
    // must never be indexed as entities (would otherwise appear as 'CLAUDE',
    // 'README', '.hidden').
    await fs.writeFile(path.join(v3, 'CLAUDE.md'), `---\ntype: npc\n---\nVault navigation guide.`)
    await fs.writeFile(path.join(v3, 'README.md'), `---\ntype: location\n---\nReadme body.`)
    await fs.writeFile(path.join(v3, '.hidden.md'), `---\ntype: faction\n---\nHidden body.`)
    const { index, source } = await buildObsidianAliasIndex(v3)
    expect(source).toBe('note-walk')
    expect(Object.keys(index.byEntity)).toEqual(['Morvan Vayne'])
    expect(index.byEntity['CLAUDE']).toBeUndefined()
    expect(index.byEntity['README']).toBeUndefined()
    await fs.rm(v3, { recursive: true, force: true })
  })
})
