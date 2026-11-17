import { describe, expect, it } from 'vitest'
import {
  phase1Ground,
  phase1GroundParts,
  phase2Audit,
  phase3Chronicle,
  phase3ChronicleParts,
  phase4Extras,
  phase6CondenseLocal,
  phase6CondenseParts,
} from './prompts'
import type { DMAnswers, DMQuestion } from '@/features/pipeline/lib/types'

const KB_CONCAT = '### Pantheon\nThe Three: Aerus, Mor, Velka.'
const QUESTIONS: DMQuestion[] = [
  { id: 'q-1-1', question: 'Was Velka named?', context: '...velka...' },
]
const ANSWERS: DMAnswers = { 'q-1-1': 'Yes, Velka.' }

describe('phase3ChronicleParts', () => {
  it('prefix contains no chunk-varying tokens (chunk text, prior tail, chunk index marker)', () => {
    const parts = phase3ChronicleParts({
      kbConcat: '',
      groundedChunk: 'UNIQUE_CHUNK_BODY_TOKEN_42',
      dmAnswers: ANSWERS,
      dmQuestions: QUESTIONS,
      index: 4,
      total: 9,
      priorTail: 'UNIQUE_PRIOR_TAIL_TOKEN_99',
    })
    expect(parts.cacheablePrefix).not.toContain('UNIQUE_CHUNK_BODY_TOKEN_42')
    expect(parts.cacheablePrefix).not.toContain('UNIQUE_PRIOR_TAIL_TOKEN_99')
    expect(parts.cacheablePrefix).not.toContain('CHUNK 5/9')
    expect(parts.userPrompt).toContain('UNIQUE_CHUNK_BODY_TOKEN_42')
    expect(parts.userPrompt).toContain('UNIQUE_PRIOR_TAIL_TOKEN_99')
    expect(parts.userPrompt).toContain('CHUNK 5/9')
  })

  it('prefix is byte-identical across chunks with different bodies but same DM Q&A', () => {
    const make = (chunk: string, index: number, priorTail: string) =>
      phase3ChronicleParts({
        kbConcat: '',
        groundedChunk: chunk,
        dmAnswers: ANSWERS,
        dmQuestions: QUESTIONS,
        index,
        total: 5,
        priorTail,
      })
    const a = make('chunk one body', 0, '(this is the first chunk)')
    const b = make('chunk two body — completely different', 1, 'tail from chunk one')
    const c = make('chunk five body', 4, 'tail from chunk four')
    expect(a.cacheablePrefix).toBe(b.cacheablePrefix)
    expect(b.cacheablePrefix).toBe(c.cacheablePrefix)
  })

  it('persona branch returns empty cacheablePrefix', () => {
    const parts = phase3ChronicleParts({
      kbConcat: '',
      groundedChunk: 'chunk',
      dmAnswers: ANSWERS,
      dmQuestions: QUESTIONS,
      index: 0,
      total: 1,
      priorTail: '',
      personaTemplate: 'Write in the voice of {chunkIndex}/{chunkTotal}: {groundedChunk}',
    })
    expect(parts.cacheablePrefix).toBe('')
    expect(parts.userPrompt).toContain('1/1')
    expect(parts.userPrompt).toContain('chunk')
  })

  it('legacy phase3Chronicle output preserves all the canonical section headers', () => {
    const legacy = phase3Chronicle({
      kbConcat: '',
      groundedChunk: 'body',
      dmAnswers: ANSWERS,
      dmQuestions: QUESTIONS,
      index: 0,
      total: 1,
      priorTail: '',
    })
    // Set-comparison: every stable section header from the pre-split prompt
    // must still be present in the combined output.
    for (const header of [
      '# DM CLARIFICATIONS',
      '# PRIOR CHRONICLE TAIL',
      '# TRANSCRIPT CHUNK',
      '# SPEAKER ATTRIBUTION',
      '# RULES',
      '# OUTPUT',
    ]) {
      expect(legacy).toContain(header)
    }
  })

  it('legacy phase3Chronicle is the prefix + body joined with \\n\\n', () => {
    const args = {
      groundedChunk: 'body',
      dmAnswers: ANSWERS,
      dmQuestions: QUESTIONS,
      kbConcat: '',
      index: 0,
      total: 1,
      priorTail: '',
    }
    const parts = phase3ChronicleParts(args)
    const combined = `${parts.cacheablePrefix}\n\n${parts.userPrompt}`
    expect(phase3Chronicle(args)).toBe(combined)
  })
})

