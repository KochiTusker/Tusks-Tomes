import { describe, expect, it } from 'vitest'
import {
  autoApplyFrontmatter,
  extractEntities,
  inferDocType,
  renderFrontmatter,
} from './entityExtraction.js'

describe('inferDocType', () => {
  it('matches Characters.md → characters/character', () => {
    expect(inferDocType('Characters.md')).toEqual({ docType: 'characters', entityType: 'character' })
  })
  it('matches Countries-Caelovar.md → countries/country', () => {
    expect(inferDocType('Countries-Caelovar.md')).toEqual({ docType: 'countries', entityType: 'country' })
  })
  it('falls back to other/other for unrecognised names', () => {
    expect(inferDocType('Random Notes.md')).toEqual({ docType: 'other', entityType: 'other' })
  })
})

describe('extractEntities', () => {
  it('extracts H1 entities + lifts Character Alias lines', () => {
    const md = `# Characters Overview

This is an intro.

# Durgin Ironheart

- Character Name: Durgin Ironheart
- Character Alias: Durgin Stonecrown, The Granite Vanguard
- Race: Dwarf

Background prose here.

# Fimble Bronzebolt

- Character Name: Fimble Bronzebolt
- Character Alias: The Tinkerer
- Race: Gnome
`
    const result = extractEntities(md, 'Characters.md')
    expect(result.docType).toBe('characters')
    expect(result.entities).toHaveLength(2)
    expect(result.entities[0].name).toBe('Durgin Ironheart')
    expect(result.entities[0].aliases).toEqual(['Durgin Stonecrown', 'The Granite Vanguard'])
    expect(result.entities[1].name).toBe('Fimble Bronzebolt')
    expect(result.entities[1].aliases).toEqual(['The Tinkerer'])
  })

  it('filters SESSION-marker H1s out', () => {
    const md = `# Session Logs

Intro.

# SESSION 23

Session 23 content here.

# SESSION 22

Session 22 content here.
`
    const result = extractEntities(md, 'Too Many Bruisers - Session Logs.md')
    expect(result.entities).toEqual([])
  })

  it('filters Overview / file-title H1s out', () => {
    const md = `# Pantheon Overview

Intro.

# Astriara

A goddess.

# Bhargo

Another goddess.
`
    const result = extractEntities(md, 'Deities.md')
    const names = result.entities.map((e) => e.name)
    expect(names).toEqual(['Astriara', 'Bhargo'])
  })

  it('promotes paragraph-style headings when the file has no # markers', () => {
    const md = `Caelovar Overview

Caelovar is the Western continent in the world, defined by its mountains and fractured nations after the collapse of Manus Titanum.

The Badlands

The Badlands refers to two ungoverned regions of Caelovar with long histories of conflict and a strong criminal presence.

Caelum Ardens

Caelum Ardens is a city-state that emerged out of the Hundred Years War after the collapse of the dwarven empire of Manus Titanum.
`
    const result = extractEntities(md, 'Countries-Caelovar.md')
    expect(result.promotedHeadings).toBe(true)
    const names = result.entities.map((e) => e.name)
    expect(names).toContain('The Badlands')
    expect(names).toContain('Caelum Ardens')
  })

  it('promotes when followed by Capital: structural-key line', () => {
    const md = `Sylvarum Libertas

Capital: None

Location: East of Caelovar
`
    const result = extractEntities(md, 'Countries-Virelia.md')
    expect(result.entities.some((e) => e.name === 'Sylvarum Libertas')).toBe(true)
  })

  it('parses bold-style **Alias**: format (Patrons.md style)', () => {
    const md = `# Patrons Overview

Intro.

# Esochrein

**Alias**: Scribe of the Waning Hour

**Symbol**: A quill

Mythology prose follows.
`
    const result = extractEntities(md, 'Patrons.md')
    expect(result.entities[0].name).toBe('Esochrein')
    expect(result.entities[0].aliases).toEqual(['Scribe of the Waning Hour'])
  })
})

describe('renderFrontmatter', () => {
  it('emits valid YAML frontmatter block', () => {
    const yaml = renderFrontmatter({
      docType: 'characters',
      entities: [
        {
          name: 'Durgin Ironheart',
          type: 'character',
          aliases: ['Durgin Stonecrown', 'The Granite Vanguard'],
          affiliations: [],
          section: 'Durgin Ironheart',
        },
      ],
      promotedHeadings: false,
    })
    expect(yaml).toMatch(/^---\nschema: 1\n/)
    expect(yaml).toContain('docType: characters')
    expect(yaml).toContain('  - name: Durgin Ironheart')
    expect(yaml).toContain('    type: character')
    expect(yaml).toContain('    aliases: [Durgin Stonecrown, The Granite Vanguard]')
    expect(yaml).toContain('    section: "Durgin Ironheart"')
    expect(yaml).toMatch(/---\n$/)
  })

  it('emits entities: [] for empty result', () => {
    const yaml = renderFrontmatter({
      docType: 'other',
      entities: [],
      promotedHeadings: false,
    })
    expect(yaml).toContain('entities: []')
  })
})

describe('autoApplyFrontmatter', () => {
  it('prepends YAML and returns entity count', () => {
    const md = `# Characters Overview

Intro.

# Durgin Ironheart

- Character Alias: Granite Vanguard

Prose.
`
    const out = autoApplyFrontmatter(md, 'Characters.md')
    expect(out.skipped).toBe(false)
    expect(out.result.entities).toHaveLength(1)
    expect(out.markdown.startsWith('---')).toBe(true)
    expect(out.markdown).toContain('# Durgin Ironheart')
  })

  it('is a no-op when the file already has frontmatter (idempotent)', () => {
    const md = `---
schema: 1
docType: characters
entities:
  - name: X
    type: character
    aliases: []
    affiliations: []
    section: "X"
---
# X

Prose.
`
    const out = autoApplyFrontmatter(md, 'Characters.md')
    expect(out.skipped).toBe(true)
    expect(out.markdown).toBe(md)
  })

  it('returns markdown unchanged when no entities are extracted', () => {
    const md = `Just a paragraph of prose with no clear headings.`
    const out = autoApplyFrontmatter(md, 'Notes.md')
    expect(out.skipped).toBe(false)
    expect(out.result.entities).toEqual([])
    expect(out.markdown).toBe(md)
  })
})
