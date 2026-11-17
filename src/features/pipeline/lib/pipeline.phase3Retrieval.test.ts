/** @vitest-environment jsdom */
//
// Phase 3 hands the Knowledge Base to the model in its cacheable prefix, once
// per chunk of transcript. On a large vault that is not merely expensive: the
// lore alone can exceed the model's context window, and the run fails with
// nothing to show for it. `retrieveVaultKb` is what narrows it.
//
// The invariants worth holding, in order of how much they cost when broken:
//
//   1. With retrieval on, the prompt carries a fraction of the vault.
//   2. With retrieval on, the prefix is still IDENTICAL across chunks —
//      retrieval runs once against the whole transcript, not per chunk.
//      Retrieving per chunk would fix the window and break prefix caching,
//      trading one bill for another.
//   3. With retrieval off, behaviour is byte-for-byte what it was.
//   4. A note the session actually names is never dropped.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlossaryDocument } from '../../corrections/lib/glossary'
import type { KBDocument } from '@/features/pipeline/lib/types'

const mockProviderRef: { current: import('../../providers/lib/providers/mockProvider').MockProvider | null } = {
  current: null,
}
const glossaryDoc: GlossaryDocument = {
  version: 1,
  safeReplacements: [],
  contextualHints: [],
}

vi.mock('../../providers/lib/providers', async () => {
  const actual = await vi.importActual<typeof import('../../providers/lib/providers')>('../../providers/lib/providers')
  return {
    ...actual,
    ensureProvidersInitialized: vi.fn(async () => undefined),
    getActiveProvider: vi.fn(() => {
      if (!mockProviderRef.current) throw new Error('mockProviderRef not set in test')
      return mockProviderRef.current
    }),
    getCloudProvider: vi.fn(() => {
      if (!mockProviderRef.current) throw new Error('mockProviderRef not set in test')
      return mockProviderRef.current
    }),
  }
})

vi.mock('../../providers/lib/providers/settings', async () => {
  const actual = await vi.importActual<typeof import('../../providers/lib/providers/settings')>('../../providers/lib/providers/settings')
  return {
    ...actual,
    isLocalProvider: vi.fn(() => false),
    getProviderSettings: vi.fn(() => ({
      providerId: 'gemini' as const,
      proModel: 'gemini-2.5-pro',
      flashModel: 'gemini-2.5-flash',
    })),
  }
})

vi.mock('../../corrections/lib/glossary', () => ({
  getGlossary: vi.fn(async () => glossaryDoc),
  subscribeGlossary: vi.fn(() => () => {}),
  putGlossary: vi.fn(),
}))

vi.mock('../../lore/lib/aliasIndexClient', () => ({
  getAliasIndex: vi.fn(async () => null),
}))

// The model catalogue the context window is read from. Empty by default, so
// every test that does not set it sees an unknown window, as before.
const catalogueRef: { models: Array<{ id: string; contextLength: number }> } = { models: [] }
vi.mock('../../providers/lib/openrouterModelsClient', async () => {
  const actual = await vi.importActual<typeof import('../../providers/lib/openrouterModelsClient')>('../../providers/lib/openrouterModelsClient')
  return {
    ...actual,
    getOpenRouterCatalogue: vi.fn(async () => ({
      fetchedAt: null,
      models: catalogueRef.models,
      providerPolicies: [],
    })),
  }
})

import { runPhase3 } from './pipeline'
import { MockProvider, mockResponse } from '../../providers/lib/providers/mockProvider'

// ─────────────────────────── Fixture vault ───────────────────────────
//
// One note the transcript names and many it does not, each padded so the
// difference between "all of it" and "the referenced slice" is measurable
// rather than incidental.

const PADDING = 'Lore text that exists only to give this note weight. '.repeat(120)

function note(name: string): KBDocument {
  return {
    id: `id-${name}`,
    name: `${name}.md`,
    relPath: `Notes/${name}.md`,
    type: 'md',
    text: `# ${name}\n\n${PADDING}`,
    sizeBytes: PADDING.length,
    addedAt: '2026-01-01T00:00:00.000Z',
  } as KBDocument
}

const REFERENCED = 'Ashenvale'
const VAULT: KBDocument[] = [
  note(REFERENCED),
  ...Array.from({ length: 40 }, (_, i) => note(`Unrelated${i}`)),
]

/** Long enough to chunk more than once, and it names exactly one note. */
const TRANSCRIPT =
  `[Kaziel (Name)] We ride for ${REFERENCED} at first light, and we do not stop. `.repeat(900)

function prefixesFrom(provider: MockProvider): string[] {
  return provider.calls.map((c) => c.req.cacheablePrefix ?? '')
}

