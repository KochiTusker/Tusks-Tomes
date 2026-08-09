// Soft-error signature library — positive + negative fixture per matcher.
// The library is the curated "investigate this" subset of the ring; if
// any matcher drifts, this suite is the contract guard.

import { describe, expect, it } from 'vitest'
import {
  runSignatures,
  SIGNATURES,
  type SignatureInput,
} from './softErrorSignatures.js'
import type { DiagnosticEntry } from './diagnosticsLog.js'

function entry(
  ts: number,
  cat: string,
  payload: Record<string, unknown>,
): DiagnosticEntry {
  return { ts, source: 'browser', cat, payload }
}

function chunkFinished(
  ts: number,
  phase: string,
  index: number,
  latencyMs: number,
): DiagnosticEntry {
  return entry(ts, 'chunk', { event: 'chunk_finished', phase, index, latencyMs, outputChars: 1000 })
}

describe('runSignatures — orchestrator', () => {
  it('returns empty array for an empty ring with no state', () => {
    expect(runSignatures({ ring: [] })).toEqual([])
  })

  it('sorts matches: critical → warning → info, then by id', () => {
    // Synthetic input that triggers two matches of different severities.
    const ring: DiagnosticEntry[] = [
      // Triggers stale_perPhase_override (warning).
      // Will be triggered via routing below; nothing in ring needed.
    ]
    const matches = runSignatures({
      ring,
      routing: {
        version: 3,
        geminiTier: 'paid',
        perPhase: {
          phase3: { target: 'cloud', cloudProvider: 'gemini', geminiTier: 'free' },
        },
      },
      // Triggers probed_model_inaccessible_but_selected (critical).
      probeCache: {
        geminiFallback: {
          probed: [{ id: 'gemini-2.5-pro', accessible: false, reason: 'Free tier quota: 0' }],
        },
      },
    })
    // We added a phase3 perPhase pointing at gemini-2.5-pro implicitly?
    // No — the probed_model check needs a modelId. Add it.
    const m2 = runSignatures({
      ring,
      routing: {
        version: 3,
        geminiTier: 'paid',
        perPhase: {
          phase3: { target: 'cloud', cloudProvider: 'gemini', geminiTier: 'free', modelId: 'gemini-2.5-pro' },
        },
      },
      probeCache: {
        geminiFallback: {
          probed: [{ id: 'gemini-2.5-pro', accessible: false, reason: 'Free tier quota: 0' }],
        },
      },
    })
    expect(m2.length).toBeGreaterThanOrEqual(2)
    // First should be critical (probed_model_inaccessible_but_selected).
    expect(m2[0].severity).toBe('critical')
    void matches
  })

  it('swallows matcher exceptions without crashing the suite', () => {
    // Force a matcher to throw by passing a ring with a non-object payload.
    // The matchers should still complete — we cast `null` as the payload
    // to provoke a NPE in code that doesn't guard.
    const ring: DiagnosticEntry[] = [
      { ts: 1, source: 'browser', cat: 'pipeline', payload: null },
    ]
    expect(() => runSignatures({ ring })).not.toThrow()
  })

  it('exposes every signature in the library', () => {
    // Lock the expected count so adding a signature without updating the
    // bundle docs trips this test.
    expect(SIGNATURES.length).toBe(11)
  })
})

