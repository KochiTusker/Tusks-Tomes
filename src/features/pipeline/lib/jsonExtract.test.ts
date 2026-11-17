import { describe, expect, it } from 'vitest'
import { stripCodeFences, extractFirstJsonBlock, repairJson, tryParseJson } from './jsonExtract'

describe('stripCodeFences', () => {
  it('strips a ```json fence', () => {
    expect(stripCodeFences('```json\n[1,2]\n```')).toBe('[1,2]')
  })
  it('strips a bare ``` fence and trims', () => {
    expect(stripCodeFences('```\n{"a":1}\n```')).toBe('{"a":1}')
  })
  it('leaves unfenced text alone', () => {
    expect(stripCodeFences('  [1] ')).toBe('[1]')
  })
})

describe('extractFirstJsonBlock', () => {
  it('extracts the first balanced array, ignoring surrounding prose', () => {
    expect(extractFirstJsonBlock('here you go: [1, 2, 3] cheers', '[')).toBe('[1, 2, 3]')
  })
  it('respects braces inside string literals', () => {
    expect(extractFirstJsonBlock('{"q":"a ] } trap"}', '{')).toBe('{"q":"a ] } trap"}')
  })
  it('returns null when there is no complete block', () => {
    expect(extractFirstJsonBlock('[1, 2, 3', '[')).toBeNull()
    expect(extractFirstJsonBlock('no json', '{')).toBeNull()
  })
})

describe('tryParseJson', () => {
  it('parses fenced JSON arrays', () => {
    expect(tryParseJson<number[]>('```json\n[1,2,3]\n```', '[')).toEqual([1, 2, 3])
  })
  it('parses JSON embedded in prose by extracting the first block', () => {
    expect(tryParseJson<{ a: number }>('sure: {"a":1} done', '{')).toEqual({ a: 1 })
  })
  it('returns null on unparseable input', () => {
    expect(tryParseJson('not json at all', '[')).toBeNull()
  })
  it('parses a string that carries a literal line break between paragraphs', () => {
    const raw = '{"narrative": "First paragraph.\n\nSecond paragraph.", "bulletPoints": ["a"]}'
    expect(tryParseJson<{ narrative: string }>(raw, '{')?.narrative).toBe('First paragraph.\n\nSecond paragraph.')
  })
  it('parses an array with a trailing comma', () => {
    expect(tryParseJson<{ b: string[] }>('{"b": ["x", "y",\n]\n}', '{')).toEqual({ b: ['x', 'y'] })
  })
})

describe('repairJson', () => {
  it('escapes control characters only inside strings', () => {
    expect(repairJson('{\n"a": "x\ty"\n}')).toBe('{\n"a": "x\\ty"\n}')
  })
  it('keeps commas inside strings and between values', () => {
    expect(repairJson('["a, ]", "b"]')).toBe('["a, ]", "b"]')
  })
  it('leaves escaped quotes alone', () => {
    expect(repairJson('{"a": "say \\"hi\\",\n"}')).toBe('{"a": "say \\"hi\\",\\n"}')
  })
})