describe('phase6CondenseParts', () => {
  it('prefix contains no chunk-varying tokens (chronicle text)', () => {
    const parts = phase6CondenseParts({
      chronicle: 'UNIQUE_CHRONICLE_TOKEN_77',
      campaign: 'Acme Bards',
      sessionNumber: 4,
      kbConcat: KB_CONCAT,
      dmAnswers: ANSWERS,
    })
    expect(parts.cacheablePrefix).not.toContain('UNIQUE_CHRONICLE_TOKEN_77')
    expect(parts.userPrompt).toContain('UNIQUE_CHRONICLE_TOKEN_77')
  })

  it('prefix is byte-identical across chronicle chunks with same KB + DM Q&A', () => {
    const make = (chronicle: string) =>
      phase6CondenseParts({
        chronicle,
        campaign: 'Acme Bards',
        sessionNumber: 4,
        kbConcat: KB_CONCAT,
        dmAnswers: ANSWERS,
      })
    expect(make('chunk A').cacheablePrefix).toBe(make('chunk B totally different').cacheablePrefix)
  })

  it('persona branch returns empty cacheablePrefix', () => {
    const parts = phase6CondenseParts({
      chronicle: 'chunk',
      campaign: 'Acme Bards',
      sessionNumber: 4,
      kbConcat: KB_CONCAT,
      dmAnswers: ANSWERS,
      personaTemplate: '{campaign} {sessionNumber} {chronicle}',
    })
    expect(parts.cacheablePrefix).toBe('')
    expect(parts.userPrompt).toContain('Acme Bards')
    expect(parts.userPrompt).toContain('chunk')
  })

  // v1.1.0 Condense Slider — Phase 6 prompt is now parameterised on the
  // user's chosen target word count. When the caller supplies one, it
  // must appear in the prefix's "narrative" instruction; when omitted,
  // the legacy `min(2000, 25%)` formula is preserved for backward-compat.
  it('targetWordCount injects the explicit slider target into the narrative section of the prefix', () => {
    const parts = phase6CondenseParts({
      chronicle: 'c',
      campaign: 'Acme',
      sessionNumber: 4,
      kbConcat: KB_CONCAT,
      dmAnswers: ANSWERS,
      targetWordCount: 1750,
    })
    expect(parts.cacheablePrefix).toContain('1750 words')
    expect(parts.cacheablePrefix).toContain('Condense Slider')
    // The legacy formula must NOT appear when a target was supplied.
    expect(parts.cacheablePrefix).not.toMatch(/SHORTER of \(a\) 2,000 words/)
  })

  it('omitted targetWordCount preserves the legacy min(2000, 25%) formula in the prefix', () => {
    const parts = phase6CondenseParts({
      chronicle: 'c',
      campaign: 'Acme',
      sessionNumber: 4,
      kbConcat: KB_CONCAT,
      dmAnswers: ANSWERS,
    })
    expect(parts.cacheablePrefix).toMatch(/SHORTER of \(a\) 2,000 words/)
  })

  // The per-chunk target must ride in the per-chunk user prompt — NOT the
  // cacheable prefix — so the prefix stays byte-identical across every chunk
  // of a run and keeps its provider-native cache hit. The whole-run target
  // stays in the prefix.
  it('chunkTargetWordCount lands in the user prompt and leaves the prefix stable on the whole target', () => {
    const parts = phase6CondenseParts({
      chronicle: 'c',
      campaign: 'Acme',
      sessionNumber: 4,
      kbConcat: KB_CONCAT,
      dmAnswers: ANSWERS,
      targetWordCount: 2000,
      chunkTargetWordCount: 700,
    })
    // Per-portion target is in the user prompt, not the prefix.
    expect(parts.userPrompt).toContain('TARGET FOR THIS PORTION')
    expect(parts.userPrompt).toContain('700 words')
    expect(parts.cacheablePrefix).not.toContain('700 words')
    // Whole target still in the prefix (cache key per slider position).
    expect(parts.cacheablePrefix).toContain('2000 words')
  })

  it('omitted chunkTargetWordCount defaults the per-portion target to the whole target', () => {
    const parts = phase6CondenseParts({
      chronicle: 'c',
      campaign: 'Acme',
      sessionNumber: 4,
      kbConcat: KB_CONCAT,
      dmAnswers: ANSWERS,
      targetWordCount: 1200,
    })
    expect(parts.userPrompt).toContain('1200 words')
  })
})

