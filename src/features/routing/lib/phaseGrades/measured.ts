// Grades measured on real sessions, per model and per model family.
import { PHASE_ORDER } from './scale'
import type { Grade, MeasurementSource, Phase } from './scale'

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
    grade: 'A',
    source: {
      method: 'bake-off',
      date: '2026-08-19',
      note: '6/6 corrections at 1.0x length with every speaker tag intact — top of PHASE1_RUBRIC. CIRCULAR: this run also produced the answer key, so it was marked against its own output. Re-score against a key built from the glossary before treating the A as independent.',
    },
  },
  'gemini-flash-latest::phase1': {
    grade: 'B',
    source: { method: 'bake-off', date: '2026-08-19', note: '5/6 corrections, 1.0x length, all tags — one short of the reference on the same key. Far cheaper too, which the cost column shows.' },
  },
  'anthropic/claude-haiku-4.5::phase1': {
    grade: 'B',
    source: { method: 'bake-off', date: '2026-08-19', note: '5/6 corrections, 1.0x length, all 609 tags preserved exactly. The strongest non-Gemini grounder measured.' },
  },
  'qwen/qwen3-30b-a3b-instruct-2507::phase1': {
    grade: 'C',
    source: { method: 'bake-off', date: '2026-08-19', note: '4/6 corrections at 1.0x length with tags intact. Roughly a twenty-fifth of the reference price, so it still tops a quality-per-dollar sort — but the letter is what it grounded.' },
  },
  'z-ai/glm-4.7-flash::phase1': {
    grade: 'C',
    source: { method: 'bake-off', date: '2026-08-19', note: '4/6 corrections, 0.99x length, 601 of 609 tags.' },
  },
  'openai/gpt-oss-120b::phase1': {
    grade: 'C',
    source: { method: 'bake-off', date: '2026-08-19', note: '4/6 corrections, 0.96x length, 594 of 609 tags. Slight shrinkage worth watching on a phase that must not compress.' },
  },
  'deepseek/deepseek-v4-flash::phase1': {
    grade: 'D',
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
      note: "A- on a 30k Session 28 chunk — the best non-Gemini chronicle graded, \"very good at picking up prose and discerning descriptions from dialogue\", just below Gemini Flash at A. B rather than A because it sits just below Flash on quality, and it takes 400-500 seconds per chunk, roughly an hour for the whole phase. Quality is not the reason to avoid it; wall-clock and silent failures are.",
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
    grade: 'B',
    source: {
      method: 'bake-off',
      date: '2026-08-19',
      note: 'B+ on the graded configuration — a good spread of quotes, though it read some DM narration as dialogue and its jests largely restated the quotes. B on its own merits. It is still the best Extras grade measured and the cheapest of the three, which the ordering shows without the letter having to claim it. REQUIRES reasoning: { effort: "low" } AND provider pinned to moonshotai.',
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
 * Model ids carrying at least one INDIVIDUAL measurement, in any phase.
 *
 * Derived from MEASURED_GRADES rather than hand-listed, so it cannot drift
 * from the table it describes.
 *
 * Deliberately excludes FAMILY_GRADES: a family row is an inference from a
 * sibling model, and a filter offering "what has been tested" must not answer
 * with something nobody ran. It also cannot be replaced by checking
 * `grade !== 'untested'`, because judgePhase() returns 'F' from a structural
 * blocker BEFORE any measurement lookup — a model nobody has run but whose
 * context window is too small would otherwise read as tested.
 *
 * Ids may themselves contain a colon (`…-a12b:free`), so the phase separator
 * is found from the end.
 */
export const MEASURED_MODEL_IDS: ReadonlySet<string> = new Set(
  Object.keys(MEASURED_GRADES).map((k) => k.slice(0, k.lastIndexOf('::'))),
)

/** How many phases this model has an individual measurement on. 0 = untested
 *  by the maintainer, whatever a family row may infer about it. */
export function measuredPhaseCount(modelId: string): number {
  let n = 0
  for (const p of PHASE_ORDER) if (MEASURED_GRADES[`${modelId}::${p}`]) n++
  return n
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
