// The two checks on a Condense (Phase 6) result: far too short to be real, or
// well over the length the user picked on the slider.
import { toast } from 'sonner'
import type { CondenseOutput } from '@/features/pipeline/lib/types'

/** Phase 6 condense catastrophic-floor — the condense target is now dynamic
 *  (whichever is SHORTER of 2,000 words OR 25% of the chronicle word count;
 *  see `phase6CondenseParts` in `src/features/pipeline/lib/prompts.ts`), so a fixed floor no
 *  longer makes sense. We keep a low absolute floor only to catch the case
 *  where the model produced almost nothing (≤ 200 wc) — that's a sign of an
 *  outright failure (truncated response, malformed JSON parsed empty), not
 *  the legitimate "short condense for a short chronicle" path. */
export const CONDENSE_FLOOR_WC = 200

/** v1.1.0 — symmetric overshoot ratio. If the model returns more than this
 *  multiple of the user's slider-picked target, fire a warning. Matched to
 *  the prompt's ±10% tolerance — a 1.5× output is 50% over and clearly off
 *  contract. Lower than 1.5 would false-positive on borderline cases (the
 *  model is trusted to interpret "approximately N words" liberally); much
 *  higher and the warning rarely fires on genuine overshoots. */
export const CONDENSE_OVERSHOOT_RATIO = 1.5

/** Surface a toast when Phase 6 condense output is catastrophically short.
 *  Called after every completePhase6() — the four call sites (happy path
 *  + two resume paths + the standalone runCondense button) all run this. */
export function warnIfCondenseShort(condensed: CondenseOutput | null | undefined): void {
  const narrative = condensed?.narrative ?? ''
  if (!narrative.trim()) return
  const wc = narrative.trim().split(/\s+/).filter(Boolean).length
  if (wc < CONDENSE_FLOOR_WC) {
    toast.warning(
      `Phase 5 condense produced only ${wc} words. Even a tiny chronicle should yield more than ` +
        `${CONDENSE_FLOOR_WC} words at any slider position. Likely cause: truncated model response, ` +
        'malformed JSON, or quota mid-flight. Regenerate Phase 5 from the chronicle card to retry.',
      { duration: 12_000 },
    )
  }
}

/** v1.1.0 — symmetric overshoot warning. Pairs with warnIfCondenseShort.
 *  The user picks a target word count via the Condense Slider; if the
 *  model returns >1.5× that target, we surface a toast so the user can
 *  rerun at a tighter slider position. Target=0 (legacy callers without
 *  a slider) disables the check. */
export function warnIfCondenseOvershoot(
  condensed: CondenseOutput | null | undefined,
  targetWordCount: number,
): void {
  if (targetWordCount <= 0) return
  const narrative = condensed?.narrative ?? ''
  if (!narrative.trim()) return
  const wc = narrative.trim().split(/\s+/).filter(Boolean).length
  if (wc > targetWordCount * CONDENSE_OVERSHOOT_RATIO) {
    const pct = Math.round((wc / targetWordCount) * 100)
    toast.warning(
      `Phase 5 condense returned ${wc.toLocaleString()} words — about ${pct}% of your chosen target ` +
        `(${targetWordCount.toLocaleString()} words). The model overshot the Condense Slider's ` +
        '±10% contract. You can rerun Phase 5 at a tighter slider position, or edit the output directly. ' +
        `This warning fires above ${Math.round(CONDENSE_OVERSHOOT_RATIO * 100)}% of the target.`,
      { duration: 12_000 },
    )
  }
}
