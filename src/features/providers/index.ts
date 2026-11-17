// Providers and models: the feature's front door.
// Other features import from here, never from a file inside this folder
// (rule d in engineering/tests/boundaries.test.ts). It re-exports only what
// they use; an import that would loop back through here stays deep and is
// listed, with its reason, in engineering/tests/boundaries.allowlist.json.
export { CodexPanel } from './components/CodexPanel'
export { ConnectionRow } from './components/ConnectionRow'
export { FreeModelsNote } from './components/FreeModelsNote'
export { ModelListFreshness } from './components/ModelListFreshness'
export { ProviderSettings } from './components/ProviderSettings'
export { useAvailabilityCache } from './hooks/useAvailabilityCache'
export {
  availableModelsFor,
  groupModels,
  hasUnverified,
  optgroupLabel,
} from './lib/availableModels'
export {
  fetchConfiguredCloudKeyOptions,
  listConfiguredCloudKeyOptions,
  optionFromRouting,
} from './lib/cloudKeys'
export type { CloudKeyOption } from './lib/cloudKeys'
export { probeClaudeCode, probeCodex, probeLocalRunners, probeWhisperCpp } from './lib/connections'
export {
  LS_CAMPAIGN,
  LS_KB,
  LS_OUTPUT_SELECTION,
  LS_REFINEMENT,
  LS_ROUTING_DRAFT,
  LS_SBV_REPAIR,
  LS_SESSION,
  LS_UPLOAD_SESSION,
  MAX_OUTPUT_TOKENS,
} from './lib/constants'
export { isPaidOnlyGeminiModel, listGeminiModelAvailability } from './lib/geminiAvailability'
export { buildLiveRateResolver, parseCatalogueGemini, parseNativeGemini } from './lib/liveRates'
export type { LiveRateResolver } from './lib/liveRates'
export { detectLocalBackends, getProbeResults, subscribeLocalLLM } from './lib/localLLM'
export type { LocalBackendInfo, ProbeResult } from './lib/localLLM'
export { shouldRetrieveVaultKb } from './lib/modelLimits'
export { classifyModelTier } from './lib/modelTier'
export type { ModelTier } from './lib/modelTier'
export { SMALL_MODEL_CEILING_B, isHiddenFromRouting } from './lib/modelVisibility'
export {
  getOpenRouterCatalogue,
  handlesMatureContent,
  isTextPipelineModel,
} from './lib/openrouterModelsClient'
export type { OpenRouterModelInfo } from './lib/openrouterModelsClient'
export { GEMINI_PRICING, estimateRunCost, formatDollars, liveRateFor } from './lib/pricing'
export type { PhaseRouting, RunCostEstimate } from './lib/pricing'
export { getProfiles } from './lib/profiles'
export type { CloudProvider, ProfilesDocument, ProviderProfile } from './lib/profiles'
export { computePacingDelay } from './lib/providerPacing'
export {
  getAvailabilityCache,
  getProvidersSummary,
  putProviderKey,
  subscribeProviders,
  testProviderKey,
} from './lib/providerSettings'
export type { AvailabilityCache, ProvidersSummary, SlotAvailability } from './lib/providerSettings'
export { isTransientServerError } from './lib/providers/gemini'
export { parseParamSizeB } from './lib/providers/hardware'
export {
  PROVIDERS_CHANGED_EVENT,
  ensureProvidersInitialized,
  getActiveProvider,
  getCloudProvider,
  hasApiKey,
  refreshProviders,
} from './lib/providers/index'
export type { GeminiTier, ProvidersChangedDetail } from './lib/providers/index'
export type {
  GenerateRequest,
  GenerateResponse,
  LLMProvider,
  ProviderEvent,
  ProviderName,
} from './lib/providers/llm'
export { LocalInstanceProvider } from './lib/providers/localInstance'
export { getModelForTier, getProviderSettings, isLocalProvider } from './lib/providers/settings'
export { estimateTokensFromChars } from './lib/rateLimit'
export { useShowAllModels } from './lib/useShowAllModels'
