import { describe, expect, it } from 'vitest'
import {
  CHECKPOINT_SCHEMA_VERSION,
  isValidCheckpoint,
  summarise,
  type RunCheckpoint,
} from './runCheckpoint'
import { initialRefinementState } from '@/types'

function makeCheckpoint(over: Partial<RunCheckpoint> = {}): RunCheckpoint {
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    runId: 'test-run-123',
    createdAt: '2026-05-21T12:00:00.000Z',
    pausedAt: '2026-05-21T12:30:00.000Z',
    pausedReason: 'quota',
    routing: { version: 3, lastSelectedProvider: 'gemini', geminiTier: 'free' },
    safetyMultiplier: 1,
    refinementState: { ...initialRefinementState, campaign: 'Acme Bards', sessionNumber: 4 },
    progress: { phase: 3, chunkIndex: 7, totalChunks: 12 },
    ...over,
  }
}

describe('isValidCheckpoint', () => {
  it('accepts a well-formed checkpoint', () => {
    expect(isValidCheckpoint(makeCheckpoint())).toBe(true)
  })

  it('rejects a schemaVersion mismatch', () => {
    expect(isValidCheckpoint(makeCheckpoint({ schemaVersion: 999 as never }))).toBe(false)
  })

  it('rejects when required string fields are missing', () => {
    expect(isValidCheckpoint(makeCheckpoint({ runId: '' }))).toBe(false)
    expect(isValidCheckpoint(makeCheckpoint({ createdAt: '' }))).toBe(false)
    expect(isValidCheckpoint(makeCheckpoint({ pausedAt: '' }))).toBe(false)
  })

  it('rejects unknown pausedReason values', () => {
    expect(isValidCheckpoint(makeCheckpoint({ pausedReason: 'bogus' as never }))).toBe(false)
  })

  it('rejects non-numeric safetyMultiplier', () => {
    expect(isValidCheckpoint(makeCheckpoint({ safetyMultiplier: 'fast' as never }))).toBe(false)
    expect(isValidCheckpoint(makeCheckpoint({ safetyMultiplier: NaN }))).toBe(false)
  })

  it('rejects unsupported progress.phase', () => {
    expect(isValidCheckpoint(makeCheckpoint({ progress: { phase: 5 as never, chunkIndex: 0, totalChunks: 1 } }))).toBe(false)
    expect(isValidCheckpoint(makeCheckpoint({ progress: { phase: 7 as never, chunkIndex: 0, totalChunks: 1 } }))).toBe(false)
  })

  it('accepts each valid phase', () => {
    for (const phase of [1, 2, 3, 4, 6] as const) {
      expect(isValidCheckpoint(makeCheckpoint({ progress: { phase, chunkIndex: 0, totalChunks: 1 } }))).toBe(true)
    }
  })

  it('rejects null / undefined / non-object input', () => {
    expect(isValidCheckpoint(null)).toBe(false)
    expect(isValidCheckpoint(undefined)).toBe(false)
    expect(isValidCheckpoint('string')).toBe(false)
    expect(isValidCheckpoint(42)).toBe(false)
  })
})

describe('summarise', () => {
  it('extracts the fields the Resume banner needs', () => {
    const c = makeCheckpoint()
    const s = summarise(c)
    expect(s.runId).toBe(c.runId)
    expect(s.schemaVersion).toBe(c.schemaVersion)
    expect(s.campaign).toBe('Acme Bards')
    expect(s.sessionNumber).toBe(4)
    expect(s.progress).toEqual({ phase: 3, chunkIndex: 7, totalChunks: 12 })
    expect(s.pausedReason).toBe('quota')
  })

  it('does NOT expose the full refinement state', () => {
    const c = makeCheckpoint()
    const s = summarise(c) as Record<string, unknown>
    expect(s.refinementState).toBeUndefined()
    expect(s.routing).toBeUndefined()
  })
})
