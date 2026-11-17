// The grading scale: phases, letters, what a letter means, and the verdict and
// measurement shapes every other part of the grades works with.

export type Phase = 'phase1' | 'phase2' | 'phase3' | 'phase4' | 'phase6'

export type Grade = 'A' | 'B' | 'C' | 'D' | 'F' | 'untested'

/** The model every grade is relative to. */
export const GEMINI_PRO_REFERENCE = 'gemini-pro-latest'

export const PHASE_LABELS: Record<Phase, string> = {
  phase1: 'Ground',
  phase2: 'Audit',
  phase3: 'Chronicle',
  phase4: 'Extras',
  phase6: 'Condense',
}

export const PHASE_ORDER: Phase[] = ['phase1', 'phase2', 'phase3', 'phase4', 'phase6']

export const GRADE_MEANING: Record<Grade, string> = {
  A: 'Does this phase well. Nothing measured does it better.',
  B: 'Solid, with small shortfalls you would notice if you looked for them.',
  C: 'Noticeably weak at this phase, though the output is usable.',
  D: "Fails the phase's core contract. Only with output checks.",
  F: 'Cannot run this phase, or fails it outright.',
  untested: 'Not measured yet. Unknown, not assumed good or bad.',
}

/**
 * How good the output is at the phase. Nothing about price.
 *
 * The names are still relative to the reference because that is how the
 * measurements were actually taken — models were run beside Gemini Pro on the
 * same chunk and judged against it. What changed is that the comparison stops
 * at quality: a cheaper model that matches the reference is `comparable`, and
 * being cheap no longer moves it up a letter.
 */
export type QualityVsReference =
  | 'better'
  | 'comparable'
  | 'slightly-below'
  | 'below'
  | 'well-below'

/**
 * Measured quality, as a letter. One argument, because there is one axis.
 *
 * This used to take `cheaperThanReference` and lift a grade a step for it.
 * Removing that is the whole point of the split: price belongs in the cost
 * column, where it stays current, rather than inside a letter recorded once
 * and never revisited. `comparePhaseOptions('value')` puts the two back
 * together at read time for anyone who wants the combined answer.
 */
export function gradeFrom(quality: QualityVsReference): Grade {
  switch (quality) {
    case 'better':
      return 'A'
    case 'comparable':
      return 'B'
    case 'slightly-below':
      return 'C'
    case 'below':
      return 'D'
    default:
      return 'F'
  }
}

/**
 * The Ground rubric, written down.
 *
 * Phase 1 is the phase gradeable without a human: its contract is stated
 * exactly — correct the phonetic misspellings the answer key lists, change
 * nothing else, return a near 1:1 transcript — and all three parts are
 * countable. This is what the rest of the scale should look like as the other
 * phases get rubrics of their own.
 *
 * FIDELITY IS A GATE, NOT A TERM. A model that quietly drops transcript has
 * failed the contract however well it grounds, which is why 1/6 corrections
 * with the text intact grades C while 1/6 with 15% of the length gone grades
 * D. The worst outcome measured was neither: a model that corrected nothing at
 * all while returning perfectly well-formed output, because nothing downstream
 * can tell that it did not run.
 *
 * THE ANSWER KEY MUST NOT COME FROM A MODEL. The first key was produced by a
 * Gemini Pro run, which made Pro's own 6/6 circular — it was marked against
 * its own output, and the note on that row said so. The key belongs in the
 * glossary and vault, which are authored by hand: the canonical spellings are
 * already there, and taking the key from them makes every model including the
 * reference an ordinary contestant.
 */
export const PHASE1_RUBRIC = {
  /** Fraction of the answer key's known mis-hearings actually corrected. */
  corrections: [
    { atLeast: 1.0, grade: 'A' as const },
    { atLeast: 0.8, grade: 'B' as const },
    { atLeast: 0.6, grade: 'C' as const },
    { atLeast: 0, grade: 'D' as const },
  ],
  /** Below these the reproduction contract is broken, and the grade caps at D
   *  however much was corrected. Set just wide enough to admit the runs that
   *  were judged acceptable — 0.96x length and 594 of 609 tags was the loosest
   *  — and to exclude the one that dropped 98 tags and a seventh of the text. */
  fidelityGate: {
    minLengthRatio: 0.95,
    maxLengthRatio: 1.05,
    minTagSurvival: 0.97,
  },
} as const

/** Apply PHASE1_RUBRIC to one measured run. Pure, so a future scoring script
 *  and this table cannot drift apart. */
