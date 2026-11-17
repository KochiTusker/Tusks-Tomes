// Audio transcription: the feature's front door.
// Other features import from here, never from a file inside this folder
// (rule d in engineering/tests/boundaries.test.ts). It re-exports only what
// they use; an import that would loop back through here stays deep and is
// listed, with its reason, in engineering/tests/boundaries.allowlist.json.
export { AddonsManager } from './components/AddonsManager'
export { SessionsList } from './components/SessionsList'
export { WhisperCppPanel } from './components/WhisperCppPanel'
export { CpuWhisperWarning, PythonBlockedNotice } from './components/WhisperPrereqs'
export { WhisperSettings } from './components/WhisperSettings'
export { streamAddonInstall } from './lib/addonInstallStream'
export type { InstallLogEntry } from './lib/addonInstallStream'
