// The Phase 4 DM rule, and the safeguard that has to travel with it.
//
// A first version of this rule made exclusion the safe default when the model
// could not identify which NPC was speaking, which dropped whole exchanges
// rather than re-attributing them. The rule now defaults to keeping the quote,
// and these assertions exist so that cannot silently regress.

import { describe, expect, it } from 'vitest'
import { phase4Extras } from './prompts'

const prompt = phase4Extras({
  groundedChunk: '[Dungeon Master (Name)] The room is dark.\n[Kaziel (Name)] I look around.',
  dmAnswers: {},
  index: 0,
  total: 1,
})

describe('phase 4 DM speech rule', () => {
  it('separates NPC voice from narration rather than excluding all DM lines', () => {
    expect(prompt).toMatch(/NPC VOICE/i)
    expect(prompt).toMatch(/SCENE NARRATION/i)
    expect(prompt).toMatch(/MECHANICS AND TABLE TALK/i)
  })

  it('makes keeping the quote the default when the call is unclear', () => {
    // The whole reason the first version failed: faced with an unnamed NPC it
    // chose the safe-looking option, which was the destructive one.
    expect(prompt).toMatch(/WHEN IN DOUBT, KEEP THE QUOTE/i)
    expect(prompt).toMatch(/NEVER DROP A LINE FOR LACK OF A NAME/i)
  })

  it('says an unattributable NPC line keeps the DM label rather than being cut', () => {
    expect(prompt).toMatch(/attribute it to\s+the DM/i)
  })

  it('routes excluded narration to the description fields instead of discarding it', () => {
    // Narration cannot be a verbatim quote, but a grisly or funny piece of it
    // is exactly what gore and jests are for.
    expect(prompt).toMatch(/"jests" and "gore" fields are DESCRIPTIONS/i)
  })

  it('states the observable symptom of applying the rule too hard', () => {
    expect(prompt).toMatch(/return no quotes from\s+it, you have applied this rule wrongly/i)
  })
})
