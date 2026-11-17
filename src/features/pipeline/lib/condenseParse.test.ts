import { describe, expect, it } from 'vitest'
import { parseCondenseChunk, salvageCondenseChunk } from './condenseParse'

describe('parseCondenseChunk', () => {
  it('reads well-formed output unchanged, trimming fields', () => {
    const raw = JSON.stringify({ narrative: '  The gate held.  ', bulletPoints: [' One. ', '', 'Two.'] })
    expect(parseCondenseChunk(raw)).toEqual({ narrative: 'The gate held.', bulletPoints: ['One.', 'Two.'] })
  })

  it('keeps an empty-but-valid object (the refusal sentinel) as an empty result, not a failure', () => {
    expect(parseCondenseChunk('{"narrative":"","bulletPoints":[]}')).toEqual({ narrative: '', bulletPoints: [] })
  })

  it('recovers a narrative whose dialogue quotes were left unescaped', () => {
    const raw =
      '```json\n{\n  "narrative": "The captain turned. "Hand it over," she said, and the room went still.\\n\\nNobody moved.",\n' +
      '  "bulletPoints": ["The party met the captain.", "The captain demanded the map."]\n}\n```'
    expect(parseCondenseChunk(raw)).toEqual({
      narrative: 'The captain turned. "Hand it over," she said, and the room went still.\n\nNobody moved.',
      bulletPoints: ['The party met the captain.', 'The captain demanded the map.'],
    })
  })

  it('recovers bullets that carry bare quotes', () => {
    const raw = '{"narrative": "Short.", "bulletPoints": ["Vell shouted "run" at the gate.", "They ran."]}'
    expect(parseCondenseChunk(raw)?.bulletPoints).toEqual(['Vell shouted "run" at the gate.', 'They ran.'])
  })

  it('recovers when bulletPoints comes before narrative', () => {
    const raw = '{"bulletPoints": ["First."], "narrative": "He said "no" twice."}'
    expect(parseCondenseChunk(raw)).toEqual({ narrative: 'He said "no" twice.', bulletPoints: ['First.'] })
  })

  it('returns null when there is nothing to recover', () => {
    expect(parseCondenseChunk('I could not condense this chronicle.')).toBeNull()
    expect(parseCondenseChunk('{"summary": "wrong shape"}')).toBeNull()
  })
})

describe('salvageCondenseChunk', () => {
  it('returns null when the narrative key is missing', () => {
    expect(salvageCondenseChunk('{"bulletPoints": ["a"]}')).toBeNull()
  })
})
