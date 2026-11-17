// Chronicle library (server): the feature's front door.
// Other features import from here, never from a file inside this folder
// (rule d in engineering/tests/boundaries.test.ts). It re-exports only what
// they use; an import that would loop back through here stays deep and is
// listed, with its reason, in engineering/tests/boundaries.allowlist.json.
export { chronicleRouter } from './routes/chronicle.js'
export { chronicleLibraryRouter } from './routes/chronicleLibrary.js'
export { renderChronicleDocx } from './services/docxRenderer.js'
export type { ChronicleDocxArgs } from './services/docxRenderer.js'
