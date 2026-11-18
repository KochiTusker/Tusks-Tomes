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
import { GEMINI_FLASH, GEMINI_PRO } from '@shared/models/catalogue'

// Vite always defines `import.meta.env`; the site's cost script
// (scripts/site/compute-costs.ts) imports this file under tsx, where it is
// undefined, so read it defensively.
const env: Record<string, unknown> = import.meta.env ?? {}
const ENV_MODEL_PRO = (env.VITE_MODEL_PRO as string | undefined) ?? ''
const ENV_MODEL_FLASH = (env.VITE_MODEL_FLASH as string | undefined) ?? ''

export const MODEL_PRO = ENV_MODEL_PRO || GEMINI_PRO
export const MODEL_FLASH = ENV_MODEL_FLASH || GEMINI_FLASH


// Legacy alias used as the default in gemini.ts when no opts.model is set.
export const PRIMARY_MODEL = MODEL_PRO

// Chunk sizes live in src/features/pipeline/lib/chunking.ts (per-provider for cloud, a single
// conservative table for local). Pacing between cloud chunks is now driven
// by each provider's RateLimitState (see src/features/providers/lib/rateLimit.ts) — the old
// 65-second `INTER_CHUNK_DELAY_MS` constant was tuned for Claude Tier 1 and
// is no longer needed.

// Gemini 2.5 Pro/Flash both support up to 65,536 output tokens. We default
// to 32,768 — comfortably above what any single chunk needs (~4× the typical
// chunk-output size) so the model is never cut off mid-paragraph. Override
// via VITE_MAX_OUTPUT_TOKENS if a future model supports more (or you want
// to clamp lower to fail fast). 8,192 was the old default and turned out
// to be too tight for grounding work where output ≈ input length.
const ENV_MAX_OUT = Number(env.VITE_MAX_OUTPUT_TOKENS ?? '')
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
/** Uncommitted per-phase routing edits. The Settings tab unmounts on a tab
 *  switch (its panels probe CLIs on mount, so keeping it mounted would run
 *  those probes at every boot), which discarded a staged routing change with
 *  no warning. Parking the draft here survives the unmount; it is cleared the
 *  moment the draft is either saved or reverted. */
export const LS_ROUTING_DRAFT = 'routing_draft'
/** Persisted across runs (independent of LS_REFINEMENT) so a returning
 *  user gets back their last-picked combination of Chronicle / Extras /
 *  Condensed. Survives a refinement state reset. */
export const LS_OUTPUT_SELECTION = 'output_selection'

/** One tick, two surfaces: the catalogue browser's "lower-performing and
 *  small" filter and the per-phase routing dropdowns read the same flag, so a
 *  user who goes looking for a small model finds it offered where they then
 *  have to pick it. Persisted because the Settings tab unmounts on a tab
 *  switch, and because the Reforge picker lives on a different tab entirely. */
export const LS_SHOW_ALL_MODELS = 'show_all_models'

/** The multitrack upload in progress: which session on disk the Upload
 *  panel is building, which parts are already committed, and whether
 *  transcription has started. The server keeps running whichever of those
 *  it was asked to do; what a page reload lost was the client's only
 *  pointer to it, so the panel came back blank over a live session. The
 *  staged File objects cannot be persisted and are not part of this. */
export const LS_UPLOAD_SESSION = 'upload_session'