export function gradePhase1Run(run: {
  correctionsFound: number
  correctionsPossible: number
  lengthRatio: number
  tagsKept: number
  tagsTotal: number
}): Grade {
  const { fidelityGate, corrections } = PHASE1_RUBRIC
  const tagSurvival = run.tagsTotal === 0 ? 1 : run.tagsKept / run.tagsTotal
  const faithful =
    run.lengthRatio >= fidelityGate.minLengthRatio &&
    run.lengthRatio <= fidelityGate.maxLengthRatio &&
    tagSurvival >= fidelityGate.minTagSurvival

  const hitRate =
    run.correctionsPossible === 0 ? 0 : run.correctionsFound / run.correctionsPossible
  const earned = corrections.find((row) => hitRate >= row.atLeast)?.grade ?? 'D'
  if (faithful) return earned
  // The gate: a broken reproduction caps the grade, and a badly broken one
  // (deliberation written into the transcript, tags gone) is not a grade at all.
  return tagSurvival < 0.5 || run.lengthRatio > 1.5 ? 'F' : 'D'
}

export interface PhaseVerdict {
  grade: Grade
  /** Structural reasons this cannot run. Non-empty means grade is F. */
  blockers: string[]
  /** Qualitative notes. Present regardless of grade. */
  caveats: Caveat[]
  /** Where a letter grade came from. Absent when untested. */
  source?: MeasurementSource
  /**
   * True when the grade was inferred from a pattern rather than measured —
   * the model's stated purpose, its declared size, a name-shaped rule. No
   * run stands behind it, on this model or any other, which is why a
   * prediction can never award an A.
   *
   * A separate field rather than a `source.method` check, because every
   * consumer needs this distinction and none of them should have to know how
   * the source union is spelled to get it right.
   */
  predicted?: boolean
  /**
   * True when the grade came from a real run, but of a sibling version or
   * channel of the same tier rather than of this model.
   *
   * Deliberately not the same flag as `predicted`. Both mean "not measured
   * on this model", and both are drawn as such; but one is a guess and the
   * other is evidence, and folding them together put an A on a chip whose
   * own legend said an A was impossible there. A comparison did happen — it
   * just happened next door.
   */
  inherited?: boolean
}

/**
 * The letter is not a measurement of THIS model.
 *
 * The question every display and filter is really asking, and the reason
 * `predicted` and `inherited` are separate: how to draw the chip and whether
 * to hide the row are the same decision for both, while what to tell the
 * reader is not.
 */
export function isIndirectGrade(verdict: PhaseVerdict): boolean {
  return verdict.predicted === true || verdict.inherited === true
}

export type CaveatKind = 'observed' | 'reported' | 'structural'

export interface Caveat {
  kind: CaveatKind
  text: string
}

export interface MeasurementSource {
  /**
   * How the grade was arrived at, strongest first:
   *
   *   bake-off        ran against the reference on real input here
   *   operator-report first-hand use, reported by whoever ran it
   *   research        derived from documented model behaviour, with a citation
   *
   *   prediction     inferred from a pattern, never run — see PREDICTED_GRADES
 *
 * `prediction` is the only one of the four that is not evidence about the
 * model in question, and it is marked separately on the verdict so nothing
 * downstream has to read this field to tell the difference.
 *
 * `research` is the weakest of the remaining three and is used only where the evidence
   * is specific and disqualifying — a vendor stating a model cannot disable
   * reasoning, a reproduced bug in a tracker, a published length-control score.
   * It is never used to award an A, because nothing published measures what an
   * A would have to mean here.
   */
  method: 'bake-off' | 'operator-report' | 'research' | 'sibling-measurement' | 'prediction'
  /** When. */
  date: string
  note?: string
  /** Where the claim comes from, for `research` grades. */
  citation?: string
}

// ────────────────────────────────────────────────────────────────────
// Verdicts
// ────────────────────────────────────────────────────────────────────

/**
 * How much weight a source carries, strongest first.
 *
 * Mirrors the ordering MeasurementSource already documents. Used to break a
 * date tie between two pieces of evidence about the same phase: a blind
 * bake-off against the reference outranks an impression from ordinary use,
 * which outranks something inferred from a document. Without this the Flash
 * Chronicle grade came down to which table was read first — a bake-off calling
 * it level with Pro and a same-day operator note calling it clearly behind.
 */
function sourceStrength(method: MeasurementSource['method']): number {
  switch (method) {
    case 'bake-off':
      return 4
    case 'operator-report':
      return 3
    case 'research':
      return 2
    case 'sibling-measurement':
      return 1
    default:
      return 0
  }
}

/** True when a outranks b: newer wins, and on the same date the stronger
 *  method wins. */
export function outranks(a: MeasurementSource, b: MeasurementSource): boolean {
  if (a.date !== b.date) return a.date > b.date
  return sourceStrength(a.method) > sourceStrength(b.method)
}
