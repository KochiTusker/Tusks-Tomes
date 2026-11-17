// Helpers the Chronicle tab's run flow shares: persona templates, the routing
// a phase runs with, run-state checks and the warnings a new session raises.
import { toast } from 'sonner'
import { findSelectedPersona } from '@/features/personas'
import type { RunSession } from '@/features/routing'
import type { PersonasDocument } from '@/features/personas'
import type { PhaseId, PipelineStatus } from '@/features/pipeline/lib/types'

/** Pulls the persona templates relevant to phases 3/5/6 out of the current
 *  personas document. Returns empty objects when the add-on is off or no
 *  persona is selected — the pipeline then falls back to the locked bard
 *  prompts. */
export function resolvePersonaTemplates(doc: PersonasDocument) {
  const p = findSelectedPersona(doc)
  if (!p) return { phase3: undefined, phase5: undefined, phase6: undefined }
  return {
    phase3: { cloud: p.prompts.phase3Cloud, local: p.prompts.phase3Local },
    phase5: p.prompts.phase5Local,
    phase6: { cloud: p.prompts.phase6Cloud, local: p.prompts.phase6Local },
  }
}

// phase6_condense is intentionally absent — RefinementTool catches it in its
// earlier `done || phase6_condense` render branch, so it never reaches this check.
const PIPELINE_RUNNING_PHASES = new Set<PipelineStatus>([
  'phase1_ground', 'phase2_audit', 'phase3_chronicle', 'phase4_extras', 'phase5_polish',
])

export function isRunningPhaseId(s: PipelineStatus): s is PhaseId {
  return PIPELINE_RUNNING_PHASES.has(s)
}

/** What a run that died with the page says for itself. Kept as a constant
 *  so the resume surfaces and the tests agree on the wording. */
export const INTERRUPTED_RUN_MESSAGE =
  'The run was interrupted — resume from the last checkpoint, or start again.'

export function fmtKbSize(chars: number): string {
  if (chars < 1024) return `${chars} chars`
  if (chars < 1024 * 1024) return `${(chars / 1024).toFixed(1)} KB`
  return `${(chars / (1024 * 1024)).toFixed(2)} MB`
}

/** Below this, a transcript is almost certainly a mistake — a stray
 *  keystroke or a failed paste. Real sessions run to tens of thousands of
 *  characters. Used only to warn; the run is never blocked. */
export const SHORT_TRANSCRIPT_CHARS = 500

/** The routing a run resolved for one phase, as the options every `runPhaseN` takes. */
export function sessionPhaseArgs(session: RunSession | null, phase: keyof RunSession['phases']) {
  return {
    model: session?.phases[phase].model,
    phaseTarget: session?.phases[phase].phaseTarget,
    cloudProvider: session?.phases[phase].cloudProvider,
    geminiTier: session?.phases[phase].geminiTier,
    geminiPaidOnlyModels: session?.geminiPaidOnlyModels,
    allPhasesFast: session?.allPhasesFast,
  }
}

/** Surface session-level warnings (modelAvailabilityWarning,
 *  modelSubstitutions, etc.) as toasts so the user knows the run is
 *  proceeding under a non-default config — vs. the silent-failure path
 *  where buildSession would just leave fields undefined and the user
 *  would discover the consequence mid-phase. */
export function reportSessionWarnings(session: RunSession | null): void {
  if (!session) return
  if (session.modelAvailabilityWarning) {
    const w = session.modelAvailabilityWarning
    toast.warning(
      `Gemini model availability couldn't load — auto-escalation to Paid for ` +
        `paid-only models is OFF for this run (${w.consequence}). ` +
        `If a phase uses gemini-2.5-pro on a Free key, expect a verbose ` +
        `mid-phase error. Probe both Gemini slots in Settings → API Keys to fix.`,
    )
    console.warn(
      `[run-start] modelAvailabilityWarning: ${w.error} (consequence: ${w.consequence})`,
    )
  }
  // Model substitutions — buildSession swapped one or more phases'
  // configured model for something the Free probe says is accessible.
  // The user MUST be told: their UI showed gemini-2.5-flash but the
  // pipeline will actually call e.g. gemini-flash-lite-latest. We toast
  // each substitution individually so the user sees the exact swap and
  // its reason. Dubious swaps (lite / experimental / -latest variants)
  // get an extra-loud warning since they're rarely what the user meant.
  if (session.modelSubstitutions && session.modelSubstitutions.length > 0) {
    for (const sub of session.modelSubstitutions) {
      const dubious = sub.dubious === true
      const message =
        `${sub.phase} model swapped: ${sub.from} → ${sub.to}. Reason: ${sub.reason}.` +
        (dubious
          ? ` ⚠ ${sub.to} is a lite/experimental/latest variant — likely NOT what you picked. ` +
            `Open Plan & routing to pin a specific model, OR probe again.`
          : ' Open Plan & routing to override.')
      if (dubious) toast.warning(message, { duration: 12_000 })
      else toast.info(message, { duration: 8_000 })
      console.warn(`[run-start] modelSubstitution:`, sub)
    }
  }
}
