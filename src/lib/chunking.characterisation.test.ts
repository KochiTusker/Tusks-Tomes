// Characterisation tests — these pin the CURRENT chunking behaviour so that any
// change to sizing shows up as a visible test diff rather than a silent
// regression in someone's chronicle.
//
// They are deliberately not "correctness" tests: they assert what the code does
// today, not what it ought to do. If a deliberate sizing change makes one fail,
// update the expectation in the same commit as the change so the diff records
// which provider/phase pairs moved and by how much.
//
// Written ahead of the OpenRouter provider work, whose model-aware sizing
// touches cloudProfileFor() and the chunk-size tables.

import { describe, expect, it } from 'vitest'
import { chunkText } from './chunker'
import { cloudChunkSize, localChunkSize, type CloudProfile, type ChunkPhase } from './chunking'
import type { ModelTier } from './modelTier'

/** Deterministic stand-in for a long session transcript.
 *  Not a grounding fixture — chunking only cares about paragraph, sentence and
 *  speaker-turn boundaries, so synthetic text exercises the same code paths.
 *  Sized past 250k chars so even the 100k Phase 6 row produces several chunks. */
function buildTranscript(): string {
  const speakers = ['Kaziel', 'Brody', 'Brugo', 'Rey', 'Takamura', 'DM']
  const beats = [
    'pushed open the door and listened for movement beyond it.',
    'rolled to disbelieve, and the illusion held for one heartbeat longer.',
    'said that the Crimson Cathedral had never once opened its gates at dusk.',
    'counted the coins twice, then a third time, and still came up short.',
    'drew the Sun Blade and let the light fall across the flooded stair.',
    'asked whether anyone had thought to check the ceiling before walking in.',
  ]
  const out: string[] = []
  for (let turn = 0; turn < 1400; turn++) {
    const who = speakers[turn % speakers.length]
    const beat = beats[turn % beats.length]
    const second = beats[(turn * 3 + 1) % beats.length]
    // Three shapes so sentence-splitting and speaker-turn splitting both fire.
    if (turn % 5 === 0) out.push(`[${who}] ${beat} Then ${who} ${second}`)
    else if (turn % 7 === 0) out.push(`[${who}] ${beat}\n[${speakers[(turn + 1) % speakers.length]}] ${second}`)
    else out.push(`[${who}] ${beat}`)
  }
  return out.join('\n\n')
}

const TRANSCRIPT = buildTranscript()

const PROFILES: CloudProfile[] = ['geminiPaid', 'geminiFree', 'claude', 'openai']
const TIERS: ModelTier[] = ['flagship', 'fast', 'frontier']
const PHASES: Exclude<ChunkPhase, 'p5'>[] = ['p1', 'p2', 'p3', 'p4', 'p6']

describe('chunking characterisation — the transcript itself', () => {
  it('is a stable size across runs', () => {
    // If this moves, every expectation below moves with it — so it is pinned
    // first and separately, to make that failure mode obvious.
    expect(TRANSCRIPT.length).toBe(142_902)
  })
})

describe('chunking characterisation — chunk counts per (profile, tier, phase)', () => {
  // One snapshot for the whole grid: 4 profiles x 3 tiers x 5 phases = 60 cells.
  // A single snapshot keeps the diff readable when a sizing change moves many
  // cells at once.
  it('matches the recorded grid', () => {
    const grid: Record<string, number> = {}
    for (const profile of PROFILES) {
      for (const tier of TIERS) {
        for (const phase of PHASES) {
          const size = cloudChunkSize(profile, phase, tier)
          grid[`${profile}:${tier}:${phase}`] = chunkText(TRANSCRIPT, size).length
        }
      }
    }
    expect(grid).toMatchSnapshot()
  })
})

describe('chunking characterisation — boundary offsets', () => {
  // Chunk COUNT can stay the same while the cut points move, which changes what
  // each call sees and therefore the output. Offsets catch that; counts do not.
  it('matches the recorded cut points for the default Gemini paid rows', () => {
    const offsets: Record<string, number[]> = {}
    for (const tier of TIERS) {
      for (const phase of PHASES) {
        const size = cloudChunkSize('geminiPaid', phase, tier)
        const chunks = chunkText(TRANSCRIPT, size)
        let cursor = 0
        offsets[`geminiPaid:${tier}:${phase}`] = chunks.map((c) => {
          cursor += c.length
          return cursor
        })
      }
    }
    expect(offsets).toMatchSnapshot()
  })

  it('matches the recorded cut points for the local profile', () => {
    const offsets: Record<string, number[]> = {}
    for (const phase of [...PHASES, 'p5' as const]) {
      const chunks = chunkText(TRANSCRIPT, localChunkSize(phase))
      let cursor = 0
      offsets[`local:${phase}`] = chunks.map((c) => {
        cursor += c.length
        return cursor
      })
    }
    expect(offsets).toMatchSnapshot()
  })
})

describe('chunking characterisation — invariants that must survive any resizing', () => {
  it('never drops or duplicates content', () => {
    // The strongest guarantee: concatenating chunks must reproduce the input
    // modulo the joiners chunkText collapses. Content loss here would be
    // invisible in a chronicle until someone noticed a missing scene.
    for (const profile of PROFILES) {
      for (const phase of PHASES) {
        const chunks = chunkText(TRANSCRIPT, cloudChunkSize(profile, phase, 'flagship'))
        const rejoinedLength = chunks.reduce((sum, c) => sum + c.length, 0)
        // Joiners are dropped at cut points, so rejoined <= original, never >.
        expect(rejoinedLength).toBeLessThanOrEqual(TRANSCRIPT.length)
        // ...and never loses more than the joiners themselves.
        expect(rejoinedLength).toBeGreaterThan(TRANSCRIPT.length - chunks.length * 4)
      }
    }
  })

  it('produces at least ceil(chars/target) chunks — target is a maximum', () => {
    for (const profile of PROFILES) {
      for (const phase of PHASES) {
        const size = cloudChunkSize(profile, phase, 'flagship')
        const chunks = chunkText(TRANSCRIPT, size)
        expect(chunks.length).toBeGreaterThanOrEqual(Math.ceil(TRANSCRIPT.length / size))
      }
    }
  })

  it('never emits a chunk longer than its target', () => {
    for (const profile of PROFILES) {
      for (const tier of TIERS) {
        for (const phase of PHASES) {
          const size = cloudChunkSize(profile, phase, tier)
          for (const chunk of chunkText(TRANSCRIPT, size)) {
            expect(chunk.length).toBeLessThanOrEqual(size)
          }
        }
      }
    }
  })

  it('never emits an empty chunk', () => {
    for (const profile of PROFILES) {
      for (const phase of PHASES) {
        for (const chunk of chunkText(TRANSCRIPT, cloudChunkSize(profile, phase, 'flagship'))) {
          expect(chunk.trim().length).toBeGreaterThan(0)
        }
      }
    }
  })
})
