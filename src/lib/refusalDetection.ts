// Heuristics for spotting when an LLM (in practice: Claude via the Claude
// Code CLI) has REFUSED or produced an empty/near-empty chunk instead of the
// requested output. Powers the explicit-content failsafe:
//   - real-time: redo a refused chunk on Gemini (permissive) mid-run;
//   - post-hoc: count detections to auto-offer a Gemini restore pass.
//
// Deliberately conservative — a false positive triggers an unnecessary Gemini
// call (cost) or a needless restore offer, so we only flag clear cases:
//   1. empty / whitespace-only output;
//   2. a refusal phrase at the very START of a SHORT output (a long chronicle
//      that merely quotes "I can't" in dialogue won't match);
//   3. a chunk that produced almost nothing relative to a large input.
//
// Subtle softening (gore toned down, profanity euphemised) is NOT detectable
// here — that's what the post-hoc reconciliation pass exists to repair.

const REFUSAL_PHRASES = [
  "i can't help",
  'i cannot help',
  "i can't assist",
  'i cannot assist',
  "i can't create",
  'i cannot create',
  "i can't generate",
  'i cannot generate',
  "i can't continue",
  'i cannot continue',
  "i can't provide",
  'i cannot provide',
  "i won't be able",
  "i'm not able to",
  'i am not able to',
  "i'm unable to",
  'i am unable to',
  "i'm not comfortable",
  'i am not comfortable',
  'i do not feel comfortable',
  "i don't feel comfortable",
  'i must decline',
  "i'm sorry, but i can",
  'i am sorry, but i can',
  "i'm sorry but i can",
  'i apologize, but i can',
  "i apologize, but i can't",
  'as an ai',
  'against my guidelines',
  'content policy',
  'violates',
]

export type RefusalCheck = {
  refused: boolean
  /** Short machine-readable reason for diagnostics / events. */
  reason?: 'empty' | 'refusal_phrase' | 'suspiciously_short'
}

/**
 * @param output   the model's returned text for a chunk
 * @param inputChars optional size of the chunk's user prompt; enables the
 *                   "produced almost nothing for a large input" signal
 */
export function detectRefusal(output: string, inputChars?: number): RefusalCheck {
  const trimmed = (output ?? '').trim()
  if (trimmed.length === 0) return { refused: true, reason: 'empty' }

  const head = trimmed.slice(0, 200).toLowerCase()
  const isShort = trimmed.length < 600
  if (isShort && REFUSAL_PHRASES.some((p) => head.includes(p))) {
    return { refused: true, reason: 'refusal_phrase' }
  }

  // A large input that yields almost nothing is either a silent refusal or a
  // dropped chunk. Threshold is intentionally low (2%) to avoid flagging a
  // legitimately terse chronicle passage.
  if (inputChars && inputChars > 2000 && trimmed.length < Math.max(120, inputChars * 0.02)) {
    return { refused: true, reason: 'suspiciously_short' }
  }

  return { refused: false }
}

/** Convenience boolean wrapper. */
export function looksLikeRefusal(output: string, inputChars?: number): boolean {
  return detectRefusal(output, inputChars).refused
}

/** A recorded Claude Code refusal that the failsafe repaired on Gemini.
 *  Surfaced post-run in the review modal so the user can read the source
 *  and edit the substituted wording. */
export type FallbackRecord = {
  /** Pipeline phase id (e.g. 'phase3_chronicle'). */
  phase: string
  /** Chunk index within the phase. */
  chunkIndex: number
  /** The grounded transcript span that was refused — the "what was said". */
  transcriptExcerpt: string
  /** What Claude returned (the refusal / blank). */
  refusedText: string
  /** What Gemini wrote in. Empty if no Gemini key was available to repair.
   *  Also the exact string the review modal find-replaces on edit. */
  replacementText: string
}

/** A persisted, repairable refusal. Unlike {@link FallbackRecord} (transient,
 *  in-run, set only when the in-run Gemini restore succeeds), this is recorded
 *  whenever a Claude Code chunk is refused AND not repaired in-run, then saved
 *  to the run state + the Saved Chronicle so a targeted repair can run later. */
export type RefusalRecord = {
  /** Stable id, also embedded in the hidden marker tag for splicing. */
  id: string
  /** Pipeline phase id. */
  phase: string
  /** Chunk index within the phase. */
  chunkIndex: number
  /** Total chunks in the phase — lets repair rebuild the per-chunk prompt
   *  ("chunk i of N") identically to the original run. */
  totalChunks: number
  /** The chunk INPUT (grounded/raw span) to re-process on repair. */
  sourceSpan: string
  /** What Claude returned (diagnostics only). */
  refusedText: string
  /** EXACT sentinel injected into the prose output (Phase 1/3). Empty for the
   *  JSON phases (2/4), which carry no inline marker. The splice/find key. */
  marker: string
  /** Chunk-size target used to split this phase — lets a repair re-derive
   *  sibling spans deterministically (Phase 2 pairs raw with grounded).
   *  Undefined for phases whose source span is self-sufficient (1/3/4/6). */
  chunkSizeChars?: number
  /** Why detectRefusal flagged it. */
  reason?: RefusalCheck['reason']
  /** Flips true once a repair pass successfully restores this chunk. */
  repaired: boolean
  /** ISO timestamp the refusal was recorded. */
  createdAt: string
}

/** Human labels for the phase id, used in the visible marker banner. */
const PHASE_LABELS: Record<string, string> = {
  phase1_ground: 'Grounding',
  phase2_audit: 'Audit',
  phase3_chronicle: 'Chronicle',
  phase4_extras: 'Extras',
  phase5_polish: 'Polish',
  phase6_condense: 'Condense',
}

/** Matches the hidden machine-readable tag embedded in a prose marker.
 *  Global so {@link parseRefusalMarkers} can collect every occurrence. */
export const REFUSAL_TAG_RE = /<!--\s*TUSKS-REFUSAL:([0-9a-zA-Z-]+)\s*-->/g

/** Build the durable in-document marker for a refused PROSE chunk (Phase 1/3).
 *  A visible blockquote banner the user sees when reading the chronicle, plus
 *  an invisible HTML-comment tag carrying the id — the splice anchor. The
 *  exact returned string is stored on the RefusalRecord so repair can
 *  find-replace it precisely. */
export function buildRefusalMarker(
  phase: string,
  chunkIndex: number,
  total: number,
  id: string,
): string {
  const label = PHASE_LABELS[phase] ?? phase
  return [
    '',
    '',
    `> ⚠️ **Refusal — ${label}, chunk ${chunkIndex + 1}/${total}.** Claude Code declined to process this passage. Use **Review & Repair Refusals** to restore it from the source transcript.`,
    `<!--TUSKS-REFUSAL:${id}-->`,
    '',
    '',
  ].join('\n')
}

/** Extract every refusal-marker id present in a document, in order. */
export function parseRefusalMarkers(text: string): string[] {
  const ids: string[] = []
  for (const m of (text ?? '').matchAll(REFUSAL_TAG_RE)) ids.push(m[1])
  return ids
}

/** Crypto-strong id with a non-crypto fallback for old runtimes. Works in the
 *  browser (Vite client) and Node (tests). */
export function genRefusalId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  // Fallback: timestamp + random suffix. Uniqueness is per-run, which is enough.
  return `r-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`
}
