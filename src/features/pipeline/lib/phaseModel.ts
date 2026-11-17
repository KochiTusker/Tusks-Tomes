// Which provider, model and chunk size a phase runs on.
import {
  classifyModelTier,
  type ModelTier,
  type GeminiTier,
  LocalInstanceProvider,
  getProviderSettings,
  isLocalProvider,
} from '@/features/providers'
import { chunkSizeFor as chunkSizeForProvider, type ChunkPhase } from './chunking'
import { contextWindowFor } from './contextWindow'
import type { LLMProvider, CloudProvider } from '@/features/providers'
import type { PhaseTarget } from '@/features/routing'

/**
 * Resolve a phase's chunk size using the active routing. Cloud providers
 * each have their own per-phase size in src/features/pipeline/lib/chunking.ts; local models
 * use a single conservative table regardless of which runner is in play.
 *
 * `model` is used to classify the per-phase model into a tier (flagship /
 * fast / frontier) so fast-tier models (Flash, Haiku, gpt-5-mini) run on
 * smaller chunks. Omitting it preserves the flagship-default behaviour.
 */
export function chunkSizeForPhase(args: {
  phase: ChunkPhase
  cloudProvider?: CloudProvider
  geminiTier?: GeminiTier
  phaseTarget?: PhaseTarget
  model?: string
  /** When set, chunking.ts applies the all-fast shrink factor. Threaded
   *  through from RunSession.allPhasesFast on the per-phase call sites. */
  allPhasesFast?: boolean
}): number {
  const isLocal = isLocalProvider() || args.phaseTarget?.target === 'local'
  const modelTier: ModelTier | undefined =
    !isLocal && args.model && args.cloudProvider
      ? classifyModelTier(args.model, args.cloudProvider)
      : undefined
  return chunkSizeForProvider({
    phase: args.phase,
    isLocal,
    cloudProvider: args.cloudProvider,
    geminiTier: args.geminiTier,
    modelTier,
    allPhasesFast: args.allPhasesFast,
  })
}

/** Tier→model resolution for the active provider. Mirrors the legacy gemini.ts behavior. */
function resolveModel(tier: 'pro' | 'flash'): string {
  const s = getProviderSettings()
  return tier === 'pro' ? s.proModel : s.flashModel
}

/** Pick the per-phase override if provided, otherwise fall back to tier resolution. */
export function resolvePhaseModel(modelOverride: string | undefined, tier: 'pro' | 'flash'): string {
  return modelOverride && modelOverride.length > 0 ? modelOverride : resolveModel(tier)
}

/**
 * The context window the lore-carrying phases (3 and 6) decide retrieval
 * against. A figure the caller passed wins; otherwise it is looked up for the
 * cloud model chunkedGenerate will call, resolved by the same rule. A phase
 * routed to a local instance, or a run with no cloud provider in its session,
 * has no catalogue figure and stays unknown.
 */
export async function resolveModelContextTokens(
  passed: number | null | undefined,
  phaseTarget: PhaseTarget | undefined,
  cloudProvider: CloudProvider | undefined,
  modelOverride: string | undefined,
): Promise<number | null> {
  if (passed !== undefined) return passed
  if (phaseTarget?.target === 'local' || !cloudProvider) return null
  return contextWindowFor(cloudProvider, resolvePhaseModel(modelOverride, 'pro'))
}

const LOCAL_BACKEND_BASE_URLS: Record<string, string> = {
  ollama: 'http://localhost:11434',
  lmstudio: 'http://localhost:1234',
  llamacpp: 'http://localhost:8080',
}

export function resolvePhaseProvider(target: PhaseTarget | undefined): {
  provider: LLMProvider
  model: string
  isLocal: boolean
} | null {
  if (!target || target.target === 'cloud') return null
  // Use the routed model. The base URL isn't carried per-phase yet, so we
  // try the common defaults — Ollama first, then LM Studio, then llama.cpp.
  // The first reachable backend that recognises this model wins. For now we
  // pick Ollama by default since it's the most common dev setup.
  const baseUrl = target.baseUrl ?? LOCAL_BACKEND_BASE_URLS.ollama
  const provider = new LocalInstanceProvider({ baseUrl, modelId: target.modelId })
  return { provider, model: target.modelId, isLocal: true }
}
