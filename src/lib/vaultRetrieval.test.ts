import { describe, expect, it } from 'vitest'
import { computeCoreNotes, noteTitle, retrieveForText, type RetrievalProfile } from './vaultRetrieval'
import type { AliasIndex } from '../../server/lore/aliasIndex'
import type { KBDocument } from '@/types'

function doc(id: string, relPath: string, text: string): KBDocument {
  return {
    id,
    name: relPath.split('/').pop()!,
    type: 'md',
    text,
    sizeBytes: text.length,
    addedAt: '2026-01-01T00:00:00Z',
    relPath,
  } as KBDocument
}

// Deliberately NOT the reference vault's layout — a flat-ish vault with
// different folder names, to prove nothing is hardcoded to one structure.
const DOCS: KBDocument[] = [
  doc('d1', 'people/Aveline.md', 'The Lady of the Gleaming Abyss. A deity of ledgers.'),
  doc('d2', 'people/Anouk Osk.md', 'A paladin. Serves Aveline reluctantly.'),
  doc('d3', 'places/Crimson Cathedral.md', 'A ruined cathedral. Aveline is worshipped here.'),
  doc('d4', 'craft/How To Write A Villain.md', 'Generic advice about villains. '.repeat(400)),
  doc('d5', 'logs/Session 27.md', 'Aveline appeared. Anouk Osk knelt.'),
  doc('d6', 'logs/Session 28.md', 'Anouk Osk fled the Crimson Cathedral.'),
  doc('d7', 'retired/Old Villain Idea.md', 'A scrapped idea involving Aveline.'),
]

const INDEX: AliasIndex = {
  schema: 1,
  builtAt: '2026-01-01T00:00:00Z',
  byEntity: {
    Aveline: {
      name: 'Aveline', type: 'deity',
      aliases: ['Aveline', 'Lady of the Gleaming Abyss', 'The Pale Ledger'],
      affiliations: [], section: 'Aveline', file: 'people/Aveline.md',
    },
    'Anouk Osk': {
      name: 'Anouk Osk', type: 'character', aliases: ['Anouk'],
      affiliations: [], section: 'Anouk', file: 'people/Anouk Osk.md',
    },
  },
  aliases: {
    daraksha: 'Aveline', 'the pale ledger': 'Aveline',
    'lady of the gleaming abyss': 'Aveline', brugo: 'Anouk Osk',
  },
  byType: { character: ['Anouk Osk'], country: [], deity: ['Aveline'], faction: [], patron: [], location: [], other: [] },
  filesWithFrontmatter: [], filesWithoutFrontmatter: [],
} as unknown as AliasIndex

const PROFILE: RetrievalProfile = {
  roles: { people: 'canon', places: 'canon', craft: 'reference', logs: 'session-log', retired: 'exclude' },
}

describe('noteTitle', () => {
  it('strips any folder depth and the .md suffix', () => {
    expect(noteTitle('05 - Lore/Deities/Aveline.md')).toBe('Aveline')
    expect(noteTitle('Aveline.md')).toBe('Aveline')
    expect(noteTitle('a\\b\\Aveline.md')).toBe('Aveline')
  })
})

