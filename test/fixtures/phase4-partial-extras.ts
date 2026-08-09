// Fixtures for B1 (Phase 4 partial extras recovery on mid-flight pause).
//
// The pipeline writes `refinementState.partialOutput` as a JSON.stringify
// of the in-progress ExtrasOutput accumulator. On resume, K.1.1's fix
// will JSON.parse this and use it as `priorExtras`. These fixtures cover:
//   - happy path: complete, well-formed JSON
//   - missing field (e.g. only jests, no gore/quotes)
//   - empty/whitespace
//   - torn write (truncated mid-object)
//   - malformed JSON

import type { ExtrasOutput } from '@/types'

/** A well-formed partial accumulator after 3 chunks completed. The fix
 *  must round-trip this exactly into priorExtras. */
export const PARTIAL_AFTER_3_CHUNKS: ExtrasOutput = {
  jests: [
    "Ursula's third pun this session",
    'Mireille mishearing "doom" as "Zoom"',
    'Hiroko insisting the goblin was actually a Funko Pop',
  ],
  gore: [
    'Zainab cleaves the ogre lengthwise',
    'Cassian critically fumbles, drops his own sword on his foot',
  ],
  quotes: [
    { speaker: 'Ursula', line: 'It\'s half seven, let\'s start.' },
    { speaker: 'Zainab', line: 'Yeah.', kind: 'funny' },
  ],
}

/** Serialised form — this is what would actually be on disk in
 *  refinementState.partialOutput at pause time. */
export const PARTIAL_AFTER_3_CHUNKS_JSON = JSON.stringify(PARTIAL_AFTER_3_CHUNKS)

/** Output with only the `jests` field populated (other arrays missing
 *  entirely). The fix must default missing arrays to []. */
export const PARTIAL_ONLY_JESTS = JSON.stringify({
  jests: ['just a single jest'],
})

/** Empty string — happens on a pause before any chunk wrote. The fix
 *  must return the empty-extras default, not crash. */
export const PARTIAL_EMPTY = ''

/** Whitespace-only — same expected behaviour as empty. */
export const PARTIAL_WHITESPACE = '   \n  \t  '

/** A torn write: the disk write was interrupted mid-object. The fix
 *  must detect parse failure, log via vlog, fall back to empty extras,
 *  and signal `parseError: true` so the UI can toast about lost data. */
export const PARTIAL_TORN = '{"jests":["one","two"],"gore":["ble'

/** Pure garbage. Same expected handling as TORN. */
export const PARTIAL_MALFORMED = 'not valid json at all'
