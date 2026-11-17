// Maintenance (server): the feature's front door.
// Other features import from here, never from a file inside this folder
// (rule d in engineering/tests/boundaries.test.ts). It re-exports only what
// they use; an import that would loop back through here stays deep and is
// listed, with its reason, in engineering/tests/boundaries.allowlist.json.
export { diagnoseRouter } from './routes/diagnose.js'
export { diagnosticsRouter } from './routes/diagnostics.js'
export { settingsRouter } from './routes/settings.js'
export { systemRouter } from './routes/system.js'
export { updaterRouter } from './routes/updater.js'
