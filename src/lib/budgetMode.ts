// Helpers for the "Budget mode" preset in the hybrid routing UI.
// Swaps every phase to the fast-tier model for the active cloud provider.
// Defaults are conservative — these are the cheapest-per-token current
// flagship-fast models on each provider as of 2026:
//   - Gemini: gemini-2.5-flash
//   - Claude: claude-haiku-4-5
//   - OpenAI: gpt-5-mini
//
// The helper is pure so the UI can render-test it without React state.

import type { CloudProvider } from './profiles'
import type { GeminiTier, PhaseRouteEntry, RoutingDocument } from './routing'

export const BUDGET_FAST_MODELS: Record<CloudProvider, string> = {
  gemini: 'gemini-2.5-flash',
  claudeCode: 'haiku',
  codex: 'gpt-5-mini',
  // Cheapest catalogue model that is unmoderated (the prose phases get refused
  // otherwise), supports structured outputs (audit and extras emit JSON), and
  // declares an output ceiling above our 32,768 default.
  openrouter: 'openai/gpt-oss-120b',
}

/** Phases that the Hybrid Routing UI exposes as per-phase overrides. */
export const ROUTABLE_PHASES = ['phase1', 'phase2', 'phase3', 'phase4', 'phase6'] as const
type RoutablePhase = (typeof ROUTABLE_PHASES)[number]

/**
 * Build the `perPhase` override map a user gets when they click "Budget
 * mode" in the hybrid routing editor. Every phase routes to the fast-tier
 * model for the chosen provider.
 *
 * For Gemini we propagate the user's current `geminiTier` so a free-tier
 * user stays on the free key — Flash is free-available, so the resulting
 * overrides are usable without an upgrade.
 */
export function buildBudgetModePerPhase(
  provider: CloudProvider,
  geminiTier: GeminiTier | undefined,
): NonNullable<RoutingDocument['perPhase']> {
  const modelId = BUDGET_FAST_MODELS[provider]
  const perPhase: NonNullable<RoutingDocument['perPhase']> = {}
  for (const phase of ROUTABLE_PHASES) {
    const entry: PhaseRouteEntry = {
      target: 'cloud',
      cloudProvider: provider,
      modelId,
    }
    if (provider === 'gemini') {
      entry.geminiTier = geminiTier ?? 'auto'
    }
    perPhase[phase as RoutablePhase] = entry
  }
  return perPhase
}

/**
 * Gemini-specific "Smart Budget" recommendation. v1.1.0 policy: the Free
 * key is only used for Phase 4 (extras) — the smallest JSON-shaped phase,
 * where the ~10 RPM Free Flash quota is comfortable on a real session.
 * Every other phase runs on the Paid key. This reflects the practical
 * reality that Free-tier Gemini cannot carry the main pipeline (Free Pro
 * is 2 RPM; Free Flash on long grounding chunks still produced long
 * pacing pauses), and that the project ships as free/open-source whose
 * only cost is the user's chosen Paid API key.
 *
 * Per-phase rationale:
 *   - Phase 1 (ground)    : Paid Flash — substitution-heavy work; Flash
 *                           is enough quality and Paid avoids the 30s
 *                           pacing waits that made Free unusable.
 *   - Phase 2 (audit)     : Paid Flash — bigger Paid chunks dilute the
 *                           PROHIBITED_CONTENT meta-filter (probe
 *                           evidence in `.diagnose/brody-probe-*.json`);
 *                           audit usually returns `[]` so per-token
 *                           cost is negligible (~$0.001/run).
 *   - Phase 3 (chronicle) : Paid Pro — load-bearing quality phase;
 *                           Pro's narrative prose is the differentiator.
 *   - Phase 4 (extras)    : **Free Flash** — JSON extraction with low
 *                           input volume. The only phase that uses
 *                           your Free key under v1.1.0 policy. Tiny
 *                           output (~few KB) easily fits Free's quota
 *                           even on a long session. Falls back to Paid
 *                           via chunkedGenerate's safety net on the
 *                           rare PROHIBITED_CONTENT / 5xx case.
 *   - Phase 6 (condense)  : Paid Flash-Lite — prose compression;
 *                           Flash-Lite at 1/30th the cost of Pro.
 *
 * Requires both a Paid Gemini key AND a Free Gemini key configured —
 * the UI gates the button on that condition. The escalation safety net
 * in `chunkedGenerate` (Free→Paid retry on PROHIBITED_CONTENT or
 * transient 5xx) is only active for Phase 4 under this policy, since
 * Phase 4 is the only phase that ever dispatches to Free.
 */
