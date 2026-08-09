export type { SbvCue } from '@/lib/sbv'
import type { SbvCue } from '@/lib/sbv'
export type { RefusalRecord } from '@/lib/refusalDetection'
import type { RefusalRecord } from '@/lib/refusalDetection'

export type SbvRepairStatus = 'idle' | 'running' | 'done' | 'error'

export type SbvRepairState = {
  fileName: string
  originalCues: SbvCue[]
  cues: SbvCue[]
  status: SbvRepairStatus
  currentChunkIndex: number
  totalChunks: number
  countdownMs: number
  totalChanged: number
  lastError?: string
  updatedAt: string
}

export const initialSbvRepairState: SbvRepairState = {
  fileName: '',
  originalCues: [],
  cues: [],
  status: 'idle',
  currentChunkIndex: 0,
  totalChunks: 0,
  countdownMs: 0,
  totalChanged: 0,
  updatedAt: new Date(0).toISOString(),
}

export type KBDocument = {
  id: string
  name: string
  type: 'pdf' | 'docx' | 'txt' | 'md'
  text: string
  sizeBytes: number
  addedAt: string
  /** Path relative to Tusks-Lore root (POSIX separators). Only populated
   * for documents sourced from the shared lore folder; legacy
   * localStorage-only docs leave this undefined. */
  relPath?: string
}

export type DMQuestion = {
  id: string
  question: string
  context?: string
}

export type DMAnswers = Record<string, string>

export type QuoteKind = 'funny' | 'stupid' | 'dark'

/** One turn of a multi-speaker exchange. */
export type QuoteTurn = {
  speaker: string
  line: string
}

export type Quote = {
  speaker: string
  line: string
  /** Curated category. Defaults to 'funny' for legacy entries. */
  kind?: QuoteKind
  /** Set when the moment only lands as a back-and-forth: the ordered turns
   *  between two or more speakers. `speaker` then holds the participant list
   *  and `line` a flattened rendering, so consumers that only understand the
   *  flat shape still show readable text. See `src/lib/quotes.ts`. */
  exchange?: QuoteTurn[]
  /** One short sentence of setup, present only when the quote does not land
   *  without it (an unstated fact that makes the payoff work). */
  context?: string
}

export type ExtrasOutput = {
  jests: string[]
  gore: string[]
  quotes: Quote[]
}

export type CondenseOutput = {
  /** Tightened narrative aiming at ~30–50% of the original chronicle. */
  narrative: string
  /** 10–15 catch-up bullets covering events, NPC interactions, party state. */
  bulletPoints: string[]
}

export type PhaseId =
  | 'phase1_ground'
  | 'phase2_audit'
  | 'phase3_chronicle'
  | 'phase4_extras'
  | 'phase5_polish'
  | 'phase6_condense'

export type PipelineStatus =
  | 'idle'
  | PhaseId
  | 'awaiting_dm'
  | 'awaiting_outputs' // the user has answered (or skipped) the DM questions
                       // and is now picking which of Chronicle / Extras /
                       // Condensed to generate. Sits between awaiting_dm
                       // and the actual phase_start.
  | 'done'
  | 'error'

/** Which of the post-Phase-2 outputs the user wants this run to produce.
 *  Selected via OutputPicker between awaiting_dm and the actual run. Each
 *  field is independent — `condensed` requires `chronicle` (the prompt
 *  consumes the chronicle), enforced in the picker UI. */
export type OutputSelection = {
  chronicle: boolean
  /** Phase 4 — quotes, jests, gore. Independent of chronicle. */
  extras: boolean
  /** Phase 6 — condensed narrative + bullets. Requires chronicle. */
  condensed: boolean
  /** v1.1.0 Condense Slider — desired condensed length as a percentage of
   *  the chronicle's word count (0-100, step 5). The actual target word
   *  count is computed at Phase 6 start time as
   *  `Math.round(chronicleWordCount * percentage / 100)`, so the user's
   *  preference holds even though the chronicle isn't known until Phase 3
   *  completes. Only consulted when `condensed === true`. */
  condensePercentage: number
}

/** Default for a fresh run. Matches today's surfaced behaviour (chronicle +
 *  extras always; condense opt-in via button). Persisted to localStorage
 *  under LS_OUTPUT_SELECTION; a returning user gets their last selection.
 *  Default condensePercentage is 20 — produces a ~2,800-word condense on
 *  a typical 14,000-word 3-hour session, close to the legacy 2,000-word
 *  ceiling at typical session sizes.
 */
export const DEFAULT_OUTPUT_SELECTION: OutputSelection = {
  chronicle: true,
  extras: true,
  condensed: false,
  condensePercentage: 20,
}

export type RefinementState = {
  campaign: string
  sessionNumber: number
  rawTranscript: string
  groundedTranscript: string
  dmQuestions: DMQuestion[]
  dmAnswers: DMAnswers
  chronicle: string
  extras: ExtrasOutput | null
  /** Phase 6 output. Optional — only produced if the user runs the
   * Condense pass. null until then. */
  condensed: CondenseOutput | null
  status: PipelineStatus
  currentPhase: PhaseId | null
  currentChunkIndex: number
  totalChunks: number
  partialOutput: string
  lastError?: string
  countdownMs: number
  updatedAt: string
  /** What this run's user opted to generate. Persisted on the state so the
   *  checkpoint captures it for resume. Defaults match
   *  DEFAULT_OUTPUT_SELECTION. */
  outputSelection: OutputSelection
  /** Id of this run's record in the Saved Chronicles library (server disk
   *  store). Set once the finished run is auto-saved; used to UPDATE (not
   *  duplicate) the record when extras/condensed are generated afterwards.
   *  Cleared by reset() so the next run gets its own library entry — the
   *  previous one stays on disk (auto-keep-both). */
  savedChronicleId?: string
  /** Claude Code refusals that were NOT repaired in-run (failsafe off, no
   *  Gemini key, or Gemini also failed). Each carries enough context to
   *  re-process just that chunk later via the Review & Repair panel. Survives
   *  reloads (persisted) and rides along in the Saved Chronicle. Absent on
   *  older state / clean runs. */
  refusals?: RefusalRecord[]
}

export const initialRefinementState: RefinementState = {
  campaign: '',
  sessionNumber: 1,
  rawTranscript: '',
  groundedTranscript: '',
  dmQuestions: [],
  dmAnswers: {},
  chronicle: '',
  extras: null,
  condensed: null,
  status: 'idle',
  currentPhase: null,
  currentChunkIndex: 0,
  totalChunks: 0,
  partialOutput: '',
  countdownMs: 0,
  updatedAt: new Date(0).toISOString(),
  outputSelection: DEFAULT_OUTPUT_SELECTION,
  refusals: [],
}