describe('silent_model_substitution_to_lite', () => {
  it('matches when a sessions model_substitution event carries dubious=true', () => {
    const ring = [
      entry(1000, 'sessions', {
        event: 'model_substitution',
        phase: 'phase2',
        from: 'gemini-2.5-flash',
        to: 'gemini-flash-lite-latest',
        reason: 'Free tier quota: 0 (paid-only)',
        dubious: true,
      }),
    ]
    const matches = runSignatures({ ring })
    const match = matches.find((m) => m.id === 'silent_model_substitution_to_lite')
    expect(match).toBeDefined()
    expect(match?.severity).toBe('warning')
    expect(match?.hint).toContain('1 dubious model substitution')
  })

  it('does NOT match when substitution has dubious=false (a sensible swap)', () => {
    const ring = [
      entry(1000, 'sessions', {
        event: 'model_substitution',
        phase: 'phase2',
        from: 'gemini-2.5-pro',
        to: 'gemini-2.5-flash', // sensible same-family fallback
        reason: 'Free tier quota: 0',
        dubious: false,
      }),
    ]
    const matches = runSignatures({ ring })
    expect(matches.find((m) => m.id === 'silent_model_substitution_to_lite')).toBeUndefined()
  })

  it('does NOT match when no substitution events are in the ring', () => {
    const ring = [
      entry(1000, 'pipeline', { type: 'phase_start', phase: 'phase1_ground', totalChunks: 5 }),
    ]
    expect(
      runSignatures({ ring }).find((m) => m.id === 'silent_model_substitution_to_lite'),
    ).toBeUndefined()
  })

  it('counts multiple dubious substitutions in the hint', () => {
    const ring = [
      entry(1000, 'sessions', {
        event: 'model_substitution',
        phase: 'phase2',
        from: 'gemini-2.5-flash',
        to: 'gemini-flash-lite-latest',
        dubious: true,
      }),
      entry(2000, 'sessions', {
        event: 'model_substitution',
        phase: 'phase4',
        from: 'gemini-2.5-flash',
        to: 'gemini-flash-experimental-001',
        dubious: true,
      }),
    ]
    const matches = runSignatures({ ring })
    const match = matches.find((m) => m.id === 'silent_model_substitution_to_lite')
    expect(match?.hint).toContain('2 dubious model substitutions')
    const evidence = match?.evidence as { substitutions: Array<{ phase: string }> } | undefined
    expect(evidence?.substitutions).toHaveLength(2)
  })
})

describe('free_tier_daily_quota_hit', () => {
  it('matches when a pipeline quota_exhausted event has quotaKind=daily_quota AND tier=free', () => {
    const ring = [
      entry(1000, 'pipeline', {
        type: 'quota_exhausted',
        provider: 'gemini',
        quotaKind: 'daily_quota',
        tier: 'free',
        model: 'gemini-3.5-flash',
        keyFingerprint: 'def456',
      }),
    ]
    const matches = runSignatures({ ring })
    const match = matches.find((m) => m.id === 'free_tier_daily_quota_hit')
    expect(match).toBeDefined()
    expect(match?.severity).toBe('critical')
    expect(match?.hint).toContain('gemini-3.5-flash')
    expect(match?.hint).toContain('midnight UTC')
  })

  it('also matches when tier is auto (because auto-tier soft-swapped to free)', () => {
    const ring = [
      entry(1000, 'pipeline', {
        type: 'quota_exhausted',
        quotaKind: 'daily_quota',
        tier: 'auto',
        model: 'gemini-2.5-flash',
      }),
    ]
    const matches = runSignatures({ ring })
    expect(matches.find((m) => m.id === 'free_tier_daily_quota_hit')).toBeDefined()
  })

  it('does NOT match when tier=paid (paid daily isn\'t the same recovery shape)', () => {
    const ring = [
      entry(1000, 'pipeline', {
        type: 'quota_exhausted',
        quotaKind: 'daily_quota',
        tier: 'paid',
        model: 'gemini-2.5-pro',
      }),
    ]
    const matches = runSignatures({ ring })
    expect(matches.find((m) => m.id === 'free_tier_daily_quota_hit')).toBeUndefined()
  })

  it('does NOT match for rate_limit (per-minute) on free', () => {
    const ring = [
      entry(1000, 'pipeline', {
        type: 'quota_exhausted',
        quotaKind: 'rate_limit',
        tier: 'free',
        model: 'gemini-2.5-flash',
      }),
    ]
    const matches = runSignatures({ ring })
    expect(matches.find((m) => m.id === 'free_tier_daily_quota_hit')).toBeUndefined()
  })

  it('reports paidKeyConfigured:true when probe cache has a gemini-slot fingerprint', () => {
    const ring = [
      entry(1000, 'pipeline', {
        type: 'quota_exhausted',
        quotaKind: 'daily_quota',
        tier: 'free',
        model: 'gemini-3.5-flash',
      }),
    ]
    const matches = runSignatures({
      ring,
      probeCache: { gemini: { keyFingerprint: 'abc123' } },
    })
    const match = matches.find((m) => m.id === 'free_tier_daily_quota_hit')
    const evidence = match?.evidence as { paidKeyConfigured?: boolean }
    expect(evidence?.paidKeyConfigured).toBe(true)
    expect(match?.nextStep).toContain('Switch to Gemini Paid')
  })

  it('reports paidKeyConfigured:false + adds-key advice when no paid slot is probed', () => {
    const ring = [
      entry(1000, 'pipeline', {
        type: 'quota_exhausted',
        quotaKind: 'daily_quota',
        tier: 'free',
        model: 'gemini-3.5-flash',
      }),
    ]
    const matches = runSignatures({
      ring,
      probeCache: { geminiFallback: { keyFingerprint: 'def456' } }, // only free probed
    })
    const match = matches.find((m) => m.id === 'free_tier_daily_quota_hit')
    const evidence = match?.evidence as { paidKeyConfigured?: boolean }
    expect(evidence?.paidKeyConfigured).toBe(false)
    expect(match?.nextStep).toContain('Add a Paid Gemini key')
  })
})

