/** @vitest-environment jsdom */
//
// Phase K.1.2 / B2 prove tests — Phase 1 input-drift on glossary edit.
//
// The bug: runPhase1 runs `cleanupTranscript → preGround(glossary) →
// detachSpeakers → chunkText` on every invocation. On resume, the live
// glossary may differ from the one in effect when the run was paused —
// the user could have added a safeReplacement entry between sessions.
// preGround output then changes character-for-character, chunkText splits
// on different boundaries, and `startChunkIndex: N` from the checkpoint
// points at content the model has never seen.
//
// The fix (K.1.2 implementation pass): runPhase1 captures the prep-stage
// output as a `Phase1InputSnapshot` and emits it via `onInputSnapshot()`
// once chunking completes. The React layer persists this snapshot into
// the next checkpoint. On resume, if the checkpoint carries an
// inputSnapshot, runPhase1 skips the prep stage entirely and uses the
// saved chunks — chunk boundaries stay locked to the original run no
// matter how the live glossary has drifted.
//
// These tests lock the contract BEFORE the fix lands. The drift assertion
// ("different glossary → different chunks") passes today (it's a control
// observation about current behaviour). The snapshot-restore assertion
// ("resume with inputSnapshot ⇒ chunks match the at-pause snapshot")
// fails today because the parameter is declared but not wired through —
// runPhase1 still re-runs prep against the live glossary. The K.1.2 fix
// makes it pass.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlossaryDocument } from './glossary'

// MockProvider + glossary need to live behind module mocks because
// runPhase1 reaches getCloudProvider/getActiveProvider for dispatch and
// getGlossary/getAliasIndex during the prep stage. The vi.mock factories
// MUST be defined before runPhase1 is imported (vitest hoists them).

const mockProviderRef: { current: import('./providers/mockProvider').MockProvider | null } = {
  current: null,
}
let glossaryDoc: GlossaryDocument = {
  version: 1,
  safeReplacements: [],
  contextualHints: [],
}

