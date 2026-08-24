// Per-phase model grades, anchored on Gemini Pro.
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
// So the grades here mean something narrower and more useful:
//
//   A   Better than the reference, OR as good and cheaper.
//   B   The reference standard itself — as good, but no cheaper.
//   C   Noticeably below the reference, even allowing for the price.
//   D   Significantly worse. Only with output checks, or not at all.
//   F   Cannot run this phase, or fails it outright.
//   -   NOT YET MEASURED. Not a pass, not a fail - unknown.
//
// Note what B means: Gemini Pro itself grades B on every phase. It is the bar,
// not the prize. A model only reaches A by beating it on quality or matching it
// for less money, which is the decision actually being made when a routing
// preset is chosen. Grading the reference A would have made A mean "as good as
// the expensive option" and left no way to say "as good and half the price".
//
// The reference is GEMINI_PRO_REFERENCE below.
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

import type { OpenRouterModelInfo } from './openrouterModelsClient'

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
  A: 'Better than the reference, or as good for less money.',
  B: `The reference standard. As good as ${GEMINI_PRO_REFERENCE}, but no cheaper.`,
  C: 'Noticeably below the reference, even allowing for the price.',
  D: 'Significantly worse. Use only with output checks.',
  F: 'Cannot run this phase, or fails it.',
  untested: 'Not measured yet. Unknown, not assumed good or bad.',
}

/**
 * Quality relative to the reference, before price is considered.
 *
 * Kept separate from the grade because the grade folds in cost, and the two
 * answer different questions: this one is "how good is the output", the grade
 * is "should I use this instead".
 */
export type QualityVsReference =
  | 'better'
  | 'comparable'
  | 'slightly-below'
  | 'below'
  | 'well-below'

/**
 * Combine measured quality with relative cost into a grade.
 *
 * The asymmetry is deliberate. Being cheaper can lift a grade by one step but
 * never rescue a model that is clearly worse — no discount makes a bad
 * chronicle worth keeping. Being more expensive never lifts anything, because
 * paying more for the same output is not a reason to switch.
 */
export function gradeFrom(quality: QualityVsReference, cheaperThanReference: boolean): Grade {
  if (quality === 'better') return 'A'
  if (quality === 'comparable') return cheaperThanReference ? 'A' : 'B'
  if (quality === 'slightly-below') return cheaperThanReference ? 'B' : 'C'
  if (quality === 'below') return 'C'
  return 'D'
}

/** A blocker that can be established without running the model. */
export interface Blocker {
  reason: string
}

export interface PhaseVerdict {
  grade: Grade
  /** Structural reasons this cannot run. Non-empty means grade is F. */
  blockers: string[]
  /** Qualitative notes. Present regardless of grade. */
  caveats: Caveat[]
  /** Where a letter grade came from. Absent when untested. */
  source?: MeasurementSource
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
   * `research` is the weakest of the three and is used only where the evidence
   * is specific and disqualifying — a vendor stating a model cannot disable
   * reasoning, a reproduced bug in a tracker, a published length-control score.
   * It is never used to award an A, because nothing published measures what an
   * A would have to mean here.
   */
  method: 'bake-off' | 'operator-report' | 'research'
  /** When. */
  date: string
  note?: string
  /** Where the claim comes from, for `research` grades. */
  citation?: string
}

// ────────────────────────────────────────────────────────────────────
// Recorded measurements
// ────────────────────────────────────────────────────────────────────

/**
 * Grades from actual comparison against the reference.
 *
 * Keyed `modelId::phase`. This table is the ONLY source of A–D grades — it
 * starts small on purpose and grows as models are actually run. An entry here
 * should be traceable to a bake-off run or to a first-hand operator report,
 * never to a benchmark leaderboard.
 */
