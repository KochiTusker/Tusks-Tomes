import { describe, expect, it, vi } from 'vitest'
import { planResumeAction } from './resumeFlow'
import {
  CHECKPOINT_SCHEMA_VERSION,
  type CheckpointPhaseId,
  type RunCheckpoint,
} from './runCheckpoint'
import { initialRefinementState, type RefinementState } from '@/types'
import {
  PARTIAL_AFTER_3_CHUNKS,
  PARTIAL_AFTER_3_CHUNKS_JSON,
  PARTIAL_EMPTY,
  PARTIAL_MALFORMED,
  PARTIAL_ONLY_JESTS,
  PARTIAL_TORN,
  PARTIAL_WHITESPACE,
} from '../../test/fixtures/phase4-partial-extras'

function makeCheckpoint(
  phase: CheckpointPhaseId,
  chunkIndex: number,
  totalChunks: number,
  refinementOverrides: Partial<RefinementState> = {},
): RunCheckpoint {
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    runId: 'test-run',
    createdAt: '2026-05-21T12:00:00.000Z',
    pausedAt: '2026-05-21T12:30:00.000Z',
    pausedReason: 'quota',
    routing: { version: 3, lastSelectedProvider: 'gemini', geminiTier: 'free' },
    safetyMultiplier: 1,
    refinementState: { ...initialRefinementState, ...refinementOverrides },
    progress: { phase, chunkIndex, totalChunks },
  }
}