describe('prompt_blocked_prohibited_content', () => {
  function softSkipped(
    ts: number,
    phase: string,
    index: number,
    model: string,
    blockReason = 'PROHIBITED_CONTENT',
  ): DiagnosticEntry {
    return entry(ts, 'chunk', {
      event: 'chunk_soft_skipped',
      phase,
      index,
      reason: 'prohibited_content',
      blockReason,
      model,
      tier: 'free',
    })
  }
  function chunkError(
    ts: number,
    phase: string,
    index: number,
    preview: string,
  ): DiagnosticEntry {
    return entry(ts, 'chunk', {
      event: 'chunk_error',
      phase,
      index,
      errorPreview: preview,
    })
  }

  it('matches a single soft-skipped chunk and reports the model + phase', () => {
    const ring = [softSkipped(1000, 'phase2_audit', 11, 'gemini-2.5-flash')]
    const matches = runSignatures({ ring })
    const match = matches.find((m) => m.id === 'prompt_blocked_prohibited_content')
    expect(match).toBeDefined()
    expect(match?.severity).toBe('warning')
    expect(match?.hint).toContain('1 chunk(s) soft-skipped')
    expect(match?.hint).toContain('phase2_audit')
    const evidence = match?.evidence as {
      softSkippedCount: number
      hardBlockCount: number
      affectedModels: string[]
      affectedPhases: string[]
    }
    expect(evidence.softSkippedCount).toBe(1)
    expect(evidence.hardBlockCount).toBe(0)
    expect(evidence.affectedModels).toContain('gemini-2.5-flash')
    expect(evidence.affectedPhases).toContain('phase2_audit')
  })

  it('matches a hard-block chunk_error whose preview contains PROHIBITED_CONTENT', () => {
    const ring = [
      chunkError(
        1000,
        'phase3_chronicle',
        5,
        'Gemini returned empty response.\n--- Prompt was blocked ---\nReason: PROHIBITED_CONTENT',
      ),
    ]
    const matches = runSignatures({ ring })
    const match = matches.find((m) => m.id === 'prompt_blocked_prohibited_content')
    expect(match).toBeDefined()
    expect(match?.hint).toContain('1 chunk(s) hard-failed')
  })

  it('matches BLOCKLIST and SPII preview tokens too', () => {
    const ring = [
      chunkError(1000, 'phase3_chronicle', 5, 'Reason: BLOCKLIST'),
      chunkError(2000, 'phase3_chronicle', 7, 'Reason: SPII'),
    ]
    const matches = runSignatures({ ring })
    expect(matches.find((m) => m.id === 'prompt_blocked_prohibited_content')).toBeDefined()
  })

  it('combines soft-skips + hard-blocks into a single match with both counts', () => {
    const ring = [
      softSkipped(1000, 'phase2_audit', 11, 'gemini-2.5-flash'),
      softSkipped(2000, 'phase2_audit', 14, 'gemini-2.5-flash'),
      chunkError(3000, 'phase3_chronicle', 5, 'Reason: PROHIBITED_CONTENT'),
    ]
    const matches = runSignatures({ ring })
    const match = matches.find((m) => m.id === 'prompt_blocked_prohibited_content')
    expect(match?.hint).toContain('2 chunk(s) soft-skipped')
    expect(match?.hint).toContain('1 chunk(s) hard-failed')
  })

  it('recommends Pro when a Flash model was the affected target', () => {
    const ring = [softSkipped(1000, 'phase2_audit', 11, 'gemini-2.5-flash')]
    const matches = runSignatures({ ring })
    const match = matches.find((m) => m.id === 'prompt_blocked_prohibited_content')
    expect(match?.nextStep).toContain('gemini-2.5-pro')
    expect(match?.nextStep).toContain('Flash')
  })

  it('falls back to generic swap advice when only Pro models hit the filter', () => {
    const ring = [softSkipped(1000, 'phase3_chronicle', 5, 'gemini-2.5-pro')]
    const matches = runSignatures({ ring })
    const match = matches.find((m) => m.id === 'prompt_blocked_prohibited_content')
    expect(match?.nextStep).not.toContain('Flash calibrate')
    expect(match?.nextStep).toContain('more permissive model')
  })

  it('does NOT match a normal chunk_error without a recognised block-reason token', () => {
    const ring = [chunkError(1000, 'phase3_chronicle', 5, 'HTTP 500 internal error')]
    const matches = runSignatures({ ring })
    expect(matches.find((m) => m.id === 'prompt_blocked_prohibited_content')).toBeUndefined()
  })

  it('does NOT match when the ring is empty', () => {
    const matches = runSignatures({ ring: [] })
    expect(matches.find((m) => m.id === 'prompt_blocked_prohibited_content')).toBeUndefined()
  })

  it('caps the examples evidence at 3 entries even when many chunks blocked', () => {
    const ring = [
      softSkipped(1000, 'phase2_audit', 1, 'gemini-2.5-flash'),
      softSkipped(2000, 'phase2_audit', 2, 'gemini-2.5-flash'),
      softSkipped(3000, 'phase2_audit', 3, 'gemini-2.5-flash'),
      softSkipped(4000, 'phase2_audit', 4, 'gemini-2.5-flash'),
      softSkipped(5000, 'phase2_audit', 5, 'gemini-2.5-flash'),
    ]
    const matches = runSignatures({ ring })
    const match = matches.find((m) => m.id === 'prompt_blocked_prohibited_content')
    const evidence = match?.evidence as { examples: unknown[] }
    expect(evidence.examples).toHaveLength(3)
    // But the total counts should still be accurate.
    const counts = match?.evidence as { softSkippedCount: number }
    expect(counts.softSkippedCount).toBe(5)
  })
})

