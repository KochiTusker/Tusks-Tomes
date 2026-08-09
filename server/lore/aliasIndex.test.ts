import { describe, expect, it } from 'vitest'
import {
  buildAliasIndex,
  parseFrontmatter,
  parseInlineList,
} from './aliasIndex.js'

describe('parseInlineList', () => {
  it('returns [] for empty / non-bracketed input', () => {
    expect(parseInlineList('')).toEqual([])
    expect(parseInlineList('  ')).toEqual([])
    expect(parseInlineList('Solveig')).toEqual([])
  })

  it('parses bare bracketed list', () => {
    expect(parseInlineList('[Solveig, Chidi, Wiktoria]')).toEqual([
      'Solveig',
      'Chidi',
      'Wiktoria',
    ])
  })

  it('strips double quotes from quoted items', () => {
    expect(parseInlineList('["Granite Vanguard", Solveig]')).toEqual([
      'Granite Vanguard',
      'Solveig',
    ])
  })

  it('respects commas inside quoted items', () => {
    expect(parseInlineList('["hello, world", goodbye]')).toEqual([
      'hello, world',
      'goodbye',
    ])
  })

  it('handles single-item lists', () => {
    expect(parseInlineList('[only]')).toEqual(['only'])
  })
})

describe('parseFrontmatter', () => {
  it('returns null when the file has no fence', () => {
    expect(parseFrontmatter('# Just a heading\n\nNo frontmatter here.')).toBeNull()
  })

  it('returns empty entities when fence is present but block is empty', () => {
    const fm = parseFrontmatter('---\nschema: 1\n---\n# Body\n')
    expect(fm).not.toBeNull()
    expect(fm?.entities).toEqual([])
    expect(fm?.schema).toBe(1)
  })

  it('parses the canonical Characters.md shape with two entities', () => {
    const raw = `---
schema: 1
docType: characters
entities:
  - name: Durgin Ironheart
    type: character
    aliases: [Durgin Stonecrown, The Granite Vanguard]
    affiliations: [Manus Titanum, Ferrum Regnum, Stonecrown]
    section: "Durgin Ironheart"
  - name: Fimble Bronzebolt
    type: character
    aliases: [The Tinkerer]
    affiliations: [Ordo Sapientium, Porta Fortuna, The Balanced Gear]
    section: "Fimble Bronzebolt"
---
# Durgin Ironheart

Basic Information:
`
    const fm = parseFrontmatter(raw)
    expect(fm).not.toBeNull()
    expect(fm?.docType).toBe('characters')
    expect(fm?.entities).toHaveLength(2)
    expect(fm?.entities[0]).toEqual({
      name: 'Durgin Ironheart',
      type: 'character',
      aliases: ['Durgin Stonecrown', 'The Granite Vanguard'],
      affiliations: ['Manus Titanum', 'Ferrum Regnum', 'Stonecrown'],
      section: 'Durgin Ironheart',
    })
    expect(fm?.entities[1].name).toBe('Fimble Bronzebolt')
    expect(fm?.entities[1].aliases).toEqual(['The Tinkerer'])
  })

  it('tolerates carriage returns (CRLF line endings)', () => {
    const raw =
      '---\r\nschema: 1\r\ndocType: factions\r\nentities:\r\n  - name: Ash & Ledger\r\n    type: faction\r\n    aliases: []\r\n---\r\n# body'
    const fm = parseFrontmatter(raw)
    expect(fm?.entities).toHaveLength(1)
    expect(fm?.entities[0].name).toBe('Ash & Ledger')
  })

  it('ignores unknown top-level keys (forward compat)', () => {
    const raw = `---
schema: 1
mysteryKey: foo
docType: characters
entities:
  - name: X
    type: character
---
`
    const fm = parseFrontmatter(raw)
    expect(fm?.docType).toBe('characters')
    expect(fm?.entities).toHaveLength(1)
  })
})

describe('buildAliasIndex', () => {
  it('returns empty buckets when nothing has frontmatter', () => {
    const idx = buildAliasIndex([{ relPath: 'plain.md', content: '# plain' }])
    expect(idx.filesWithoutFrontmatter).toEqual(['plain.md'])
    expect(idx.filesWithFrontmatter).toEqual([])
    expect(Object.keys(idx.byEntity)).toHaveLength(0)
  })

  it('builds alias map (lowercased key → canonical name)', () => {
    const raw = `---
schema: 1
docType: characters
entities:
  - name: Durgin Ironheart
    type: character
    aliases: [Durgin Stonecrown, The Granite Vanguard]
---
# body`
    const idx = buildAliasIndex([{ relPath: 'Characters.md', content: raw }])
    expect(idx.aliases['durgin ironheart']).toBe('Durgin Ironheart')
    expect(idx.aliases['durgin stonecrown']).toBe('Durgin Ironheart')
    expect(idx.aliases['the granite vanguard']).toBe('Durgin Ironheart')
    expect(idx.byType.character).toEqual(['Durgin Ironheart'])
    expect(idx.byEntity['Durgin Ironheart'].file).toBe('Characters.md')
  })

  it('coerces unknown entity types to "other" without throwing', () => {
    const raw = `---
schema: 1
docType: misc
entities:
  - name: The Whatever
    type: weirdtype
---
# body`
    const idx = buildAliasIndex([{ relPath: 'Misc.md', content: raw }])
    expect(idx.byType.other).toEqual(['The Whatever'])
    expect(idx.byEntity['The Whatever'].type).toBe('other')
  })

  it('separates "with-frontmatter" vs "without-frontmatter" file lists', () => {
    const withFm = `---
schema: 1
docType: characters
entities:
  - name: X
    type: character
---
# body`
    const idx = buildAliasIndex([
      { relPath: 'a.md', content: withFm },
      { relPath: 'b.md', content: '# Just a heading\n\nPlain body.' },
    ])
    expect(idx.filesWithFrontmatter).toEqual(['a.md'])
    expect(idx.filesWithoutFrontmatter).toEqual(['b.md'])
  })

  it('schemaVersion + builtAt are populated', () => {
    const idx = buildAliasIndex([])
    expect(idx.schema).toBe(1)
    expect(typeof idx.builtAt).toBe('string')
    expect(new Date(idx.builtAt).toString()).not.toBe('Invalid Date')
  })
})
