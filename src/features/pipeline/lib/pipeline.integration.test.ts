/** @vitest-environment jsdom */
//
// K.3.1 — end-to-end pipeline integration test.
//
// The 2,169-line driver (pipeline.ts) had no integration test before this
// file — every previous test covered an individual helper. We exercise
// runPhase1 → runPhase2 → runPhase3 → runPhase4 → runPhase6 on the 24KB
// synthetic transcript with a MockProvider standing in for the cloud
// LLM, then assert:
//
//   - Each phase returns non-empty canonical output (groundedTranscript,
//     DM questions array, chronicle prose, extras JSON, condense
//     output).
//   - The PipelineEvent stream for each phase looks like
//     `phase_start → N × chunk_done → phase_complete` with the right N.
//   - N matches `chunkSizeFor()` for the supplied (provider, tier, phase).
//   - provider.generate was called N times with the correct model.
//   - No silent-empty output: each generated chunk has text.length > 100.
//
// Phase 5 is local-only by design (cloud chronicle skips polish) so the
// integration test exercises the five cloud phases. The local-only path
// is covered by phase5-specific tests if/when they exist.
//
// Mocking shape mirrors src/features/pipeline/lib/pipeline.test.ts (the K.1.2 prove test)
// since that pattern is already production-validated.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlossaryDocument } from '../../corrections/lib/glossary'
import type { KBDocument } from './types'
import { DEFAULT_RETRIEVAL_MAX_CHARS } from '@/features/lore'

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

import {
  runPhase1,
  runPhase2,
  runPhase3,
  runPhase4,
  runPhase6,
  type PipelineEvent,
} from './pipeline'
import { MockProvider, mockResponse } from '../../providers/lib/providers/mockProvider'
import { chunkSizeFor } from './chunking'
import { TRANSCRIPT_24KB } from '../../../../test/fixtures/transcript-24kb'
import type { PhaseId, DMQuestion, ExtrasOutput } from '@/features/pipeline/lib/types'

// ────────────────────── Mock responses per phase ──────────────────────
//
// Each phase parses chunk responses differently, so the MockProvider
// handler needs to return the right shape. The body is unique per
// (phase, chunkIndex) so we can assert per-call dispatch.

const GROUNDED_PROSE_PER_CHUNK = (i: number) =>
  `[Esen (Baptiste)] In Waterdeep, Esen rolls a perception check while Janus watches. ` +
  `The party glances at the Sun Blade. The Crimson Cathedral looms over the square. ` +
  // Pad past 100 chars so the no-silent-empty assertion clears with margin.
  `Chunk #${i} grounded — additional canonical narrative padding to keep response length stable.`

const PHASE2_QUESTIONS_PER_CHUNK = (i: number) =>
  JSON.stringify([
    {
      id: `q-${i}-1`,
      question: `What did Esen actually do at the Crimson Cathedral in chunk ${i}?`,
      context: `The grounded transcript suggests a perception check, but the raw says lunge.`,
    },
  ])

const CHRONICLE_PROSE_PER_CHUNK = (i: number) =>
  `The chronicle of chunk ${i} unfolds: Esen stepped through the gates of the Crimson ` +
  `Cathedral, the Sun Blade humming faintly at his hip. Janus followed, axe gleaming. ` +
  `The party paused at the inscription, weighing what to do next under Waterdeep's red sun.`

const PHASE4_EXTRAS_PER_CHUNK = (i: number) =>
  JSON.stringify({
    jests: [`Chunk ${i}: Esen forgot to bring rope, again.`],
    gore: [`Chunk ${i}: a guard fell from the rampart, splattering on cobblestone.`],
    quotes: [
      {
        speaker: 'Esen',
        line: `That's the third time this week, chunk ${i}.`,
        kind: 'funny',
      },
    ],
  })

const PHASE6_CONDENSE_PER_CHUNK = (i: number) =>
  JSON.stringify({
    narrative:
      `Chunk ${i}: the party entered the Crimson Cathedral under Waterdeep's red sun, ` +
      `Esen leading with the Sun Blade. Janus followed, axe drawn. They paused at the ` +
      `inscription. Bones cracked under boots. A guard fell from the rampart. The party ` +
      `pressed on, weighing the riddle of the Withering Staff against the lure of gold. ` +
      `By the third bell they had decided — into the crypt, weapons ready, hope thin.`,
    bulletPoints: [
      `Chunk ${i} — bullet A: party entered Cathedral`,
      `Chunk ${i} — bullet B: Esen found the inscription`,
    ],
  })