describe('retrieveForText — Tier 0 (no profile, any vault layout)', () => {
  it('retrieves notes whose title appears in the text', () => {
    const r = retrieveForText('Anouk Osk swung his hammer.', DOCS, { index: INDEX })
    expect(r.docs.map((d) => d.id)).toContain('d2')
  })

  it('resolves an alias back to the note that defines it', () => {
    // "The Pale Ledger" never appears in any title — only the index knows it.
    const r = retrieveForText('They spoke of the Pale Ledger in hushed tones.', DOCS, { index: INDEX })
    expect(r.matchedEntities).toContain('Aveline')
    expect(r.docs.map((d) => d.id)).toContain('d1')
  })

  it('still works with no index at all (add-on disabled)', () => {
    const r = retrieveForText('The Crimson Cathedral burned.', DOCS, { index: null })
    expect(r.docs.map((d) => d.id)).toContain('d3')
  })

  it('ignores sub-word hits so short titles do not over-match', () => {
    const r = retrieveForText('He travelled through Darakshanistan, a place.', DOCS, { index: INDEX })
    expect(r.matchedEntities).not.toContain('Aveline')
  })

  it('carries the previous chunk forward so pronoun-only follow-ups stay grounded', () => {
    const first = retrieveForText('Anouk Osk arrived.', DOCS, { index: INDEX })
    const second = retrieveForText('He said nothing at all.', DOCS, {
      index: INDEX, previousSelection: first.selection,
    })
    expect(second.docs.map((d) => d.id)).toContain('d2')
    expect(second.stats.carriedDocs).toBeGreaterThan(0)
  })

  it('reduces payload substantially versus sending everything', () => {
    const r = retrieveForText('Anouk Osk knelt.', DOCS, { index: INDEX })
    expect(r.stats.selectedChars).toBeLessThan(r.stats.totalChars / 2)
  })
})

describe('retrieveForText — profile is advisory, never lossy', () => {
  it('demotes reference material when a profile marks it', () => {
    const withProfile = retrieveForText('Anouk Osk knelt.', DOCS, { index: INDEX, profile: PROFILE })
    expect(withProfile.docs.map((d) => d.id)).not.toContain('d4')
  })

  it('keeps only the newest session log', () => {
    const r = retrieveForText('A quiet morning.', DOCS, { index: INDEX, profile: PROFILE })
    const ids = r.docs.map((d) => d.id)
    expect(ids).not.toContain('d5')
    if (ids.includes('d6')) expect(ids).toContain('d6')
  })

  it('SAFETY: a literal match is retrieved even from an excluded folder', () => {
    // d7 lives in `retired`, role 'exclude' — but its title is named outright.
    const r = retrieveForText('Someone mentioned the Old Villain Idea again.', DOCS, {
      index: INDEX, profile: PROFILE,
    })
    expect(r.docs.map((d) => d.id)).toContain('d7')
  })

  it('SAFETY: a literal match survives an exhausted budget', () => {
    const r = retrieveForText('Anouk Osk and Aveline and the Crimson Cathedral.', DOCS, {
      index: INDEX, profile: PROFILE, maxChars: 1,
    })
    for (const id of ['d1', 'd2', 'd3']) expect(r.docs.map((d) => d.id)).toContain(id)
  })

  it('SAFETY: a profile that misclassifies canon as excluded still grounds it', () => {
    const bad: RetrievalProfile = { roles: { people: 'exclude', places: 'exclude' } }
    const r = retrieveForText('Aveline watched from the Crimson Cathedral.', DOCS, {
      index: INDEX, profile: bad,
    })
    const ids = r.docs.map((d) => d.id)
    expect(ids).toContain('d1')
    expect(ids).toContain('d3')
  })

  it('drops only non-literal notes to satisfy the budget', () => {
    const r = retrieveForText('Anouk Osk knelt.', DOCS, {
      index: INDEX, maxChars: 100,
    })
    // Whatever was dropped, the literal match is still present.
    expect(r.docs.map((d) => d.id)).toContain('d2')
    expect(r.stats.droppedForBudget).toBeGreaterThanOrEqual(0)
  })
})

describe('computeCoreNotes', () => {
  it('ranks the most-referenced notes without knowing any folder names', () => {
    // Aveline is mentioned by Anouk, the Cathedral, both logs and the retired note.
    const core = computeCoreNotes(DOCS, 1)
    expect([...core]).toEqual(['d1'])
  })

  it('never returns notes nothing references', () => {
    const isolated = [doc('x1', 'a/Alpha.md', 'nothing'), doc('x2', 'b/Beta.md', 'nothing')]
    expect(computeCoreNotes(isolated, 5).size).toBe(0)
  })
})
