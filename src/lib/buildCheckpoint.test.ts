// buildCheckpoint pure-function tests. The contract: the checkpoint's
// `progress.chunkIndex` always matches the snapshot's
// `state.currentChunkIndex`, and `refinementState` is exactly the
// snapshot's state spread over the campaign/sessionNumber overrides —
// no closure surprises. K.1.3 / W1 depends on this invariant for the
// stateRef-snapshot pattern to actually prevent the race.

import { describe, expect, it } from 'vitest'
import { buildCheckpoint } from './buildCheckpoint'
import { initialRefinementState, type RefinementState } from '@/types'
import type { RoutingDocument } from './routing'
import { CHECKPOINT_SCHEMA_VERSION } from './runCheckpoint'

const ROUTING: RoutingDocument = {
  version: 3,
  lastSelectedProvider: 'gemini',
  geminiTier: 'paid',
}

function makeState(overrides: Partial<RefinementState>): RefinementState {
  return { ...initialRefinementState, ...overrides }
}

describe('buildCheckpoint', () => {
  it('returns a v2 checkpoint with progress mirroring the snapshot', () => {
    const state = makeState({
      currentPhase: 'phase1_ground',
      currentChunkIndex: 3,
      totalChunks: 5,
      partialOutput: 'g0\n\ng1\n\ng2',
      rawTranscript: 'raw',
      updatedAt: '2026-05-27T10:00:00.000Z',
    })
    const cp = buildCheckpoint({
      snapshot: { state, campaign: 'C', sessionNumber: 7 },
      runId: 'r1',
      routing: ROUTING,
      pausedReason: 'user',
      phaseNumeric: 1,
      safetyMultiplier: 1.5,
      nowIso: '2026-05-27T10:05:00.000Z',
    })
    expect(cp.schemaVersion).toBe(CHECKPOINT_SCHEMA_VERSION)
    expect(cp.runId).toBe('r1')
    expect(cp.createdAt).toBe('2026-05-27T10:00:00.000Z')
    expect(cp.pausedAt).toBe('2026-05-27T10:05:00.000Z')
    expect(cp.pausedReason).toBe('user')
    expect(cp.safetyMultiplier).toBe(1.5)
    expect(cp.progress).toEqual({ phase: 1, chunkIndex: 3, totalChunks: 5 })
    expect(cp.refinementState.partialOutput).toBe('g0\n\ng1\n\ng2')
    expect(cp.refinementState.campaign).toBe('C')
    expect(cp.refinementState.sessionNumber).toBe(7)
  })

  it('uses snapshot at call time — mutating state AFTER the call does NOT leak in', () => {
    // The load-bearing K.1.3 contract: once buildCheckpoint returns, the
    // checkpoint must be a frozen snapshot. If the caller's stateRef
    // mutates afterwards (because a chunk_done landed), the already-
    // built checkpoint must not see the mutation.
    const state = makeState({ currentChunkIndex: 3, partialOutput: 'A' })
    const cp = buildCheckpoint({
      snapshot: { state, campaign: 'C', sessionNumber: 1 },
      runId: 'r1',
      routing: ROUTING,
      pausedReason: 'user',
      phaseNumeric: 1,
      safetyMultiplier: 1,
    })
    // Mutate the underlying state — simulating chunk_done landing
    // after writeCheckpoint already snapshot it.
    state.currentChunkIndex = 4
    state.partialOutput = 'A\n\nB'
    expect(cp.progress.chunkIndex).toBe(3)
    expect(cp.refinementState.partialOutput).toBe('A')
  })

  it('omits runFingerprint and inputSnapshot when not supplied', () => {
    const cp = buildCheckpoint({
      snapshot: { state: makeState({}), campaign: '', sessionNumber: 0 },
      runId: 'r1',
      routing: ROUTING,
      pausedReason: 'quota',
      phaseNumeric: 1,
      safetyMultiplier: 1,
    })
    expect('runFingerprint' in cp).toBe(false)
    expect('inputSnapshot' in cp).toBe(false)
  })

  it('includes runFingerprint when truthy, omits when null', () => {
    const base = {
      snapshot: { state: makeState({}), campaign: '', sessionNumber: 0 },
      runId: 'r1',
      routing: ROUTING,
      pausedReason: 'user' as const,
      phaseNumeric: 1 as const,
      safetyMultiplier: 1,
    }
    expect(buildCheckpoint({ ...base, runFingerprint: 'abc123' }).runFingerprint).toBe('abc123')
    expect('runFingerprint' in buildCheckpoint({ ...base, runFingerprint: null })).toBe(false)
  })

  it('includes inputSnapshot when truthy, omits when null', () => {
    const snap = {
      phase1Chunks: ['c0', 'c1'],
      chunkSizeChars: 1500,
      detachAttached: false,
      speakersByMarker: {},
    }
    const base = {
      snapshot: { state: makeState({}), campaign: '', sessionNumber: 0 },
      runId: 'r1',
      routing: ROUTING,
      pausedReason: 'user' as const,
      phaseNumeric: 1 as const,
      safetyMultiplier: 1,
    }
    expect(buildCheckpoint({ ...base, inputSnapshot: snap }).inputSnapshot).toBe(snap)
    expect('inputSnapshot' in buildCheckpoint({ ...base, inputSnapshot: null })).toBe(false)
  })

  it('falls back to nowIso when state.updatedAt is empty', () => {
    const cp = buildCheckpoint({
      snapshot: { state: makeState({ updatedAt: '' }), campaign: '', sessionNumber: 0 },
      runId: 'r1',
      routing: ROUTING,
      pausedReason: 'user',
      phaseNumeric: 1,
      safetyMultiplier: 1,
      nowIso: '2026-05-27T11:00:00.000Z',
    })
    expect(cp.createdAt).toBe('2026-05-27T11:00:00.000Z')
  })
})
