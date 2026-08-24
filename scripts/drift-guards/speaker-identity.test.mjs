// Drift guard for the mirrored `findSpeakerFor` implementations.
//
// The helper exists twice on purpose — server/lib/speakerIdentity.ts and
// src/lib/speakers.ts — because the two trees don't import from each
// other (same convention as the Quote type mirrored in
// server/lore/docxRenderer.ts). Neither tsconfig will resolve an import
// across its rootDir, so the comparison lives here in scripts/, matching
// scripts/safety-probe/prompts.test.mjs.
//
// Why it's load-bearing: the SERVER copy decides the speaker labels
// written into the SBV; the CLIENT copy decides what pre-fills the
// attribution screen. Let them diverge and the transcript and the UI
// disagree about who is who — the exact wrong-attribution failure the
// speakerIdentity module was added to fix.

import { describe, expect, it } from 'vitest'
import { findSpeakerFor as serverFindSpeakerFor } from '../../server/lib/speakerIdentity.js'
import { findSpeakerFor as clientFindSpeakerFor } from '../../src/lib/speakers.js'

const ROWS = [
  { discordUserId: '3', discordDisplayName: 'dicegoblin', characterName: 'Brody' },
  { discordUserId: 'u_abc', discordDisplayName: 'lanternfly', characterName: 'Kaziel' },
  { discordUserId: '9', characterName: 'no-display-name' },
  { discordUserId: 'x', discordDisplayName: 'dup', characterName: 'first-dup' },
  { discordUserId: 'y', discordDisplayName: 'dup', characterName: 'second-dup' },
  { discordUserId: 'z', discordDisplayName: '  Padded  ', characterName: 'padded' },
]

// [userId, displayName] — covers id hit, display-name fallback, case and
// whitespace folding, ambiguity, and both "no match" paths.
const CASES = [
  ['u_abc', 'lanternfly'],
  ['u_new', 'dicegoblin'],
  ['u_new', ' DiceGoblin '],
  ['u_new', 'PADDED'],
  ['3', 'anything'],
  ['9', undefined],
  ['9', ''],
  ['unknown', undefined],
  ['unknown', '   '],
  ['unknown', 'dup'],
  ['y', 'dup'],
  ['missing', 'nobody-by-this-name'],
]

describe('findSpeakerFor — server and client copies agree', () => {
  for (const [userId, displayName] of CASES) {
    it(`agrees for (${userId}, ${JSON.stringify(displayName)})`, () => {
      expect(serverFindSpeakerFor(ROWS, userId, displayName)).toEqual(
        clientFindSpeakerFor(ROWS, userId, displayName)
      )
    })
  }

  it('agrees on an empty registry', () => {
    expect(serverFindSpeakerFor([], 'a', 'b')).toEqual(clientFindSpeakerFor([], 'a', 'b'))
  })
})
