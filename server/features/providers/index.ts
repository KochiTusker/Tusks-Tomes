// Providers and models (server): the feature's front door.
// Other features import from here, never from a file inside this folder
// (rule d in engineering/tests/boundaries.test.ts). It re-exports only what
// they use; an import that would loop back through here stays deep and is
// listed, with its reason, in engineering/tests/boundaries.allowlist.json.
export {
  claudeCodeStatus,
  isClaudeCodeMounted,
  registerClaudeCodeRoutes,
} from './routes/claudeCode.js'
export { codexStatus, registerCodexRoutes } from './routes/codex.js'
export { registerLocalLlmRoutes } from './routes/localLLM.js'
export { readAvailabilityCache } from './routes/modelProbe.js'
export type { AvailabilityCache } from './routes/modelProbe.js'
export { openrouterModelsRouter } from './routes/openrouterModels.js'
export { profilesRouter } from './routes/profiles.js'
export { providerKeysRouter } from './routes/providerKeys.js'
export { acceptModel, loadAvailabilityCache, warningFor } from './services/knownModels.js'
export type { LegacyCloudProvider } from './services/knownModels.js'