describe('Phase 3 knowledge-base retrieval', () => {
  beforeEach(() => {
    const provider = new MockProvider({ name: 'gemini', nextDelayMs: 0 })
    provider.setHandler(() =>
      mockResponse(
        'The company rode out under a grey sky, and the road behind them emptied of everything ' +
          'but dust. Nobody spoke for the first mile.',
      ),
    )
    mockProviderRef.current = provider
    catalogueRef.models = []
  })

  it('sends only the referenced slice of the vault when retrieval is on', async () => {
    const provider = mockProviderRef.current!

    await runPhase3({
      groundedTranscript: TRANSCRIPT,
      dmQuestions: [],
      dmAnswers: {},
      kb: VAULT,
      callbacks: { onEvent: () => {} },
      cloudProvider: 'gemini',
      geminiTier: 'paid',
      retrieveVaultKb: true,
    })

    const prefix = prefixesFrom(provider)[0]
    const fullVaultChars = VAULT.reduce((n, d) => n + d.text.length, 0)

    // The note the transcript names survives — retrieval must not lose lore.
    expect(prefix).toContain(REFERENCED)
    // And the bulk of the vault does not ride along.
    expect(prefix.length).toBeLessThan(fullVaultChars / 2)
  })

  it('keeps the cacheable prefix identical across chunks', async () => {
    const provider = mockProviderRef.current!

    await runPhase3({
      groundedTranscript: TRANSCRIPT,
      dmQuestions: [],
      dmAnswers: {},
      kb: VAULT,
      callbacks: { onEvent: () => {} },
      cloudProvider: 'gemini',
      geminiTier: 'paid',
      retrieveVaultKb: true,
    })

    const prefixes = prefixesFrom(provider)
    expect(prefixes.length).toBeGreaterThan(1)
    // Retrieval is decided once, against the whole transcript. If it ever runs
    // per chunk, these diverge and provider-side prefix caching stops paying.
    expect(new Set(prefixes).size).toBe(1)
  })

  it('sends the whole vault when retrieval is off', async () => {
    const provider = mockProviderRef.current!

    await runPhase3({
      groundedTranscript: TRANSCRIPT,
      dmQuestions: [],
      dmAnswers: {},
      kb: VAULT,
      callbacks: { onEvent: () => {} },
      cloudProvider: 'gemini',
      geminiTier: 'paid',
      retrieveVaultKb: false,
    })

    const prefix = prefixesFrom(provider)[0]
    // Every note, referenced or not — the pre-existing behaviour, unchanged
    // for anyone who has not asked for the trade.
    expect(prefix).toContain(REFERENCED)
    expect(prefix).toContain('Unrelated39')
  })

  it('defaults to the whole vault when the caller says nothing', async () => {
    const provider = mockProviderRef.current!

    await runPhase3({
      groundedTranscript: TRANSCRIPT,
      dmQuestions: [],
      dmAnswers: {},
      kb: VAULT,
      callbacks: { onEvent: () => {} },
      cloudProvider: 'gemini',
      geminiTier: 'paid',
    })

    expect(prefixesFrom(provider)[0]).toContain('Unrelated39')
  })

  // The window comes from the catalogue when the caller does not pass one, so
  // a vault larger than the Chronicle model's window is narrowed rather than
  // sent whole, without any entry point having to know the figure.
  it('narrows the lore by itself when the catalogue shows it cannot fit', async () => {
    const provider = mockProviderRef.current!
    // The fixture vault is ~66k tokens; this window cannot take it.
    catalogueRef.models = [{ id: 'google/gemini-2.5-pro', contextLength: 32_000 }]

    await runPhase3({
      groundedTranscript: TRANSCRIPT,
      dmQuestions: [],
      dmAnswers: {},
      kb: VAULT,
      callbacks: { onEvent: () => {} },
      cloudProvider: 'gemini',
      geminiTier: 'paid',
      model: 'gemini-2.5-pro',
      retrieveVaultKb: false,
    })

    const prefix = prefixesFrom(provider)[0]
    expect(prefix).toContain(REFERENCED)
    expect(prefix).not.toContain('Unrelated39')
  })

  it('keeps the whole vault when the catalogue shows it fits', async () => {
    const provider = mockProviderRef.current!
    catalogueRef.models = [{ id: 'google/gemini-2.5-pro', contextLength: 1_048_576 }]

    await runPhase3({
      groundedTranscript: TRANSCRIPT,
      dmQuestions: [],
      dmAnswers: {},
      kb: VAULT,
      callbacks: { onEvent: () => {} },
      cloudProvider: 'gemini',
      geminiTier: 'paid',
      model: 'gemini-2.5-pro',
      retrieveVaultKb: false,
    })

    expect(prefixesFrom(provider)[0]).toContain('Unrelated39')
  })

  it('treats an explicit null window as unknown, whatever the catalogue says', async () => {
    const provider = mockProviderRef.current!
    catalogueRef.models = [{ id: 'google/gemini-2.5-pro', contextLength: 32_000 }]

    await runPhase3({
      groundedTranscript: TRANSCRIPT,
      dmQuestions: [],
      dmAnswers: {},
      kb: VAULT,
      callbacks: { onEvent: () => {} },
      cloudProvider: 'gemini',
      geminiTier: 'paid',
      model: 'gemini-2.5-pro',
      retrieveVaultKb: false,
      modelContextTokens: null,
    })

    expect(prefixesFrom(provider)[0]).toContain('Unrelated39')
  })
})
