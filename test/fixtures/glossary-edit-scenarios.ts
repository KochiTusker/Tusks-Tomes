// Fixtures for B2 (Phase 1 input-drift on glossary edit).
//
// The bug: pipeline.ts:1189 runs cleanupTranscript → preGround → detachSpeakers
// against LIVE glossary state on resume. If the user edited the glossary
// between pause and resume, preGround output changes → chunk boundaries
// shift → startChunkIndex points at wrong content.
//
// K.1.2's fix snapshots groundingInput + chunkSizeChars in RunCheckpoint
// and skips the re-prep on resume. These fixtures provide deterministic
// glossary states to exercise the snapshot-vs-live-glossary divergence.

import type { GlossaryDocument } from '@/lib/glossary'

/** Glossary state at pause time. Small, controlled — the test runs Phase 1
 *  with this glossary, captures a checkpoint mid-chunk, then mutates the
 *  glossary and resumes to assert the snapshot is honoured. */
export const GLOSSARY_AT_PAUSE: GlossaryDocument = {
  version: 1,
  safeReplacements: [
    { from: 'broady', to: 'Lucia' },
    { from: 'kazle', to: 'Seoyeon' },
  ],
  contextualHints: [
    {
      canonical: 'Lucia',
      commonMishears: ['Broady', 'Brodie'],
      notes: 'Halfling rogue.',
    },
  ],
}

/** Glossary state at resume time — significantly different. Adds 500+
 *  characters of new contextual hints. preGround output on this state
 *  would have different boundaries than the AT_PAUSE state. */
export const GLOSSARY_AT_RESUME: GlossaryDocument = {
  version: 1,
  safeReplacements: [
    { from: 'broady', to: 'Lucia' },
    { from: 'kazle', to: 'Seoyeon' },
    { from: 'broogo', to: 'Yuzuki' }, // NEW: another safe replacement
  ],
  contextualHints: [
    {
      canonical: 'Lucia',
      commonMishears: ['Broady', 'Brodie'],
      notes: 'Halfling rogue.',
    },
    {
      canonical: 'Yuzuki',
      commonMishears: ['Brewgo', 'Broogo', 'Yuzuki'],
      // 500-char block guarantees the preGround output diverges if applied.
      notes:
        'Yuzuki is a half-orc barbarian recruited from the slums of Waterdeep. He carries a greataxe inherited from his grandfather, who fought in the wars of the southern reaches. Common mishearings include Brewgo and Broogo. Always treat any mention of a half-orc warrior with a greataxe as a probable Yuzuki reference even if the transcript spells it differently. Yuzuki speaks in short sentences and rarely uses complex vocabulary. He is fiercely loyal to Lucia despite their cultural differences.',
    },
  ],
}

/** A modest transcript that produces predictable chunk boundaries (~24KB).
 *  The Phase 1 chunker would split this into ~3 chunks at standard sizes;
 *  the test uses a smaller chunk size to force more chunks for cleaner
 *  boundary assertions. */
export const TRANSCRIPT_FOR_DRIFT_TEST = (() => {
  const lines: string[] = []
  // Realistic-ish dialogue that will be affected by the glossary above:
  // mishearings ("broady", "broogo") get replaced via preGround.
  const speakers = ['Seoyeon', 'Lucia', 'Yuzuki', 'Thao', 'Eero']
  for (let i = 0; i < 240; i++) {
    const speaker = speakers[i % speakers.length]
    // Sprinkle the mishearings the glossary will replace.
    const phrase = i % 7 === 0
      ? `broady looks at the door and gestures to ${speakers[(i + 1) % speakers.length].toLowerCase()}`
      : i % 11 === 0
        ? `broogo grunts something about gold, then shoves kazle`
        : `${speaker} says something about turn ${i} and the dice clatter on the table`
    lines.push(`[${speaker}] ${phrase}.`)
  }
  return lines.join('\n')
})()
