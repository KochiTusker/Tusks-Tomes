import { describe, expect, it } from 'vitest'
import { classifyModelTier } from './modelTier'

describe('classifyModelTier — gemini', () => {
  it('classifies pro variants as flagship', () => {
    expect(classifyModelTier('gemini-2.5-pro', 'gemini')).toBe('flagship')
    expect(classifyModelTier('gemini-1.5-pro', 'gemini')).toBe('flagship')
    expect(classifyModelTier('gemini-2.5-pro-preview-0827', 'gemini')).toBe('flagship')
  })
  it('classifies flash variants as fast', () => {
    expect(classifyModelTier('gemini-2.5-flash', 'gemini')).toBe('fast')
    expect(classifyModelTier('gemini-1.5-flash', 'gemini')).toBe('fast')
    expect(classifyModelTier('gemini-2.0-flash-lite', 'gemini')).toBe('fast')
  })
  it('handles the flashy-pro adversarial case (pro wins)', () => {
    expect(classifyModelTier('gemini-flashy-pro', 'gemini')).toBe('flagship')
  })
  it('defaults unknown gemini strings to flagship', () => {
    expect(classifyModelTier('gemini-future-9000', 'gemini')).toBe('flagship')
    expect(classifyModelTier('gemini-experimental', 'gemini')).toBe('flagship')
  })
})

describe('classifyModelTier — claude', () => {
  it('classifies opus as frontier', () => {
    expect(classifyModelTier('claude-opus-4-7', 'claude')).toBe('frontier')
    expect(classifyModelTier('claude-3-opus-20240229', 'claude')).toBe('frontier')
  })
  it('classifies sonnet as flagship', () => {
    expect(classifyModelTier('claude-sonnet-4-6', 'claude')).toBe('flagship')
    expect(classifyModelTier('claude-3-5-sonnet-20241022', 'claude')).toBe('flagship')
  })
  it('classifies haiku as fast', () => {
    expect(classifyModelTier('claude-haiku-4-5-20251001', 'claude')).toBe('fast')
    expect(classifyModelTier('claude-3-5-haiku-20241022', 'claude')).toBe('fast')
  })
  it('defaults unknown claude strings to flagship', () => {
    expect(classifyModelTier('claude-future', 'claude')).toBe('flagship')
  })
})

describe('classifyModelTier — openai', () => {
  it('classifies mini/nano as fast', () => {
    expect(classifyModelTier('gpt-5-mini', 'openai')).toBe('fast')
    expect(classifyModelTier('gpt-5-nano', 'openai')).toBe('fast')
    expect(classifyModelTier('gpt-4o-mini', 'openai')).toBe('fast')
  })
  it('classifies gpt-5 and gpt-4o as flagship', () => {
    expect(classifyModelTier('gpt-5', 'openai')).toBe('flagship')
    expect(classifyModelTier('gpt-4o', 'openai')).toBe('flagship')
    expect(classifyModelTier('gpt-4-turbo', 'openai')).toBe('flagship')
  })
  it('defaults unknown openai strings to flagship', () => {
    expect(classifyModelTier('gpt-future', 'openai')).toBe('flagship')
  })
})

describe('classifyModelTier — edge cases', () => {
  it('handles empty string as flagship', () => {
    expect(classifyModelTier('', 'gemini')).toBe('flagship')
    expect(classifyModelTier('', 'claude')).toBe('flagship')
    expect(classifyModelTier('', 'openai')).toBe('flagship')
  })
  it('is case-insensitive', () => {
    expect(classifyModelTier('GEMINI-2.5-FLASH', 'gemini')).toBe('fast')
    expect(classifyModelTier('Claude-Haiku-4-5', 'claude')).toBe('fast')
    expect(classifyModelTier('GPT-5-MINI', 'openai')).toBe('fast')
  })
})
