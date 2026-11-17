import { describe, expect, it } from 'vitest'
import { promoteHeadings } from './headingPromotion.js'

describe('promoteHeadings', () => {
  it('returns input unchanged when any # heading already exists', () => {
    const md = '# Existing\n\nDurgin Ironheart\n\nSome longer body text that should not be promoted.'
    expect(promoteHeadings(md)).toBe(md)
  })

  it('promotes a Title Case line followed by long prose', () => {
    const md = [
      'The Badlands',
      '',
      'The Badlands refers to two ungoverned regions of Caelovar with long histories of conflict.',
    ].join('\n')
    const out = promoteHeadings(md)
    expect(out.split('\n')[0]).toBe('# The Badlands')
  })

  it('promotes a Title Case line followed by structural Capital: line', () => {
    const md = [
      'Thalassa',
      '',
      'Capital: Porta Fortuna',
      '',
      'Location: South East of Caelovar',
    ].join('\n')
    const out = promoteHeadings(md)
    expect(out.split('\n')[0]).toBe('# Thalassa')
  })

  it('does NOT promote a sentence ending in punctuation', () => {
    const md = [
      'This is a sentence.',
      '',
      'And here is another paragraph with enough content to qualify on length grounds.',
    ].join('\n')
    expect(promoteHeadings(md)).toBe(md)
  })

  it('does NOT promote a list item starting with -', () => {
    const md = [
      '- Bullet item one',
      '',
      'And a second long paragraph that is much longer than forty characters in length.',
    ].join('\n')
    expect(promoteHeadings(md)).toBe(md)
  })

  it('does NOT promote a key:value line', () => {
    const md = [
      'Capital: Porta Fortuna',
      '',
      'A long enough paragraph to satisfy the content length check easily.',
    ].join('\n')
    expect(promoteHeadings(md)).toBe(md)
  })

  it('handles CRLF line endings', () => {
    const md = 'The Badlands\r\n\r\nThe Badlands refers to two ungoverned regions of Caelovar.'
    const out = promoteHeadings(md)
    expect(out.startsWith('# The Badlands')).toBe(true)
  })
})