describe('chunk_latency_outlier', () => {
  it('matches a chunk that took >3× the median', () => {
    const ring = [
      chunkFinished(1000, 'phase1_ground', 0, 8000),
      chunkFinished(2000, 'phase1_ground', 1, 8500),
      chunkFinished(3000, 'phase1_ground', 2, 9000),
      chunkFinished(4000, 'phase1_ground', 3, 47000), // outlier
    ]
    const matches = runSignatures({ ring })
    const match = matches.find((m) => m.id === 'chunk_latency_outlier')
    expect(match).toBeDefined()
    expect(match?.severity).toBe('warning')
    expect(match?.evidence?.outliers).toBeDefined()
  })

  it('does NOT match when all chunks are within 3× of median', () => {
    const ring = [
      chunkFinished(1000, 'phase1_ground', 0, 8000),
      chunkFinished(2000, 'phase1_ground', 1, 8500),
      chunkFinished(3000, 'phase1_ground', 2, 9000),
      chunkFinished(4000, 'phase1_ground', 3, 12000),
    ]
    const matches = runSignatures({ ring })
    expect(matches.find((m) => m.id === 'chunk_latency_outlier')).toBeUndefined()
  })

  it('skips when fewer than 4 samples (median is meaningless)', () => {
    const ring = [
      chunkFinished(1000, 'phase1_ground', 0, 8000),
      chunkFinished(2000, 'phase1_ground', 1, 800_000), // single outlier in 2 samples
    ]
    const matches = runSignatures({ ring })
    expect(matches.find((m) => m.id === 'chunk_latency_outlier')).toBeUndefined()
  })
})