export const GEMINI_HYBRID_RECOMMENDED: Record<RoutablePhase, { tier: GeminiTier; model: string }> = {
  phase1: { tier: 'paid', model: 'gemini-2.5-flash' },
  phase2: { tier: 'paid', model: 'gemini-2.5-flash' },
  phase3: { tier: 'paid', model: 'gemini-2.5-pro' },
  phase4: { tier: 'free', model: 'gemini-2.5-flash' },
  phase6: { tier: 'paid', model: 'gemini-2.5-flash-lite' },
}

/** Build the perPhase override map for the Gemini Smart Budget preset.
 *  Gemini-only — the function returns null for non-Gemini providers so
 *  the UI can hide / disable the button cleanly. */
export function buildGeminiSmartBudgetPerPhase(
  provider: CloudProvider,
): NonNullable<RoutingDocument['perPhase']> | null {
  if (provider !== 'gemini') return null
  const perPhase: NonNullable<RoutingDocument['perPhase']> = {}
  for (const phase of ROUTABLE_PHASES) {
    const rec = GEMINI_HYBRID_RECOMMENDED[phase]
    perPhase[phase] = {
      target: 'cloud',
      cloudProvider: 'gemini',
      geminiTier: rec.tier,
      modelId: rec.model,
    }
  }
  return perPhase
}

/** Human-readable summary of the Gemini Smart Budget preset. Used by
 *  the UI to render the tooltip + the post-apply toast. */
/** Rough saving vs All-Pro. Pro only on Phase 3. */
export const GEMINI_SMART_BUDGET_SAVING_PCT = 60

export const GEMINI_SMART_BUDGET_SUMMARY =
  'Paid Flash for Phase 1+2 (grounding + audit), Paid Pro for Phase 3 (chronicle, the quality phase), Free Flash for Phase 4 (extras — the only phase that uses your Free key under v1.1.0 policy), Paid Flash-Lite for Phase 6 (condense). Cheaper than All-Pro on the prose-critical phases; uses your Free key only for the small JSON extraction step where its rate limits are comfortable. Requires both Paid AND Free Gemini keys configured.'

// ────────────────────────────────────────────────────────────────────
// Quality Budget — the middle tier. Pro for grounding/audit/chronicle/
// condense (the phases whose output quality matters most), Flash (NOT
// Flash-Lite) for extras (JSON extraction with enough nuance to dedup
// good quotes from filler dialogue). Aimed at ~half the cost of
// All-Pro with ~90% of the quality.
// ────────────────────────────────────────────────────────────────────

export const GEMINI_QUALITY_BUDGET_RECOMMENDED: Record<RoutablePhase, { tier: GeminiTier; model: string }> = {
  phase1: { tier: 'paid', model: 'gemini-2.5-pro' },         // sharper grounding, profanity preserved
  phase2: { tier: 'paid', model: 'gemini-2.5-pro' },         // smarter audit, fewer noisy questions
  phase3: { tier: 'paid', model: 'gemini-2.5-pro' },         // chronicle quality, unchanged from Smart Budget
  phase4: { tier: 'paid', model: 'gemini-2.5-flash' },       // bumped from Flash-Lite — tighter quote/jest/gore picks
  phase6: { tier: 'paid', model: 'gemini-2.5-pro' },         // bumped from Flash-Lite — longer, denser condense
}

