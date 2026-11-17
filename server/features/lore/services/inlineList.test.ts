import { describe, it, expect } from 'vitest'
import { parseInlineList, stripQuotes } from './inlineList.js'

describe('parseInlineList', () => {
  it('splits, trims and respects double-quoted commas', () => {
    expect(parseInlineList('[a, b , "c, d"]')).toEqual(['a', 'b', 'c, d'])
  })
  it('returns [] for missing, bracketless or empty lists', () => {
    for (const raw of ['', 'a, b', '[]', '[  ]']) expect(parseInlineList(raw)).toEqual([])
  })
  it('strips single quotes and drops blank items', () => {
    expect(parseInlineList("['x', , y,]")).toEqual(['x', 'y'])
  })
  it('keeps an empty single-quoted item unless skipEmptyUnquoted is set', () => {
    expect(parseInlineList("[a, '']")).toEqual(['a', ''])
    expect(parseInlineList("[a, '']", { skipEmptyUnquoted: true })).toEqual(['a'])
    expect(parseInlineList("[a, '', b]")).toEqual(['a', '', 'b'])
    expect(parseInlineList("[a, '', b]", { skipEmptyUnquoted: true })).toEqual(['a', 'b'])
  })
})

describe('stripQuotes', () => {
  it('removes one matching pair only', () => {
    expect(stripQuotes('"a"')).toBe('a')
    expect(stripQuotes("'a'")).toBe('a')
    expect(stripQuotes('"a\'')).toBe('"a\'')
    expect(stripQuotes('"')).toBe('"')
  })
})