describe('auto_fallback_mid_run', () => {
  it('matches when a pipeline auto_fallback event is in the ring', () => {
    const ring = [
      entry(1000, 'pipeline', { type: 'auto_fallback', phase: 'phase3_chronicle', provider: 'gemini', reason: 'hard_zero_quota' }),
    ]
    const matches = runSignatures({ ring })
    const match = matches.find((m) => m.id === 'auto_fallback_mid_run')
    expect(match).toBeDefined()
    expect(match?.hint).toContain('hard_zero_quota')
  })

  it('matches when a provider-channel auto_fallback event is in the ring', () => {
    const ring = [
      entry(1000, 'provider', { phase: 'phase3_chronicle', event: { kind: 'auto_fallback', reason: 'repeated_exhaustion' } }),
    ]
    const matches = runSignatures({ ring })
    expect(matches.find((m) => m.id === 'auto_fallback_mid_run')).toBeDefined()
  })

  it('does NOT match when no auto_fallback events are in the ring', () => {
    const ring = [
      entry(1000, 'pipeline', { type: 'phase_start', phase: 'phase1_ground', totalChunks: 5 }),
    ]
    expect(runSignatures({ ring }).find((m) => m.id === 'auto_fallback_mid_run')).toBeUndefined()
  })
})

describe('probed_model_inaccessible_but_selected', () => {
  it('matches when routing names a model the probe marked inaccessible', () => {
    const matches = runSignatures({
      ring: [],
      routing: {
        version: 3,
        geminiTier: 'free',
        perPhase: {
          phase3: { target: 'cloud', cloudProvider: 'gemini', geminiTier: 'free', modelId: 'gemini-2.5-pro' },
        },
      },
      probeCache: {
        geminiFallback: {
          probed: [{ id: 'gemini-2.5-pro', accessible: false, reason: 'Free tier quota: 0' }],
        },
      },
    })
    const match = matches.find((m) => m.id === 'probed_model_inaccessible_but_selected')
    expect(match).toBeDefined()
    expect(match?.severity).toBe('critical')
  })

  it('does NOT match when the probe marked the model accessible', () => {
    const matches = runSignatures({
      ring: [],
      routing: {
        perPhase: {
          phase3: { target: 'cloud', cloudProvider: 'gemini', geminiTier: 'free', modelId: 'gemini-2.5-flash' },
        },
      },
      probeCache: {
        geminiFallback: { probed: [{ id: 'gemini-2.5-flash', accessible: true }] },
      },
    })
    expect(matches.find((m) => m.id === 'probed_model_inaccessible_but_selected')).toBeUndefined()
  })

  it('does NOT match when no perPhase override exists', () => {
    const matches = runSignatures({
      ring: [],
      routing: { lastSelectedProvider: 'gemini', geminiTier: 'paid' },
      probeCache: { gemini: { probed: [{ id: 'gemini-2.5-pro', accessible: false }] } },
    })
    expect(matches.find((m) => m.id === 'probed_model_inaccessible_but_selected')).toBeUndefined()
  })
})

