// What a reference session costs on a model, phase by phase.
import type { OpenRouterModelInfo } from '@/features/providers'
import { CHARS_PER_TOKEN, DEFAULT_SIZING, OUTPUT_RATIO } from './judge'
import { PHASE_ORDER } from './scale'
import type { Phase } from './scale'

// ────────────────────────────────────────────────────────────────────
// Session cost
// ────────────────────────────────────────────────────────────────────

/** A three-hour session with 10,000 words of lore — the reference workload. */
export const REFERENCE_SESSION = {
  /** ~285 KB of SBV on disk, less the timestamp lines. */
  transcriptChars: 220_000,
  /** 10,000 words at ~5.8 characters per word including spaces. */
  loreChars: 58_000,
  label: '3-hour session, 10,000 words of lore',
} as const

/**
 * Cost of ONE phase on one model, for the reference session.
 *
 * The picker sorts by this rather than by headline token price, because the
 * two disagree badly. Chronicle emits output at roughly 0.9x its input while
 * Audit emits 0.02x, so a dear model costs very different amounts depending on
 * where it runs; and reasoning bills as output, so a model that cannot switch
 * it off pays it on every call. Sorting a phase's candidates by list price
 * would put them in close to the wrong order.
 */
export function phaseCost(model: OpenRouterModelInfo, phase: Phase): number {
  return referenceSessionCost(model).perPhase.find((p) => p.phase === phase)?.usd ?? 0
}

/**
 * Estimated cost of one reference session on a single model.
 *
 * Uses the same per-phase ratios as the run estimator, and honours prompt-length
 * pricing tiers — Condense carries the whole lore corpus, so it is the phase
 * most likely to cross a threshold.
 */
export function referenceSessionCost(model: OpenRouterModelInfo): {
  usd: number
  perPhase: Array<{ phase: Phase; usd: number; chunks: number }>
} {
  const perPhase: Array<{ phase: Phase; usd: number; chunks: number }> = []
  let total = 0

  for (const phase of PHASE_ORDER) {
    const sizing = DEFAULT_SIZING[phase]
    // Condense reads the chronicle and carries the lore. The chronicle runs
    // ~0.32 of the transcript (measured; see pricing.ts), which is the same
    // number as OUTPUT_RATIO.phase3 because it IS Phase 3's output.
    const corpus =
      phase === 'phase6'
        ? REFERENCE_SESSION.transcriptChars * OUTPUT_RATIO.phase3
        : REFERENCE_SESSION.transcriptChars
    // Condense carries the whole vault; every other phase carries what the
    // sizing table says it carries, which is no longer zero for Audit,
    // Chronicle and Extras.
    const kbChars = phase === 'phase6' ? REFERENCE_SESSION.loreChars : sizing.kbChars
    const chunks = Math.max(1, Math.ceil(corpus / sizing.chunkChars))
    const perChunkCorpus = Math.min(sizing.chunkChars, corpus / chunks)
    // Audit ships the raw AND grounded chunk.
    const corpusMult = phase === 'phase2' ? 2 : 1

    const promptTokens = Math.ceil(
      (perChunkCorpus * corpusMult + kbChars + sizing.overheadChars) / CHARS_PER_TOKEN,
    )
    const outputTokens = Math.ceil((perChunkCorpus / CHARS_PER_TOKEN) * OUTPUT_RATIO[phase])

    // Thinking bills at the output rate. Omitting it understated a measured
    // Gemini bill by ~4.5x, and it changes the comparison here too: a model
    // that cannot switch reasoning off carries that cost on every call, while
    // one that is non-thinking by construction does not.
    const thinkingTokens = Math.ceil(outputTokens * thinkingMultiplier(model, phase))
    const billedOutput = outputTokens + thinkingTokens

    const rate = rateAt(model, promptTokens)
    const usd =
      (promptTokens * rate.inputPerM + billedOutput * rate.outputPerM) * chunks / 1_000_000

    perPhase.push({ phase, usd, chunks })
    total += usd
  }
  return { usd: total, perPhase }
}

/**
 * Thinking tokens as a multiple of visible output, for one model on one phase.
 *
 * Mirrors the ratios in pricing.ts, which were reconciled against real Gemini
 * billing, and then scales them by whether the model can actually be stopped
 * from reasoning:
 *
 *   mandatory      cannot be turned off — full ratio, always
 *   default on     on unless the caller disables it — full ratio assumed here,
 *                  because that is what an unconfigured run gets
 *   opt-in / none  nothing, since the pipeline does not ask for reasoning
 *
 * This is where a non-thinking model earns its keep. Two models at identical
 * headline rates can differ severalfold on a phase that produces long output,
 * purely on whether reasoning can be switched off.
 */
const THINKING_RATIO: Record<Phase, number> = {
  phase1: 0.3,
  phase2: 4.0,
  phase3: 4.8,
  phase4: 2.0,
  phase6: 1.5,
}

export function thinkingMultiplier(model: OpenRouterModelInfo, phase: Phase): number {
  const r = model.reasoning
  if (!r) return 0
  if (!r.mandatory && r.defaultEnabled !== true) return 0
  return THINKING_RATIO[phase]
}

function rateAt(
  model: OpenRouterModelInfo,
  promptTokens: number,
): { inputPerM: number; outputPerM: number } {
  if (!model.pricingTiers?.length) return { inputPerM: model.inputPerM, outputPerM: model.outputPerM }
  let applied: (typeof model.pricingTiers)[number] | null = null
  for (const t of model.pricingTiers) if (promptTokens >= t.minPromptTokens) applied = t
  return applied
    ? { inputPerM: applied.inputPerM, outputPerM: applied.outputPerM }
    : { inputPerM: model.inputPerM, outputPerM: model.outputPerM }
}
