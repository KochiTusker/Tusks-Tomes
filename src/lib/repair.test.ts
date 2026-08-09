import { describe, expect, it } from 'vitest'
import {
  priorTailBeforeMarker,
  spliceProse,
  mergeQuestions,
  mergeExtras,
} from './repair'
import type { ExtrasOutput } from '@/types'

describe('priorTailBeforeMarker', () => {
  it('returns the last 2000 chars BEFORE the marker', () => {
    const before = 'A'.repeat(3000)
    const marker = '<<MARK>>'
    const after = 'B'.repeat(500)
    const tail = priorTailBeforeMarker(before + marker + after, marker)
    expect(tail.length).toBe(2000)
    expect(tail).toBe('A'.repeat(2000))
    expect(tail).not.toContain('B')
  })

  it('falls back to the chronicle tail when the marker is absent', () => {
    const doc = 'C'.repeat(2500)
    expect(priorTailBeforeMarker(doc, '<<missing>>')).toBe('C'.repeat(2000))
  })

  it('handles an empty marker gracefully (treats as absent)', () => {
    expect(priorTailBeforeMarker('hello world', '')).toBe('hello world')
  })
})

describe('spliceProse', () => {
  it('replaces the anchor with the replacement and reports found', () => {
    const doc = 'intro\n\n[MARKER]\n\noutro'
    const res = spliceProse(doc, '[MARKER]', 'restored passage')
    expect(res.found).toBe(true)
    expect(res.doc).toBe('intro\n\nrestored passage\n\noutro')
  })

  it('returns found=false and the original doc when the anchor is missing', () => {
    const res = spliceProse('no marker here', '[MARKER]', 'x')
    expect(res.found).toBe(false)
    expect(res.doc).toBe('no marker here')
  })

  it('returns found=false for an empty anchor (never splices blindly)', () => {
    const res = spliceProse('anything', '', 'x')
    expect(res.found).toBe(false)
  })
})

describe('mergeQuestions', () => {
  it('appends novel questions and dedupes by normalised text', () => {
    const existing = [{ id: 'a', question: 'Who is the BBEG?' }]
    const incoming = [
      { id: 'b', question: '  who is the bbeg?  ' }, // dup (case/space)
      { id: 'c', question: 'Where did the relic go?' }, // novel
    ]
    const merged = mergeQuestions(existing, incoming)
    expect(merged.map((q) => q.id)).toEqual(['a', 'c'])
  })
})

describe('mergeExtras', () => {
  const base: ExtrasOutput = {
    jests: ['old jest'],
    gore: ['old gore'],
    quotes: [{ speaker: 'Wiktoria', line: 'We march.', kind: 'funny' }],
  }

  it('appends novel entries and dedupes jests/gore (string) + quotes (speaker+line)', () => {
    const incoming: ExtrasOutput = {
      jests: ['old jest', 'new jest'],
      gore: ['new gore'],
      quotes: [
        { speaker: 'Wiktoria', line: 'We march.', kind: 'funny' }, // dup
        { speaker: 'Solveig', line: 'I roll to disbelieve.', kind: 'stupid' }, // novel
      ],
    }
    const merged = mergeExtras(base, incoming)
    expect(merged.jests).toEqual(['old jest', 'new jest'])
    expect(merged.gore).toEqual(['old gore', 'new gore'])
    expect(merged.quotes).toHaveLength(2)
    expect(merged.quotes[1].speaker).toBe('Solveig')
  })
})
