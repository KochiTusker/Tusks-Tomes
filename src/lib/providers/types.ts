// Provider abstraction for AI model dispatch. The constraints this exists to
// satisfy — provider isolation and tier-based model selection — are recorded
// under "Binding engineering principles" in ROADMAP.md.
//
// The pipeline declares which "tier" each phase needs (pro / flash). Each
// provider (Gemini, Ollama, LM Studio, OpenAI later, Anthropic later) maps
// the tier to a concrete model the user has selected for that provider.
// Adding a new provider = implementing this surface, adding a new ID, and
// extending the dispatcher.

export type Tier = 'pro' | 'flash'

export type ProviderId = 'gemini' | 'ollama' | 'lmstudio' | 'unsloth'

/** Whether a provider is locally hosted (vs. cloud). */
export const LOCAL_PROVIDERS: ReadonlyArray<ProviderId> = ['ollama', 'lmstudio', 'unsloth']

/**
 * Auth credentials for local runners. The server proxy decides which
 * mechanism to use:
 *   - bearerToken takes precedence — sent verbatim as Authorization: Bearer <token>.
 *   - username + password: server first tries OAuth2 password flow against /token
 *     (FastAPI standard, used by Unsloth Studio). If that fails, falls back to
 *     HTTP Basic auth.
 * Leave all blank for runners that don't require auth (default Ollama, LM Studio).
 */
export type LocalAuth = {
  username: string
  password: string
  bearerToken?: string
}

/** User-supplied hardware specs for model-fit advisories. */
export type HardwareProfile = {
  /** Total VRAM in gigabytes on the GPU running inference. */
  vramGb: number
  /** Typical context size (tokens) the user runs through the model. Defaults to 50000 if unset. */
  expectedContextTokens?: number
}

export type ProviderSettings = {
  providerId: ProviderId
  /** Concrete model for the "pro" tier (used by phases prioritizing accuracy). */
  proModel: string
  /** Concrete model for the "flash" tier (used by mechanical / extraction phases). */
  flashModel: string
  /** For local providers, override the default base URL (e.g. for a remote Ollama box). */
  baseUrl?: string
  /** Optional auth for local runners that require login. */
  auth?: LocalAuth
  /** Optional hardware profile, used by the model-fit advisor. */
  hardware?: HardwareProfile
}

export type ModelInfo = {
  /** Bare ID — what gets passed to the provider's generate call. */
  id: string
  /** Human-readable label. */
  displayName: string
  /** Whether this model can produce text completions. False = filter out. */
  supportsGenerate: boolean
  /** Coarse tier classification used to pre-populate dropdown groups. */
  tier: Tier | 'other'
}