export const MEASURED_GRADES: Record<string, { grade: Grade; source: MeasurementSource }> = {
  // Operator testing, 2026-08-18. Flash 3.5 produced error-ridden output on
  // both mechanical phases — the specific case that showed the old
  // capability-only grading was misleading, since it clears every structural
  // bar comfortably.
  'google/gemini-3.5-flash::phase1': {
    grade: 'D',
    source: {
      method: 'operator-report',
      date: '2026-08-18',
      note: 'Error-ridden grounding output in hands-on testing.',
    },
  },
  'google/gemini-3.5-flash::phase2': {
    grade: 'D',
    source: {
      method: 'operator-report',
      date: '2026-08-18',
      note: 'Error-ridden audit output in hands-on testing.',
    },
  },

  // ---- Grounding bake-off, 2026-08-19 ----
  // Phase 1 is the one phase gradeable without a human: its job is stated
  // exactly — correct phonetic misspellings against the Knowledge Base,
  // change nothing else, return a near 1:1 transcript — and all three are
  // checkable. Scored on six known Whisper mis-hearings with canonical forms
  // in the vault, plus length ratio and speaker-tag survival.
  //
  // It is also the phase where cheap models matter most: 15 of a session's
  // ~50 calls, mechanical rather than creative, and the bulk of the bill for
  // anyone without a subscription CLI.
  'gemini-pro-latest::phase1': {
    grade: 'B',
    source: {
      method: 'bake-off',
      date: '2026-08-19',
      note: '6/6 corrections at 1.0x length with every speaker tag intact — but it also produced the reference set, so its score is definitional rather than independent. B as the anchor.',
    },
  },
  'gemini-flash-latest::phase1': {
    grade: 'A',
    source: { method: 'bake-off', date: '2026-08-19', note: '5/6 corrections, 1.0x length, all tags. Matches the reference for a fraction of the price.' },
  },
  'anthropic/claude-haiku-4.5::phase1': {
    grade: 'A',
    source: { method: 'bake-off', date: '2026-08-19', note: '5/6 corrections, 1.0x length, all 609 tags preserved exactly. The strongest non-Gemini grounder measured, and cheaper than the reference.' },
  },
  'qwen/qwen3-30b-a3b-instruct-2507::phase1': {
    grade: 'B',
    source: { method: 'bake-off', date: '2026-08-19', note: '4/6 corrections at 1.0x length with tags intact, for roughly a twenty-fifth of the reference price. The best value measured on this phase.' },
  },
  'z-ai/glm-4.7-flash::phase1': {
    grade: 'B',
    source: { method: 'bake-off', date: '2026-08-19', note: '4/6 corrections, 0.99x length, 601 of 609 tags.' },
  },
  'openai/gpt-oss-120b::phase1': {
    grade: 'B',
    source: { method: 'bake-off', date: '2026-08-19', note: '4/6 corrections, 0.96x length, 594 of 609 tags. Slight shrinkage worth watching on a phase that must not compress.' },
  },
  'deepseek/deepseek-v4-flash::phase1': {
    grade: 'C',
    source: { method: 'bake-off', date: '2026-08-19', note: 'Only 1/6 corrections, though length and tags were perfect — it reproduces faithfully and grounds barely at all. Also slow: 340s for one chunk, which is roughly 85 minutes of Phase 1 across a session.' },
  },
  'openai/gpt-5-mini::phase1': {
    grade: 'D',
    source: { method: 'bake-off', date: '2026-08-19', note: '1/6 corrections AND it compressed: 0.85x length with 98 speaker tags dropped. Losing transcript on the phase whose contract is a near 1:1 reproduction is worse than grounding poorly.' },
  },
  'nvidia/nemotron-3.5-lightning::phase1': {
    grade: 'D',
    source: {
      method: 'bake-off',
      date: '2026-08-19',
      note: 'Corrected NOTHING — 0/6, with every mis-hearing still present at its original count — while returning perfectly well-formed output at 0.94x length with 561 tags. A silent no-op is the worst shape of failure here: nothing downstream can tell it did not run.',
    },
  },
  'openai/gpt-5-nano::phase1': {
    grade: 'F',
    source: {
      method: 'bake-off',
      date: '2026-08-19',
      note: "REFUSED outright — it replied that it could not assist with the request. The only refusal measured across every model and phase tested. Moderated small models are a real risk on table content.",
    },
  },
  'nvidia/nemotron-3-super-120b-a12b:free::phase1': {
    grade: 'F',
    source: {
      method: 'bake-off',
      date: '2026-08-19',
      note: 'Wrote its deliberation into the output instead of the transcript ("We need to correct the transcript... Wait:") — 3.49x the input length, zero speaker tags preserved, unusable downstream. Also required the privacy floor to be lowered before it could be reached at all.',
    },
  },

  // ---- Chronicle bake-off, 2026-08-18 ----
  // Ten models, one grounded 15k chunk of a real session, the real Phase 3
  // prompt, graded blind by the operator with cost hidden. Their letters are
  // mapped onto this scale (which has no +/-), with the original kept in each
  // note so nothing is lost in the rounding.
  'gemini-pro-latest::phase3': {
    grade: 'A',
    source: {
      method: 'bake-off',
      date: '2026-08-18',
      note: 'A-. "Strongest at balancing prose and dialogue", and best at keeping the DM as narrator rather than treating them as a character.',
    },
  },
  'gemini-flash-latest::phase3': {
    grade: 'A',
    source: {
      method: 'bake-off',
      date: '2026-08-18',
      note: 'A-. Judged virtually equal to Pro at a fraction of the cost — the finding that matters most, since this is what routing already runs.',
    },
  },
  '~google/gemini-pro-latest::phase3': {
    grade: 'B',
    source: {
      method: 'bake-off',
      date: '2026-08-18',
      note: 'B+. Same model as the A-grade reference, routed via OpenRouter, graded one step lower on the same chunk. One sample at temperature 0.7, so suggestive rather than settled.',
    },
  },
  'deepseek/deepseek-v4-pro::phase3': {
    grade: 'B',
    source: { method: 'bake-off', date: '2026-08-18', note: 'B+. Opened with content unrelated to the story; referred to the DM by name rather than as the Dungeon Master.' },
  },
  'deepseek/deepseek-v4-flash::phase3': {
    grade: 'B',
    source: { method: 'bake-off', date: '2026-08-18', note: 'B+. Terser prose, better at naming D&D spells. ~125x cheaper than the reference, but slowest in the field at ~6.5 min/chunk.' },
  },
  'z-ai/glm-5.2::phase3': {
    grade: 'B',
    source: { method: 'bake-off', date: '2026-08-18', note: 'B-. Longer than average, and retained above-the-table chatter the Gemini models correctly dropped.' },
  },
  'moonshotai/kimi-k2.6::phase3': {
    grade: 'B',
    source: {
      method: 'bake-off',
      date: '2026-08-19',
      note: "A- on a 30k Session 28 chunk — the best non-Gemini chronicle graded, \"very good at picking up prose and discerning descriptions from dialogue\", just below Gemini Flash at A. B rather than A because it is neither better nor cheaper than Flash, and it takes 400-500 seconds per chunk, roughly an hour for the whole phase. Quality is not the reason to avoid it; wall-clock and silent failures are.",
    },
  },
  'minimax/minimax-m3::phase3': {
    grade: 'B',
    source: { method: 'bake-off', date: '2026-08-18', note: 'B- / C+, on the boundary. Strong at quotes and dialogue, weaker at tracking the story. Retained out-of-campaign chatter.' },
  },
  'x-ai/grok-4.20::phase3': {
    grade: 'C',
    source: { method: 'bake-off', date: '2026-08-18', note: 'C-. Tracks events well but captured almost no dialogue.' },
  },
  'moonshotai/kimi-k3::phase3': {
    grade: 'B',
    source: {
      method: 'bake-off',
      date: '2026-08-19',
      note: 'B+ on a 30k Session 28 chunk — "very good, but dialogue-heavy with less detail outside the dialogue", against A for Gemini Flash on the same chunk. REQUIRES reasoning: { effort: "low" } AND provider pinned to moonshotai; unpinned it draws a serving provider that ignores the cap. Pinned: 3/3, ~$0.055/call, ~110s. Unpinned: 5x the cost, up to 6x slower.',
    },
  },

  // ---- Extras bake-off, 2026-08-19 ----
  // Same ten models, one 30k window of a dialogue-dense session, read from the
  // GROUNDED TRANSCRIPT (the shipped default — every production call site
  // passes it). Blind except for Flash, named so the operator could anchor
  // against what they already run.
  //
  // NOTE the reference itself grades C here. The "B is the reference" anchor in
  // GRADE_MEANING is calibrated on Chronicle, where Gemini is genuinely strong.
  // It does not transfer to Extras, where Gemini is weak at extraction and
  // several cheaper models beat it outright. That divergence is the whole
  // reason grades are per-phase, so it is recorded as measured rather than
  // renormalised to protect the anchor.
  'moonshotai/kimi-k3::phase4': {
    grade: 'A',
    source: {
      method: 'bake-off',
      date: '2026-08-19',
      note: 'B+ on the graded configuration — a good spread of quotes, though it read some DM narration as dialogue and its jests largely restated the quotes. A rather than B because both Gemini tiers grade C here, so this is clearly better than the reference and cheaper than it. REQUIRES reasoning: { effort: "low" } AND provider pinned to moonshotai.',
    },
  },
  'x-ai/grok-4.20::phase4': {
    grade: 'B',
    source: { method: 'bake-off', date: '2026-08-19', note: 'B-. Captured the whole relevant run of a dark exchange, but weak on the context behind one, and mistook DM narration for spoken dialogue.' },
  },
  'z-ai/glm-5.2::phase4': {
    grade: 'B',
    source: { method: 'bake-off', date: '2026-08-19', note: 'B-. Splits lines apart more than the others; jests tended to restate the quoted exchanges rather than find separate funny moments.' },
  },
  'deepseek/deepseek-v4-pro::phase4': {
    grade: 'B',
    source: { method: 'bake-off', date: '2026-08-19', note: 'B-. Starts exchanges at arbitrary points rather than at the setup, and captured DM scene-setting as a character quote.' },
  },
  '~google/gemini-pro-latest::phase4': {
    grade: 'C',
    source: { method: 'bake-off', date: '2026-08-19', note: 'C+. Enters exchanges mid-run rather than at the beginning; returned no gore at all, and light on jests.' },
  },
  'moonshotai/kimi-k2.6::phase4': {
    grade: 'D',
    source: {
      method: 'bake-off',
      date: '2026-08-19',
      note: 'C- on quality — nonsensical context ("Jesus Christ." answered by "is Jesus?"), a fraction of the exchanges other models found, and gore that is barely gore. Compounded by returning an empty body on two runs in three even with the provider pinned, so D rather than C.',
    },
  },
  'deepseek/deepseek-v4-flash::phase4': {
    grade: 'C',
    source: { method: 'bake-off', date: '2026-08-19', note: 'C+. Thin: four exchanges and one lone quote, no gore, three jests. Effectively free, so the trade is at least explicit.' },
  },
  'gemini-pro-latest::phase4': {
    grade: 'C',
    source: {
      method: 'bake-off',
      date: '2026-08-19',
      note: 'C-. Poor at telling dialogue from narration — captured a long DM scene-description as a spoken quote. Thin on both jests and gore. This is the REFERENCE model: strong at Chronicle, weak here.',
    },
  },
  // Re-run 2026-08-19 with temperature unset, matching production exactly
  // (runPhase4 never sets it, so both adapters fall through to the
  // provider default). Output was materially unchanged on both Gemini
  // tiers — Flash 2 jests/0 gore/4 quotes became 3/0/4, Pro 2/1/5 became
  // 2/1/6. Sampling temperature is therefore ruled out as the reason
  // these grade below several cheaper models here.
  'gemini-flash-latest::phase4': {
    grade: 'C',
    source: {
      method: 'bake-off',
      date: '2026-08-19',
      note: 'C-. Very few jests and gore, quotes thin. This is what routing runs on Extras today, so it is the clearest available upgrade in the pipeline.',
    },
  },
}

