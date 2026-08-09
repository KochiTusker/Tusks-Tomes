import { describe, expect, it } from 'vitest'
import {
  appendNovelQuotes,
  exchangeSpeakers,
  flattenExchange,
  MAX_EXCHANGE_TURNS,
  normalizeQuote,
  normalizeQuoteKind,
  normalizeQuotes,
  quoteKeys,
  quoteToPlainText,
} from './quotes'
import type { Quote } from '@/types'

// The case the exchange shape exists for: a three-hander where no single line
// is funny alone — a plain question, a flat denial, a deadpan interjection —
// but the volley is. Judged line-by-line, extraction drops all of it.
//
// Invented dialogue on the synthetic cast. Never paste real session lines
// into a fixture: they are private player dialogue and this tree ships
// publicly.
const MULE_EXCHANGE = {
  kind: 'funny',
  exchange: [
    { speaker: 'Anwen', line: 'Did you feed the mule this morning?' },
    { speaker: 'Niamh', line: 'I always feed the mule.' },
    { speaker: 'Anwen', line: 'Then why is it eating my cloak?' },
    { speaker: 'Niamh', line: "It's a very hungry mule. That is not on me." },
    { speaker: 'Ngozi', line: "You can't even see the mule from here." },
    { speaker: 'Niamh', line: 'Have you heard of a window, Ngozi?' },
  ],
}

describe('normalizeQuoteKind', () => {
  it('passes through the three valid kinds', () => {
    expect(normalizeQuoteKind('funny')).toBe('funny')
    expect(normalizeQuoteKind('stupid')).toBe('stupid')
    expect(normalizeQuoteKind('dark')).toBe('dark')
  })

  it('falls back to funny for missing or unknown kinds', () => {
    expect(normalizeQuoteKind(undefined)).toBe('funny')
    expect(normalizeQuoteKind('hilarious')).toBe('funny')
    expect(normalizeQuoteKind(7)).toBe('funny')
  })
})

describe('normalizeQuote — single line', () => {
  it('keeps the flat shape and trims', () => {
    expect(normalizeQuote({ speaker: '  Ngozi ', line: " that's a rock ", kind: 'stupid' })).toEqual({
      speaker: 'Ngozi',
      line: "that's a rock",
      kind: 'stupid',
    })
  })

  it('drops entries missing a speaker or a line', () => {
    expect(normalizeQuote({ speaker: 'Ngozi' })).toBeNull()
    expect(normalizeQuote({ line: 'orphaned' })).toBeNull()
    expect(normalizeQuote({ speaker: '  ', line: '  ' })).toBeNull()
    expect(normalizeQuote('not an object')).toBeNull()
    expect(normalizeQuote(null)).toBeNull()
  })

  it('carries an optional context sentence', () => {
    expect(normalizeQuote({ speaker: 'Niamh', line: 'Much obliged.', context: ' He had just been healed. ' }))
      .toEqual({ speaker: 'Niamh', line: 'Much obliged.', kind: 'funny', context: 'He had just been healed.' })
  })

  it('omits context entirely when blank', () => {
    expect(normalizeQuote({ speaker: 'Ngozi', line: 'no', context: '   ' })).not.toHaveProperty('context')
  })
})

describe('normalizeQuote — exchange', () => {
  it('keeps turns in order and derives the participant list + flat fallback', () => {
    const q = normalizeQuote(MULE_EXCHANGE)!
    expect(q.exchange).toHaveLength(6)
    expect(q.exchange!.map((t) => t.speaker)).toEqual([
      'Anwen', 'Niamh', 'Anwen', 'Niamh', 'Ngozi', 'Niamh',
    ])
    // Participants are unique, in order of first appearance.
    expect(q.speaker).toBe('Anwen, Niamh & Ngozi')
    // The flat `line` still reads as the whole exchange for any consumer
    // that only understands the pre-exchange shape.
    expect(q.line).toContain('Anwen: "Did you feed the mule this morning?"')
    expect(q.line).toContain('Niamh: "Have you heard of a window, Ngozi?"')
    expect(q.kind).toBe('funny')
  })

  it('drops malformed turns but keeps the rest', () => {
    const q = normalizeQuote({
      kind: 'dark',
      exchange: [
        { speaker: 'Anwen', line: 'We march.' },
        { speaker: 'Niamh' },
        'garbage',
        { line: 'no speaker' },
        { speaker: 'Ngozi', line: 'Fine.' },
      ],
    })!
    expect(q.exchange).toEqual([
      { speaker: 'Anwen', line: 'We march.' },
      { speaker: 'Ngozi', line: 'Fine.' },
    ])
    expect(q.kind).toBe('dark')
  })

  it('folds a one-turn exchange back to the flat shape', () => {
    const q = normalizeQuote({ kind: 'stupid', exchange: [{ speaker: 'Niamh', line: 'Solo.' }] })
    expect(q).toEqual({ speaker: 'Niamh', line: 'Solo.', kind: 'stupid' })
    expect(q).not.toHaveProperty('exchange')
  })

  it('caps a runaway exchange at MAX_EXCHANGE_TURNS', () => {
    const turns = Array.from({ length: 40 }, (_, i) => ({ speaker: `S${i}`, line: `line ${i}` }))
    expect(normalizeQuote({ exchange: turns })!.exchange).toHaveLength(MAX_EXCHANGE_TURNS)
  })

  it('ignores a stray speaker/line pair when a valid exchange is present', () => {
    const q = normalizeQuote({ speaker: 'Whoever', line: 'stray', ...MULE_EXCHANGE })!
    expect(q.speaker).toBe('Anwen, Niamh & Ngozi')
    expect(q.line).not.toBe('stray')
  })
})