describe('phase1Ground still works after Phase 3/6 split', () => {
  it('combined form equals prefix + body joined with \\n\\n', () => {
    const args = { chunk: 'c', kbConcat: KB_CONCAT, index: 0, total: 1 }
    const parts = phase1GroundParts(args)
    expect(phase1Ground(args)).toBe(`${parts.cacheablePrefix}\n\n${parts.userPrompt}`)
  })
})

describe('phase3 player action-vs-dialogue rule', () => {
  it('teaches narrating action declarations vs quoting in-character dialogue', () => {
    const prefix = phase3ChronicleParts({
      kbConcat: '',
      groundedChunk: 'b',
      dmAnswers: ANSWERS,
      dmQuestions: QUESTIONS,
      index: 0,
      total: 1,
      priorTail: '',
    }).cacheablePrefix
    expect(prefix).toContain('PLAYER SPEECH HANDLING')
    expect(prefix).toMatch(/action declaration/i)
    expect(prefix).toMatch(/in-character dialogue/i)
    // The anti-pattern (rendering action as dialogue) is explicitly forbidden.
    expect(prefix).toMatch(/NEVER (render|write) it as dialogue/i)
  })
})

describe('phase4Extras tuning', () => {
  const base = { groundedChunk: 'b', dmAnswers: ANSWERS, kbConcat: '', index: 0, total: 1 }

  it('biases toward quality + including dark/edgy/explicit lines', () => {
    const p = phase4Extras(base)
    expect(p).toMatch(/QUALITY OVER QUANTITY/i)
    expect(p).toMatch(/dark/i)
    expect(p).toMatch(/edgy/i)
    expect(p).toMatch(/explicit/i)
    // Still preserves the existing no-sanitise contract.
    expect(p).toMatch(/Do NOT sanitise/i)
  })

  it('transcript source (default) frames the input as a grounded transcript', () => {
    const p = phase4Extras(base)
    expect(p).toContain('TRANSCRIPT CHUNK')
    expect(p).not.toContain('NARRATIVE CHRONICLE PROSE')
  })

  it('chronicle source frames the input as narrative prose', () => {
    const p = phase4Extras({ ...base, sourceKind: 'chronicle' })
    expect(p).toContain('NARRATIVE CHRONICLE PROSE')
    expect(p).toMatch(/attributed quoted speech/i)
  })
})

