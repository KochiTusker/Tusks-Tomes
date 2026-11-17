// Turning measurements, predictions and structural limits into a verdict per
// phase and overall.
import type { OpenRouterModelInfo } from '@/features/providers'
import { baseModelId, lineageMeasurement } from './lineage'
import { FAMILY_GRADES, MEASURED_GRADES } from './measured'
import { MODEL_CAVEATS, PREDICTED_GRADES, PREDICTIONS_DATED } from './predicted'
import { PHASE_ORDER, outranks } from './scale'
import type { Caveat, Grade, Phase, PhaseVerdict } from './scale'

// ────────────────────────────────────────────────────────────────────
// Structural blockers — checkable without running anything
// ────────────────────────────────────────────────────────────────────

const JSON_PHASES = new Set<Phase>(['phase2', 'phase4'])
const PROSE_PHASES = new Set<Phase>(['phase1', 'phase3', 'phase6'])
export const CHARS_PER_TOKEN = 4

/** Output volume relative to the phase's input chunk.
 *
 *  Same numbers as PHASE_OUTPUT_RATIO_VS_CORPUS in pricing.ts, and they have
 *  to be: both describe how much text a phase emits per unit of corpus. Phase
 *  3 and Phase 6 were remeasured on 2026-09-16 against completed runs on disk
 *  (0.32 and 0.22) — see that file for the derivation.
 *
 *  The two copies are deliberate rather than shared: pricing.ts estimates what
 *  a run will BILL, this estimates whether a model can DO the phase at all.
 *  The second use is why the old 0.9 mattered beyond cost — structuralBlockers
 *  sizes a call's output against the model's context window and completion
 *  limit, so an inflated ratio ruled out models that would have handled the
 *  phase comfortably. The blocker list is not a cost estimate; being wrong
 *  there removes a working option rather than misquoting a price. */
export const OUTPUT_RATIO: Record<Phase, number> = {
  phase1: 1.0,
  phase2: 0.02,
  phase3: 0.32,
  phase4: 0.05,
  phase6: 0.22,
}

export interface PhaseSizing {
  chunkChars: number
  kbChars: number
  overheadChars: number
}

export const DEFAULT_SIZING: Record<Phase, PhaseSizing> = {
  // Lore per phase, on the reference session. Phases 1, 2 and 4 carry the
  // compact form; 3 carries the full text (REFERENCE_SESSION.loreChars, well
  // under the retrieval budget that bounds it); 6 carries whatever retrieval
  // returns and is sized without it — see structuralBlockers.
  phase1: { chunkChars: 15_000, kbChars: 15_000, overheadChars: 1_870 },
  phase2: { chunkChars: 15_000, kbChars: 15_000, overheadChars: 2_220 },
  phase3: { chunkChars: 30_000, kbChars: 58_000, overheadChars: 8_030 },
  phase4: { chunkChars: 30_000, kbChars: 15_000, overheadChars: 5_140 },
  phase6: { chunkChars: 50_000, kbChars: 0, overheadChars: 3_790 },
}

export function structuralBlockers(
  model: OpenRouterModelInfo,
  phase: Phase,
  sizing: PhaseSizing,
): string[] {
  const out: string[] = []

  const inputTokens = Math.ceil(
    (sizing.chunkChars + sizing.kbChars + sizing.overheadChars) / CHARS_PER_TOKEN,
  )
  const expectedOutput = Math.ceil((sizing.chunkChars / CHARS_PER_TOKEN) * OUTPUT_RATIO[phase])

  if (model.contextLength > 0 && inputTokens + expectedOutput > model.contextLength) {
    out.push(
      `Needs about ${fmtK(inputTokens + expectedOutput)} tokens of context; this model has ${fmtK(model.contextLength)}.` +
        (phase === 'phase6' ? ' Lore retrieval brings this within range.' : ''),
    )
  }

  if (model.maxCompletionTokens !== null && model.maxCompletionTokens < expectedOutput) {
    out.push(
      `This phase produces around ${fmtK(expectedOutput)} tokens; the model caps output at ${fmtK(model.maxCompletionTokens)}, so it would be cut off.`,
    )
  }

  if (JSON_PHASES.has(phase) && !model.supportsStructuredOutputs) {
    out.push('No structured-output support, and this phase must return JSON.')
  }

  if (PROSE_PHASES.has(phase) && model.leaksReasoning) {
    out.push(
      'Writes its reasoning into the reply rather than a separate field, so deliberation would land in the finished prose.',
    )
  }

  return out
}

