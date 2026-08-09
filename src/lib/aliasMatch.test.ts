import { describe, expect, it } from 'vitest'
import { annotateChunk, aliasIndexToSafeReplacements } from './aliasMatch'
import type { AliasIndex } from './aliasIndexClient'

function makeIndex(entities: Array<{ name: string; aliases?: string[] }>): AliasIndex {
  const byEntity: Record<string, any> = {}
  const aliases: Record<string, string> = {}
  for (const e of entities) {
    byEntity[e.name] = {
      name: e.name,
      type: 'character',
      aliases: e.aliases ?? [],
      affiliations: [],
      section: e.name,
      file: 'test.md',
    }
    aliases[e.name.toLowerCase()] = e.name
    for (const a of e.aliases ?? []) aliases[a.toLowerCase()] = e.name
  }
  return {
    schema: 1,
    builtAt: new Date().toISOString(),
    byEntity,
    aliases,
    byType: { character: entities.map((e) => e.name) } as any,
    filesWithFrontmatter: ['test.md'],
    filesWithoutFrontmatter: [],
  }
}

describe('annotateChunk — phonetic alias matching', () => {
  it('catches "more than vain" → Morvan Vayne (the user-flagged regression)', () => {
    const idx = makeIndex([{ name: 'Morvan Vayne' }])
    const result = annotateChunk('The temple records called him more than vain.', idx)
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0].canonical).toBe('Morvan Vayne')
    expect(result.candidates[0].text).toBe('more than vain')
    expect(result.annotated).toContain('[≈Morvan Vayne?')
  })

  it('does NOT match unrelated words ("meant to" should NOT match "Meredith")', () => {
    const idx = makeIndex([{ name: 'Meredith' }])
    const result = annotateChunk('I meant to ask about something.', idx)
    expect(result.candidates).toHaveLength(0)
  })

  it('does NOT match short common words to short names ("even" should NOT match "Vayun")', () => {
    const idx = makeIndex([{ name: 'Vayun' }])
    const result = annotateChunk('How are we even meant to find them?', idx)
    expect(result.candidates).toHaveLength(0)
  })

  it('does NOT match different-first-sound names ("Solveig" should NOT match "Bhargo")', () => {
    // Both M-codes start with B+R = PR in metaphone. The first-sound
    // discipline only rules out when the FIRST sound differs; Solveig/Bhargo
    // both start with B-R which IS the same first sound. So this case
    // tests that the ratio threshold catches it: PRT vs PRK = distance 1
    // on 3-char codes = 0.33 > 0.20 ratio.
    const idx = makeIndex([{ name: 'Bhargo' }])
    const result = annotateChunk('[Solveig] hit the goblin.', idx)
    expect(result.candidates).toHaveLength(0)
  })

  it('skips exact matches (preGround handles those)', () => {
    const idx = makeIndex([{ name: 'Morvan Vayne' }])
    const result = annotateChunk('They tracked Morvan Vayne to the pass.', idx)
    expect(result.candidates).toHaveLength(0)
  })

  it('caps annotations to maxAnnotations', () => {
    const idx = makeIndex([
      { name: 'Morvan Vayne' },
      { name: 'Durgin Ironheart' },
      { name: 'Kerrin Voss' },
    ])
    const chunk = 'morlan vain durgan irinhart karen voss'.repeat(5)
    const result = annotateChunk(chunk, idx, { maxAnnotations: 2 })
    expect(result.candidates.length).toBeLessThanOrEqual(2)
  })

  it('returns chunk unchanged when index is null', () => {
    const result = annotateChunk('some text', null)
    expect(result.annotated).toBe('some text')
    expect(result.candidates).toHaveLength(0)
  })

  it('returns chunk unchanged when no candidates accepted', () => {
    const idx = makeIndex([{ name: 'Xerthax' }])
    const result = annotateChunk('Nothing here matches.', idx)
    expect(result.annotated).toBe('Nothing here matches.')
    expect(result.candidates).toHaveLength(0)
  })
})

describe('aliasIndexToSafeReplacements — deterministic substitution layer', () => {
  it('returns one rule per alias (alias → canonical)', () => {
    const idx = makeIndex([
      { name: 'Durgin Ironheart', aliases: ['Durgin Stonecrown', 'The Granite Vanguard'] },
      { name: 'Morvan Vayne', aliases: [] },
    ])
    const rules = aliasIndexToSafeReplacements(idx)
    expect(rules).toHaveLength(2) // 2 aliases for Durgin, 0 for Morlan
    expect(rules).toContainEqual({ from: 'Durgin Stonecrown', to: 'Durgin Ironheart' })
    expect(rules).toContainEqual({ from: 'The Granite Vanguard', to: 'Durgin Ironheart' })
  })

  it('skips aliases that match the canonical name case-insensitively', () => {
    const idx = makeIndex([{ name: 'Foo', aliases: ['foo', 'Foo'] }])
    const rules = aliasIndexToSafeReplacements(idx)
    expect(rules).toHaveLength(0)
  })

  it('returns empty array when index is null', () => {
    expect(aliasIndexToSafeReplacements(null)).toHaveLength(0)
  })
})
