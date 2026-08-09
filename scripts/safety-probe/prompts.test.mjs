// Drift-guard test for the embedded phase2/phase4 prompt builders.
// If src/lib/prompts.ts changes phase2Audit or phase4Extras, this test
// fails — forcing the editor to update scripts/safety-probe/prompts.mjs
// in lockstep. Without this guard, the probe would silently test stale
// prompt text and give misleading data.

import { describe, expect, it } from 'vitest'
import {
  phase1Ground as embeddedPhase1,
  phase2Audit as embeddedPhase2,
  phase3Chronicle as embeddedPhase3,
  phase4Extras as embeddedPhase4,
} from './prompts.mjs'
import {
  phase1Ground as canonicalPhase1,
  phase2Audit as canonicalPhase2,
  phase3Chronicle as canonicalPhase3,
  phase4Extras as canonicalPhase4,
} from '../../src/lib/prompts.js'

describe('embedded prompts.mjs drift guard', () => {
  it('phase2Audit produces byte-identical output to src/lib/prompts.ts', () => {
    const args = {
      rawChunk: '[Speaker (Player)] hello world\n[DM] response',
      groundedChunk: '[Speaker (Player)] hello world\n[DM] response',
      index: 0,
      total: 1,
    }
    expect(embeddedPhase2(args)).toBe(canonicalPhase2(args))
  })

  it('phase2Audit matches across a range of index/total values', () => {
    for (const [idx, total] of [
      [0, 1],
      [5, 10],
      [27, 28], // user's failure case
      [99, 100],
    ]) {
      const args = {
        rawChunk: 'raw text body',
        groundedChunk: 'grounded text body',
        index: idx,
        total,
      }
      expect(embeddedPhase2(args)).toBe(canonicalPhase2(args))
    }
  })

  it('phase4Extras produces byte-identical output to src/lib/prompts.ts with empty dmAnswers', () => {
    const args = {
      groundedChunk: '[Cassian (Katarzyna)] 36 damage',
      dmAnswers: {},
      index: 0,
      total: 1,
    }
    expect(embeddedPhase4(args)).toBe(canonicalPhase4(args))
  })

  it('phase4Extras matches when dmAnswers has answers', () => {
    const args = {
      groundedChunk: '[Lakshmi (Olamide)] I cast Fireball',
      dmAnswers: { 'q-1-1': 'It crit for 8d6.' },
      index: 0,
      total: 1,
    }
    expect(embeddedPhase4(args)).toBe(canonicalPhase4(args))
  })

  it('phase4Extras matches across a range of index/total values', () => {
    for (const [idx, total] of [
      [0, 1],
      [3, 7],
      [11, 28],
    ]) {
      const args = {
        groundedChunk: 'chunk body text',
        dmAnswers: {},
        index: idx,
        total,
      }
      expect(embeddedPhase4(args)).toBe(canonicalPhase4(args))
    }
  })

  it('phase1Ground produces byte-identical output to src/lib/prompts.ts (no KB, no hints, not stripped)', () => {
    const args = {
      chunk: '[Cassian (Katarzyna)] 36 damage on the smite.',
      kbConcat: '',
      index: 0,
      total: 1,
    }
    expect(embeddedPhase1(args)).toBe(canonicalPhase1(args))
  })

  it('phase1Ground matches with a populated KB + hints', () => {
    const args = {
      chunk: '[Lakshmi (Olamide)] I cast Fireball.',
      kbConcat: '### Speakers\nBrugo, Lakshmi, Zainab.\n### Spells\nFireball, Healing Word.',
      index: 5,
      total: 10,
      contextualHintsBlock: '## Contextual hints\n- "Cassian" should always be capitalised.',
    }
    expect(embeddedPhase1(args)).toBe(canonicalPhase1(args))
  })

  it('phase1Ground matches with stripped=true (speaker-detach mode)', () => {
    const args = {
      chunk: '«1» content line\n«2» second line',
      kbConcat: '',
      index: 0,
      total: 1,
      stripped: true,
    }
    expect(embeddedPhase1(args)).toBe(canonicalPhase1(args))
  })

  it('phase3Chronicle matches with empty dmQuestions (no Q&A)', () => {
    const args = {
      groundedChunk: '[Cassian (Katarzyna)] I roll a 20.\n[DM] Critical hit.',
      dmAnswers: {},
      dmQuestions: [],
      index: 0,
      total: 1,
      priorTail: '',
    }
    expect(embeddedPhase3(args)).toBe(canonicalPhase3(args))
  })

  it('phase3Chronicle matches with populated Q&A + priorTail', () => {
    const args = {
      groundedChunk: '[Lakshmi (Olamide)] I dodge.',
      dmAnswers: { 'q-1-1': 'They were attacked by goblins.' },
      dmQuestions: [{ id: 'q-1-1', question: 'Who attacked them?' }],
      index: 3,
      total: 7,
      priorTail: 'The party emerged from the cave, bloodied but alive.',
    }
    expect(embeddedPhase3(args)).toBe(canonicalPhase3(args))
  })
})
