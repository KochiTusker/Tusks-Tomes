// Caption repair: the feature's front door.
// Other features import from here, never from a file inside this folder
// (rule d in engineering/tests/boundaries.test.ts). It re-exports only what
// they use; an import that would loop back through here stays deep and is
// listed, with its reason, in engineering/tests/boundaries.allowlist.json.
export { CaptionRepair } from './components/CaptionRepair'
export { isSbv, sbvToText } from './lib/sbv'
export type { SbvCue } from './lib/sbv'
