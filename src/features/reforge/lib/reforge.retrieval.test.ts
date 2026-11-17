/** @vitest-environment jsdom */
//
// Reforge re-runs the same phase functions the Chronicle tool does, so it
// inherits the same failure mode: Phases 3 and 6 are handed the entire lore
// vault, and on a large one the lore alone exceeds the model's context window.
// It also inherited the fix separately from the Chronicle tool, which is the
// part worth a test — a setting honoured by one entry point and not the other
// is a setting whose behaviour depends on which button you pressed.
//
// Unlike src/features/reforge/lib/reforge.test.ts, which stubs the phase runners to test
// orchestration, this drives the REAL pipeline behind a MockProvider so the
// assertions are about what the model actually receives.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlossaryDocument } from '../../corrections/lib/glossary'
import type { KBDocument } from '@/features/pipeline'

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

import { runReforge, type ReforgeConfig, type ReforgeInput } from './reforge'
import { MockProvider, mockResponse } from '../../providers/lib/providers/mockProvider'

// ─────────────────────────── Fixture vault ───────────────────────────

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
const VAULT_CHARS = VAULT.reduce((n, d) => n + d.text.length, 0)

/** Both the transcript Phase 3 reads and the chronicle Phase 6 reads name
 *  exactly one note, so retrieval has the same single target on both. */
const NAMES_ONE_NOTE = (subject: string) =>
  `${subject} rode for ${REFERENCED} at first light, and did not stop. `.repeat(900)

const CONDENSE_JSON = JSON.stringify({
  narrative:
    'The company rode out under a grey sky and the road behind them emptied of everything but ' +
    'dust. By the third bell they had decided, and nobody spoke of it again.',
  bulletPoints: ['The company rode out', 'Nobody spoke of the decision'],
})

const baseInput = (): ReforgeInput => ({
  chronicle: NAMES_ONE_NOTE('The company'),
  groundedTranscript: `[Kaziel (Name)] ${NAMES_ONE_NOTE('We')}`,
  dmQuestions: [],
  dmAnswers: {},
  kb: VAULT,
  campaign: 'Ironvale',
  sessionNumber: 24,
})

/** Chronicle + condense only. Extras is a third phase with its own JSON shape
 *  and no vault of its own to narrow — leaving it out keeps the assertions
 *  about the two phases that receive the full KB. */
const config: ReforgeConfig = {
  regenerateChronicle: true,
  doExtras: false,
  doCondense: true,
  extrasSource: 'transcript',
  geminiTier: 'paid',
}

/** Every prompt the provider saw, prefix and per-chunk body together —
 *  Phase 3 puts the KB in the cacheable prefix, Phase 6 may not. */
function promptsFrom(provider: MockProvider): string[] {
  return provider.calls.map((c) => `${c.req.cacheablePrefix ?? ''}\n${c.req.userPrompt ?? ''}`)
}

describe('Reforge knowledge-base retrieval', () => {
  beforeEach(() => {
    const provider = new MockProvider({ name: 'gemini', nextDelayMs: 0 })
    // Phase 6 parses JSON; Phase 3 takes prose. Answer by what the prompt asks
    // for, since one reforge run drives both.
    provider.setHandler((req) =>
      mockResponse(
        /bulletPoints|JSON/i.test(`${req.cacheablePrefix ?? ''}${req.userPrompt ?? ''}`)
          ? CONDENSE_JSON
          : // Names the note, as a real chronicle of this session would — Phase 6
            // retrieves against the chronicle Phase 3 just wrote, so a mock that
            // mentions no lore would leave it nothing to find.
            'The company rode out from ' +
            REFERENCED +
            ' under a grey sky, and the road behind them ' +
            'emptied of everything but dust. Nobody spoke for the first mile.',
      ),
    )
    mockProviderRef.current = provider
  })

  it('sends only the referenced slice of the vault when retrieval is on', async () => {
    const provider = mockProviderRef.current!

    await runReforge({ ...baseInput(), retrieveVaultKb: true }, config, { onEvent: () => {} })

    const prompts = promptsFrom(provider)
    expect(prompts.length).toBeGreaterThan(0)

    for (const p of prompts) {
      // The note both texts name survives — retrieval must not lose lore.
      expect(p).toContain(REFERENCED)
      // And the bulk of the vault does not ride along, on any phase.
      expect(p.length).toBeLessThan(VAULT_CHARS / 2)
    }
  })

  it('sends the whole vault when retrieval is off', async () => {
    const provider = mockProviderRef.current!

    await runReforge({ ...baseInput(), retrieveVaultKb: false }, config, { onEvent: () => {} })

    const prompts = promptsFrom(provider)
    // Unchanged for anyone who has not asked for the trade.
    expect(prompts.some((p) => p.includes('Unrelated39'))).toBe(true)
  })

  it('defaults to the whole vault when the caller says nothing', async () => {
    const provider = mockProviderRef.current!

    await runReforge(baseInput(), config, { onEvent: () => {} })

    expect(promptsFrom(provider).some((p) => p.includes('Unrelated39'))).toBe(true)
  })
})