export function buildGeminiQualityBudgetPerPhase(
  provider: CloudProvider,
): NonNullable<RoutingDocument['perPhase']> | null {
  if (provider !== 'gemini') return null
  const perPhase: NonNullable<RoutingDocument['perPhase']> = {}
  for (const phase of ROUTABLE_PHASES) {
    const rec = GEMINI_QUALITY_BUDGET_RECOMMENDED[phase]
    perPhase[phase] = {
      target: 'cloud',
      cloudProvider: 'gemini',
      geminiTier: rec.tier,
      modelId: rec.model,
    }
  }
  return perPhase
}


// ────────────────────────────────────────────────────────────────────
// Caption route — for users with NO local transcription.
//
// Someone without Whisper is importing YouTube captions, and a caption file
// carries no speaker labels at all: it is one undifferentiated stream of text.
// That moves the hard work onto the model. Phase 1 has to infer who is
// speaking from context alone, and Phase 2 is where the "who said this?"
// clarifications are generated — the questions that let the user fill the gaps
// the audio never provided.
//
// Flash is noticeably weaker at both. It under-asks: it guesses an attribution
// and moves on, and a confidently wrong speaker is far worse than a question.
// So this preset puts Pro on every judgement phase and leaves Flash only on
// Phase 4, which is bounded extraction rather than inference.
//
// Costs more than the Flash-heavy presets, and it should — this is the
// configuration where model quality is doing the job the recording didn't.
// ────────────────────────────────────────────────────────────────────

export const GEMINI_CAPTION_ROUTE_RECOMMENDED: Record<RoutablePhase, { tier: GeminiTier; model: string }> = {
  phase1: { tier: 'paid', model: 'gemini-pro-latest' }, // infer speakers from context
  phase2: { tier: 'paid', model: 'gemini-pro-latest' }, // ask good clarifying questions
  phase3: { tier: 'paid', model: 'gemini-pro-latest' }, // narrative prose
  phase4: { tier: 'paid', model: 'gemini-flash-latest' }, // extraction — Flash is fine
  phase6: { tier: 'paid', model: 'gemini-pro-latest' }, // condense without losing attribution
}

/** Per-phase routing for someone transcribing via YouTube captions rather
 *  than locally. Gemini only, Pro everywhere it matters. */
export function buildGeminiCaptionRoutePerPhase(): NonNullable<RoutingDocument['perPhase']> {
  const perPhase: NonNullable<RoutingDocument['perPhase']> = {}
  for (const phase of ROUTABLE_PHASES) {
    const rec = GEMINI_CAPTION_ROUTE_RECOMMENDED[phase]
    perPhase[phase] = {
      target: 'cloud',
      cloudProvider: 'gemini',
      geminiTier: rec.tier,
      modelId: rec.model,
    }
  }
  return perPhase
}

export const CAPTION_ROUTE_SUMMARY =
  'Gemini Pro on grounding, audit, chronicle and condense, with Flash on extras. Recommended when you ' +
  'have no local transcription: YouTube captions carry no speaker labels, so the model has to work out ' +
  'who said what — and Pro both guesses better and, more usefully, asks more when it is unsure.'

// ────────────────────────────────────────────────────────────────────
// All-Pro — the maximum quality tier. Everything on gemini-2.5-pro.
// Matches the "old" pre-cost-cutting baseline.
// ────────────────────────────────────────────────────────────────────

export const GEMINI_ALL_PRO_RECOMMENDED: Record<RoutablePhase, { tier: GeminiTier; model: string }> = {
  phase1: { tier: 'paid', model: 'gemini-2.5-pro' },
  phase2: { tier: 'paid', model: 'gemini-2.5-pro' },
  phase3: { tier: 'paid', model: 'gemini-2.5-pro' },
  phase4: { tier: 'paid', model: 'gemini-2.5-pro' },
  phase6: { tier: 'paid', model: 'gemini-2.5-pro' },
}

