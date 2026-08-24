// Unified abstraction for cloud + local LLMs (ROADMAP Step 3).
//
// Pipeline phases call `provider.generate({ systemPrompt, userPrompt, ... })`
// instead of hitting a provider's SDK directly. Each provider implementation
// (Gemini today; Claude in Step 4; OpenAI in Step 5; local backends in Step 13)
// adapts the unified request to its native API, threads cacheable content
// through whatever caching mechanism the API offers, and reports token usage
// in a consistent shape.

export type ProviderName = 'gemini' | 'claude' | 'openai' | 'local' | 'claudeCode' | 'codex' | 'openrouter'

export type GenerateRequest = {
  systemPrompt: string
  /** Optional extra cacheable content (KB / glossary). Concatenated after systemPrompt for providers without cache primitives. */
  cacheablePrefix?: string
  userPrompt: string
  /** Concrete model identifier passed to the provider's API. */
  model: string
  maxOutputTokens: number
  temperature?: number
  responseFormat?: 'text' | 'json'
  /** 'permissive' loosens user-tier safety filters for mature TTRPG content. Provider may ignore if not supported. */
  safetyMode?: 'permissive' | 'default'
  /** Gemini-only: per-call thinking budget (Gemini 2.5+ / 3.x).
   *    undefined → SDK default (model decides; usually -1 = AUTOMATIC).
   *    0         → DISABLED. Cheaper for mechanical phases that don't
   *                 benefit from reasoning (grounding, audit, extras,
   *                 condense). Hardcoded undefined on Phase 3 chronicle
   *                 — the user-facing toggle CANNOT disable thinking on
   *                 the chronicle phase to prevent voice degradation.
   *    > 0       → explicit cap on thinking tokens.
   *  Non-Gemini providers ignore this field. */
  thinkingBudget?: number
}

export type Usage = {
  inputTokens: number
  cachedInputTokens?: number
  outputTokens: number
  /**
   * Tokens spent on internal reasoning, when the provider reports them.
   *
   * These are BILLED AS OUTPUT on every provider that charges for them, but
   * they arrive in a separate field and are easy to drop. Gemini reports them
   * as `thoughtsTokenCount`, distinct from `candidatesTokenCount`, and until
   * 2026-08-18 this codebase recorded only the latter — so both the cost
   * estimate and the actual-usage figure understated real spend by several
   * times on any phase with thinking enabled.
   */
  thinkingTokens?: number
  /** Actual USD charged for this call, when the provider reports it.
   *  OpenRouter returns `usage.cost` on every response with no opt-in, which
   *  makes it the only provider we can bill-match rather than estimate. Left
   *  undefined everywhere else; callers must fall back to estimateCost(). */
  costUsd?: number
}

export type GenerateResponse = {
  text: string
  usage: Usage
}

/**
 * Out-of-band events a provider may surface mid-call so the pipeline can
 * react (e.g. open a dialog when a free-tier key hits its daily quota).
 * Stays separate from `GenerateResponse` because these don't replace the
 * call's return value — the call may still succeed after the event fires.
 */
