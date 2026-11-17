// Chronicle library: the feature's front door.
// Other features import from here, never from a file inside this folder
// (rule d in engineering/tests/boundaries.test.ts). It re-exports only what
// they use; an import that would loop back through here stays deep and is
// listed, with its reason, in engineering/tests/boundaries.allowlist.json.
export { ChronicleView } from './components/ChronicleView'
export { SavedChroniclesPanel } from './components/SavedChroniclesPanel'
export {
  CHRONICLE_LIBRARY_EVENT,
  getChronicle,
  listChronicles,
  saveChronicle,
  updateChronicle,
} from './lib/chronicleLibrary'
export type { ChronicleSummary, SavedChronicle } from './lib/chronicleLibrary'
export { buildPartialMarkdown, downloadMarkdownFile } from './lib/exportMarkdown'
