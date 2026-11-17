// Maintenance: the feature's front door.
// Other features import from here, never from a file inside this folder
// (rule d in engineering/tests/boundaries.test.ts). It re-exports only what
// they use; an import that would loop back through here stays deep and is
// listed, with its reason, in engineering/tests/boundaries.allowlist.json.
export { DevTestModeCard } from './components/DevTestModeCard'
export { DiagnosticsCard } from './components/DiagnosticsCard'
export { UpdaterCard } from './components/UpdaterCard'
export { truncateAtLineBoundary } from './lib/devTruncate'
export { extractSymbolFromError, requestBundle, shouldAutoCheckpointOnError } from './lib/diagnose'
export { getSystemInfo } from './lib/system'
export type { SystemInfo } from './lib/system'
export { isPersistingBlockedChunks, vlog } from './lib/verboseLog'