/**
 * Grades applied to a whole model FAMILY by id prefix.
 *
 * Two kinds of entry live here:
 *
 *  1. Calibration against the reference from first-hand use. The Gemini Flash
 *     rows are the important ones — Pro is clearly better at Chronicle, but the
 *     gap narrows to near-parity on Extras and Condense, which is exactly the
 *     sort of per-phase difference a single overall score would flatten away.
 *
 *  2. Disqualifications where published evidence is specific enough to act on.
 *     These are F and D only. Nothing here awards an A from research.
 */
export const FAMILY_GRADES: Array<{
  match: (id: string) => boolean
  phases: Phase[]
  grade: Grade
  source: MeasurementSource
}> = [
  // ── The reference itself ─────────────────────────────────────────
  {
    // Gemini Pro is the bar, so it grades B everywhere by definition: as good
    // as itself, and not cheaper than itself. Anything reaching A has to have
    // earned it on quality or on price.
    match: (id) => /^(~)?google\/gemini(-[\d.]+)?-pro/.test(id),
    phases: [...PHASE_ORDER],
    grade: 'B',
    source: {
      method: 'operator-report',
      date: '2026-08-18',
      note: 'The reference model. B is the bar, not a criticism.',
    },
  },

  // ── Reference calibration ────────────────────────────────────────
  {
    // Full parity on Extras, and a fraction of the price — the clearest A in
    // the table, and a straightforward saving on a phase Pro is wasted on.
    match: (id) => /^google\/gemini-[\d.]+-flash$/.test(id) || id === 'google/gemini-flash-latest',
    phases: ['phase4'],
    grade: 'A',
    source: {
      method: 'operator-report',
      date: '2026-08-18',
      note: 'Matches Pro on extracting quotes, jests and gore, for a fraction of the cost.',
    },
  },
  {
    // Very close on Condense but not quite level, so the lower price lifts it
    // to B rather than A.
    match: (id) => /^google\/gemini-[\d.]+-flash$/.test(id) || id === 'google/gemini-flash-latest',
    phases: ['phase6'],
    grade: 'B',
    source: {
      method: 'operator-report',
      date: '2026-08-18',
      note: 'Nearly level with Pro on condensing; the gap is small but visible.',
    },
  },
  {
    // Pro is clearly ahead on long-form prose. Cheapness does not close that.
    match: (id) => /^google\/gemini-[\d.]+-flash$/.test(id) || id === 'google/gemini-flash-latest',
    phases: ['phase3'],
    grade: 'C',
    source: {
      method: 'operator-report',
      date: '2026-08-18',
      note: 'Pro is clearly better at long-form chronicle prose. Usable, but you would see it.',
    },
  },
  {
    // Gemini finds the joke where Claude finds a merely notable line.
    match: (id) => id.startsWith('anthropic/'),
    phases: ['phase4'],
    grade: 'C',
    source: {
      method: 'operator-report',
      date: '2026-08-18',
      note: 'Weak grasp of humour when asked for funny quotes. Fine on gore and events.',
    },
  },

  // ── Research-based disqualifications ─────────────────────────────
  {
    // Cannot disable thinking, and separately shown to overshoot an explicit
    // length constraint by 5x (303 characters against a 60-character limit).
    // Both phases here are defined by "same length as the input".
    match: (id) => id === 'minimax/minimax-m2.5',
    phases: ['phase1', 'phase3'],
    grade: 'F',
    source: {
      method: 'research',
      date: '2026-08-18',
      note: 'Thinking cannot be disabled, and a reproduced report shows it overshooting an explicit length limit by 5x.',
      citation: 'MiniMax API docs; MiniMax-M2 issue #77',
    },
  },
  {
    // Being retired on 2026-08-31.
    match: (id) => id.startsWith('moonshotai/kimi-k2.5'),
    phases: [...PHASE_ORDER],
    grade: 'F',
    source: {
      method: 'research',
      date: '2026-08-18',
      note: 'Platform sunset on 2026-08-31 — already closed to new users. Do not build on it.',
      citation: 'platform.kimi.ai model list',
    },
  },
  {
    // Open, unresolved report of Chinese characters injected into English
    // output mid-session, plus a 16k output cap on its default host.
    match: (id) => id.startsWith('z-ai/glm-4.7-flash'),
    phases: ['phase1', 'phase3', 'phase6'],
    grade: 'F',
    source: {
      method: 'research',
      date: '2026-08-18',
      note: 'Open unresolved report of non-Latin characters injected into English output, and a 16k output cap on the default host.',
      citation: 'zai-org/GLM-4.5 issue #143',
    },
  },
  {
    // Trained toward the shortest correct response, with a middling
    // long-form-generation score. The opposite of what these phases need.
    match: (id) => id.startsWith('inclusionai/ling'),
    phases: ['phase1', 'phase3'],
    grade: 'D',
    source: {
      method: 'research',
      date: '2026-08-18',
      note: 'Optimised toward the shortest correct response, and LIFEBench long-form generation of 57.2. Elevated risk of summarising where reproduction was asked for.',
      citation: 'arXiv 2606.15079 (Ling 2.6 technical report)',
    },
  },
  {
    // A coding model. Returned an empty body on a grounding probe.
    match: (id) => /code|coder/.test(id),
    phases: ['phase3', 'phase4', 'phase6'],
    grade: 'D',
    source: {
      method: 'research',
      date: '2026-08-18',
      note: 'Code-specialised model. One returned an empty body when probed on a grounding task; prose phases are outside what these are tuned for.',
    },
  },
]

