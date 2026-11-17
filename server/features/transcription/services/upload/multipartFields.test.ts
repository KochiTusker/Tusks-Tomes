import { describe, it, expect } from 'vitest'
import { parseDisplayNameOverrides, parseFileOrder } from './multipartFields.js'

describe('parseDisplayNameOverrides', () => {
  it('accepts a JSON object', () => {
    expect(parseDisplayNameOverrides({ displayNameOverrides: '{"a.wav":"Zuri"}' })).toEqual({ 'a.wav': 'Zuri' })
  })
  it.each([undefined, 3, '', '   ', '{bad', '[1]', 'null', '"s"'])('reads %j as not supplied', (v) => {
    expect(parseDisplayNameOverrides({ displayNameOverrides: v })).toBeUndefined()
  })
})

describe('parseFileOrder', () => {
  it('accepts an array of strings, including empty', () => {
    expect(parseFileOrder({ fileOrder: '["b","a"]' })).toEqual(['b', 'a'])
    expect(parseFileOrder({ fileOrder: '[]' })).toEqual([])
  })
  it.each([undefined, 3, '', ' ', '[', '{"a":1}', '[1,"a"]'])('reads %j as not supplied', (v) => {
    expect(parseFileOrder({ fileOrder: v })).toBeUndefined()
  })
})