export function judgePhase(
  model: OpenRouterModelInfo,
  phase: Phase,
  sizing: PhaseSizing = DEFAULT_SIZING[phase],
): PhaseVerdict {
  const blockers = structuralBlockers(model, phase, sizing)
  const measured = MEASURED_GRADES[`${model.id}::${phase}`]
  const caveats: Caveat[] = []
  for (const entry of MODEL_CAVEATS) {
    if (!entry.phases.includes(phase) || !entry.match(model.id)) continue
    // A caveat that says "unverified until you have read its output" has been
    // answered once its output HAS been read. Leaving it up next to a measured
    // grade would tell the reader the grade is untrustworthy, which is exactly
    // backwards — the measurement is the strongest evidence in the table.
    if (entry.supersededByMeasurement && measured) continue
    caveats.push(entry.caveat)
  }
  if (model.isModerated && (phase === 'phase1' || phase === 'phase3' || phase === 'phase4')) {
    caveats.push({
      kind: 'structural',
      text: 'Carries a platform moderation filter. Measured on 2026-08-18, this did NOT cause refusals on real table content — every moderated model tested wrote up graphic violence, torture and crude sexual banter without complaint. Treat it as a flag to watch, not a reason to avoid.',
    })
  }
  if (model.isFree) {
    caveats.push({
      kind: 'observed',
      text: 'Free models run only on providers that retain prompts, and are shared capacity — 4 of 14 answered "temporarily rate-limited" when probed on 2026-08-18.',
    })
  }

  // A structural blocker settles it without needing a measurement.
  if (blockers.length > 0) return { grade: 'F', blockers, caveats }

  // Exact model+phase measurement wins over anything family-wide. Looked up
  // at the top of the function, because the caveat filter needs it too.
  if (measured) return { grade: measured.grade, blockers, caveats, source: measured.source }

  // Same weights on a different delivery channel inherit the measurement.
  const base = baseModelId(model.id)
  const inherited = base === model.id ? undefined : MEASURED_GRADES[`${base}::${phase}`]
  if (inherited) return { grade: inherited.grade, blockers, caveats, source: inherited.source }

  // Family calibration and a sibling measurement are both real evidence, so
  // the newer one wins rather than whichever table is consulted first. That is
  // not a tie-break detail: the Flash rows disagreed with a bake-off run a day
  // later, in opposite directions on two phases, and reading them by table
  // order meant one tier reported two different grades depending on which of
  // its ids you happened to look at.
  const family = FAMILY_GRADES.find((f) => f.phases.includes(phase) && f.match(base))
  const sibling = lineageMeasurement(model.id, phase)
  if (family && (!sibling || !outranks(sibling.source, family.source))) {
    return { grade: family.grade, blockers, caveats, source: family.source }
  }

  if (sibling) {
    return {
      grade: sibling.grade,
      blockers,
      caveats,
      // Evidence, not a guess: this letter was earned on a run, on a sibling
      // of the same tier. It keeps whatever letter that run earned.
      inherited: true,
      source: {
        method: 'sibling-measurement',
        date: sibling.source.date,
        note: `Measured on ${sibling.fromId}, not on this version. ${sibling.source.note ?? ''}`.trim(),
      },
    }
  }

  // Last: a pattern rather than evidence about this model. Flagged as such so
  // nothing downstream can mistake it for a measurement.
  const prediction = PREDICTED_GRADES.find((p) => p.phases.includes(phase) && p.match(base))
  if (prediction) {
    return {
      grade: prediction.grade,
      blockers,
      caveats,
      predicted: true,
      source: { method: 'prediction', date: PREDICTIONS_DATED, note: prediction.basis },
    }
  }

  // No blocker, no measurement, no family evidence, no pattern that fits.
  // Unknown, and said so.
  return { grade: 'untested', blockers, caveats }
}

export function judgeAllPhases(
  model: OpenRouterModelInfo,
  sizing?: Partial<Record<Phase, PhaseSizing>>,
): Record<Phase, PhaseVerdict> {
  const out = {} as Record<Phase, PhaseVerdict>
  for (const p of PHASE_ORDER) out[p] = judgePhase(model, p, sizing?.[p] ?? DEFAULT_SIZING[p])
  return out
}

/**
 * One letter for the whole pipeline.
 *
 * The per-phase grades are the honest unit — a model can be the best thing
 * available on Chronicle and unusable on Extras, and that is a real and common
 * shape. But five chips is more than a reader scanning a 400-row catalogue can
 * take in, so this collapses them into the one number that answers "is this
 * worth a closer look", with the per-phase detail still a click away.
 *
 * Mean of the phases that carry a letter, rounded. Phases with no grade are
 * left out rather than counted as bad — averaging in an unknown would let an
 * untested model drift toward the middle of the scale for no reason.
 *
 * Confidence is the weakest link: an overall grade counts as predicted unless
 * every letter behind it was measured. One real measurement must not launder
 * four predictions into looking like evidence.
 */
export interface OverallVerdict {
  grade: Grade
  /** True when any contributing grade was read off a pattern. */
  predicted: boolean
  /** True when any contributing grade was measured on a sibling, not here. */
  inherited: boolean
  /** How many of the five phases contributed a letter. */
  gradedPhases: number
  /** How many phases this model cannot run at all. */
  blockedPhases: number
}

const GRADE_POINTS: Record<Exclude<Grade, 'untested'>, number> = { A: 4, B: 3, C: 2, D: 1, F: 0 }
const POINTS_TO_GRADE: Array<Exclude<Grade, 'untested'>> = ['F', 'D', 'C', 'B', 'A']

export function overallVerdict(
  verdicts: Record<Phase, PhaseVerdict>,
): OverallVerdict {
  const graded = PHASE_ORDER.filter((p) => verdicts[p].grade !== 'untested')
  const blockedPhases = PHASE_ORDER.filter((p) => verdicts[p].grade === 'F').length

  if (graded.length === 0) {
    return { grade: 'untested', predicted: false, inherited: false, gradedPhases: 0, blockedPhases }
  }

  const total = graded.reduce(
    (sum, p) => sum + GRADE_POINTS[verdicts[p].grade as Exclude<Grade, 'untested'>],
    0,
  )
  const mean = Math.round(total / graded.length)
  return {
    grade: POINTS_TO_GRADE[Math.min(POINTS_TO_GRADE.length - 1, Math.max(0, mean))],
    predicted: graded.some((p) => verdicts[p].predicted === true),
    inherited: graded.some((p) => verdicts[p].inherited === true),
    gradedPhases: graded.length,
    blockedPhases,
  }
}

function fmtK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}
