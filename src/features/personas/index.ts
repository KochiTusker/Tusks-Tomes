// Personas: the feature's front door.
// Other features import from here, never from a file inside this folder
// (rule d in engineering/tests/boundaries.test.ts). It re-exports only what
// they use; an import that would loop back through here stays deep and is
// listed, with its reason, in engineering/tests/boundaries.allowlist.json.
export { PersonaPicker } from './components/PersonaPicker'
export { PersonasManager } from './components/PersonasManager'
export { findSelectedPersona, getPersonas, peekPersonas, subscribePersonas } from './lib/personas'
export { renderPersonaPrompt } from './lib/personas/render'
export type { Persona, PersonasDocument } from './lib/personas/types'
