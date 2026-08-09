// Speaker-tag detach/reattach for Phase 1 grounding on Craig transcripts.
//
// Craig recordings come into the pipeline as
//   [Dungeon Master (DM)] So the orc charges at you.
//   [Lakshmi (Olamide)] I dodge and counter.
//
// where `[CharacterName (PlayerName)]` is generated deterministically by
// server/whisper/liveQueue.ts:rewriteSbv() from speakers.json + per-track
// segments. The bracketed prefix is already-correct lore — there's no
// grounding work for the model to do on it, but today it ships through
// every Phase 1 chunk and Phase 2 audit, paying ~25-30 chars per
// utterance per phase in pure noise.
//
// This module strips the brackets before grounding, replaces them with
// short numeric markers `«N»` (U+00AB / U+00BB — visually distinct from
// content brackets, statistically absent from TTRPG text), and
// reattaches the original brackets after grounding by matching markers
// in the model's output. The marker pattern is inspired by sbvGround.ts
// which uses `[N]` cue numbering for the same problem — we picked
// different glyphs here because the dialogue body may already contain
// `[...]` content brackets and we don't want collisions.
//
// Behaviour on non-Craig inputs (plain text, no speaker tags) is a
// no-op: detectSpeakers returns `attached: false` and the caller passes
// the original transcript through unchanged. No marker overhead is paid
// for inputs that wouldn't benefit.

/** Regex matching a speaker-tagged line.
 *
 *  Group 1 = the bracket including its delimiters (e.g. `[Dungeon Master (DM)]`)
 *  Group 2 = the dialogue body (everything after the bracket + space)
 *
 *  Anchored to the start of a line. The bracket itself is greedy-up-to-
 *  the-next-`]` so `[Lakshmi (Olamide)]` matches even though the content has
 *  nested parens — we don't try to validate the inner shape, just that
 *  the prefix exists. Trailing whitespace between bracket and body is
 *  collapsed to one space on reattachment. */
const SPEAKER_LINE_RE = /^\s*(\[[^\]]+\])\s+(.*)$/

/** Marker regex used on the model's grounded output. Group 1 is the
 *  marker index; group 2 is the dialogue body the model returned. */
const MARKER_LINE_RE = /^«(\d+)»\s*(.*)$/

export type DetachResult = {
  /** The transcript fed into the chunker / grounder. Lines that had a
   *  speaker bracket are now prefixed with `«N»`; lines that didn't are
   *  passed through verbatim. */
  stripped: string
  /** When `attached === true`, this maps each line index (1-based, to
   *  match the marker) to the original speaker bracket. Lines without a
   *  bracket are absent from the map. Empty map when attached === false. */
  speakersByMarker: Map<number, string>
  /** True iff at least one line had a speaker bracket. False short-
   *  circuits the whole detach/reattach pipeline — non-Craig inputs go
   *  through Phase 1 unchanged (matching the pre-optimization byte-for-
   *  byte behaviour). */
  attached: boolean
}

/**
 * Walk a transcript line-by-line. For each line that matches the
 * `[Speaker (Player)] body` shape, replace the bracket with `«N» body`
 * where N is the line's 1-based index. For lines without a bracket,
 * emit them unchanged.
 *
 * Returns `attached: false` and the input verbatim when no line carried
 * a bracket — this is the no-op path for plain-text / non-Craig inputs.
 *
 * Pure function. Safe to call on any string. Idempotent only in the
 * sense that re-running it on an already-stripped transcript would
 * find no `[...]` prefixes and skip — the markers themselves are not
 * removed.
 */
export function detachSpeakers(transcript: string): DetachResult {
  const lines = transcript.split('\n')
  const speakersByMarker = new Map<number, string>()
  const outLines: string[] = []
  let anyMatched = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const match = SPEAKER_LINE_RE.exec(line)
    if (match) {
      anyMatched = true
      const markerIndex = i + 1
      speakersByMarker.set(markerIndex, match[1])
      outLines.push(`«${markerIndex}» ${match[2]}`)
    } else {
      outLines.push(line)
    }
  }

  if (!anyMatched) {
    return {
      stripped: transcript,
      speakersByMarker: new Map(),
      attached: false,
    }
  }
  return {
    stripped: outLines.join('\n'),
    speakersByMarker,
    attached: true,
  }
}

export type ReattachResult = {
  /** The reattached transcript — Phase 2 / 3 see this identical to what
   *  Phase 1 produced before the optimisation. */
  transcript: string
  /** Fraction of source lines (the ones that originally had a speaker
   *  bracket) where the marker was lost in the model's output and we
   *  fell back to plain dialogue without re-prepending the bracket.
   *  A high rate (≥ 15 %) is a signal that the model is dropping markers
   *  faster than the optimisation can absorb — the caller surfaces this
   *  in the UI so the user can opt out for the next run. */
  dropoutRate: number
}

/**
 * Re-prepend speaker brackets to a grounded transcript by parsing the
 * `«N»` markers. Lines that emit a marker get their original bracket
 * back; lines that don't (model dropped the marker, split a line, or
 * the source line never had a bracket) are emitted as-is so the
 * downstream phases still see SOMETHING for that line.
 *
 * Dropout accounting:
 *   - Numerator: source lines (entries in speakersByMarker) whose
 *     marker number does NOT appear at the head of any output line.
 *   - Denominator: total source lines that had a bracket.
 *
 * Caller threshold to recommend disabling the optimisation: 15 %.
 */
export function reattachSpeakers(
  groundedTranscript: string,
  detach: DetachResult,
): ReattachResult {
  if (!detach.attached) {
    return { transcript: groundedTranscript, dropoutRate: 0 }
  }

  const seenMarkers = new Set<number>()
  const lines = groundedTranscript.split('\n')
  const out: string[] = []

  for (const line of lines) {
    const match = MARKER_LINE_RE.exec(line)
    if (match) {
      const idx = Number.parseInt(match[1], 10)
      const bracket = detach.speakersByMarker.get(idx)
      if (bracket !== undefined) {
        seenMarkers.add(idx)
        out.push(`${bracket} ${match[2]}`)
        continue
      }
      // Marker pointed at an index we never registered (model invented
      // one). Drop the marker so the user doesn't see «42» in the final
      // chronicle; emit the body so the line isn't lost outright.
      out.push(match[2])
      continue
    }
    // Plain line — either the source line never had a bracket, or the
    // model dropped the marker. Either way: pass through. The Phase 3
    // chronicle prompt tolerates unbracketed narrator / scene-break
    // lines per its existing instructions.
    out.push(line)
  }

  const totalSourceLines = detach.speakersByMarker.size
  const droppedCount = totalSourceLines - seenMarkers.size
  const dropoutRate = totalSourceLines === 0 ? 0 : droppedCount / totalSourceLines

  return {
    transcript: out.join('\n'),
    dropoutRate,
  }
}
