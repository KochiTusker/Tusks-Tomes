import { describe, expect, it } from 'vitest'
import { decideDraftRestore } from './routingDraft'

const committed = { lastSelectedProvider: 'gemini', perPhase: {} }
const json = JSON.stringify(committed)
const edited = { ...committed, perPhase: { phase3: { target: 'cloud', modelId: 'x' } } }

describe('decideDraftRestore', () => {
  it('restores a draft edited against the current document', () => {
    expect(decideDraftRestore({ base: json, routing: edited }, json)).toBe('restore')
  })

  it('has nothing to restore when the draft equals the committed document', () => {
    expect(decideDraftRestore({ base: json, routing: committed }, json)).toBe('none')
  })

  it('discards a draft made against a document that has since changed', () => {
    // The setup wizard, a fallback flip or a resumed session wrote routing.json
    // in between. Restoring this draft would revert their write at Save.
    const older = JSON.stringify({ lastSelectedProvider: 'openrouter', perPhase: {} })
    expect(decideDraftRestore({ base: older, routing: edited }, json)).toBe('discard')
  })

  it('discards a draft in an older shape, and ignores an absent one', () => {
    expect(decideDraftRestore(edited, json)).toBe('discard') // a bare document, no fingerprint
    expect(decideDraftRestore('garbage', json)).toBe('discard')
    expect(decideDraftRestore(null, json)).toBe('none')
  })
})