describe('empty_phase_output', () => {
  it('matches when phase3 completes but chronicle is too short', () => {
    const matches = runSignatures({
      ring: [
        entry(1000, 'pipeline', { type: 'phase_complete', phase: 'phase3_chronicle' }),
      ],
      state: { chronicle: 'short.' },
    })
    expect(matches.find((m) => m.id === 'empty_phase_output')).toBeDefined()
  })

  it('does NOT match when chronicle is substantial', () => {
    const matches = runSignatures({
      ring: [entry(1000, 'pipeline', { type: 'phase_complete', phase: 'phase3_chronicle' })],
      state: { chronicle: 'x'.repeat(500) },
    })
    expect(matches.find((m) => m.id === 'empty_phase_output')).toBeUndefined()
  })

  it('does NOT match when phase3 never completed', () => {
    const matches = runSignatures({
      ring: [entry(1000, 'pipeline', { type: 'phase_start', phase: 'phase3_chronicle', totalChunks: 5 })],
      state: { chronicle: 'short.' },
    })
    expect(matches.find((m) => m.id === 'empty_phase_output')).toBeUndefined()
  })
})

describe('stale_perPhase_override', () => {
  it('matches when a phase tier differs from the global tier', () => {
    const matches = runSignatures({
      ring: [],
      routing: {
        geminiTier: 'paid',
        perPhase: {
          phase3: { target: 'cloud', cloudProvider: 'gemini', geminiTier: 'free' },
        },
      },
    })
    expect(matches.find((m) => m.id === 'stale_perPhase_override')).toBeDefined()
  })

  it('does NOT match when global + perPhase tiers align', () => {
    const matches = runSignatures({
      ring: [],
      routing: {
        geminiTier: 'paid',
        perPhase: {
          phase3: { target: 'cloud', cloudProvider: 'gemini', geminiTier: 'paid' },
        },
      },
    })
    expect(matches.find((m) => m.id === 'stale_perPhase_override')).toBeUndefined()
  })

  it('ignores non-gemini perPhase entries', () => {
    const matches = runSignatures({
      ring: [],
      routing: {
        geminiTier: 'paid',
        perPhase: {
          phase3: { target: 'cloud', cloudProvider: 'claude' },
        },
      },
    })
    expect(matches.find((m) => m.id === 'stale_perPhase_override')).toBeUndefined()
  })
})

describe('provider_keys_mismatch_with_fingerprint', () => {
  it('matches when quota_exhausted fingerprint is absent from probe cache', () => {
    const ring = [
      entry(1000, 'pipeline', {
        type: 'quota_exhausted',
        provider: 'gemini',
        quotaKind: 'rate_limit',
        tier: 'paid',
        model: 'gemini-2.5-pro',
        keyFingerprint: 'zzz999',
      }),
    ]
    const matches = runSignatures({
      ring,
      probeCache: { gemini: { keyFingerprint: 'abc123' } },
    })
    const match = matches.find((m) => m.id === 'provider_keys_mismatch_with_fingerprint')
    expect(match).toBeDefined()
    expect(match?.severity).toBe('critical')
  })

  it('does NOT match when the fingerprint is present in probe cache', () => {
    const ring = [
      entry(1000, 'pipeline', {
        type: 'quota_exhausted',
        keyFingerprint: 'abc123',
      }),
    ]
    const matches = runSignatures({
      ring,
      probeCache: { gemini: { keyFingerprint: 'abc123' } },
    })
    expect(matches.find((m) => m.id === 'provider_keys_mismatch_with_fingerprint')).toBeUndefined()
  })

  it('does NOT match when no fingerprint is on the event', () => {
    const ring = [entry(1000, 'pipeline', { type: 'quota_exhausted' })]
    const matches = runSignatures({
      ring,
      probeCache: { gemini: { keyFingerprint: 'abc123' } },
    })
    expect(matches.find((m) => m.id === 'provider_keys_mismatch_with_fingerprint')).toBeUndefined()
  })
})