describe('phase4Extras — reassembleQuotes toggle', () => {
  const base = { groundedChunk: 'b', dmAnswers: ANSWERS, kbConcat: '', index: 0, total: 1 }

  it('defaults to the strict-verbatim turn rule', () => {
    const p = phase4Extras(base)
    expect(p).toContain('Every turn is VERBATIM and in source order')
    expect(p).not.toMatch(/MACHINE-TRANSCRIBED IN SHORT FRAGMENTS/)
  })

  it('reassemble=false is byte-identical to omitting the flag', () => {
    expect(phase4Extras({ ...base, reassemble: false })).toBe(phase4Extras(base))
  })

  it('reassemble=true swaps in the fragment-reassembly rule', () => {
    const p = phase4Extras({ ...base, reassemble: true })
    expect(p).toMatch(/MACHINE-TRANSCRIBED IN SHORT FRAGMENTS/)
    expect(p).toMatch(/may NOT add, drop, or alter any word/i)
    expect(p).toMatch(/Never quote a fragment that is grammatically incomplete/i)
    // The strict rule must be gone, not merely supplemented — the two
    // instructions contradict each other.
    expect(p).not.toContain('Every turn is VERBATIM and in source order')
  })

  it('ignores reassemble on chronicle sources (finished prose has real sentences)', () => {
    const withFlag = phase4Extras({ ...base, sourceKind: 'chronicle', reassemble: true })
    const without = phase4Extras({ ...base, sourceKind: 'chronicle' })
    expect(withFlag).toBe(without)
    expect(withFlag).toContain('Every turn is VERBATIM and in source order')
  })
})

// Every phase that reasons about who a character IS must be able to see the
// lore. Phase 1 always could; phases 2, 3 and 4 could not, which is how a
// character established as female in the Tome could be narrated as "he" —
// grounding is a near-1:1 transform and deliberately does not rewrite speech,
// so the prose phase was the only pass that could fix it, and it was the one
// pass with no lore to fix it from. kbCompact's kbForPhase had branches for
// all of these long before anything called them, so a type signature is the
// wrong guard here: assert the text actually arrives.
describe('lore reaches every phase that needs it', () => {
  const MARKER = 'ZZTOP_UNIQUE_LORE_MARKER'

  it('phase2Audit carries the Knowledge Base it is told to weigh candidates against', () => {
    const p = phase2Audit({
      rawChunk: 'raw',
      groundedChunk: 'grounded',
      kbConcat: MARKER,
      index: 0,
      total: 1,
    })
    expect(p).toContain('# KNOWLEDGE BASE')
    expect(p).toContain(MARKER)
  })

  it('phase3Chronicle carries it, in the cacheable prefix', () => {
    const parts = phase3ChronicleParts({
      groundedChunk: 'body',
      dmAnswers: ANSWERS,
      dmQuestions: QUESTIONS,
      kbConcat: MARKER,
      index: 0,
      total: 3,
      priorTail: '',
    })
    expect(parts.cacheablePrefix).toContain(MARKER)
    expect(parts.userPrompt).not.toContain(MARKER)
  })

  it('phase3 instructs the narrator to follow the KB over the transcript on pronouns', () => {
    const parts = phase3ChronicleParts({
      groundedChunk: 'body',
      dmAnswers: ANSWERS,
      dmQuestions: QUESTIONS,
      kbConcat: KB_CONCAT,
      index: 0,
      total: 1,
      priorTail: '',
    })
    expect(parts.cacheablePrefix).toMatch(/gender and pronouns/i)
    // ...but never at the cost of rewriting what someone actually said.
    expect(parts.cacheablePrefix).toMatch(/Quoted in-character dialogue\s+stays verbatim/i)
  })

  it('a persona still gets the lore, even though it forgoes the cacheable prefix', () => {
    const parts = phase3ChronicleParts({
      groundedChunk: 'body',
      dmAnswers: ANSWERS,
      dmQuestions: QUESTIONS,
      kbConcat: MARKER,
      index: 0,
      total: 1,
      priorTail: '',
      personaTemplate: 'Narrate {{chunk}} in the voice of a bored god.',
    })
    expect(parts.cacheablePrefix).toBe('')
    expect(parts.userPrompt).toContain(MARKER)
  })

  it('phase4Extras carries it, so attributions use canonical names', () => {
    const p = phase4Extras({
      groundedChunk: 'body',
      dmAnswers: ANSWERS,
      kbConcat: MARKER,
      index: 0,
      total: 1,
    })
    expect(p).toContain('# KNOWLEDGE BASE')
    expect(p).toContain(MARKER)
  })

  it('adding lore does not break phase 3 prefix caching (prefix stays chunk-invariant)', () => {
    const make = (chunk: string, index: number, priorTail: string) =>
      phase3ChronicleParts({
        groundedChunk: chunk,
        dmAnswers: ANSWERS,
        dmQuestions: QUESTIONS,
        kbConcat: KB_CONCAT,
        index,
        total: 5,
        priorTail,
      }).cacheablePrefix
    expect(make('one', 0, '')).toBe(make('two — different', 1, 'a tail'))
    expect(make('two — different', 1, 'a tail')).toBe(make('five', 4, 'another tail'))
  })

  it('an empty Knowledge Base degrades to the same placeholder Phase 1 uses', () => {
    const p = phase4Extras({
      groundedChunk: 'body',
      dmAnswers: {},
      kbConcat: '',
      index: 0,
      total: 1,
    })
    expect(p).toContain('(no Knowledge Base provided)')
  })
})

