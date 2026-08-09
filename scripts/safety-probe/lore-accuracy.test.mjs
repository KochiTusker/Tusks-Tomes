// Tests for the lore-accuracy harness. Covers countMentions, scoreChronicle,
// scoreExtras, scoreExtrasSpeakerAttribution, scoreRun.

import { describe, expect, it } from 'vitest'
import {
  countMentions,
  scoreChronicle,
  scoreExtras,
  scoreExtrasSpeakerAttribution,
  scoreRun,
} from './lore-accuracy.mjs'

describe('countMentions', () => {
  it('case-insensitive substring match', () => {
    const r = countMentions('Cassian swung his axe at the troll.', ['Cassian', 'Troll'])
    expect(r.hits).toBe(2)
    expect(r.perName.Cassian).toBe(true)
    expect(r.perName.Troll).toBe(true)
  })

  it('reports per-name miss for absent entities', () => {
    const r = countMentions('Cassian swung his axe.', ['Cassian', 'Zainab'])
    expect(r.hits).toBe(1)
    expect(r.perName.Cassian).toBe(true)
    expect(r.perName.Zainab).toBe(false)
  })

  it('handles null/undefined text gracefully', () => {
    const r = countMentions(null, ['Cassian'])
    expect(r.hits).toBe(0)
    expect(r.perName.Cassian).toBe(false)
  })

  it('handles empty name list', () => {
    expect(countMentions('text', []).hits).toBe(0)
  })
})

describe('scoreChronicle', () => {
  const seeded = {
    speakers: ['Cassian', 'Lakshmi', 'Zainab', 'Liesel', 'Sam'],
    location: 'Thornholt',
    faction: 'The Three',
    magicSystem: 'Pact of Mor',
  }

  it('100% when all seeded entities appear', () => {
    const chronicle = `
      The party arrived in Thornholt as the sun set. Cassian led the way,
      with Lakshmi and Zainab close behind. Sam, the Dungeon Master,
      narrated the encounter. They met Liesel in the tavern. The Three
      were said to watch over the city. Pact of Mor was the local magic.
    `
    const r = scoreChronicle(chronicle, seeded)
    expect(r.speakerScore).toBe(1)
    expect(r.entityScore).toBe(1)
    expect(r.overall).toBe(1)
  })

  it('partial credit when some speakers missing', () => {
    const chronicle = `
      Cassian and Lakshmi entered Thornholt. They met The Three. Pact of Mor.
    `
    const r = scoreChronicle(chronicle, seeded)
    // 2/5 speakers, 3/3 entities
    expect(r.speakerScore).toBeCloseTo(2 / 5, 3)
    expect(r.entityScore).toBe(1)
    expect(r.overall).toBeCloseTo((2 / 5 + 1) / 2, 3)
  })

  it('records per-name pass/fail in details', () => {
    const chronicle = 'Cassian and Lakshmi.'
    const r = scoreChronicle(chronicle, seeded)
    expect(r.details.speakers.Cassian).toBe(true)
    expect(r.details.speakers.Zainab).toBe(false)
    expect(r.details.entities.Thornholt).toBe(false)
  })

  it('returns 100% scores when seeded lists are empty (vacuous)', () => {
    const r = scoreChronicle('any text', { speakers: [] })
    expect(r.speakerScore).toBe(1)
    expect(r.entityScore).toBe(1)
  })

  it('handles missing chronicle text', () => {
    const r = scoreChronicle('', seeded)
    expect(r.speakerScore).toBe(0)
    expect(r.entityScore).toBe(0)
    expect(r.overall).toBe(0)
  })
})

describe('scoreExtras', () => {
  it('reports counts + nonEmpty flag from a populated extras object', () => {
    const r = scoreExtras({
      jests: ['One funny moment.'],
      gore: ['One brutal kill.', 'Another.'],
      quotes: [{ speaker: 'Cassian', line: 'fuck', kind: 'funny' }],
    })
    expect(r.jests).toBe(1)
    expect(r.gore).toBe(2)
    expect(r.quotes).toBe(1)
    expect(r.populated).toBe(4)
    expect(r.nonEmpty).toBe(true)
  })

  it('reports nonEmpty=false for all-empty extras', () => {
    const r = scoreExtras({ jests: [], gore: [], quotes: [] })
    expect(r.nonEmpty).toBe(false)
  })

  it('returns nonEmpty=false and populated=0 for null/undefined input', () => {
    expect(scoreExtras(null).nonEmpty).toBe(false)
    expect(scoreExtras(null).populated).toBe(0)
    expect(scoreExtras(undefined).nonEmpty).toBe(false)
    expect(scoreExtras(undefined).populated).toBe(0)
  })

  it('handles malformed extras (non-array fields)', () => {
    const r = scoreExtras({ jests: 'not an array', gore: null, quotes: undefined })
    expect(r.jests).toBe(0)
    expect(r.gore).toBe(0)
    expect(r.quotes).toBe(0)
  })
})