// ────────────────────────────────────────────────────────────────────
// Qualitative caveats
// ────────────────────────────────────────────────────────────────────

/**
 * Notes that do not fit a grade but change whether you want a model on a
 * phase. `observed` is first-hand; `reported` comes from published sources or
 * vendor documentation.
 *
 * Keyed by model-id prefix so a family can be annotated once.
 */
export const MODEL_CAVEATS: Array<{
  match: (id: string) => boolean
  phases: Phase[]
  caveat: Caveat
  /** Drop this caveat once the model+phase has a MEASURED_GRADES entry. For
   *  caveats whose whole content is "we have not checked this yet" — keeping
   *  them beside a measured grade would undercut the better evidence. */
  supersededByMeasurement?: boolean
}> = [
  {
    // The most important caveat in this table, because the model it describes
    // is graded A on Extras. Measured across five long generations on
    // 2026-08-19: it returned an empty body or a repetition loop on every run
    // that exceeded roughly ten thousand reasoning tokens, and completed
    // cleanly below that. The failures were served by a different upstream
    // than the successes, so this is provider routing rather than the model —
    // which is precisely why it cannot be relied on without pinning.
    match: (id) => id.startsWith('moonshotai/kimi-k3'),
    phases: ['phase1', 'phase2', 'phase3', 'phase4', 'phase6'],
    caveat: {
      kind: 'observed',
      text: 'Needs TWO settings, not one: reasoning: { effort: "low" } AND the serving provider pinned to moonshotai. The cap alone is not enough — OpenRouter routes to whichever provider it likes, and several accept the request while ignoring the cap entirely, at which point it reasons past fifteen thousand tokens and returns an empty body, billed in full. Pinned and capped it completed every attempt at under twenty reasoning tokens, five times cheaper and up to six times faster than the same request unpinned.',
    },
  },
  {
    // Same failure shape as kimi-k3, but the fix does NOT transfer: asked for
    // low effort it still spent 9.9k-15.3k reasoning tokens, so it keeps
    // crossing the threshold that kills it.
    match: (id) => id.startsWith('moonshotai/kimi-k2'),
    phases: ['phase1', 'phase2', 'phase3', 'phase4', 'phase6'],
    caveat: {
      kind: 'observed',
      text: 'Ignores the reasoning cap, and neither capping nor pinning the provider fixes it. Run on the same provider that honours the cap perfectly for its sibling model, it still spent six to nineteen thousand reasoning tokens and returned an empty body on two Extras runs in three. Also slow: 400-500 seconds per chunk, which is roughly an hour for a whole prose phase. The quality is genuinely good on prose; the wall-clock and the silent failures are what rule it out.',
    },
  },
  {
    // Measured 2026-08-19 on a dialogue-dense session. The direction is the
    // opposite of the Chronicle result, where both Gemini models graded A.
    match: (id) => id.startsWith('google/') || id.startsWith('~google/') || id.startsWith('gemini-'),
    phases: ['phase4'],
    caveat: {
      kind: 'observed',
      text: 'Strong at prose, weak at extraction. On Extras both Gemini tiers returned thin jests and gore, and captured long DM scene-description as though it were spoken dialogue. Several cheaper models beat them clearly on this phase, which is not true of Chronicle.',
    },
  },
  {
    // Mandatory reasoning with no off switch. Probed on 2026-08-18 it returned
    // an EMPTY body on a small JSON task — consistent with reasoning consuming
    // the whole token budget before any visible output was produced.
    match: (id) => id.startsWith('openai/gpt-oss'),
    phases: ['phase2', 'phase4'],
    caveat: {
      kind: 'observed',
      text: 'Reasoning cannot be disabled, and it returned an empty body on a small JSON task when probed — the reasoning appears to consume the budget before any output is produced. Raise the output allowance well above what the JSON needs, or pick a model whose reasoning can be switched off.',
    },
  },
  {
    // First-hand comparison against Gemini on the same session.
    match: (id) => id.startsWith('anthropic/'),
    phases: ['phase4'],
    caveat: {
      kind: 'observed',
      text: 'Weak sense of what is actually funny. Asked to pull humorous quotes it returns lines that are merely notable, where Gemini finds the joke. Fine for gore and jests-as-events, poor for comic timing.',
    },
  },
  {
    match: (id) => id.startsWith('x-ai/'),
    phases: ['phase3', 'phase4'],
    caveat: {
      kind: 'reported',
      text: 'No prompt-level moderation and a conversational register, so expected to handle humour and mature content well. Not yet measured against the reference here.',
    },
  },
  {
    match: (id) =>
      id.startsWith('deepseek/') || id.startsWith('z-ai/') || id.startsWith('qwen/') ||
      id.startsWith('moonshotai/') || id.startsWith('minimax/') || id.startsWith('inclusionai/'),
    phases: ['phase3', 'phase4', 'phase6'],
    supersededByMeasurement: true,
    caveat: {
      kind: 'reported',
      text: 'Strong on structured transformation; conversational range and English prose quality are unverified for this pipeline. Treat prose phases as untested until you have read a chronicle it wrote.',
    },
  },
  {
    match: (id) => id.startsWith('deepseek/') || id.startsWith('z-ai/'),
    phases: ['phase1', 'phase3', 'phase6'],
    caveat: {
      kind: 'reported',
      text: 'Both families have vendor-acknowledged issues with non-Latin characters appearing in long English output, more often on quantised hosting and more often the longer the passage. One report describes it occurring specifically when reproducing input, which is what Ground does.',
    },
  },
  {
    match: (id) => id.startsWith('inclusionai/'),
    phases: ['phase1', 'phase3'],
    caveat: {
      kind: 'reported',
      text: 'Trained toward the shortest correct response, which is the opposite of what the two long phases need. Elevated risk of summarising where reproduction was asked for.',
    },
  },
]

