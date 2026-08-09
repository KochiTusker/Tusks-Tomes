/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest'
import { computeRunFingerprint } from './runFingerprint'
import type { GlossaryDocument } from './glossary'
import type { AliasIndex } from './aliasIndexClient'

const EMPTY_GLOSSARY: GlossaryDocument = {
  version: 1,
  safeReplacements: [],
  contextualHints: [],
}

const SIMPLE_GLOSSARY: GlossaryDocument = {
  version: 1,
  safeReplacements: [{ from: 'broady', to: 'Yannick' }],
  contextualHints: [],
}

const RICHER_GLOSSARY: GlossaryDocument = {
  version: 1,
  safeReplacements: [
    { from: 'broady', to: 'Yannick' },
    { from: 'kazle', to: 'Anwen' },
  ],
  contextualHints: [
    { canonical: 'Yannick', commonMishears: ['Broady'], notes: 'Halfling rogue.' },
  ],
}

describe('computeRunFingerprint', () => {
  it('returns a 16-hex-char string for valid inputs', async () => {
    const fp = await computeRunFingerprint({
      rawTranscript: 'hello',
      glossary: EMPTY_GLOSSARY,
      aliasIndex: null,
      phase1AliasHints: false,
    })
    expect(fp).toMatch(/^[0-9a-f]{16}$/)
  })

  it('is deterministic for identical inputs', async () => {
    const inputs = {
      rawTranscript: 'transcript body',
      glossary: SIMPLE_GLOSSARY,
      aliasIndex: null,
      phase1AliasHints: false,
    }
    const a = await computeRunFingerprint(inputs)
    const b = await computeRunFingerprint(inputs)
    expect(a).toBe(b)
  })

  it('changes when rawTranscript changes', async () => {
    const base = {
      glossary: EMPTY_GLOSSARY,
      aliasIndex: null as AliasIndex | null,
      phase1AliasHints: false,
    }
    const a = await computeRunFingerprint({ ...base, rawTranscript: 'one' })
    const b = await computeRunFingerprint({ ...base, rawTranscript: 'two' })
    expect(a).not.toBe(b)
  })

  it('changes when glossary safeReplacements change', async () => {
    const base = {
      rawTranscript: 'body',
      aliasIndex: null as AliasIndex | null,
      phase1AliasHints: false,
    }
    const a = await computeRunFingerprint({ ...base, glossary: EMPTY_GLOSSARY })
    const b = await computeRunFingerprint({ ...base, glossary: SIMPLE_GLOSSARY })
    expect(a).not.toBe(b)
  })

  it('changes when glossary contextualHints change', async () => {
    const base = {
      rawTranscript: 'body',
      aliasIndex: null as AliasIndex | null,
      phase1AliasHints: false,
    }
    const a = await computeRunFingerprint({ ...base, glossary: SIMPLE_GLOSSARY })
    const b = await computeRunFingerprint({ ...base, glossary: RICHER_GLOSSARY })
    expect(a).not.toBe(b)
  })

  it('changes when phase1AliasHints toggle flips', async () => {
    const base = {
      rawTranscript: 'body',
      glossary: EMPTY_GLOSSARY,
      aliasIndex: null as AliasIndex | null,
    }
    const a = await computeRunFingerprint({ ...base, phase1AliasHints: false })
    const b = await computeRunFingerprint({ ...base, phase1AliasHints: true })
    expect(a).not.toBe(b)
  })

  it('changes when aliasIndex content changes', async () => {
    const base = {
      rawTranscript: 'body',
      glossary: EMPTY_GLOSSARY,
      phase1AliasHints: true,
    }
    const indexA: AliasIndex = {
      schema: 1,
      builtAt: '2026-05-01T00:00:00Z',
      byEntity: {
        Yannick: { name: 'Yannick', type: 'character', aliases: ['broady'], affiliations: [], section: 'Yannick', file: 'Characters.md' },
      },
      aliases: { brody: 'Yannick', broady: 'Yannick' },
      byType: { character: ['Yannick'], country: [], deity: [], faction: [], patron: [], location: [], other: [] },
      filesWithFrontmatter: ['Characters.md'],
      filesWithoutFrontmatter: [],
    }
    const indexB: AliasIndex = {
      ...indexA,
      byEntity: {
        ...indexA.byEntity,
        Anwen: { name: 'Anwen', type: 'character', aliases: ['kazle'], affiliations: [], section: 'Anwen', file: 'Characters.md' },
      },
      aliases: { ...indexA.aliases, kaziel: 'Anwen', kazle: 'Anwen' },
      byType: { ...indexA.byType, character: ['Yannick', 'Anwen'] },
    }
    const a = await computeRunFingerprint({ ...base, aliasIndex: indexA })
    const b = await computeRunFingerprint({ ...base, aliasIndex: indexB })
    expect(a).not.toBe(b)
  })

  it('ignores aliasIndex.builtAt (rebuild timestamp must not invalidate snapshot)', async () => {
    const base = {
      rawTranscript: 'body',
      glossary: EMPTY_GLOSSARY,
      phase1AliasHints: true,
    }
    const sharedEntities = {
      Yannick: { name: 'Yannick', type: 'character' as const, aliases: ['broady'], affiliations: [], section: 'Yannick', file: 'Characters.md' },
    }
    const sharedAliases = { brody: 'Yannick', broady: 'Yannick' }
    const sharedByType = {
      character: ['Yannick'], country: [], deity: [], faction: [], patron: [], location: [], other: [],
    }
    const indexA: AliasIndex = {
      schema: 1,
      builtAt: '2026-05-01T00:00:00Z',
      byEntity: sharedEntities,
      aliases: sharedAliases,
      byType: sharedByType,
      filesWithFrontmatter: ['Characters.md'],
      filesWithoutFrontmatter: [],
    }
    const indexB: AliasIndex = { ...indexA, builtAt: '2026-06-01T00:00:00Z' }
    const a = await computeRunFingerprint({ ...base, aliasIndex: indexA })
    const b = await computeRunFingerprint({ ...base, aliasIndex: indexB })
    expect(a).toBe(b)
  })

  it('returns null when Web Crypto is unavailable (degrades gracefully)', async () => {
    const original = globalThis.crypto
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true })
    try {
      const fp = await computeRunFingerprint({
        rawTranscript: 'body',
        glossary: EMPTY_GLOSSARY,
        aliasIndex: null,
        phase1AliasHints: false,
      })
      expect(fp).toBeNull()
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: original, configurable: true })
    }
  })
})
