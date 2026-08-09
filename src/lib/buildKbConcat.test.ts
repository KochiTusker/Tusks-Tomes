import { describe, expect, it } from 'vitest'
import { buildKbConcat } from './pipeline'

describe('buildKbConcat — frontmatter stripping', () => {
  it('strips YAML frontmatter from each doc so the AI sees only prose', () => {
    const docs = [
      {
        name: 'Characters.md',
        text:
          '---\nschema: 1\ndocType: characters\nentities:\n  - name: Durgin Ironheart\n    type: character\n    aliases: [Granite Vanguard]\n---\n# Durgin Ironheart\n\nKnown as the Granite Vanguard.',
      } as never,
    ]
    const out = buildKbConcat(docs)
    expect(out).not.toContain('schema:')
    expect(out).not.toContain('docType:')
    expect(out).not.toContain('aliases:')
    expect(out).toContain('# Durgin Ironheart')
    expect(out).toContain('Known as the Granite Vanguard')
  })

  it('leaves docs without frontmatter untouched', () => {
    const docs = [
      { name: 'World.md', text: '# World\n\nA place of mystery.' } as never,
    ]
    const out = buildKbConcat(docs)
    expect(out).toContain('# World')
    expect(out).toContain('A place of mystery')
  })

  it('handles CRLF frontmatter fences', () => {
    const docs = [
      {
        name: 'Doc.md',
        text: '---\r\nschema: 1\r\n---\r\n# Body\r\n\r\nContent here.',
      } as never,
    ]
    const out = buildKbConcat(docs)
    expect(out).not.toContain('schema:')
    expect(out).toContain('# Body')
  })

  it('keeps the doc separator markers between docs', () => {
    const docs = [
      { name: 'A.md', text: '---\nschema: 1\n---\n# Alpha' } as never,
      { name: 'B.md', text: '---\nschema: 1\n---\n# Beta' } as never,
    ]
    const out = buildKbConcat(docs)
    expect(out).toContain('### A.md')
    expect(out).toContain('### B.md')
    expect(out).toContain('# Alpha')
    expect(out).toContain('# Beta')
    // The `---` separator between docs is still preserved (it's inserted by
    // buildKbConcat itself, not the frontmatter).
    expect(out.split('\n\n---\n\n').length).toBe(2)
  })

  it('does NOT strip mid-doc `---` (horizontal rules in prose)', () => {
    const docs = [
      {
        name: 'Doc.md',
        text: '# Title\n\nIntro.\n\n---\n\nMore prose.',
      } as never,
    ]
    const out = buildKbConcat(docs)
    // The mid-doc `---` rule is part of prose, not a frontmatter fence.
    expect(out).toContain('Intro.')
    expect(out).toContain('More prose.')
  })
})