export function buildGeminiAllProPerPhase(
  provider: CloudProvider,
): NonNullable<RoutingDocument['perPhase']> | null {
  if (provider !== 'gemini') return null
  const perPhase: NonNullable<RoutingDocument['perPhase']> = {}
  for (const phase of ROUTABLE_PHASES) {
    const rec = GEMINI_ALL_PRO_RECOMMENDED[phase]
    perPhase[phase] = {
      target: 'cloud',
      cloudProvider: 'gemini',
      geminiTier: rec.tier,
      modelId: rec.model,
    }
  }
  return perPhase
}


// ────────────────────────────────────────────────────────────────────
// Measured Hybrid — derived from a Session 29 A/B rather than from
// guesswork. Every figure below was measured on real chunks with real
// token counts, priced with src/lib/pricing.ts.
//
// What the test found:
//   - Thinking tokens bill at the OUTPUT rate. On Pro they were 55-80% of
//     Phase 3's billed output — the single largest line item, and never
//     previously measured.
//   - Disabling thinking is NOT safe: with thinking off, Flash misattributed
//     dialogue to the wrong character. Thinking stays ON everywhere here.
//   - With thinking ON, latest Flash matched latest Pro on chronicle quality
//     for 72-83% less. That is the trade this preset takes.
//
// Model ids are the floating `-latest` aliases so the preset tracks each
// tier's newest release without a code change. Pricing is per TIER, not per
// generation (see pricing.ts: gemini-3-pro costs the same as gemini-2.5-pro),
// so tracking latest is free. rateFor() resolves these aliases by substring.
// ────────────────────────────────────────────────────────────────────

export const GEMINI_MEASURED_HYBRID_RECOMMENDED: Record<RoutablePhase, { tier: GeminiTier; model: string }> = {
  phase1: { tier: 'paid', model: 'gemini-flash-latest' },  // mechanical substitution; Pro adds nothing
  phase2: { tier: 'paid', model: 'gemini-flash-latest' },  // short JSON audit
  phase3: { tier: 'paid', model: 'gemini-flash-latest' },  // matched Pro in the A/B, thinking ON
  phase4: { tier: 'paid', model: 'gemini-flash-latest' },  // already Flash in practice
  phase6: { tier: 'paid', model: 'gemini-flash-latest' },  // Flash read RICHER than Pro here
}

export function buildGeminiMeasuredHybridPerPhase(
  provider: CloudProvider,
): NonNullable<RoutingDocument['perPhase']> | null {
  if (provider !== 'gemini') return null
  const perPhase: NonNullable<RoutingDocument['perPhase']> = {}
  for (const phase of ROUTABLE_PHASES) {
    const rec = GEMINI_MEASURED_HYBRID_RECOMMENDED[phase]
    perPhase[phase] = { target: 'cloud', cloudProvider: 'gemini', geminiTier: rec.tier, modelId: rec.model }
  }
  return perPhase
}

/** Rough saving vs the All-Pro baseline (Pro everywhere, thinking on),
 *  from the Session 29 measurement. Surfaced on the preset chip. */
export const GEMINI_MEASURED_HYBRID_SAVING_PCT = 77

export const GEMINI_MEASURED_HYBRID_SUMMARY =
  'Latest Paid Flash on every phase, with thinking left ON. Measured against the latest Pro on a full-length session: ' +
  'chronicle quality was comparable, at 72-83% less per chunk. Thinking is deliberately NOT disabled — ' +
  'switching it off made Flash misattribute dialogue to the wrong character. Tracks the newest model in ' +
  'each tier automatically via the -latest aliases. Requires a Paid Gemini key.'