describe('hidden_500_retries', () => {
  it('matches when ≥ 3 retry_waiting events for one phase land within 60s', () => {
    const ring = [
      entry(1000, 'pipeline', { type: 'retry_waiting', phase: 'phase3_chronicle', attempt: 1, maxAttempts: 4, waitMs: 8000 }),
      entry(15000, 'pipeline', { type: 'retry_waiting', phase: 'phase3_chronicle', attempt: 2, maxAttempts: 4, waitMs: 8000 }),
      entry(40000, 'pipeline', { type: 'retry_waiting', phase: 'phase3_chronicle', attempt: 3, maxAttempts: 4, waitMs: 8000 }),
    ]
    const matches = runSignatures({ ring })
    expect(matches.find((m) => m.id === 'hidden_500_retries')).toBeDefined()
  })

  it('does NOT match when retries span >60s', () => {
    const ring = [
      entry(1000, 'pipeline', { type: 'retry_waiting', phase: 'phase3_chronicle', attempt: 1, maxAttempts: 4, waitMs: 8000 }),
      entry(70000, 'pipeline', { type: 'retry_waiting', phase: 'phase3_chronicle', attempt: 2, maxAttempts: 4, waitMs: 8000 }),
      entry(140000, 'pipeline', { type: 'retry_waiting', phase: 'phase3_chronicle', attempt: 3, maxAttempts: 4, waitMs: 8000 }),
    ]
    const matches = runSignatures({ ring })
    expect(matches.find((m) => m.id === 'hidden_500_retries')).toBeUndefined()
  })

  it('does NOT match for only 2 retries (need ≥3)', () => {
    const ring = [
      entry(1000, 'pipeline', { type: 'retry_waiting', phase: 'phase3_chronicle', attempt: 1, maxAttempts: 4, waitMs: 8000 }),
      entry(15000, 'pipeline', { type: 'retry_waiting', phase: 'phase3_chronicle', attempt: 2, maxAttempts: 4, waitMs: 8000 }),
    ]
    const matches = runSignatures({ ring })
    expect(matches.find((m) => m.id === 'hidden_500_retries')).toBeUndefined()
  })
})

describe('tier_escalated_silently', () => {
  it('matches when chunk_started after tier_escalated still reports old tier', () => {
    const ring = [
      entry(1000, 'pipeline', {
        type: 'tier_escalated',
        phase: 'phase3_chronicle',
        model: 'gemini-2.5-pro',
        fromTier: 'free',
        toTier: 'paid',
        reason: 'paid_only_model_on_free_tier',
      }),
      entry(2000, 'chunk', {
        event: 'chunk_started',
        phase: 'phase3_chronicle',
        index: 5,
        tier: 'free', // BAD: should be 'paid'
        model: 'gemini-2.5-pro',
        promptChars: 1000,
        estimatedTokens: 250,
      }),
    ]
    const matches = runSignatures({ ring })
    const match = matches.find((m) => m.id === 'tier_escalated_silently')
    expect(match).toBeDefined()
    expect(match?.severity).toBe('critical')
  })

  it('does NOT match when chunk_started honors the escalation', () => {
    const ring = [
      entry(1000, 'pipeline', {
        type: 'tier_escalated',
        phase: 'phase3_chronicle',
        toTier: 'paid',
      }),
      entry(2000, 'chunk', {
        event: 'chunk_started',
        phase: 'phase3_chronicle',
        tier: 'paid',
      }),
    ]
    const matches = runSignatures({ ring })
    expect(matches.find((m) => m.id === 'tier_escalated_silently')).toBeUndefined()
  })
})