describe('normalizeQuotes', () => {
  it('filters unusable entries out of a mixed array', () => {
    expect(normalizeQuotes([
      { speaker: 'Ngozi', line: 'ok' },
      null,
      { speaker: 'X' },
      MULE_EXCHANGE,
    ])).toHaveLength(2)
  })

  it('returns [] for a non-array', () => {
    expect(normalizeQuotes(undefined)).toEqual([])
    expect(normalizeQuotes('{}')).toEqual([])
  })
})

describe('exchangeSpeakers / flattenExchange', () => {
  it('formats one, two, and three participants', () => {
    expect(exchangeSpeakers([{ speaker: 'A', line: 'x' }])).toBe('A')
    expect(exchangeSpeakers([{ speaker: 'A', line: 'x' }, { speaker: 'B', line: 'y' }])).toBe('A & B')
    expect(exchangeSpeakers([
      { speaker: 'A', line: 'x' }, { speaker: 'B', line: 'y' }, { speaker: 'C', line: 'z' },
    ])).toBe('A, B & C')
  })

  it('flattens turns to speaker-quoted text', () => {
    expect(flattenExchange([{ speaker: 'A', line: 'x' }, { speaker: 'B', line: 'y' }]))
      .toBe('A: "x" / B: "y"')
  })
})

describe('appendNovelQuotes', () => {
  const single: Quote = { speaker: 'Ngozi', line: "that's a rock", kind: 'stupid' }

  it('appends novel entries', () => {
    const out = appendNovelQuotes([single], [{ speaker: 'Niamh', line: 'The mule agrees.', kind: 'funny' }])
    expect(out).toHaveLength(2)
  })

  it('drops an exact repeat (chunk-fusion re-emit)', () => {
    expect(appendNovelQuotes([single], [{ ...single }])).toHaveLength(1)
  })

  it('drops a standalone line that already sits inside an accumulated exchange', () => {
    const exchange = normalizeQuote(MULE_EXCHANGE)!
    const dupOfATurn: Quote = { speaker: 'Ngozi', line: "You can't even see the mule from here.", kind: 'funny' }
    expect(appendNovelQuotes([exchange], [dupOfATurn])).toHaveLength(1)
  })

  it('drops an exchange that repeats a line already captured standalone', () => {
    const alreadyHave: Quote = { speaker: 'Niamh', line: 'I always feed the mule.', kind: 'funny' }
    const exchange = normalizeQuote(MULE_EXCHANGE)!
    expect(appendNovelQuotes([alreadyHave], [exchange])).toHaveLength(1)
  })

  it('does not mutate the existing array', () => {
    const existing = [single]
    appendNovelQuotes(existing, [{ speaker: 'New', line: 'line', kind: 'funny' }])
    expect(existing).toHaveLength(1)
  })
})

describe('quoteKeys', () => {
  it('claims one key per turn plus the entry key', () => {
    expect(quoteKeys(normalizeQuote(MULE_EXCHANGE)!)).toHaveLength(7)
    expect(quoteKeys({ speaker: 'Ngozi', line: 'x' })).toEqual(['Ngozi::x'])
  })
})

describe('quoteToPlainText', () => {
  it('quotes a single line', () => {
    expect(quoteToPlainText({ speaker: 'Ngozi', line: 'a rock' })).toBe('Ngozi: "a rock"')
  })

  it('renders an exchange without nesting quotes inside quotes', () => {
    const text = quoteToPlainText(normalizeQuote(MULE_EXCHANGE)!)
    expect(text.startsWith('Anwen: "Did you feed the mule')).toBe(true)
    expect(text).not.toContain('""')
  })

  it('prefixes context when present', () => {
    expect(quoteToPlainText({ speaker: 'Niamh', line: 'Thanks.', context: 'He was just healed.' }))
      .toBe('(He was just healed.) Niamh: "Thanks."')
  })
})