// ══════════════════════════════════════════════════════════════════
// Preset ladder — the simple, non-advanced routing view.
//
// Each rung is a complete routing recipe applied with one click, annotated
// with a rough saving vs the MAXIMUM QUALITY baseline (latest pro-tier
// model on every phase, thinking on). Percentages marked "measured" come
// from the Session 29 A/B (real chunks, real token counts, priced via
// src/lib/pricing.ts); "estimated" rungs extrapolate from those
// measurements. Builders that route phases to claudeCode / codex require
// the matching add-on to be loaded — the ladder UI gates availability;
// the builders themselves just emit the recipe.
// ══════════════════════════════════════════════════════════════════

export type PresetLadderRungId =
  | 'max-quality'
  | 'balanced-thinking'
  | 'balanced-fast'
  | 'measured-hybrid'
  | 'free-subscription'
  | 'openrouter-best'
  | 'openrouter-hybrid'

export type SubscriptionTarget = 'claudeCode' | 'codex'

/** Latest pro-tier models per API provider for the Maximum Quality rung.
 *  Gemini uses the floating -latest alias so the rung tracks new releases;
 *  pricing is per tier, so tracking latest costs nothing extra. */
const MAX_QUALITY_MODELS: Record<'gemini' | 'claude' | 'openai' | 'openrouter', string> = {
  gemini: 'gemini-pro-latest',
  claude: 'claude-opus-4-8',
  openai: 'gpt-5',
  // Namespaced id — OpenRouter passes Anthropic pricing straight through, so
  // this is the same model at the same rate, reached by a different key.
  openrouter: 'anthropic/claude-opus-4.8',
}

function cloudEntry(
  cloudProvider: CloudProvider,
  modelId: string,
  geminiTier?: GeminiTier,
): PhaseRouteEntry {
  return {
    target: 'cloud',
    cloudProvider,
    ...(cloudProvider === 'gemini' ? { geminiTier: geminiTier ?? 'paid' } : {}),
    modelId,
  }
}

function allPhasesEntry(entry: PhaseRouteEntry): NonNullable<RoutingDocument['perPhase']> {
  const perPhase: NonNullable<RoutingDocument['perPhase']> = {}
  for (const phase of ROUTABLE_PHASES) perPhase[phase] = { ...entry }
  return perPhase
}

/** Maximum Quality — the 0% baseline every other rung's saving is quoted
 *  against. Latest pro-tier model on every phase; thinking stays on (the
 *  Session 29 A/B showed disabling it causes dialogue misattribution). */
export function buildMaxQualityPerPhase(
  provider: CloudProvider,
): NonNullable<RoutingDocument['perPhase']> | null {
  if (provider !== 'gemini' && provider !== 'openrouter') return null
  return allPhasesEntry(cloudEntry(provider, MAX_QUALITY_MODELS[provider]))
}


// ══════════════════════════════════════════════════════════════════
// OpenRouter rungs
//
// Both are built from the 2026-08-18/19 bake-offs rather than from price
// lists, and both state plainly where the evidence stops.
//
// Per-phase picks, and why:
//
//   Ground   Qwen3 30B A3B — graded B, at roughly a twenty-fifth of the
//            reference price, with output length and every speaker tag
//            preserved exactly. Ground is the largest block of calls in a
//            session, so this is where cheap actually shows up in the bill.
//   Audit    the same model. Audit was NOT measured — no model has a grade on
//            it — so this is inference from the sibling mechanical phase, not
//            a result. Flagged rather than dressed up.
//   Chronicle DeepSeek V4 Pro — graded B+, the best non-Gemini chronicle
//            measured. Note it did NOT beat Gemini, which took A-; it is
//            close, and far cheaper.
//   Extras   GLM 5.2 — graded B-, against C- for both Gemini tiers. This is
//            the one phase where OpenRouter models genuinely outperform
//            Gemini rather than merely undercutting it.
//   Condense ungraded. Uses the Chronicle pick, prose being the closest
//            proxy available.
// ══════════════════════════════════════════════════════════════════

