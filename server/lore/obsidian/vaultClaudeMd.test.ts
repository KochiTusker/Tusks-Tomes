import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildVaultClaudeMd, readVaultClaudeMd, joinClaudeMd } from './vaultClaudeMd.js'

describe('buildVaultClaudeMd against a synthetic vault', () => {
  let vault: string
  beforeAll(async () => {
    vault = await fs.mkdtemp(path.join(os.tmpdir(), 'obs-claudemd-'))
    await fs.mkdir(path.join(vault, '02 - NPCs'), { recursive: true })
    await fs.mkdir(path.join(vault, '04 - Locations'), { recursive: true })
    await fs.mkdir(path.join(vault, 'Templates'), { recursive: true })
    await fs.writeFile(
      path.join(vault, '02 - NPCs', 'Sorrel Grast.md'),
      `---\ntype: npc\naliases: [Gravedust]\naffiliations:\n  - "[[The Accord]]"\n---\nA grim secret lurks in the body text that must not leak.`,
    )
    await fs.writeFile(
      path.join(vault, '04 - Locations', 'Caminus.md'),
      `---\ntype: location\n---\nPrivate location body text.`,
    )
    // Excluded folder + dev file — must not be counted as lore.
    await fs.writeFile(path.join(vault, 'Templates', 'NPC.md'), `---\ntype: npc\n---\n{{template}}`)
    await fs.writeFile(path.join(vault, 'README.md'), `---\ntype: npc\n---\nReadme body.`)
  })
  afterAll(async () => {
    await fs.rm(vault, { recursive: true, force: true })
  })

  it('lists the present folders with note counts, excluding meta folders/dev files', async () => {
    const md = await buildVaultClaudeMd(vault)
    expect(md).toContain('`02 - NPCs/` — 1 note')
    expect(md).toContain('`04 - Locations/` — 1 note')
    // The excluded Templates/ folder and README dev file are not COUNTED as
    // lore folders (the usage section may still name them as ignored).
    expect(md).not.toContain('`Templates/` — ')
    expect(md).not.toContain('`README')
  })

  it('reports entity-type counts and alias usage', async () => {
    const md = await buildVaultClaudeMd(vault)
    expect(md).toContain('Lore entities indexed: **2**')
    expect(md).toMatch(/- character: 1/)
    expect(md).toMatch(/- location: 1/)
    expect(md).toContain('Notes declaring `aliases:`: **1** of 2')
  })

  it('lists observed frontmatter keys but never note body content', async () => {
    const md = await buildVaultClaudeMd(vault)
    expect(md).toContain('`type`')
    expect(md).toContain('`aliases`')
    // Structural field names only — never the private body prose.
    expect(md).not.toContain('grim secret')
    expect(md).not.toContain('Private location body')
  })

  it('emits guidance for an empty vault rather than a misleading guide', async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'obs-empty-cmd-'))
    const md = await buildVaultClaudeMd(empty)
    expect(md).toContain('No notes were found')
    await fs.rm(empty, { recursive: true, force: true })
  })
})

describe('readVaultClaudeMd', () => {
  it('reports absence when no CLAUDE.md exists', async () => {
    const v = await fs.mkdtemp(path.join(os.tmpdir(), 'obs-read-cmd-'))
    expect(await readVaultClaudeMd(v)).toEqual({ present: false, summary: null, modifiedAt: null })
    await fs.rm(v, { recursive: true, force: true })
  })

  it('returns a bounded preview of an existing CLAUDE.md', async () => {
    const v = await fs.mkdtemp(path.join(os.tmpdir(), 'obs-read-cmd2-'))
    await fs.writeFile(joinClaudeMd(v), '# Existing guide\n\nLine two.\n')
    const out = await readVaultClaudeMd(v)
    expect(out.present).toBe(true)
    expect(out.summary).toContain('# Existing guide')
    expect(out.modifiedAt).toBeTruthy()
    await fs.rm(v, { recursive: true, force: true })
  })
})
