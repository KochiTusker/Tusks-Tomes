// Per-phase routing: the feature's front door.
// Other features import from here, never from a file inside this folder
// (rule d in engineering/tests/boundaries.test.ts). It re-exports only what
// they use; an import that would loop back through here stays deep and is
// listed, with its reason, in engineering/tests/boundaries.allowlist.json.
export { HybridRoutingEditor } from './components/HybridRoutingEditor'
export { RecommendedSetupWizard } from './components/RecommendedSetupWizard'
export {
  GEMINI_ALL_PRO_RECOMMENDED,
  GEMINI_HYBRID_RECOMMENDED,
  GEMINI_QUALITY_BUDGET_RECOMMENDED,
} from './lib/budgetMode'
export {
  GEMINI_PRO_REFERENCE,
  GRADE_MEANING,
  MEASURED_GRADES,
  MEASURED_MODEL_IDS,
  PHASE_LABELS,
  PHASE_ORDER,
  PREDICTIONS_DATED,
  REFERENCE_SESSION,
  isIndirectGrade,
  judgeAllPhases,
  judgePhase,
  measuredPhaseCount,
  overallVerdict,
  referenceSessionCost,
} from './lib/phaseGrades'
export type { Grade, MeasurementSource, OverallVerdict, Phase } from './lib/phaseGrades'
export { fitFor, recommendRouting } from './lib/recommendations'
export type { Recommendation } from './lib/recommendations'
export { getRouting, putRouting } from './lib/routing'
export type { GeminiTier, RoutingDocument } from './lib/routing'
export {
  autoResolveSession,
  buildSession,
  chunkSizeForSessionPhase,
  listConfiguredCloudKeys,
} from './lib/sessions'
export type { PhaseTarget, ResolvedPhaseConfig, RunSession } from './lib/sessions'
