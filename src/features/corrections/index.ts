// Names and corrections: the feature's front door.
// Other features import from here, never from a file inside this folder
// (rule d in engineering/tests/boundaries.test.ts). It re-exports only what
// they use; an import that would loop back through here stays deep and is
// listed, with its reason, in engineering/tests/boundaries.allowlist.json.
export { GlossaryEditor } from './components/GlossaryEditor'
export { SpeakerEditor } from './components/SpeakerEditor'
export { getGlossary } from './lib/glossary'
export type { GlossaryDocument } from './lib/glossary'
export { combineRules, formatContextualHints, pickHintsFor, preGround } from './lib/preGround'
export type { PreGroundReport } from './lib/preGround'
export { findSpeakerFor, getSpeakers, putSpeakers } from './lib/speakers'
export type { Speaker, SpeakersDocument } from './lib/speakers'