export type ProviderEvent =
  | {
      kind: 'quota_exhausted'
      provider: ProviderName
      /** 'rate_limit' = per-minute RPM; 'daily_quota' = won't recover until reset. */
      quotaKind: 'rate_limit' | 'daily_quota'
      /** Free / paid / auto tier (Gemini); other providers report 'paid'. */
      tier: 'free' | 'paid' | 'auto'
      /** Model id at the time of exhaustion. */
      model: string
      /** Short SHA-256 prefix of the active key, when available. Matches the
       *  fingerprint shown in Settings → API Keys → Probe so the user can
       *  see which physical key got rate-limited. */
      keyFingerprint?: string
      /** Approximate count of requests the provider singleton has sent in the
       *  last 60 seconds (best-effort, drawn from in-memory call history).
       *  Lets the dialog say "you've made N requests" instead of being vague. */
      requestsInLastMinute?: number
      /** Provider's published per-minute cap for (tier, model). Static for
       *  Gemini (from GEMINI_STATIC_LIMITS), header-derived for Claude/OpenAI. */
      rpmCap?: number
      /** Provider's published per-minute input-token cap for (tier, model). */
      tpmCap?: number
      /** True for Gemini auto-tier singletons that have already swapped to
       *  the Free key in this run via `useFallback`. The dialog uses this to
       *  disable the "Switch to paid" button, which would be a no-op (Paid
       *  is already exhausted; swapping back wouldn't recover anything).
       *  Always false for tier-locked ('paid'/'free') singletons since they
       *  can't auto-swap in the first place. */
      permanentlyOnFallback?: boolean
    }
  | {
      kind: 'auto_fallback'
      provider: ProviderName
      /** Which fallback path fired — useful for the dialog's copy. */
      reason: 'hard_zero_quota' | 'repeated_exhaustion'
    }

export type GenerateOptions = {
  signal?: AbortSignal
  /** Free-form label prepended to error messages, e.g. "Phase 1 — chunk 3/7". */
  contextLabel?: string
  onRetry?: (attempt: number, waitMs: number) => void
  /** Provider may emit out-of-band events (quota exhaustion, auto-fallback). */
  onProviderEvent?: (event: ProviderEvent) => void
  /**
   * Opaque handle returned by `createPrefixCache()` earlier in the phase.
   * When set, the provider sends only `req.userPrompt` over the wire and
   * the cached system + cacheablePrefix is referenced by handle — saving
   * the prefix bytes on every chunk after the first.
   */
  cachedContentHandle?: string
}

export interface LLMProvider {
  readonly name: ProviderName
  generate(req: GenerateRequest, opts?: GenerateOptions): Promise<GenerateResponse>
  /** Suggested model IDs; users can override with any string. */
  listModels(): Promise<string[]>
  /** Optional rough cost estimate in USD for the given usage on the given model. */
  estimateCost?(usage: Usage, model: string): number
  /**
   * ms the pipeline should wait before the next chunk, given the next
   * chunk's estimated input-token budget. Cloud providers consult their
   * RateLimitState; local providers (and others without rate limits)
   * return 0. Returning 0 means "go now"; the pipeline applies this
   * value as a pre-call gate.
   *
   * `extraMultiplier` (default 1.0) is a user-controlled "slow down" dial
   * from the rate-limit dialog. 3.0 paces 3× more slowly than the
   * provider's natural rate to avoid thrashing a free-tier key.
   *
   * `modelId` lets a provider keep one budget per model rather than one per
   * key. It matters whenever a run mixes models: a 2 RPM model and a 1000 RPM
   * model sharing a single anchor means each is paced as though it were the
   * other. Optional and additive — providers that serve one model at a time
   * ignore it and behave exactly as before.
   */
  getNextDelayMs?(
    estimatedInputTokens: number,
    extraMultiplier?: number,
    modelId?: string,
  ): number
  /**
   * Optional: register the per-phase stable prefix (system prompt + KB +
   * cacheable hints) as a server-side cache so subsequent chunks don't
   * re-ship those bytes. Returns an opaque handle the caller passes back
   * to `generate()` via `opts.cachedContentHandle`, or null when the
   * provider couldn't cache (prefix too small for the provider's
   * minimum, transient error, provider doesn't support explicit
   * caching).
   *
   * Only Gemini implements this today — Claude uses inline
   * `cache_control: ephemeral` blocks per call, and OpenAI auto-caches
   * prefixes above 1024 tokens. For those providers the method is
   * absent; callers should check before invoking.
   */
  createPrefixCache?(req: GenerateRequest): Promise<string | null>
  /** Optional: tear down a cache created by `createPrefixCache`.
   *  Best-effort cleanup — caches are TTL-billed, so leaks just expire
   *  on their own, but explicit deletion is cheap good hygiene. */
  deletePrefixCache?(handle: string): Promise<void>
}
