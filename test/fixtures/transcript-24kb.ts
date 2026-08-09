// 24KB synthetic transcript for pipeline.integration.test.ts (K.3.1).
//
// Designed to:
//   - Produce deterministic chunk counts across phases (driven by the
//     existing chunkSizeFor() table — see src/lib/chunking.ts).
//   - Include enough character names + place names + lore terms that
//     the grounding + chronicle phases have material to work with.
//   - Hit ~24,000 characters total (close to one Phase 1 chunk on
//     Gemini Paid; ~3 chunks on the conservative local profile).

const CHARACTERS = ['Seoyeon', 'Lucia', 'Yuzuki', 'Thao', 'Eero']
const ACTIONS = [
  'rolls a perception check',
  'casts shield of faith',
  'lunges with the greataxe',
  'parries the strike',
  'shouts encouragement',
  'drinks from the waterskin',
  'examines the inscription',
  'whispers a warning',
  'leaps from the rampart',
  'binds the wound',
]
const PLACES = ['the Crimson Cathedral', 'Waterdeep', 'the Sunless Citadel', 'Phandalin']
const ITEMS = ['the Sun Blade', 'the Bag of Holding', 'the Staff of Withering']

function dialogueLine(turn: number): string {
  const speaker = CHARACTERS[turn % CHARACTERS.length]
  const partner = CHARACTERS[(turn + 1) % CHARACTERS.length]
  const place = PLACES[turn % PLACES.length]
  const item = ITEMS[turn % ITEMS.length]
  const action = ACTIONS[turn % ACTIONS.length]
  // Vary line shape so the chunker doesn't see a perfectly periodic input.
  if (turn % 5 === 0) {
    return `[${speaker} (Player)] Now in ${place}, ${speaker} ${action} while ${partner} watches. The party glances at ${item}.`
  }
  if (turn % 7 === 0) {
    return `[${speaker} (Player)] "${speaker} says: hold on — what does ${item} actually do here?"`
  }
  return `[${speaker} (Player)] ${speaker} ${action}, calling out to ${partner} over the noise of ${place}.`
}

/** ~24KB transcript. Deterministic across runs. */
export const TRANSCRIPT_24KB: string = (() => {
  const lines: string[] = []
  for (let turn = 0; turn < 220; turn++) {
    lines.push(dialogueLine(turn))
  }
  return lines.join('\n')
})()

if (typeof process !== 'undefined' && process.env?.DEBUG_FIXTURE) {
  // eslint-disable-next-line no-console
  console.log(`transcript-24kb: ${TRANSCRIPT_24KB.length} chars`)
}