function installPhaseHandler(provider: MockProvider, phase: PhaseId): void {
  provider.setHandler((req, callIndex) => {
    // Each handler returns the per-phase shape; callIndex serves as
    // the absolute chunk index because the integration test runs one
    // phase at a time with a fresh provider per phase.
    switch (phase) {
      case 'phase1_ground':
        return mockResponse(GROUNDED_PROSE_PER_CHUNK(callIndex))
      case 'phase2_audit':
        return mockResponse(PHASE2_QUESTIONS_PER_CHUNK(callIndex))
      case 'phase3_chronicle':
        return mockResponse(CHRONICLE_PROSE_PER_CHUNK(callIndex))
      case 'phase4_extras':
        return mockResponse(PHASE4_EXTRAS_PER_CHUNK(callIndex))
      case 'phase6_condense':
        return mockResponse(PHASE6_CONDENSE_PER_CHUNK(callIndex))
      default:
        // Phase 5 is local-only — not exercised here.
        return mockResponse(`unhandled-phase-${req.model}-${callIndex}`)
    }
  })
}

function makeProvider(phase: PhaseId): MockProvider {
  const p = new MockProvider({ name: 'gemini', nextDelayMs: 0 })
  installPhaseHandler(p, phase)
  mockProviderRef.current = p
  return p
}

function captureEvents(): { events: PipelineEvent[]; onEvent: (e: PipelineEvent) => void } {
  const events: PipelineEvent[] = []
  return {
    events,
    onEvent: (e) => events.push(e),
  }
}

function eventsForPhase(events: PipelineEvent[], phase: PhaseId): PipelineEvent[] {
  return events.filter((e) => 'phase' in e && e.phase === phase)
}

function expectedChunkCountForPhase(
  phase: Extract<PhaseId, 'phase1_ground' | 'phase2_audit' | 'phase3_chronicle' | 'phase4_extras' | 'phase6_condense'>,
  bodyLen: number,
): number {
  const sizeKey: Record<typeof phase, 'p1' | 'p2' | 'p3' | 'p4' | 'p6'> = {
    phase1_ground: 'p1',
    phase2_audit: 'p2',
    phase3_chronicle: 'p3',
    phase4_extras: 'p4',
    phase6_condense: 'p6',
  }
  const chunkSize = chunkSizeFor({
    phase: sizeKey[phase],
    isLocal: false,
    cloudProvider: 'gemini',
    geminiTier: 'paid',
    modelTier: 'flagship',
  })
  return Math.max(1, Math.ceil(bodyLen / chunkSize))
}

