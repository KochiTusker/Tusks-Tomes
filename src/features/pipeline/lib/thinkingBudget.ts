import type { PhaseId } from '@/features/pipeline/lib/types'

// ----- Gemini thinking budget per-phase resolver (Phase A) -----
//
// Single source of truth for whether to pass `thinkingBudget` to the Gemini
// SDK on a given phase. The mapping is:
//
//   - Phase 3 (chronicle): ALWAYS `undefined` (SDK default = model decides).
//     This is hardcoded for voice protection — no user toggle can disable
//     thinking on the chronicle phase.
//   - Phase 1 (grounding): respects `disableThinkingOnGrounding` toggle.
//     undefined when off (existing behaviour); 0 when on (cheaper, mechanical).
//   - Phases 2 / 4 / 6: kept on SDK default for this cycle. The toggle's
//     scope is intentionally narrow on first ship — Phase 1 is the most
//     mechanical and lowest-risk phase to disable thinking on. Other phases
//     can be added later if the user opts in to a broader scope.
//
// `disableThinkingOnGrounding` defaults to false (off) per the user's hard
// constraint: existing behaviour preserved, savings opt-in.
//
// Stage 4 — extended with `perPhaseThinking` map. When a phase has an
// explicit boolean override:
//   true  → thinking ON (undefined budget = SDK default)
//   false → thinking OFF (budget = 0, cheaper)
// When the phase has NO override (undefined), fall back to the legacy
// per-phase default. Phase 3 chronicle is ALWAYS undefined (no override
// permitted — voice protection guardrail).
export function resolveThinkingBudget(
  phase: PhaseId,
  opts: {
    disableThinkingOnGrounding: boolean
    perPhaseThinking?: {
      phase4?: boolean
      phase6?: boolean
    }
  },
): number | undefined {
  if (phase === 'phase3_chronicle') return undefined
  const explicit = opts.perPhaseThinking
  if (phase === 'phase4_extras' && explicit?.phase4 !== undefined) {
    return explicit.phase4 ? undefined : 0
  }
  if (phase === 'phase6_condense' && explicit?.phase6 !== undefined) {
    return explicit.phase6 ? undefined : 0
  }
  // Legacy fallback — preserve today's behaviour for users who haven't
  // touched per-phase thinking.
  if (phase === 'phase1_ground' && opts.disableThinkingOnGrounding) return 0
  return undefined
}
