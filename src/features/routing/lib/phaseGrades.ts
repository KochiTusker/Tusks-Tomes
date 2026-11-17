// Per-phase model grades, anchored on the task rather than on a model.
//
// ─── Why this replaced the previous red/amber/green scheme ─────────────
//
// The first version of this graded models on capability FIELDS — context
// window, output ceiling, JSON support, moderation flag. Everything with no
// structural blocker came out green. That is a coherent thing to compute, but
// it is not what anyone reads a green badge as meaning, and the gap between
// the two is where it misled: a model can clear every structural bar and still
// produce error-ridden grounding. Gemini Flash 3.5 does exactly that on Ground
// and Audit in practice, and the old scheme would have called it green.
//
// So a letter here says one thing only — how well the model does the phase:
//
//   A   Does the phase well. Nothing measured does it better.
//   B   Solid, with small shortfalls you would notice if you looked for them.
//   C   Noticeably weak at this phase, though the output is usable.
//   D   Fails the phase's core contract. Only with output checks, or not at all.
//   F   Cannot run this phase, or fails it outright.
//   -   NOT YET MEASURED. Not a pass, not a fail — unknown.
//
// ─── The letter does NOT include price ────────────────────────────────
//
// It used to. A grade was quality-versus-reference passed through a cost rule,
// so being cheap could lift a letter one step. That made A mean two unrelated
// things — "excellent" and "adequate but cheap" — and it froze a price
// judgement into a letter at the moment of measurement, where it went stale as
// soon as the catalogue moved.
//
// It also made the best model in the catalogue unreadable. Gemini Pro is the
// strongest output measured on most phases and by far the most expensive
// thing here — six times Flash for one session. Folding both facts into one
// letter produced a B, which reads as "middling" and is the opposite of what
// the measurements say. Quality and price disagree sharply about that model,
// and a scale that cannot say so is hiding the actual decision.
//
// So: the letter is quality. Cost is a live column beside it, recomputed from
// the catalogue rather than remembered from a bake-off, and "is it worth the
// money" is a sort the reader can apply — see comparePhaseOptions('value').
//
// ─── What the scale is anchored to ────────────────────────────────────
//
// A per-phase rubric, not a model. PHASE1_RUBRIC below is the worked example
// and the one that is fully mechanical: corrections found against a known
// answer key, length ratio, speaker-tag survival. A model either hits those
// numbers or it does not, and the same run scores the same way next year.
//
// GEMINI_PRO_REFERENCE is the model the prose rubrics were calibrated against
// and the one most measurements were taken beside. It is a landmark, not a
// definition: it earns whatever letter the rubric gives it, and if something
// beats it that is simply a higher score rather than a rescaling.
//
// ─── The rule that keeps this honest ──────────────────────────────────
//
// A letter comes from exactly one of four places, and nowhere else:
//
//   1. A structural blocker, checkable without running anything      -> F
//   2. A bake-off against the reference on real input                -> A..F
//   3. First-hand use reported by whoever ran it                     -> A..F
//   4. Published evidence specific enough to disqualify              -> D or F
//
// Everything else is '—'.
//
// Note the asymmetry in (4): documented evidence can pull a grade DOWN but
// never award an A. That is deliberate. A vendor stating its model cannot
// disable reasoning, or a reproduced bug report of characters being injected
// into English output, is concrete enough to act on. A high benchmark score is
// not, because the research behind this found that no vendor publishes the axis
// this pipeline actually loads — instruction-following scores are saturated and
// measure short answers, and arena rankings are actively anti-predictive here,
// since their own style-control analysis shows answer length is the strongest
// single predictor of a win and these phases need a model that writes exactly
// as much as its input and adds nothing.
//
// So: evidence that something breaks is usable. Evidence that something is
// generally clever is not.
//
// The parts live in ./phaseGrades/: scale.ts (phases, letters and the verdict
// shapes), measured.ts and predicted.ts (the grade tables), lineage.ts (model
// identity), judge.ts (turning all of that into a verdict) and cost.ts (what a
// reference session costs). This file re-exports what the rest of the app uses.

export {
  REFERENCE_SESSION,
  phaseCost,
  referenceSessionCost,
  thinkingMultiplier,
} from './phaseGrades/cost'
export {
  CHARS_PER_TOKEN,
  DEFAULT_SIZING,
  OUTPUT_RATIO,
  judgeAllPhases,
  judgePhase,
  overallVerdict,
  structuralBlockers,
} from './phaseGrades/judge'
export type { OverallVerdict } from './phaseGrades/judge'
export {
  baseModelId,
  declaredSizeB,
  lineageMeasurement,
  lineageVersion,
  modelLineage,
} from './phaseGrades/lineage'
export { MEASURED_GRADES, MEASURED_MODEL_IDS, measuredPhaseCount } from './phaseGrades/measured'
export { PREDICTED_GRADES, PREDICTIONS_DATED } from './phaseGrades/predicted'
export {
  GEMINI_PRO_REFERENCE,
  GRADE_MEANING,
  PHASE1_RUBRIC,
  PHASE_LABELS,
  PHASE_ORDER,
  gradeFrom,
  gradePhase1Run,
  isIndirectGrade,
} from './phaseGrades/scale'
export type { Grade, MeasurementSource, Phase, PhaseVerdict } from './phaseGrades/scale'