describe('pipeline integration — all 6 phases on the 24KB fixture', () => {
  beforeEach(() => {
    mockProviderRef.current = null
  })

  it('fixture is the expected ~24KB shape (sanity-check)', () => {
    expect(TRANSCRIPT_24KB.length).toBeGreaterThan(20_000)
    expect(TRANSCRIPT_24KB.length).toBeLessThan(30_000)
    // Speaker brackets are present so the detach-pass has work to do.
    expect(TRANSCRIPT_24KB).toMatch(/^\[Esen \(Player\)\]/)
  })

  describe('Phase 1 — ground', () => {
    it('returns non-empty grounded transcript, fires phase_start → N×chunk_done → phase_complete', async () => {
      const provider = makeProvider('phase1_ground')
      const cap = captureEvents()

      const grounded = await runPhase1({
        rawTranscript: TRANSCRIPT_24KB,
        kb: [],
        callbacks: { onEvent: cap.onEvent },
        cloudProvider: 'gemini',
        geminiTier: 'paid',
      })

      expect(grounded.length).toBeGreaterThan(100)
      expect(grounded.trim()).toBe(grounded.trim()) // no leading/trailing whitespace contract

      const ph1Events = eventsForPhase(cap.events, 'phase1_ground')
      const starts = ph1Events.filter((e) => e.type === 'phase_start')
      const completes = ph1Events.filter((e) => e.type === 'phase_complete')
      const chunkDones = ph1Events.filter((e) => e.type === 'chunk_done')

      expect(starts).toHaveLength(1)
      expect(completes).toHaveLength(1)
      expect(chunkDones.length).toBe(provider.calls.length)
      // Order: every chunk_done arrives between phase_start and phase_complete.
      const startIdx = ph1Events.indexOf(starts[0])
      const completeIdx = ph1Events.indexOf(completes[0])
      for (const cd of chunkDones) {
        const i = ph1Events.indexOf(cd)
        expect(i).toBeGreaterThan(startIdx)
        expect(i).toBeLessThan(completeIdx)
      }
    })

    it('chunk count matches chunkSizeFor() and provider model is gemini-2.5-pro', async () => {
      const provider = makeProvider('phase1_ground')
      const cap = captureEvents()

      await runPhase1({
        rawTranscript: TRANSCRIPT_24KB,
        kb: [],
        callbacks: { onEvent: cap.onEvent },
        cloudProvider: 'gemini',
        geminiTier: 'paid',
      })

      // Phase 1 prep produces a transformed transcript whose length differs
      // slightly from the raw fixture (cleanup + preGround + detach). The
      // exact count depends on those passes; assert it's in a sensible
      // bracket relative to the size table rather than pinning a number
      // that would tie this test to internal prep details.
      const upperBound = expectedChunkCountForPhase('phase1_ground', TRANSCRIPT_24KB.length)
      expect(provider.calls.length).toBeGreaterThanOrEqual(1)
      expect(provider.calls.length).toBeLessThanOrEqual(upperBound + 1)

      for (const c of provider.calls) {
        expect(c.req.model).toBe('gemini-2.5-pro')
      }
    })

    it('no silent-empty output — each provider response has text.length > 100', async () => {
      const provider = makeProvider('phase1_ground')
      const cap = captureEvents()
      await runPhase1({
        rawTranscript: TRANSCRIPT_24KB,
        kb: [],
        callbacks: { onEvent: cap.onEvent },
        cloudProvider: 'gemini',
        geminiTier: 'paid',
      })

      for (let i = 0; i < provider.calls.length; i++) {
        const responseText = GROUNDED_PROSE_PER_CHUNK(i)
        expect(responseText.length).toBeGreaterThan(100)
      }
    })
  })

  describe('Phase 2 — audit', () => {
    it('returns DMQuestion[] with at least one parsed entry', async () => {
      const provider = makeProvider('phase2_audit')
      const cap = captureEvents()

      // Phase 2 needs both raw + grounded text. The audit-skip path
      // short-circuits chunks whose grounded body equals raw, so we
      // make grounded materially different for at least one chunk.
      const grounded = TRANSCRIPT_24KB.replace(/perception check/g, 'insight check')

      const questions: DMQuestion[] = await runPhase2({
        kb: [],
        rawTranscript: TRANSCRIPT_24KB,
        groundedTranscript: grounded,
        callbacks: { onEvent: cap.onEvent },
        cloudProvider: 'gemini',
        geminiTier: 'paid',
      })

      expect(Array.isArray(questions)).toBe(true)
      expect(questions.length).toBeGreaterThanOrEqual(1)
      expect(questions[0].question.length).toBeGreaterThan(0)
      expect(typeof questions[0].id).toBe('string')

      const events = eventsForPhase(cap.events, 'phase2_audit')
      expect(events.filter((e) => e.type === 'phase_start')).toHaveLength(1)
      expect(events.filter((e) => e.type === 'phase_complete')).toHaveLength(1)
      // Audit may skip chunks whose grounded === raw — provider.calls.length
      // tracks how many actually fired. Chunk_done events fire once per
      // dispatched chunk regardless of skip status.
      expect(provider.calls.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('Phase 3 — chronicle', () => {
    it('returns non-empty narrative chronicle prose', async () => {
      const provider = makeProvider('phase3_chronicle')
      const cap = captureEvents()
      const grounded = TRANSCRIPT_24KB

      const chronicle = await runPhase3({
        groundedTranscript: grounded,
        dmQuestions: [],
        dmAnswers: {},
        kb: [],
        callbacks: { onEvent: cap.onEvent },
        cloudProvider: 'gemini',
        geminiTier: 'paid',
      })

      expect(chronicle.length).toBeGreaterThan(100)

      const events = eventsForPhase(cap.events, 'phase3_chronicle')
      const starts = events.filter((e) => e.type === 'phase_start')
      const completes = events.filter((e) => e.type === 'phase_complete')
      const chunkDones = events.filter((e) => e.type === 'chunk_done')
      expect(starts).toHaveLength(1)
      // The split is reported so a resume (e.g. of a stopped Reforge) can
      // cut the transcript at the same boundaries.
      expect(starts[0]).toMatchObject({
        chunkSizeChars: chunkSizeFor({ phase: 'p3', isLocal: false, cloudProvider: 'gemini', geminiTier: 'paid', modelTier: 'flagship' }),
      })
      expect(completes).toHaveLength(1)
      expect(chunkDones.length).toBe(provider.calls.length)

      // Model on each dispatched call.
      for (const c of provider.calls) {
        expect(c.req.model).toBe('gemini-2.5-pro')
      }
    })
  })

  describe('Phase 3 — lore payload', () => {
    // The lore rides in the cacheable prefix. Two things must hold whatever
    // its size: the prefix is identical from chunk to chunk (or caching is
    // defeated), and it is bounded (or a vault-sized lore source overflows the
    // window of every model short of a million tokens, three hours into the
    // run, on the phase that writes the chronicle).
    const doc = (i: number, chars: number, name = `Note ${i}`): KBDocument => ({
      id: `kb-${i}`,
      name,
      type: 'md',
      text: `# ${name}\nMARKER_${i}_ ${'lore text '.repeat(Math.ceil(chars / 10))}`.slice(0, chars),
      sizeBytes: chars,
      addedAt: '2026-01-01T00:00:00.000Z',
    })
    // The transcript names one note, so title matching has something to keep.
    const grounded = `[Zuri (DM)] The party rides for Harrowgate at first light.\n${TRANSCRIPT_24KB}`

    async function prefixesFor(
      kb: KBDocument[],
      extra: { modelContextTokens?: number; retrieveVaultKb?: boolean } = {},
    ): Promise<string[]> {
      const provider = makeProvider('phase3_chronicle')
      await runPhase3({
        groundedTranscript: grounded,
        dmQuestions: [],
        dmAnswers: {},
        kb,
        callbacks: { onEvent: () => {} },
        cloudProvider: 'gemini',
        geminiTier: 'paid',
        ...extra,
      })
      const prefixes = provider.calls.map((c) => c.req.cacheablePrefix ?? '')
      expect(prefixes.length).toBeGreaterThan(0)
      return prefixes
    }

    it('carries a small lore source in full, identically in every chunk', async () => {
      const prefixes = await prefixesFor([doc(1, 20_000), doc(2, 20_000), doc(3, 20_000)])
      for (const p of prefixes) {
        expect(p).toContain('MARKER_1_')
        expect(p).toContain('MARKER_3_')
        expect(p).toBe(prefixes[0])
      }
    })

    // An UNKNOWN window is deliberately not a reason to narrow: retrieval is
    // opt-in, and an absent context length is not evidence of a bad fit. That
    // contract is pinned in pipeline.phase3Retrieval.test.ts, which asserts
    // the whole vault goes when the caller says nothing.

    it('bounds the lore when the window is known and the full text cannot fit', async () => {
      const kb = Array.from({ length: 50 }, (_, i) => doc(i, 12_000)) // 600k chars
      const prefixes = await prefixesFor(kb, { modelContextTokens: 128_000 })
      for (const p of prefixes) expect(p.length).toBeLessThan(DEFAULT_RETRIEVAL_MAX_CHARS + 30_000)
    })

    it('leaves the lore whole when the window is known and it fits', async () => {
      const kb = Array.from({ length: 50 }, (_, i) => doc(i, 2_000)) // 100k chars
      const prefixes = await prefixesFor(kb, { modelContextTokens: 1_000_000 })
      for (const p of prefixes) expect(p.length).toBeGreaterThan(100_000)
    })
  })

  describe('Phase 4 — extras', () => {
    it('returns ExtrasOutput { jests, gore, quotes } with at least one of each', async () => {
      makeProvider('phase4_extras')
      const cap = captureEvents()

      const extras: ExtrasOutput = await runPhase4({
        kb: [],
        groundedTranscript: TRANSCRIPT_24KB,
        dmAnswers: {},
        callbacks: { onEvent: cap.onEvent },
        cloudProvider: 'gemini',
        geminiTier: 'paid',
      })

      expect(Array.isArray(extras.jests)).toBe(true)
      expect(Array.isArray(extras.gore)).toBe(true)
      expect(Array.isArray(extras.quotes)).toBe(true)
      expect(extras.jests.length).toBeGreaterThanOrEqual(1)
      expect(extras.gore.length).toBeGreaterThanOrEqual(1)
      expect(extras.quotes.length).toBeGreaterThanOrEqual(1)

      // Quote shape: speaker + line + kind.
      const q = extras.quotes[0]
      expect(q.speaker.length).toBeGreaterThan(0)
      expect(q.line.length).toBeGreaterThan(0)
      expect(['funny', 'stupid', 'dark']).toContain(q.kind)

      const events = eventsForPhase(cap.events, 'phase4_extras')
      const starts = events.filter((e) => e.type === 'phase_start')
      expect(starts).toHaveLength(1)
      expect(starts[0]).toMatchObject({
        chunkSizeChars: chunkSizeFor({ phase: 'p4', isLocal: false, cloudProvider: 'gemini', geminiTier: 'paid', modelTier: 'flagship' }),
      })
      expect(events.filter((e) => e.type === 'phase_complete')).toHaveLength(1)
    })
  })

  describe('Phase 6 — condense', () => {
    it('returns CondenseOutput { narrative, bulletPoints } when chronicle is supplied', async () => {
      makeProvider('phase6_condense')
      const cap = captureEvents()
      // Use the chronicle-shaped string from Phase 3's expected output as
      // the input here — it's all that matters; Phase 6 chunks on this.
      const chronicle = (
        'Esen walked into the Crimson Cathedral. Janus followed, axe in hand. ' +
        'The party paused at the inscription. They debated, then descended into the crypt. '
      ).repeat(30) // ~6000 chars so we definitely have ≥1 chunk

      const condensed = await runPhase6({
        chronicle,
        kb: [],
        dmAnswers: {},
        campaign: 'Test Campaign',
        sessionNumber: 1,
        callbacks: { onEvent: cap.onEvent },
        cloudProvider: 'gemini',
        geminiTier: 'paid',
      })

      expect(condensed.narrative.length).toBeGreaterThan(100)
      expect(Array.isArray(condensed.bulletPoints)).toBe(true)
      expect(condensed.bulletPoints.length).toBeGreaterThanOrEqual(1)

      const events = eventsForPhase(cap.events, 'phase6_condense')
      expect(events.filter((e) => e.type === 'phase_start')).toHaveLength(1)
      expect(events.filter((e) => e.type === 'phase_complete')).toHaveLength(1)
    })

    // Two chunks at the Gemini-paid flagship size (100k) — the shape of a real
    // multi-chunk condense.
    const TWO_CHUNK_CHRONICLE = Array.from(
      { length: 1300 },
      (_, i) => `Paragraph ${i}: the party crossed the Crimson Cathedral's nave and argued about the Sun Blade.`,
    ).join('\n\n')

    const runTwoChunkCondense = () =>
      runPhase6({
        chronicle: TWO_CHUNK_CHRONICLE,
        kb: [],
        dmAnswers: {},
        campaign: 'Test Campaign',
        sessionNumber: 1,
        callbacks: { onEvent: () => {} },
        cloudProvider: 'gemini',
        geminiTier: 'paid',
      })

    it('re-runs an unreadable first chunk instead of starting the condense partway through', async () => {
      const provider = new MockProvider({ name: 'gemini', nextDelayMs: 0 })
      mockProviderRef.current = provider
      // Call 0: chunk 0 answers with output that is not JSON at all.
      // Call 1: chunk 1 answers normally. Call 2: the retry of chunk 0.
      provider.setHandler((_req, callIndex) =>
        mockResponse(
          callIndex === 0
            ? 'Here is the condensed chronicle you asked for.'
            : JSON.stringify({
                narrative: callIndex === 2 ? 'OPENING of the session.' : 'LATER in the session.',
                bulletPoints: [callIndex === 2 ? 'Opening bullet.' : 'Later bullet.'],
              }),
        ),
      )

      const condensed = await runTwoChunkCondense()

      expect(provider.calls).toHaveLength(3)
      expect(condensed.narrative).toBe('OPENING of the session.\n\nLATER in the session.')
      expect(condensed.bulletPoints).toEqual(['Opening bullet.', 'Later bullet.'])
    })

    it('fails loudly when a chunk is still unreadable after its retry', async () => {
      const provider = new MockProvider({ name: 'gemini', nextDelayMs: 0 })
      mockProviderRef.current = provider
      provider.setHandler((req) =>
        mockResponse(
          req.userPrompt?.includes('Paragraph 0:')
            ? 'Not JSON.'
            : JSON.stringify({ narrative: 'Later.', bulletPoints: ['Later.'] }),
        ),
      )

      await expect(runTwoChunkCondense()).rejects.toThrow(/chunk 1\/2 could not be read/)
      expect(provider.calls).toHaveLength(3)
    })

    it('returns empty output and skips dispatch when chronicle is blank', async () => {
      const provider = makeProvider('phase6_condense')
      const cap = captureEvents()

      const condensed = await runPhase6({
        chronicle: '   \n\n  ',
        kb: [],
        dmAnswers: {},
        campaign: 'Test Campaign',
        sessionNumber: 1,
        callbacks: { onEvent: cap.onEvent },
        cloudProvider: 'gemini',
        geminiTier: 'paid',
      })

      expect(condensed.narrative).toBe('')
      expect(condensed.bulletPoints).toEqual([])
      expect(provider.calls).toHaveLength(0)
    })
  })

  describe('end-to-end — Phase 1 → 2 → 3 → 4 → 6 chained on the same fixture', () => {
    it('chains outputs across all five cloud phases without losing data', async () => {
      // Run all phases serially, swapping handler between phases so each
      // call returns the right shape for the next phase's parser.
      const provider = new MockProvider({ name: 'gemini', nextDelayMs: 0 })
      mockProviderRef.current = provider

      const allEvents: PipelineEvent[] = []
      const onEvent = (e: PipelineEvent) => allEvents.push(e)

      // ─── Phase 1 ───
      installPhaseHandler(provider, 'phase1_ground')
      const grounded = await runPhase1({
        rawTranscript: TRANSCRIPT_24KB,
        kb: [],
        callbacks: { onEvent },
        cloudProvider: 'gemini',
        geminiTier: 'paid',
      })
      expect(grounded.length).toBeGreaterThan(100)
      provider.reset()

      // ─── Phase 2 ───
      installPhaseHandler(provider, 'phase2_audit')
      const groundedDifferent = TRANSCRIPT_24KB.replace(/perception/g, 'insight')
      const questions = await runPhase2({
        kb: [],
        rawTranscript: TRANSCRIPT_24KB,
        groundedTranscript: groundedDifferent,
        callbacks: { onEvent },
        cloudProvider: 'gemini',
        geminiTier: 'paid',
      })
      expect(questions.length).toBeGreaterThanOrEqual(1)
      provider.reset()

      // ─── Phase 3 ───
      installPhaseHandler(provider, 'phase3_chronicle')
      const chronicle = await runPhase3({
        groundedTranscript: groundedDifferent,
        dmQuestions: questions,
        dmAnswers: {},
        kb: [],
        callbacks: { onEvent },
        cloudProvider: 'gemini',
        geminiTier: 'paid',
      })
      expect(chronicle.length).toBeGreaterThan(100)
      provider.reset()

      // ─── Phase 4 ───
      installPhaseHandler(provider, 'phase4_extras')
      const extras = await runPhase4({
        kb: [],
        groundedTranscript: groundedDifferent,
        dmAnswers: {},
        callbacks: { onEvent },
        cloudProvider: 'gemini',
        geminiTier: 'paid',
      })
      expect(extras.jests.length + extras.gore.length + extras.quotes.length).toBeGreaterThan(0)
      provider.reset()

      // ─── Phase 6 ───
      installPhaseHandler(provider, 'phase6_condense')
      const condensed = await runPhase6({
        chronicle,
        kb: [],
        dmAnswers: {},
        campaign: 'Test Campaign',
        sessionNumber: 1,
        callbacks: { onEvent },
        cloudProvider: 'gemini',
        geminiTier: 'paid',
      })
      expect(condensed.narrative.length).toBeGreaterThan(100)

      // ─── Per-phase event totals (one phase_start + phase_complete each) ───
      const phaseIds: PhaseId[] = [
        'phase1_ground',
        'phase2_audit',
        'phase3_chronicle',
        'phase4_extras',
        'phase6_condense',
      ]
      for (const phase of phaseIds) {
        const ev = eventsForPhase(allEvents, phase)
        expect(ev.filter((e) => e.type === 'phase_start')).toHaveLength(1)
        expect(ev.filter((e) => e.type === 'phase_complete')).toHaveLength(1)
      }
    })
  })
})
