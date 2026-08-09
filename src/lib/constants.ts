// ----- Model configuration -----
//
// Defaults are deliberately set to Gemini 2.5 model IDs which are stable
// and broadly available on billing-enabled projects. Gemini 3.x model IDs
// vary by API version and project access — use the "Check available
// models" button in the UI to see which IDs your key supports, then
// override via .env without changing code:
//   VITE_MODEL_PRO=gemini-3-pro-...        # whatever your key reports
//   VITE_MODEL_FLASH=gemini-3-flash-...
// "Tier-based model selection" under Developer notes in ROADMAP.md is the
// long-term plan here: model lists dynamic / dropdown-driven, so users never
// edit env files at all.
const ENV_MODEL_PRO = (import.meta.env.VITE_MODEL_PRO as string | undefined) ?? ''
const ENV_MODEL_FLASH = (import.meta.env.VITE_MODEL_FLASH as string | undefined) ?? ''

export const MODEL_PRO = ENV_MODEL_PRO || 'gemini-2.5-pro'
export const MODEL_FLASH = ENV_MODEL_FLASH || 'gemini-2.5-flash'


// Legacy alias used as the default in gemini.ts when no opts.model is set.
export const PRIMARY_MODEL = MODEL_PRO

// Chunk sizes live in src/lib/chunking.ts (per-provider for cloud, a single
// conservative table for local). Pacing between cloud chunks is now driven
// by each provider's RateLimitState (see src/lib/rateLimit.ts) — the old
// 65-second `INTER_CHUNK_DELAY_MS` constant was tuned for Claude Tier 1 and
// is no longer needed.

// Gemini 2.5 Pro/Flash both support up to 65,536 output tokens. We default
// to 32,768 — comfortably above what any single chunk needs (~4× the typical
// chunk-output size) so the model is never cut off mid-paragraph. Override
// via VITE_MAX_OUTPUT_TOKENS if a future model supports more (or you want
// to clamp lower to fail fast). 8,192 was the old default and turned out
// to be too tight for grounding work where output ≈ input length.
const ENV_MAX_OUT = Number(import.meta.env.VITE_MAX_OUTPUT_TOKENS ?? '')
export const MAX_OUTPUT_TOKENS =
  Number.isFinite(ENV_MAX_OUT) && ENV_MAX_OUT > 0 ? ENV_MAX_OUT : 32_768

// Per-provider retry constants for non-429 transient failures (5xx, network
// blips). 429s are handled via Retry-After in each provider's catch path.
export const TRANSIENT_RETRY_MS = 35_000
export const EXHAUSTION_RETRY_MS = 65_000
export const MAX_RETRIES = 4

// localStorage keys
export const LS_KB = 'kb_documents'
export const LS_CAMPAIGN = 'campaign'
export const LS_SESSION = 'sessionNumber'
export const LS_REFINEMENT = 'refinement_state'
export const LS_SBV_REPAIR = 'sbv_repair_state'
/** Persisted across runs (independent of LS_REFINEMENT) so a returning
 *  user gets back their last-picked combination of Chronicle / Extras /
 *  Condensed. Survives a refinement state reset. */
export const LS_OUTPUT_SELECTION = 'output_selection'