// A chronicle written as an unattributed volley of quoted lines is still
// "dialogue" by any word count, but it reads as a script with the speaker
// tags deleted — and Phase 6 cannot recover a voice from it. These lock the
// two prompt-side causes: nothing asked for attribution, and the prior tail
// was inherited as a style rather than as a position in the story.
describe('phase 3 asks for dialogue that sits inside prose', () => {
  const prefix = () =>
    phase3ChronicleParts({
      groundedChunk: 'body',
      dmAnswers: ANSWERS,
      dmQuestions: QUESTIONS,
      kbConcat: KB_CONCAT,
      index: 1,
      total: 5,
      priorTail: 'a tail',
    }).cacheablePrefix

  it('bounds how long an exchange may run unattributed', () => {
    expect(prefix()).toContain('two consecutive unattributed lines')
  })

  it('does not overcorrect into tagging every line', () => {
    expect(prefix()).toContain('Not every line needs')
  })

  it('treats the prior tail as a position in the story, not a house style', () => {
    expect(prefix()).toContain('not how to write it')
  })

  it('refuses to hand the next chunk a tail that ends mid-volley', () => {
    expect(prefix()).toContain('End this passage on narration')
  })
})

// Phase 6 defaulted to reported speech ("he demanded it back") because the
// prompt told it to reference a moment rather than transcribe it, and pointed
// every funny beat at the Jests list. Both surfaces condense, so both are
// checked: OpenRouter and the subscription CLIs take the cloud prompt, local
// runners take the terse one.
describe('phase 6 keeps the session funny and in-voice', () => {
  const cloud = () =>
    phase6CondenseParts({
      chronicle: 'c',
      campaign: 'Acme',
      sessionNumber: 1,
      kbConcat: KB_CONCAT,
      dmAnswers: ANSWERS,
    }).cacheablePrefix
  const local = () =>
    phase6CondenseLocal({
      chronicle: 'c',
      campaign: 'Acme',
      sessionNumber: 1,
      kbConcat: KB_CONCAT,
      dmAnswers: ANSWERS,
    })

  it('no longer sends comedy away to the Jests list', () => {
    expect(cloud()).not.toContain('transcribe the joke itself')
    expect(cloud()).toContain('Comedy is content')
  })

  it('no longer supplies a worked example of reported speech', () => {
    expect(cloud()).not.toContain('would later be quoted endlessly')
    expect(cloud()).toContain('Quote rather than report')
  })

  it('cuts a gag only once it is genuinely repetition', () => {
    expect(cloud()).not.toContain('repeated jokes')
    expect(cloud()).toContain('running gag past its second outing')
  })

  it('bounds the quoting so a recap does not become a transcript', () => {
    expect(cloud()).toContain('wall-to-wall dialogue is not')
  })

  it('asks the local prompt for the same thing, in its own register', () => {
    expect(local()).not.toContain('repeated jokes')
    expect(local()).toContain('funny beats')
  })
})