/** Best-graded OpenRouter model per phase. */
const OPENROUTER_BEST: Record<RoutablePhase, string> = {
  phase1: 'qwen/qwen3-30b-a3b-instruct-2507',
  phase2: 'qwen/qwen3-30b-a3b-instruct-2507',
  phase3: 'deepseek/deepseek-v4-pro',
  phase4: 'z-ai/glm-5.2',
  phase6: 'deepseek/deepseek-v4-pro',
}

/** All phases on OpenRouter. One key, no Gemini, no subscription CLI. */
export function buildOpenRouterBestPerPhase(): NonNullable<RoutingDocument['perPhase']> {
  return {
    phase1: cloudEntry('openrouter', OPENROUTER_BEST.phase1),
    phase2: cloudEntry('openrouter', OPENROUTER_BEST.phase2),
    phase3: cloudEntry('openrouter', OPENROUTER_BEST.phase3),
    phase4: cloudEntry('openrouter', OPENROUTER_BEST.phase4),
    phase6: cloudEntry('openrouter', OPENROUTER_BEST.phase6),
  }
}

export const OPENROUTER_BEST_SAVING_PCT = 93
export const OPENROUTER_BEST_SUMMARY =
  'Every phase on OpenRouter, each on the best model measured for that phase. One API key, no Gemini, ' +
  'no subscription needed. Extras is genuinely better than Gemini here; Chronicle is close but a step below.'

/** Subscription CLI on the mechanical phases, OpenRouter for everything else
 *  — including the repair when the CLI refuses a chunk. That last part is the
 *  point of this rung: the failsafe used to require a Gemini key, so this
 *  recipe was previously impossible to run without one. */
export function buildOpenRouterHybridPerPhase(
  sub: SubscriptionTarget,
): NonNullable<RoutingDocument['perPhase']> {
  const subFast = sub === 'claudeCode' ? 'haiku' : 'gpt-5-mini'
  const subMain = sub === 'claudeCode' ? 'sonnet' : 'default'
  return {
    phase1: cloudEntry(sub, subMain),
    phase2: cloudEntry(sub, subFast),
    phase3: cloudEntry('openrouter', OPENROUTER_BEST.phase3),
    phase4: cloudEntry('openrouter', OPENROUTER_BEST.phase4),
    phase6: cloudEntry('openrouter', OPENROUTER_BEST.phase6),
  }
}

export const OPENROUTER_HYBRID_SAVING_PCT = 94
export const OPENROUTER_HYBRID_SUMMARY =
  'Grounding + audit on your subscription CLI (free), every prose phase on OpenRouter, and refused chunks ' +
  'repaired on OpenRouter too rather than needing a Gemini key. No Gemini key required anywhere.'

export const MAX_QUALITY_SAVING_PCT = 0
export const MAX_QUALITY_SUMMARY =
  'The latest pro-tier model on every phase, thinking on. Maximum quality, maximum cost — this is the ' +
  'baseline every other preset saving is measured against. Requires the matching API key.'

/** Balanced — grounding + audit offloaded to the subscription CLI (free),
 *  prose phases on Gemini. Pro stays on the prose phases; the
 *  all-Flash variant this used to offer was byte-identical to Measured
 *  Hybrid, so it lives there instead. Gemini thinking budgets stay at their
 *  defaults — the Session 29 A/B showed disabling thinking causes dialogue
 *  misattribution, so no rung turns it off. */
export function buildBalancedPerPhase(
  sub: SubscriptionTarget,
): NonNullable<RoutingDocument['perPhase']> {
  const subFast = sub === 'claudeCode' ? 'haiku' : 'gpt-5-mini'
  const subMain = sub === 'claudeCode' ? 'sonnet' : 'default'
  return {
    phase1: cloudEntry(sub, subMain),
    phase2: cloudEntry(sub, subFast),
    phase3: cloudEntry('gemini', 'gemini-pro-latest'),
    phase4: cloudEntry('gemini', 'gemini-flash-latest'),
    phase6: cloudEntry('gemini', 'gemini-pro-latest'),
  }
}