vi.mock('./providers', async () => {
  const actual = await vi.importActual<typeof import('./providers')>('./providers')
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

// Imports below this line run after vi.mock factories register.
import { runPhase1, type PipelineEvent } from './pipeline'
import { MockProvider, mockResponse } from './providers/mockProvider'
import {
  GLOSSARY_AT_PAUSE,
  GLOSSARY_AT_RESUME,
  TRANSCRIPT_FOR_DRIFT_TEST,
} from '../../test/fixtures/glossary-edit-scenarios'
import type { Phase1InputSnapshot } from './runCheckpoint'

// Force-small chunk size so the transcript splits into multiple chunks
// regardless of the per-provider chunkSizeFor() table. The fixture is
// ~10 KB; 1500 yields ~7-8 chunks — enough to demonstrate boundary
// drift without being noisy.
const CHUNK_SIZE_FOR_TEST = 1500

function makeMockProvider(): MockProvider {
  const p = new MockProvider({ name: 'gemini' })
  // Handler mode: return a deterministic response per call so we don't
  // have to enqueue N responses up-front (chunk count varies by glossary).
  p.setHandler((req, callIndex) =>
    mockResponse(`grounded-output-for-call-${callIndex}-len-${req.userPrompt.length}`),
  )
  return p
}

async function runAndCaptureSnapshot(args: {
  glossary: GlossaryDocument
  inputSnapshot?: Phase1InputSnapshot
  startChunkIndex?: number
  priorPartial?: string
}): Promise<{
  capturedSnapshot: Phase1InputSnapshot | null
  modelCalls: ReadonlyArray<{ userPrompt: string }>
}> {
  glossaryDoc = args.glossary
  mockProviderRef.current = makeMockProvider()
  let capturedSnapshot: Phase1InputSnapshot | null = null
  const events: PipelineEvent[] = []
  await runPhase1({
    rawTranscript: TRANSCRIPT_FOR_DRIFT_TEST,
    kb: [],
    callbacks: { onEvent: (e) => events.push(e) },
    cloudProvider: 'gemini',
    geminiTier: 'paid',
    chunkSizeChars: CHUNK_SIZE_FOR_TEST,
    startChunkIndex: args.startChunkIndex,
    priorPartial: args.priorPartial,
    inputSnapshot: args.inputSnapshot,
    onInputSnapshot: (snapshot) => {
      capturedSnapshot = snapshot
    },
  })
  return {
    capturedSnapshot,
    modelCalls: mockProviderRef.current.calls.map((c) => ({ userPrompt: c.req.userPrompt })),
  }
}

describe('runPhase1 — B2 input-drift on glossary edit', () => {
  beforeEach(() => {
    glossaryDoc = { version: 1, safeReplacements: [], contextualHints: [] }
    mockProviderRef.current = null
  })

  it('control: glossary edit between runs shifts model dispatch (drift exists)', async () => {
    // Observe drift via the model's userPrompts directly — independent
    // of the snapshot-capture API, so this assertion passes both pre-
    // and post-fix. It's a regression guard for the underlying premise:
    // "glossary edits between Phase 1 runs DO shift the chunk content
    // sent to the model." If this ever stops being true (e.g. someone
    // de-coupled chunking from preGround), the snapshot mechanism in
    // this file would become unnecessary and the fix tests below would
    // mask the change instead of failing usefully.
    const atPause = await runAndCaptureSnapshot({ glossary: GLOSSARY_AT_PAUSE })
    const atResume = await runAndCaptureSnapshot({ glossary: GLOSSARY_AT_RESUME })

    const atPausePrompts = atPause.modelCalls.map((c) => c.userPrompt)
    const atResumePrompts = atResume.modelCalls.map((c) => c.userPrompt)

    // Either the call count differs or at least one prompt body differs.
    expect(atResumePrompts).not.toEqual(atPausePrompts)
  })

  it('fix: resume with inputSnapshot honours the saved chunks (skips live-glossary re-prep)', async () => {
    // Step 1 — run under pause-time glossary to obtain a snapshot.
    const pause = await runAndCaptureSnapshot({ glossary: GLOSSARY_AT_PAUSE })
    const pauseSnapshot = pause.capturedSnapshot!
    expect(pauseSnapshot.phase1Chunks.length).toBeGreaterThanOrEqual(4)

    // Step 2 — resume under the mutated glossary, mid-flight (startChunkIndex: 3).
    // The fix's contract: inputSnapshot is passed in, runPhase1 skips
    // cleanup/preGround/detach, and dispatches chunks 3..N from the
    // SAVED snapshot — not the live-glossary-recomputed array.
    const resume = await runAndCaptureSnapshot({
      glossary: GLOSSARY_AT_RESUME,
      inputSnapshot: pauseSnapshot,
      startChunkIndex: 3,
      priorPartial: 'grounded-output-for-chunk-0\n\ngrounded-output-for-chunk-1\n\ngrounded-output-for-chunk-2',
    })

    // The model should have received exactly (snapshot.length - 3) calls.
    expect(resume.modelCalls).toHaveLength(pauseSnapshot.phase1Chunks.length - 3)

    // Each dispatched call's userPrompt must contain the corresponding
    // snapshot chunk verbatim. With the bug (snapshot ignored), the
    // chunks fed to the model come from the LIVE-glossary recompute
    // array and the substring check fails.
    for (let offset = 0; offset < resume.modelCalls.length; offset++) {
      const absoluteIndex = 3 + offset
      const expectedChunkBody = pauseSnapshot.phase1Chunks[absoluteIndex]
      const actualPrompt = resume.modelCalls[offset].userPrompt
      expect(
        actualPrompt.includes(expectedChunkBody),
        `Chunk ${absoluteIndex}: live-glossary chunk leaked into resume dispatch instead of using snapshot. ` +
          `Expected userPrompt to contain snapshot chunk \`${expectedChunkBody.slice(0, 60)}...\``,
      ).toBe(true)
    }
  })

  it('fix: resume with inputSnapshot does NOT call onInputSnapshot (capture is one-way)', async () => {
    // Capture an initial snapshot.
    const pause = await runAndCaptureSnapshot({ glossary: GLOSSARY_AT_PAUSE })
    const pauseSnapshot = pause.capturedSnapshot!

    // Now resume passing in the snapshot. Because the resume path SKIPS
    // prep, onInputSnapshot must not fire — otherwise the RefinementTool
    // would re-emit an identical snapshot and trigger an unnecessary
    // checkpoint rewrite on every resume.
    glossaryDoc = GLOSSARY_AT_RESUME
    mockProviderRef.current = makeMockProvider()
    let snapshotEmittedOnResume = false
    await runPhase1({
      rawTranscript: TRANSCRIPT_FOR_DRIFT_TEST,
      kb: [],
      callbacks: { onEvent: () => {} },
      cloudProvider: 'gemini',
      geminiTier: 'paid',
      chunkSizeChars: CHUNK_SIZE_FOR_TEST,
      startChunkIndex: 3,
      priorPartial: 'prior',
      inputSnapshot: pauseSnapshot,
      onInputSnapshot: () => {
        snapshotEmittedOnResume = true
      },
    })
    expect(snapshotEmittedOnResume).toBe(false)
  })

  it('edge case: pre-first-chunk pause (no snapshot saved) re-runs prep from rawTranscript', async () => {
    // When the run paused BEFORE any chunk completed, no snapshot was
    // captured (the writeCheckpoint at the rate-limit dialog has nothing
    // to stash yet). The resume path receives inputSnapshot: undefined
    // and must fall back to the cleanup → preGround → detach → chunk
    // pipeline. That's SAFE because rawTranscript doesn't change between
    // sessions, even if the glossary does — but it means a pre-boundary
    // pause is the one case where glossary edits DO surface to the
    // resumed model. The K.1.2 confirm-modal/warning path is what tells
    // the user about this; the pipeline-level contract is just "no
    // snapshot ⇒ re-run prep, no crash."
    glossaryDoc = GLOSSARY_AT_RESUME
    mockProviderRef.current = makeMockProvider()
    let capturedSnapshot: Phase1InputSnapshot | null = null
    await runPhase1({
      rawTranscript: TRANSCRIPT_FOR_DRIFT_TEST,
      kb: [],
      callbacks: { onEvent: () => {} },
      cloudProvider: 'gemini',
      geminiTier: 'paid',
      chunkSizeChars: CHUNK_SIZE_FOR_TEST,
      startChunkIndex: 0,
      onInputSnapshot: (s) => {
        capturedSnapshot = s
      },
    })
    // A snapshot WAS captured (the fix path always captures on a fresh
    // / no-snapshot run, so the next pause has something to save).
    expect(capturedSnapshot).not.toBeNull()
    expect(capturedSnapshot!.phase1Chunks.length).toBeGreaterThan(0)
    expect(capturedSnapshot!.chunkSizeChars).toBe(CHUNK_SIZE_FOR_TEST)
    // detachAttached should be true — the fixture lines start with `[Speaker]`.
    expect(capturedSnapshot!.detachAttached).toBe(true)
    // speakersByMarker should have entries for the bracketed lines.
    expect(Object.keys(capturedSnapshot!.speakersByMarker).length).toBeGreaterThan(0)
  })
})
