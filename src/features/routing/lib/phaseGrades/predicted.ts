// Predicted grades for models not yet measured, and known per-model caveats.
import { declaredSizeB } from './lineage'
import { PHASE_ORDER } from './scale'
import type { Caveat, Grade, Phase } from './scale'

/** When the prediction rules below were last reviewed against the catalogue.
 *  Shown on every predicted grade so a reader can see how stale the reasoning
 *  is — model lines move faster than this table does. */
export const PREDICTIONS_DATED = '2026-08-27'

export const PREDICTED_GRADES: Array<{
  match: (id: string) => boolean
  phases: Phase[]
  grade: Exclude<Grade, 'A' | 'untested'>
  basis: string
}> = [
  // ── Purpose: not a general text generator ───────────────────────
  {
    match: (id) =>
      /llama-guard|content-safety|safeguard|guardrail/.test(id) || id === 'openrouter/free',
    phases: [...PHASE_ORDER],
    grade: 'F',
    basis:
      'A safety classifier rather than a generator: it returns a verdict about text, not text. No phase here has anything to read from it.',
  },
  {
    match: (id) => /^relace\/|^morph\//.test(id),
    phases: [...PHASE_ORDER],
    grade: 'F',
    basis:
      'A code-edit application endpoint. It takes a diff and a file and returns the merged file; it is not built to write prose or to extract anything from it.',
  },
  {
    match: (id) => /ui-tars|^perceptron\//.test(id),
    phases: [...PHASE_ORDER],
    grade: 'F',
    basis:
      'A GUI-grounding model, trained to locate and act on screen elements. Long-form prose is outside what it exists to emit.',
  },
  {
    match: (id) => /^perplexity\/sonar/.test(id),
    phases: ['phase1', 'phase3'],
    grade: 'F',
    basis:
      'Answers from live web retrieval and cites what it finds. These phases must write only from the transcript in front of them, so retrieved material reaching the prose would corrupt the record rather than merely weaken it.',
  },
  {
    match: (id) => /^perplexity\/sonar/.test(id),
    phases: ['phase2', 'phase4', 'phase6'],
    grade: 'D',
    basis:
      'Built for retrieval-backed answers, not for extracting structure from a supplied document.',
  },
  {
    match: (id) => /^openai\/gpt-oss/.test(id),
    phases: ['phase2', 'phase6'],
    grade: 'D',
    basis:
      'Reasoning cannot be disabled, and this family returned an empty body on a small JSON task when probed — the reasoning appears to consume the budget before any output is produced. The other JSON phases are predicted to hit the same wall.',
  },

  // ── Purpose: built for code ─────────────────────────────────────
  // FAMILY_GRADES already grades /code|coder/ at D on Chronicle, Extras and
  // Condense off a probe that came back with an empty body. This extends the
  // same finding to the two phases that rule does not cover, and to the code
  // vendors whose names do not contain the word.
  {
    match: (id) =>
      /coder|codestral|devstral|codex|-code(\b|-|:|$)|^poolside\/|^kwaipilot\//.test(id),
    phases: ['phase1', 'phase2'],
    grade: 'D',
    basis:
      'Post-trained for code. Ground has to reproduce prose faithfully and Audit has to judge it, neither of which is what a code specialisation is tuned for — and the phases already measured on this family came back at D.',
  },

  // ── Size: the smallest tier a vendor ships ──────────────────────
  {
    match: (id) => /-(nano|micro|edge|tiny)(\b|-|:|$)|^liquid\/lfm/.test(id),
    phases: [...PHASE_ORDER],
    grade: 'D',
    basis:
      'The smallest tier a vendor ships. The one model of this class put through the Grounding bake-off refused the task outright, and the tier above it returned well-formed output that had corrected almost nothing.',
  },

  // ── Purpose: creative and roleplay finetunes ────────────────────
  // Ahead of the size rules on purpose: several of these are small, and their
  // prose is the whole reason someone would reach for one.
  {
    match: (id) =>
      /^(thedrummer|sao10k|anthracite-org|gryphe|undi95|mancer|cognitivecomputations|nousresearch)\/|aion-rp/.test(
        id,
      ),
    phases: ['phase3'],
    grade: 'C',
    basis:
      'A creative-writing finetune. Prose voice is what these are tuned for and they carry mature content without complaint, which suits a table transcript — but they are built on older, smaller base models, so fidelity across a long chunk is the risk.',
  },
  {
    match: (id) =>
      /^(thedrummer|sao10k|anthracite-org|gryphe|undi95|mancer|cognitivecomputations|nousresearch)\/|aion-rp/.test(
        id,
      ),
    phases: ['phase1', 'phase2', 'phase4', 'phase6'],
    grade: 'D',
    basis:
      'Roleplay finetuning trades away the instruction-following these phases depend on: three of them must return strict JSON, and Ground must change nothing it was not asked to change.',
  },

  // ── Size the id declares ────────────────────────────────────────
  {
    match: (id) => (declaredSizeB(id) ?? Infinity) < 10,
    phases: [...PHASE_ORDER],
    grade: 'D',
    basis:
      'Single-digit billions of parameters. Ground must reproduce a 20,000-character chunk almost exactly while correcting names inside it, and Chronicle must write back about as much as it reads; models of this size measured on Ground failed it while returning output that looked right.',
  },
  {
    match: (id) => {
      const b = declaredSizeB(id) ?? Infinity
      return b >= 10 && b < 100
    },
    phases: [...PHASE_ORDER],
    grade: 'C',
    basis:
      'Tens of billions of parameters. Enough to hold the format across a long chunk, not enough to expect the reference standard from it. Single-digit sizes grade below this and triple-digit ones above — coarse, but legible.',
  },

  // ── The vendor's own cheap tier ─────────────────────────────────
  // Named rather than sized, because "mini" and "lite" are the vendor saying
  // this is the cheap one. Deliberately C: the two measured models of roughly
  // this class landed at D and F, but both were the tier BELOW, and a C keeps
  // the model listed with its grade on show rather than filtering it out on a
  // marketing suffix.
  {
    match: (id) => /-(mini|lite|air|small|turbo|flash)(\b|-|:|$)/.test(id),
    phases: [...PHASE_ORDER],
    grade: 'C',
    basis:
      'The cheap tier of its line. Usually a real drop in sustained-output fidelity from the flagship beside it, which is the axis every phase here loads — but the size of that drop varies enough between vendors to make this a caution rather than a disqualification.',
  },

  // ── Generation: superseded lines ────────────────────────────────
  {
    match: (id) => /^openai\/gpt-3\.5/.test(id),
    phases: [...PHASE_ORDER],
    grade: 'D',
    basis:
      'Several generations behind the current line, with a short context and weak instruction-following by present standards.',
  },
  {
    match: (id) =>
      /^openai\/(gpt-4($|-|:)|gpt-4o|gpt-4\.1|o1|o3|o4)/.test(id) ||
      /^anthropic\/claude-(3-haiku|opus-4($|:)|sonnet-4($|:))/.test(id) ||
      /^meta-llama\/llama-3/.test(id) ||
      /^qwen\/qwen-?2\.5/.test(id) ||
      /^deepseek\/deepseek-(r1|chat|v3)/.test(id) ||
      /^z-ai\/glm-4\.5/.test(id) ||
      /^minimax\/minimax-(01|m1)/.test(id) ||
      /^moonshotai\/kimi-k2($|-0905)/.test(id) ||
      /^google\/gemma-/.test(id) ||
      /^cohere\/command-r/.test(id) ||
      /^mistralai\/(mixtral|mistral-nemo|mistral-saba)/.test(id) ||
      /^microsoft\/(phi-4|wizardlm)/.test(id),
    phases: [...PHASE_ORDER],
    grade: 'C',
    basis:
      'A generation or more behind the current line from the same vendor. Still capable, but the newer sibling beside it is the one worth spending a session on.',
  },

  // ── Family evidence carried across a line ───────────────────────
  // Two Nemotron models went through the Grounding bake-off. One wrote its own
  // deliberation into the transcript at 3.5x length; the other corrected
  // nothing at all while returning perfectly well-formed output. Two failures
  // of different kinds in one family is a pattern, not a coincidence.
  {
    match: (id) => /^nvidia\/nemotron/.test(id),
    phases: [...PHASE_ORDER],
    grade: 'D',
    basis:
      'Every Nemotron measured here has failed the phase it was tried on, in two different ways. Until one is measured passing, the line is treated as suspect.',
  },

  // ── Flagship tier of lines with a track record here ─────────────
  // B, never higher. B is the reference standard, and beating it is the one
  // thing a prediction cannot establish.
  {
    match: (id) =>
      /^anthropic\/claude-(opus|sonnet|fable)/.test(id) ||
      /^openai\/gpt-(5|latest)/.test(id) ||
      /^x-ai\/grok-4/.test(id) ||
      /^deepseek\/deepseek-v4/.test(id) ||
      /^qwen\/qwen3.*(max|plus)/.test(id) ||
      /^moonshotai\/kimi-(k2\.[5-9]|k3|latest)/.test(id) ||
      /^z-ai\/glm-(5|4\.[67]|latest)/.test(id) ||
      /^minimax\/minimax-m[23]/.test(id) ||
      /^mistralai\/mistral-(large|medium)/.test(id) ||
      (declaredSizeB(id) ?? 0) >= 100,
    phases: [...PHASE_ORDER],
    grade: 'B',
    basis:
      'A current flagship from a line with a track record on this pipeline, or a model large enough to be one. Predicted at the reference standard — a prediction cannot establish that anything beats the reference, so B is the ceiling.',
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
