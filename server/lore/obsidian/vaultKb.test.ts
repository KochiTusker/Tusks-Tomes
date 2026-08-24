import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveWikilinks, buildModeBHeader, buildObsidianKbConcat, listObsidianDocuments } from './vaultKb.js'

describe('resolveWikilinks', () => {
  it('renders aliased and bare wikilinks to plaintext', () => {
    expect(resolveWikilinks('met [[Pernille Corvel|Merr]] today')).toBe('met Merr today')
    expect(resolveWikilinks('the [[Dustvale Accord]] moved')).toBe('the Dustvale Accord moved')
    // path-style target keeps the leaf
    expect(resolveWikilinks('see [[04 - Locations/Caminus Primordialis]]')).toBe(
      'see Caminus Primordialis',
    )
  })
  it('strips Obsidian callout markers', () => {
    expect(resolveWikilinks('> [!incomplete] needs work')).toBe('> needs work')
  })
})

describe('buildModeBHeader', () => {
  it('summarises relationship frontmatter into one line', () => {
    const raw = `---\ntype: npc\naffiliations:\n  - "[[The Dustvale Accord]]"\n  - "[[Kerrin Voss]]"\npatron: "[[Aveline]]"\n---\nbody`
    const header = buildModeBHeader(raw, 'Lucen Draunt', 'npc')
    expect(header).toContain('Lucen Draunt (npc)')
    expect(header).toContain('affiliations: The Dustvale Accord, Kerrin Voss')
    expect(header).toContain('patron: Aveline')
  })
  it('returns empty string when no relationship fields', () => {
    expect(buildModeBHeader('---\ntype: npc\n---\nbody', 'X', 'npc')).toBe('')
  })
})

describe('KB assembly against a synthetic vault', () => {
  let vault: string
  beforeAll(async () => {
    vault = await fs.mkdtemp(path.join(os.tmpdir(), 'obs-kb-'))
    await fs.mkdir(path.join(vault, '02 - NPCs'), { recursive: true })
    await fs.mkdir(path.join(vault, 'Templates'), { recursive: true })
    await fs.writeFile(
      path.join(vault, '02 - NPCs', 'Sorrel Grast.md'),
      `---\ntype: npc\naffiliations:\n  - "[[The Cinderpall Brotherhood]]"\n---\nKnown as [[Sorrel Grast|Gravedust]], a grim figure.`,
    )
    // Excluded folder — must not appear in KB.
    await fs.writeFile(path.join(vault, 'Templates', 'NPC.md'), `---\ntype: npc\n---\n{{template}}`)
    // Excluded dev file — a non-empty CLAUDE.md at the vault root must NOT be
    // listed or concatenated (it would otherwise surface as a 'CLAUDE' doc).
    await fs.writeFile(
      path.join(vault, 'CLAUDE.md'),
      `# Vault navigation guide\n\nFolders, entity types, frontmatter conventions.`,
    )
  })
  afterAll(async () => {
    await fs.rm(vault, { recursive: true, force: true })
  })

  it('lists notes (excluding Templates/ + CLAUDE.md) with wikilinks resolved', async () => {
    const docs = await listObsidianDocuments(vault, { modeB: false })
    expect(docs.map((d) => d.name)).toEqual(['Sorrel Grast'])
    expect(docs[0].text).toContain('Known as Gravedust')
  })

  it('excludes CLAUDE.md from the KB concat', async () => {
    const { text } = await buildObsidianKbConcat(vault, { modeB: false })
    expect(text).not.toContain('Vault navigation guide')
    expect(text).not.toContain('### CLAUDE')
  })

  it('prepends the Mode-B header when enabled', async () => {
    const { text } = await buildObsidianKbConcat(vault, { modeB: true })
    expect(text).toContain('### Sorrel Grast')
    expect(text).toContain('affiliations: The Cinderpall Brotherhood')
  })
})