describe('planResumeAction', () => {
  describe('Phase 1 (grounding)', () => {
    it('continues Phase 1 from the saved chunkIndex with grounded partial', () => {
      const cp = makeCheckpoint(1, 5, 10, {
        rawTranscript: 'raw',
        groundedTranscript: 'PARTIAL-GROUNDED',
      })
      const action = planResumeAction(cp)
      expect(action.kind).toBe('continue')
      expect(action.phase).toBe(1)
      expect(action.startChunkIndex).toBe(5)
      expect(action.priorPartial).toBe('PARTIAL-GROUNDED')
      expect(action.afterPhases).toEqual([2])
    })
  })

  describe('Phase 2 (audit)', () => {
    it('restarts Phase 2 from chunk 0 — audit has no priorPartial concept', () => {
      const cp = makeCheckpoint(2, 4, 8, {
        rawTranscript: 'raw',
        groundedTranscript: 'COMPLETE-GROUNDED',
      })
      const action = planResumeAction(cp)
      expect(action.kind).toBe('restart')
      expect(action.phase).toBe(2)
      expect(action.startChunkIndex).toBe(0)
      expect(action.priorPartial).toBeUndefined()
    })
  })

  describe('Phase 3 (chronicle)', () => {
    it('continues Phase 3 from the saved chunkIndex with prior chronicle', () => {
      const cp = makeCheckpoint(3, 7, 12, {
        rawTranscript: 'raw',
        groundedTranscript: 'g',
        dmQuestions: [{ id: 'q1', question: 'Who?', context: '' }],
        dmAnswers: { q1: 'Velka' },
        chronicle: 'PARTIAL-CHRONICLE',
      })
      const action = planResumeAction(cp)
      expect(action.kind).toBe('continue')
      expect(action.phase).toBe(3)
      expect(action.startChunkIndex).toBe(7)
      expect(action.priorPartial).toBe('PARTIAL-CHRONICLE')
      // After Phase 3 the pipeline does Phase 5 (local polish, cloud no-op) + Phase 4 (extras).
      expect(action.afterPhases).toEqual([5, 4])
    })
  })

  describe('Phase 4 (extras)', () => {
    it('continues Phase 4 from saved chunkIndex with the priorExtras shape', () => {
      const cp = makeCheckpoint(4, 3, 8, {
        rawTranscript: 'raw',
        groundedTranscript: 'g',
        chronicle: 'c',
        extras: { jests: ['existing-jest'], gore: [], quotes: [] },
      })
      const action = planResumeAction(cp)
      expect(action.kind).toBe('continue')
      expect(action.phase).toBe(4)
      expect(action.startChunkIndex).toBe(3)
      // Phase 4 uses priorExtras (an ExtrasOutput object), not priorPartial.
      expect(action.priorExtras).toEqual({ jests: ['existing-jest'], gore: [], quotes: [] })
      expect(action.afterPhases).toEqual([])
    })
  })

  describe('Phase 6 (condense)', () => {
    it('restarts Phase 6 from chunk 0 — condense has no chunk-level resume support', () => {
      const cp = makeCheckpoint(6, 2, 4, {
        rawTranscript: 'raw',
        groundedTranscript: 'g',
        chronicle: 'c',
      })
      const action = planResumeAction(cp)
      expect(action.kind).toBe('restart')
      expect(action.phase).toBe(6)
      expect(action.startChunkIndex).toBe(0)
      expect(action.priorPartial).toBeUndefined()
    })
  })

  describe('edge cases', () => {
    it('clamps chunkIndex to 0 when negative (defensive)', () => {
      const cp = makeCheckpoint(3, -1, 5, { chronicle: 'x' })
      const action = planResumeAction(cp)
      expect(action.startChunkIndex).toBe(0)
    })

    it('treats Phase 1 with empty groundedTranscript AND empty partialOutput as startChunkIndex=0', () => {
      // Genuinely-empty pause (e.g. quota hit before chunk 0 even started).
      // No carryover anywhere → safe to restart from chunk 0.
      const cp = makeCheckpoint(1, 3, 10, { groundedTranscript: '', partialOutput: '' })
      const action = planResumeAction(cp)
      expect(action.startChunkIndex).toBe(0)
      expect(action.priorPartial).toBe('')
    })
  })

  describe('mid-flight pause recovery via partialOutput fallback', () => {
    // Bug fix landed 2026-05-26 after Phase G Playwright validation found
    // that a Free Flash run pausing on quota at Phase 1 chunk 5/9 would
    // restart from chunk 0 on Resume, because `groundedTranscript` is only
    // populated when Phase 1 fully completes; mid-flight chunks accumulate
    // into `partialOutput` instead, which the planner previously ignored.
    // The fallback below preserves user progress across pauses (quota,
    // error, or user-initiated) for both Phase 1 and Phase 3.

    it('Phase 1 with empty grounded but populated partialOutput uses partialOutput as priorPartial', () => {
      const cp = makeCheckpoint(1, 5, 9, {
        rawTranscript: 'r',
        groundedTranscript: '',
        partialOutput: 'CHUNKS-0-THROUGH-4-OUTPUT',
      })
      const action = planResumeAction(cp)
      expect(action.kind).toBe('continue')
      expect(action.startChunkIndex).toBe(5)
      expect(action.priorPartial).toBe('CHUNKS-0-THROUGH-4-OUTPUT')
    })

    it('Phase 1 prefers groundedTranscript when both are populated', () => {
      // Defensive: if a phase has fully completed and a new phase started,
      // groundedTranscript holds the canonical output and partialOutput may
      // hold an in-flight buffer from a different phase. Prefer the canonical.
      const cp = makeCheckpoint(1, 5, 9, {
        rawTranscript: 'r',
        groundedTranscript: 'CANONICAL',
        partialOutput: 'STALE-PARTIAL-FROM-LATER-PHASE',
      })
      const action = planResumeAction(cp)
      expect(action.priorPartial).toBe('CANONICAL')
      expect(action.startChunkIndex).toBe(5)
    })

    it('Phase 3 with empty chronicle but populated partialOutput uses partialOutput', () => {
      const cp = makeCheckpoint(3, 2, 4, {
        rawTranscript: 'r',
        groundedTranscript: 'g',
        chronicle: '',
        partialOutput: 'CHRONICLE-CHUNKS-0-1-NARRATIVE',
      })
      const action = planResumeAction(cp)
      expect(action.kind).toBe('continue')
      expect(action.startChunkIndex).toBe(2)
      expect(action.priorPartial).toBe('CHRONICLE-CHUNKS-0-1-NARRATIVE')
    })

    it('Phase 3 prefers chronicle when both are populated', () => {
      const cp = makeCheckpoint(3, 2, 4, {
        rawTranscript: 'r',
        groundedTranscript: 'g',
        chronicle: 'CANONICAL-NARRATIVE',
        partialOutput: 'STALE',
      })
      const action = planResumeAction(cp)
      expect(action.priorPartial).toBe('CANONICAL-NARRATIVE')
    })

    it('Phase 3 with both empty returns startChunkIndex=0 (no silent chunk drop)', () => {
      const cp = makeCheckpoint(3, 2, 4, {
        rawTranscript: 'r',
        groundedTranscript: 'g',
        chronicle: '',
        partialOutput: '',
      })
      const action = planResumeAction(cp)
      expect(action.startChunkIndex).toBe(0)
      expect(action.priorPartial).toBe('')
    })
  })

  describe('Phase 4 mid-flight pause recovery (B1)', () => {
    // The bug: Phase 4's accumulator (ExtrasOutput object) only commits to
    // refinementState.extras on phase completion. Mid-flight pauses (quota,
    // error, Halt) leave the in-progress JSON in refinementState.partialOutput.
    // Without these tests the planner ignores partialOutput and returns an
    // empty priorExtras, silently dropping every chunk completed before the
    // pause. Fix: JSON.parse partialOutput when extras is empty; on parse
    // failure, vlog + fall back to empty + signal parseError so the UI can
    // toast about the lost data.

    // Recovered quotes go through normalizeQuotes, which fills in the 'funny'
    // default the renderers already applied to kind-less legacy entries. The
    // fixture keeps one such entry to cover that on-disk shape.
    const RECOVERED_AFTER_3_CHUNKS = {
      ...PARTIAL_AFTER_3_CHUNKS,
      quotes: PARTIAL_AFTER_3_CHUNKS.quotes.map((q) => ({ ...q, kind: q.kind ?? 'funny' })),
    }

    it('uses extras when canonical field has content (happy path)', () => {
      const cp = makeCheckpoint(4, 3, 8, {
        chronicle: 'c',
        extras: { jests: ['canonical-jest'], gore: [], quotes: [] },
        partialOutput: PARTIAL_AFTER_3_CHUNKS_JSON, // present but should be ignored
      })
      const action = planResumeAction(cp)
      expect(action.priorExtras).toEqual({ jests: ['canonical-jest'], gore: [], quotes: [] })
      expect(action.parseError).toBeFalsy()
    })

    it('falls back to partialOutput JSON when extras is null', () => {
      const cp = makeCheckpoint(4, 3, 8, {
        chronicle: 'c',
        extras: null,
        partialOutput: PARTIAL_AFTER_3_CHUNKS_JSON,
      })
      const action = planResumeAction(cp)
      expect(action.priorExtras).toEqual(RECOVERED_AFTER_3_CHUNKS)
      expect(action.startChunkIndex).toBe(3) // chunk index preserved
      expect(action.parseError).toBeFalsy()
    })

    it('falls back to partialOutput when extras is fully empty', () => {
      // Empty arrays look like "no data yet" — partialOutput should win.
      const cp = makeCheckpoint(4, 2, 6, {
        chronicle: 'c',
        extras: { jests: [], gore: [], quotes: [] },
        partialOutput: PARTIAL_AFTER_3_CHUNKS_JSON,
      })
      const action = planResumeAction(cp)
      expect(action.priorExtras).toEqual(RECOVERED_AFTER_3_CHUNKS)
    })

    it('defaults missing fields to empty arrays when JSON has only some keys', () => {
      const cp = makeCheckpoint(4, 1, 5, {
        chronicle: 'c',
        extras: null,
        partialOutput: PARTIAL_ONLY_JESTS,
      })
      const action = planResumeAction(cp)
      expect(action.priorExtras).toEqual({
        jests: ['just a single jest'],
        gore: [],
        quotes: [],
      })
    })

    it('returns empty extras (no parseError) when partialOutput is empty string', () => {
      // Genuine "haven't written anything yet" case — not a torn write.
      const cp = makeCheckpoint(4, 0, 5, {
        chronicle: 'c',
        extras: null,
        partialOutput: PARTIAL_EMPTY,
      })
      const action = planResumeAction(cp)
      expect(action.priorExtras).toEqual({ jests: [], gore: [], quotes: [] })
      expect(action.parseError).toBeFalsy()
    })

    it('treats whitespace-only partialOutput as empty (no parseError)', () => {
      const cp = makeCheckpoint(4, 0, 5, {
        chronicle: 'c',
        extras: null,
        partialOutput: PARTIAL_WHITESPACE,
      })
      const action = planResumeAction(cp)
      expect(action.priorExtras).toEqual({ jests: [], gore: [], quotes: [] })
      expect(action.parseError).toBeFalsy()
    })

    it('signals parseError + falls back to empty extras when partialOutput is a torn write', () => {
      const cp = makeCheckpoint(4, 2, 5, {
        chronicle: 'c',
        extras: null,
        partialOutput: PARTIAL_TORN,
      })
      // Suppress the expected vlog (test environment doesn't have the ring).
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const action = planResumeAction(cp)
        expect(action.priorExtras).toEqual({ jests: [], gore: [], quotes: [] })
        expect(action.parseError).toBe(true)
      } finally {
        consoleErrorSpy.mockRestore()
      }
    })

    it('signals parseError when partialOutput is malformed JSON', () => {
      const cp = makeCheckpoint(4, 1, 5, {
        chronicle: 'c',
        extras: null,
        partialOutput: PARTIAL_MALFORMED,
      })
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const action = planResumeAction(cp)
        expect(action.parseError).toBe(true)
        expect(action.priorExtras).toEqual({ jests: [], gore: [], quotes: [] })
      } finally {
        consoleErrorSpy.mockRestore()
      }
    })
  })

  describe('outputSelection-driven afterPhases (Phase 4 land)', () => {
    // The new optional-outputs feature stores the user's pick on
    // `refinementState.outputSelection`. The resume planner reads it and
    // rebuilds afterPhases conditionally. These tests lock the contract
    // so a future refactor of the selection shape can't silently break it.

    it('Phase 3 resume with chronicle-only selection: afterPhases = [5] (no extras, no condense)', () => {
      const cp = makeCheckpoint(3, 4, 8, {
        chronicle: 'partial',
        outputSelection: { chronicle: true, extras: false, condensed: false, condensePercentage: 20 },
      })
      const action = planResumeAction(cp)
      expect(action.afterPhases).toEqual([5])
    })

    it('Phase 3 resume with chronicle + extras: afterPhases = [5, 4]', () => {
      const cp = makeCheckpoint(3, 4, 8, {
        chronicle: 'partial',
        outputSelection: { chronicle: true, extras: true, condensed: false, condensePercentage: 20 },
      })
      const action = planResumeAction(cp)
      expect(action.afterPhases).toEqual([5, 4])
    })

    it('Phase 3 resume with chronicle + condensed: afterPhases = [5, 6] (no Phase 4)', () => {
      const cp = makeCheckpoint(3, 4, 8, {
        chronicle: 'partial',
        outputSelection: { chronicle: true, extras: false, condensed: true, condensePercentage: 20 },
      })
      const action = planResumeAction(cp)
      expect(action.afterPhases).toEqual([5, 6])
    })

    it('Phase 3 resume with everything: afterPhases = [5, 4, 6]', () => {
      const cp = makeCheckpoint(3, 4, 8, {
        chronicle: 'partial',
        outputSelection: { chronicle: true, extras: true, condensed: true, condensePercentage: 20 },
      })
      const action = planResumeAction(cp)
      expect(action.afterPhases).toEqual([5, 4, 6])
    })

    it('Phase 4 resume with no condensed: afterPhases = [] (terminal)', () => {
      const cp = makeCheckpoint(4, 2, 6, {
        extras: { jests: [], gore: [], quotes: [] },
        outputSelection: { chronicle: true, extras: true, condensed: false, condensePercentage: 20 },
      })
      const action = planResumeAction(cp)
      expect(action.afterPhases).toEqual([])
    })

    it('Phase 4 resume WITH condensed selected: afterPhases = [6] (chain condense)', () => {
      const cp = makeCheckpoint(4, 2, 6, {
        extras: { jests: [], gore: [], quotes: [] },
        chronicle: 'existing-chronicle',
        outputSelection: { chronicle: true, extras: true, condensed: true, condensePercentage: 20 },
      })
      const action = planResumeAction(cp)
      expect(action.afterPhases).toEqual([6])
    })

    it('Legacy checkpoint missing outputSelection defaults to chronicle+extras (today\'s behavior)', () => {
      // Build a checkpoint without ever assigning outputSelection.
      const cp = makeCheckpoint(3, 4, 8, { chronicle: 'partial' })
      // Defensive: strip the field so we exercise the missing-field path.
      delete (cp.refinementState as { outputSelection?: unknown }).outputSelection
      const action = planResumeAction(cp)
      // DEFAULT_OUTPUT_SELECTION = { chronicle:true, extras:true, condensed:false }
      expect(action.afterPhases).toEqual([5, 4])
    })
  })
})
