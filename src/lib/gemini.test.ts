import { describe, expect, it } from 'vitest'
import { isPaidOnlyGeminiModel } from './gemini'

describe('isPaidOnlyGeminiModel', () => {
  describe('Gemini 3.x family — paid-only', () => {
    it('flags gemini-3-pro', () => {
      expect(isPaidOnlyGeminiModel('gemini-3-pro-preview')).toBe(true)
    })
    it('flags gemini-3-flash', () => {
      expect(isPaidOnlyGeminiModel('gemini-3.0-flash-preview')).toBe(true)
    })
  })

  describe('Gemini 2.5 Pro — paid-only as of 2026 free-tier policy', () => {
    it('flags the GA gemini-2.5-pro', () => {
      expect(isPaidOnlyGeminiModel('gemini-2.5-pro')).toBe(true)
    })
    it('flags gemini-2.5-pro previews', () => {
      expect(isPaidOnlyGeminiModel('gemini-2.5-pro-preview-03-25')).toBe(true)
    })
    it('does not over-match unrelated 2.5 models', () => {
      expect(isPaidOnlyGeminiModel('gemini-2.5-flash')).toBe(false)
      expect(isPaidOnlyGeminiModel('gemini-2.5-flash-lite')).toBe(false)
    })
  })

  describe('Other paid-only families', () => {
    it('flags deep-research', () => {
      expect(isPaidOnlyGeminiModel('deep-research-preview')).toBe(true)
    })
    it('flags computer-use preview', () => {
      expect(isPaidOnlyGeminiModel('gemini-2.5-computer-use-preview')).toBe(true)
    })
    it('flags gemini-pro-latest alias', () => {
      expect(isPaidOnlyGeminiModel('gemini-pro-latest')).toBe(true)
    })
    it('flags robotics models', () => {
      expect(isPaidOnlyGeminiModel('gemini-robotics-preview')).toBe(true)
    })
    it('flags nano-banana-pro', () => {
      expect(isPaidOnlyGeminiModel('nano-banana-pro-v1')).toBe(true)
    })
  })

  describe('Free-tier-available models', () => {
    it('does not flag gemini-2.0-flash', () => {
      expect(isPaidOnlyGeminiModel('gemini-2.0-flash')).toBe(false)
    })
    it('does not flag gemma baselines', () => {
      expect(isPaidOnlyGeminiModel('gemma-2-9b-it')).toBe(false)
    })
    it('does not flag gemini-2.5-flash family', () => {
      expect(isPaidOnlyGeminiModel('gemini-2.5-flash')).toBe(false)
      expect(isPaidOnlyGeminiModel('gemini-2.5-flash-lite')).toBe(false)
    })
  })
})