describe('scoreExtrasSpeakerAttribution', () => {
  const seeded = ['Cassian', 'Lakshmi', 'Zainab']

  it('100% when every quote attribution matches a seeded speaker', () => {
    const extras = {
      quotes: [
        { speaker: 'Cassian (Katarzyna)', line: 'fuck', kind: 'funny' },
        { speaker: 'Lakshmi (Olamide)', line: 'I dodge', kind: 'funny' },
      ],
    }
    const r = scoreExtrasSpeakerAttribution(extras, seeded)
    expect(r.matched).toBe(2)
    expect(r.ratio).toBe(1)
  })

  it('partial when some quotes attributed to non-seeded speakers', () => {
    const extras = {
      quotes: [
        { speaker: 'Cassian (Katarzyna)', line: 'x', kind: 'funny' },
        { speaker: 'Pentagon', line: 'y', kind: 'stupid' }, // hallucinated
      ],
    }
    const r = scoreExtrasSpeakerAttribution(extras, seeded)
    expect(r.matched).toBe(1)
    expect(r.total).toBe(2)
    expect(r.ratio).toBe(0.5)
  })

  it('vacuous pass (ratio=1) when no extras quotes', () => {
    expect(scoreExtrasSpeakerAttribution({ quotes: [] }, seeded).ratio).toBe(1)
    expect(scoreExtrasSpeakerAttribution(null, seeded).ratio).toBe(1)
  })
})

describe('scoreRun', () => {
  const seeded = {
    speakers: ['Cassian', 'Lakshmi', 'Zainab', 'Liesel', 'Sam'],
    location: 'Thornholt',
    faction: 'The Three',
    magicSystem: 'Pact of Mor',
  }

  it('produces a composite finalAccuracy when both Chronicle + Extras populated', () => {
    const chronicleText = `
      Cassian, Lakshmi, Zainab, Liesel, Sam journeyed to Thornholt.
      The Three watched. Pact of Mor was the local magic.
    `
    const extras = {
      jests: ['One.'],
      gore: ['One.'],
      quotes: [{ speaker: 'Cassian', line: 'x', kind: 'funny' }],
    }
    const r = scoreRun({ chronicleText, extras, seeded })
    expect(r.chronicle.overall).toBe(1)
    expect(r.extras.nonEmpty).toBe(true)
    expect(r.extrasAttribution.ratio).toBe(1)
    expect(r.finalAccuracy).toBeGreaterThan(0.9)
  })

  it('finalAccuracy falls back to chronicle.overall when extras is empty', () => {
    const chronicleText = 'Cassian at Thornholt.'
    const extras = { jests: [], gore: [], quotes: [] }
    const r = scoreRun({ chronicleText, extras, seeded })
    expect(r.extras.nonEmpty).toBe(false)
    expect(r.finalAccuracy).toBe(r.chronicle.overall)
  })

  it('penalises a hallucinated speaker in extras', () => {
    const chronicleText = `
      Cassian, Lakshmi, Zainab, Liesel, Sam journeyed to Thornholt.
      The Three. Pact of Mor.
    `
    const extras = {
      jests: ['One.'],
      gore: [],
      quotes: [
        { speaker: 'Pentagon', line: 'x', kind: 'stupid' }, // hallucinated
      ],
    }
    const r = scoreRun({ chronicleText, extras, seeded })
    expect(r.chronicle.overall).toBe(1)
    expect(r.extrasAttribution.ratio).toBe(0) // 0/1 matched
    // composite < chronicle.overall because extras attribution dragged it down
    expect(r.finalAccuracy).toBeLessThan(1)
  })
})