export const BALANCED_THINKING_SAVING_PCT = 40 // estimated: free P1/P2 + measured P4 flash
export const BALANCED_THINKING_SUMMARY =
  'Grounding + audit on your subscription CLI (free), chronicle + condense on the latest Gemini Pro with ' +
  'thinking on, extras on latest Flash. Estimated ~40% cheaper than Maximum Quality with near-identical prose.'

/** Measured Hybrid — the best cost/quality balance found in the Session 29
 *  A/B: subscription CLI for the mechanical phases, latest paid Flash
 *  (thinking ON) for every prose/judgement phase. Flash matched Pro on
 *  chronicle quality in blind comparison at 72-83% less per chunk. */
export function buildMeasuredHybridSubPerPhase(
  sub: SubscriptionTarget,
): NonNullable<RoutingDocument['perPhase']> {
  const subFast = sub === 'claudeCode' ? 'haiku' : 'gpt-5-mini'
  const subMain = sub === 'claudeCode' ? 'sonnet' : 'default'
  return {
    phase1: cloudEntry(sub, subMain),
    phase2: cloudEntry(sub, subFast),
    phase3: cloudEntry('gemini', 'gemini-flash-latest'),
    phase4: cloudEntry('gemini', 'gemini-flash-latest'),
    phase6: cloudEntry('gemini', 'gemini-flash-latest'),
  }
}

export const MEASURED_HYBRID_SUB_SAVING_PCT = 85 // 77% measured for all-Gemini-Flash; free CLI P1/P2 adds the rest
export const MEASURED_HYBRID_SUB_SUMMARY =
  'The routing this app\u2019s own A/B testing converged on: grounding + audit on your subscription CLI ' +
  '(free), everything else on the latest paid Gemini Flash with thinking ON. Blind-judged comparable to Pro ' +
  'at a fraction of the cost. Roughly 85% cheaper than Maximum Quality (77% of that measured; the rest from ' +
  'the free CLI phases).'

/** Free — every phase on the subscription CLI. No API keys, no per-token
 *  cost. Ships with an explicit measured quality caveat — see the summary. */
export function buildFreeSubscriptionPerPhase(
  sub: SubscriptionTarget,
): NonNullable<RoutingDocument['perPhase']> {
  const subFast = sub === 'claudeCode' ? 'haiku' : 'gpt-5-mini'
  const subMain = sub === 'claudeCode' ? 'sonnet' : 'default'
  return {
    phase1: cloudEntry(sub, subMain),
    phase2: cloudEntry(sub, subFast),
    phase3: cloudEntry(sub, subMain),
    phase4: cloudEntry(sub, subMain),
    phase6: cloudEntry(sub, subMain),
  }
}

export const FREE_SUBSCRIPTION_SAVING_PCT = 100
export const FREE_SUBSCRIPTION_SUMMARY =
  'Every phase runs on your subscription CLI — no API keys, no per-token cost. Measured quality caveat ' +
  'in testing: the CLI completed mechanical grounding 15/15 but refused the analytical audit on 14/15 ' +
  'chunks, and its funny/notable-moment judgement trails Gemini. Use for zero-budget runs; if the usage ' +
  'window runs out mid-run, the run auto-pauses and resumes exactly where it stopped.'

// ════════════════════════════════════════════════════════════════════
// Claude presets — mirror of the Gemini three-preset structure.
// Cheapest:  Haiku everywhere. Sonnet chronicle as the bare-min quality
//            anchor. Cost is dominated by Sonnet's chronicle.
// Balanced:  Haiku grounding/audit/extras, Sonnet chronicle/condense.
// Best:      Opus chronicle/condense, Sonnet grounding/audit, Haiku extras
//            (Opus on every phase is overkill; chronicle is the load-bearing
//             quality phase, condense benefits from frontier prose).
// ════════════════════════════════════════════════════════════════════

type ClaudePhaseEntry = { model: string }


