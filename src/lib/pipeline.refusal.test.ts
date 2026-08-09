/** @vitest-environment jsdom */
//
// Integration coverage for the always-on Claude Code refusal tracking +
// per-phase marker injection (see chunkedGenerate). With the failsafe toggle
// OFF and the provider returning a refusal, every refused chunk must:
//   - emit an `auto_fallback {reason:'claude_refusal', repaired:false}` event
//     carrying a refusalId + sourceSpan,
//   - inject the per-phase output: a visible banner + hidden tag for Phase 3
//     (prose), the ungrounded passthrough for Phase 1, the empty `[]` sentinel
//     for Phase 2 (JSON).
//
// Mock shape mirrors pipeline.integration.test.ts, plus a claudeFailsafe mock
// so the in-run Gemini restore is deliberately skipped (we're testing the
// UNREPAIRED path).

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlossaryDocument } from './glossary'

const mockProviderRef: { current: import('./providers/mockProvider').MockProvider | null } = {
  current: null,
}
const glossaryDoc: GlossaryDocument = { version: 1, safeReplacements: [], contextualHints: [] }

vi.mock('./providers', async () => {
  const actual = await vi.importActual<typeof import('./providers')>('./providers')
  return {
    ...actual,
    ensureProvidersInitialized: vi.fn(async () => undefined),
    getActiveProvider: vi.fn(() => mockProviderRef.current),
    getCloudProvider: vi.fn(() => mockProviderRef.current),
  }
})

vi.mock('./providers/settings', async () => {
  const actual = await vi.importActual<typeof import('./providers/settings')>('./providers/settings')
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

vi.mock('./glossary', () => ({
  getGlossary: vi.fn(async () => glossaryDoc),
  peekGlossary: vi.fn(() => glossaryDoc),
  subscribeGlossary: vi.fn(() => () => {}),
  putGlossary: vi.fn(),
}))

vi.mock('./aliasIndexClient', () => ({
  getAliasIndex: vi.fn(async () => null),
  entitiesFromIndex: vi.fn(() => []),
}))

// Failsafe OFF → no in-run Gemini restore; every refusal stays unrepaired.
vi.mock('./claudeFailsafe', () => ({
  getClaudeFailsafeEnabled: vi.fn(() => false),
}))

import { runPhase1, runPhase2, runPhase3, type PipelineEvent } from './pipeline'
import { MockProvider, mockResponse } from './providers/mockProvider'
import { parseRefusalMarkers } from './refusalDetection'

const REFUSAL = "I can't help with that — it violates my content policy."

function refusingProvider(): MockProvider {
  const p = new MockProvider({ name: 'gemini', nextDelayMs: 0 })
  p.setHandler(() => mockResponse(REFUSAL))
  mockProviderRef.current = p
  return p
}

function captureEvents() {
  const events: PipelineEvent[] = []
  return { events, onEvent: (e: PipelineEvent) => events.push(e) }
}

function refusalEvents(events: PipelineEvent[]) {
  return events.filter(
    (e): e is Extract<PipelineEvent, { type: 'auto_fallback' }> =>
      e.type === 'auto_fallback' && e.reason === 'claude_refusal',
  )
}

const RAW =
  '[Seoyeon (Amina)] We march on the Crimson Cathedral at dawn, blades drawn.\n' +
  '[Lucia (Tanvi)] Aye, and the Sun Blade hums for blood this morning.\n'.repeat(40)

describe('Claude Code refusal tracking (failsafe OFF)', () => {
  beforeEach(() => {
    mockProviderRef.current = null
  })

  it('Phase 3 injects a visible banner + hidden tag and emits an unrepaired refusal event', async () => {
    refusingProvider()
    const cap = captureEvents()

    const chronicle = await runPhase3({
      groundedTranscript: RAW,
      dmQuestions: [],
      dmAnswers: {},
      kb: [],
      callbacks: { onEvent: cap.onEvent },
      cloudProvider: 'claudeCode',
    })

    // Banner + hidden tag landed in the prose output.
    expect(chronicle).toContain('Review & Repair Refusals')
    expect(parseRefusalMarkers(chronicle).length).toBeGreaterThan(0)
    expect(chronicle).not.toContain(REFUSAL) // refused text never silently kept

    const refusals = refusalEvents(cap.events)
    expect(refusals.length).toBeGreaterThan(0)
    const r = refusals[0]
    expect(r.repaired).toBe(false)
    expect(r.refusalId).toBeTruthy()
    expect(r.marker).toContain('TUSKS-REFUSAL')
    expect((r.transcriptExcerpt ?? '').length).toBeGreaterThan(0)
  })

  it('Phase 1 passes the ungrounded chunk through (no banner) but still records the refusal', async () => {
    refusingProvider()
    const cap = captureEvents()

    const grounded = await runPhase1({
      rawTranscript: RAW,
      kb: [],
      callbacks: { onEvent: cap.onEvent },
      cloudProvider: 'claudeCode',
    })

    // Grounding feeds downstream phases → never a banner in the transcript.
    expect(parseRefusalMarkers(grounded)).toEqual([])
    expect(grounded).not.toContain('Review & Repair Refusals')
    expect(grounded.length).toBeGreaterThan(50) // passthrough, not blank

    const refusals = refusalEvents(cap.events)
    expect(refusals.length).toBeGreaterThan(0)
    expect(refusals[0].repaired).toBe(false)
    expect(refusals[0].marker).toBe('') // manifest-only, no inline anchor
  })

  it('Phase 2 keeps valid empty JSON output and records the refusal (manifest-only)', async () => {
    refusingProvider()
    const cap = captureEvents()

    // Grounded must differ from raw or the audit-skip short-circuits every
    // chunk (no provider call → no refusal).
    const grounded = RAW.replace(/Crimson Cathedral/g, 'Obsidian Spire')

    const questions = await runPhase2({
      rawTranscript: RAW,
      groundedTranscript: grounded,
      callbacks: { onEvent: cap.onEvent },
      cloudProvider: 'claudeCode',
    })

    // Refused audit chunks degrade to empty — no questions, no crash.
    expect(Array.isArray(questions)).toBe(true)
    expect(questions).toHaveLength(0)

    const refusals = refusalEvents(cap.events)
    expect(refusals.length).toBeGreaterThan(0)
    expect(refusals[0].repaired).toBe(false)
    expect(refusals[0].marker).toBe('')
    // chunkSizeChars recorded so a repair can re-derive the raw span.
    expect(refusals[0].chunkSizeChars).toBeGreaterThan(0)
  })
})
