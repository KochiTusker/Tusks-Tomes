// Which OpenRouter models are offered before the user asks to see everything.
//
// The catalogue is ~400 models and most of them are a bad idea for this
// pipeline, but "bad idea" has to be decided on something. phaseGrades.ts sets
// the standard the rest of this file follows: a letter comes from a
// measurement or a structural check, never from an inference about how clever
// a model sounds. Two signals clear that bar, and they are applied in order.
//
//   1. A MEASUREMENT, where one exists. If a model has been graded on any
//      phase, that settles it in both directions — an A or B anywhere keeps it
//      visible no matter what else is true, and a model assessed only at C/D/F
//      is hidden. This is the rule the catalogue browser already applied.
//
//   2. A DECLARED PARAMETER COUNT, for models with no measurement at all.
//      OpenRouter publishes no size field, so the only honest source is the id
//      the vendor chose: `mistralai/ministral-3b` says 3B about itself. That is
//      a fact being read, not a capability being guessed.
//
// What is deliberately NOT a signal: the words "mini", "nano", "lite" and
// "small". Those are marketing positions rather than statements of size, and
// the models carrying them span three orders of magnitude of capability. A
// name-based rule would have hidden gpt-5.4-mini and gemini-flash-lite on no
// evidence, which is the exact failure the grading scheme was rewritten to
// avoid. An untested model with no declared size stays visible: an unknown is
// not a low score.

import { declaredSizeB, isIndirectGrade, judgeAllPhases, PHASE_ORDER } from '../../routing/lib/phaseGrades'
import type { OpenRouterModelInfo } from './openrouterModelsClient'

/**
 * Models at or below this many billion parameters are hidden by default.
 *
 * Set where the pipeline's own demands stop being plausible rather than where
 * a model stops being useful. Phase 1 must reproduce a 20k-character chunk
 * near 1:1 while correcting names inside it, and Phase 3 must write back about
 * as much as it reads; single-digit-billion models measured on those phases
 * have failed them in a specific and dangerous way — returning well-formed
 * output that silently corrected nothing.
 */
export const SMALL_MODEL_CEILING_B = 10

/**
 * The parameter count a model's own id or name declares, in billions.
 *
 * Reads `-8b`, ` 120B`, `-3.5b`. Returns the LARGEST match, which is what
 * makes MoE ids safe: `qwen3-30b-a3b` is a 30B model with 3B active, and
 * taking the max reads it as 30 rather than mistaking the active count for
 * the whole model. Returns null when the id declares nothing — most of the
 * catalogue, which is why this is a floor and not a sort key.
 */
export function declaredParameterSizeB(model: OpenRouterModelInfo): number | null {
  return declaredSizeB(`${model.id} ${model.name}`)
}

/** True when the id declares a size under the ceiling. A model that declares
 *  nothing is not small — it is unstated, which is not the same. */
export function isBelowSizeFloor(model: OpenRouterModelInfo): boolean {
  const size = declaredParameterSizeB(model)
  return size !== null && size < SMALL_MODEL_CEILING_B
}

/**
 * Hidden unless the user asks for everything.
 *
 * Measurement first and in both directions, size floor only as a fallback for
 * models nothing is known about. A measured A or B keeps an 8B model visible,
 * which is the point of checking the grade first: evidence outranks the
 * heuristic that exists only because evidence is missing.
 *
 * Hiding needs evidence of FAILURE, not merely an absence of praise. The
 * catalogue browser used to hide anything without an A or B somewhere, which
 * quietly disqualified a model carrying one C on one phase and no measurement
 * at all on the other four — Claude Opus 5 among them. Reading four unknowns
 * as four strikes is the same mistake the grading scheme was rewritten to stop
 * making, and it matters far more here than it did in a reference table,
 * because this list is also what the routing dropdowns offer.
 *
 * So a D or an F has to be present. C means "noticeably below the reference,
 * even allowing for the price" — worth knowing and shown on the row, but not
 * worth withholding, since the picker displays the grade next to the model.
 */
export function isUnrecommended(model: OpenRouterModelInfo): boolean {
  const verdicts = judgeAllPhases(model)
  // Only a measurement of THIS model hides it. A pattern is not evidence, and
  // a sibling's run is evidence about the sibling — near enough to show the
  // reader, not near enough to withhold a model over.
  const assessed = PHASE_ORDER.filter(
    (p) => verdicts[p].grade !== 'untested' && !isIndirectGrade(verdicts[p]),
  )
  if (assessed.length > 0) {
    const passes = assessed.some((p) => verdicts[p].grade === 'A' || verdicts[p].grade === 'B')
    const fails = assessed.some((p) => verdicts[p].grade === 'D' || verdicts[p].grade === 'F')
    if (passes || fails) return !passes && fails
  }
  return isBelowSizeFloor(model)
}

/**
 * Hidden from the per-phase routing dropdowns.
 *
 * Stricter than the catalogue browser by one term: free models are excluded
 * here too. The two surfaces are answering different questions. Browsing the
 * catalogue is reading, and a free model's price and policy are worth reading;
 * picking one for a phase is a decision to send a table's transcript to a host
 * that keeps it, and around half of them may train on it. That belongs behind
 * the same deliberate tick, not in the default list of things to pick.
 */
export function isHiddenFromRouting(model: OpenRouterModelInfo): boolean {
  return model.isFree || isUnrecommended(model)
}