// ────────────────────────────────────────────────────────────────────
// Structural blockers — checkable without running anything
// ────────────────────────────────────────────────────────────────────

const JSON_PHASES = new Set<Phase>(['phase2', 'phase4'])
const PROSE_PHASES = new Set<Phase>(['phase1', 'phase3', 'phase6'])
export const CHARS_PER_TOKEN = 4

/** Output volume relative to the phase's input chunk. */
export const OUTPUT_RATIO: Record<Phase, number> = {
  phase1: 1.0,
  phase2: 0.02,
  phase3: 0.9,
  phase4: 0.05,
  phase6: 0.3,
}

export interface PhaseSizing {
  chunkChars: number
  kbChars: number
  overheadChars: number
}

export const DEFAULT_SIZING: Record<Phase, PhaseSizing> = {
  phase1: { chunkChars: 15_000, kbChars: 15_000, overheadChars: 1_870 },
  phase2: { chunkChars: 15_000, kbChars: 0, overheadChars: 2_220 },
  phase3: { chunkChars: 30_000, kbChars: 0, overheadChars: 8_030 },
  phase4: { chunkChars: 30_000, kbChars: 0, overheadChars: 5_140 },
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

// ────────────────────────────────────────────────────────────────────
// Verdicts
// ────────────────────────────────────────────────────────────────────

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

  const family = FAMILY_GRADES.find(
    (f) => f.phases.includes(phase) && f.match(model.id),
  )
  if (family) return { grade: family.grade, blockers, caveats, source: family.source }

  // No blocker, no measurement, no family evidence. Unknown, and said so.
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

/** Grades that mean "this will not work", for filtering. */
export function isBlocked(v: PhaseVerdict): boolean {
  return v.grade === 'F'
}

function fmtK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

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
    // Condense reads the chronicle (~0.9 of transcript) and carries the lore.
    const corpus =
      phase === 'phase6' ? REFERENCE_SESSION.transcriptChars * 0.9 : REFERENCE_SESSION.transcriptChars
    const kbChars = phase === 'phase1' ? 15_000 : phase === 'phase6' ? REFERENCE_SESSION.loreChars : 0
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
