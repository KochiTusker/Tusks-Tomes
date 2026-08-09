// Fuzzy alias matcher — Levenshtein-based phonetic candidate annotation.
//
// Purpose: bridge the gap between "more than vain" (what Whisper transcribed)
// and "Morvan Vayne" (the canonical alias-index entry). Pro models catch
// this semantically; Flash models miss it. This layer annotates Phase 1
// chunks inline with `[≈Name? NN%]` hints so Flash can validate-or-reject
// the algorithmic suggestion instead of having to discover the name from
// scratch.
//
// Algorithm:
//   1. Build candidate phrase pool from the chunk text (tokens, 2-grams,
//      3-grams) at word boundaries.
//   2. For each canonical name + alias in the index, compute Levenshtein
//      distance against every candidate phrase.
//   3. Accept a match when distance <= maxDistance AND distance/maxLen <=
//      maxRatio. Pick the BEST match per source span (no double-annotating
//      the same words with multiple aliases).
//   4. Skip exact-match cases (preGround will substitute those; no hint
//      needed).
//   5. Cap total annotations per chunk to avoid prompt noise.
//
// Annotations are inserted inline as `original text [≈Canonical Name? NN%]`
// where NN is (1 - distance/maxLen) * 100. The prompt explains how to
// interpret them (accept-when-context-fits, remove markers from output).

import { distance as levenshtein } from 'fastest-levenshtein'
import { doubleMetaphone } from 'double-metaphone'
import type { AliasIndex } from './aliasIndexClient'

/** Concatenate Double Metaphone codes for a multi-word phrase so we can
 *  match phonetic shape across word boundaries ("more than vain" →
 *  "MR0NFN" or "MRTNFN" depending on the primary/alternate code). */
function phoneticCode(phrase: string): { primary: string; alternate: string } {
  const tokens = phrase.toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return { primary: '', alternate: '' }
  let primary = ''
  let alternate = ''
  for (const t of tokens) {
    const [p, a] = doubleMetaphone(t)
    primary += p ?? ''
    alternate += a ?? p ?? ''
  }
  return { primary, alternate }
}

/** Phonetic Levenshtein distance: distance on Double Metaphone codes,
 *  taking the MIN over primary/alternate to be generous. Returns the
 *  distance and the max-length-of-the-two-codes (for ratio). */
function phoneticDistance(a: string, b: string): { distance: number; maxLen: number } {
  const ca = phoneticCode(a)
  const cb = phoneticCode(b)
  const candidates: number[] = []
  if (ca.primary && cb.primary) candidates.push(levenshtein(ca.primary, cb.primary))
  if (ca.primary && cb.alternate) candidates.push(levenshtein(ca.primary, cb.alternate))
  if (ca.alternate && cb.primary) candidates.push(levenshtein(ca.alternate, cb.primary))
  if (ca.alternate && cb.alternate) candidates.push(levenshtein(ca.alternate, cb.alternate))
  if (candidates.length === 0) return { distance: Infinity, maxLen: 1 }
  const dist = Math.min(...candidates)
  const maxLen = Math.max(ca.primary.length, ca.alternate.length, cb.primary.length, cb.alternate.length, 1)
  return { distance: dist, maxLen }
}

export interface Candidate {
  /** Span in the original chunk text (start offset, length). */
  start: number
  length: number
  /** Original text from the chunk. */
  text: string
  /** Canonical name we're suggesting it might map to. */
  canonical: string
  /** Alias we matched against (often the canonical name itself). */
  matchedAgainst: string
  /** Levenshtein edit distance between text and matchedAgainst. */
  distance: number
  /** 0-1, higher = closer match. = 1 - distance/maxLen. */
  similarity: number
}

export interface AnnotateOptions {
  /** Default 25 — cap on inline annotations per chunk to limit prompt noise. */
  maxAnnotations?: number
  /** Default 1 — maximum PHONETIC edit distance (on Double Metaphone codes).
   *  Phonetic codes are short (~5-8 chars typical) so even 1 substitution
   *  is meaningful. Raise to 2 to be more permissive at cost of noise. */
  maxDistance?: number
  /** Default 0.34 — phonetic-code-length-relative threshold. */
  maxRatio?: number
  /** Default 3 — minimum length of a candidate phrase to consider. */
  minPhraseLen?: number
  /** Default 5 — maximum n-gram size to scan. */
  maxNgram?: number
  /** Default 1 — minimum length of a candidate's phonetic code to consider.
   *  Filters out function words like "a", "the" which have empty codes. */
  minCodeLen?: number
}

export interface AnnotateResult {
  /** Original chunk text with `[≈…]` annotations inserted inline. */
  annotated: string
  /** All accepted candidates in source order (for diagnostics). */
  candidates: Candidate[]
}

const DEFAULT_OPTS: Required<AnnotateOptions> = {
  maxAnnotations: 25,
  maxDistance: 1,
  // 0.20 admits "more than vain"/"Morvan Vayne" (6-char code, distance
  // 1 = 0.167) but rejects "meant to"/"Meredith" (4-char code, distance
  // 1 = 0.25). Empirically determined via phase1-grounding-probe
  // iterations 1-4: anything looser produced > 50% false-positive rate.
  maxRatio: 0.20,
  minPhraseLen: 4,
  maxNgram: 5,
  // Phonetic code must be at least 5 chars to be considered. Real
  // lore names are usually 2+ syllables (MRLNFN=6, KRNVS=5,
  // FMPLPRNZPLT=11); 5 is the floor that admits 2-syllable names
  // while killing 1-2-syllable noise like "Too Many Bruisers"
  // (alias "the Tonies" → TTNS = 4 chars, rejected).
  minCodeLen: 5,
}

/**
 * Annotate a chunk of transcript text with fuzzy alias hints from the
 * provided index. Returns the chunk unchanged when no index or no
 * accepted candidates.
 */
export function annotateChunk(
  chunk: string,
  index: AliasIndex | null,
  opts?: AnnotateOptions,
): AnnotateResult {
  if (!index || !chunk) {
    return { annotated: chunk, candidates: [] }
  }
  const o = { ...DEFAULT_OPTS, ...(opts ?? {}) }

  // Build the matcher target list — canonical names + all aliases — but
  // keep the mapping back to the canonical so we always suggest the
  // canonical regardless of which form matched.
  const targets: Array<{ form: string; canonical: string }> = []
  const lowercaseChunk = chunk.toLowerCase()
  for (const [canonical, entity] of Object.entries(index.byEntity)) {
    // Skip canonicals that already appear literally in the chunk —
    // preGround will substitute, no hint needed. We match case-insensitively
    // here only to skip; the substitution itself stays case-aware.
    if (lowercaseChunk.includes(canonical.toLowerCase())) continue
    targets.push({ form: canonical, canonical })
    for (const alias of entity.aliases ?? []) {
      if (!alias.trim()) continue
      // Skip alias if it already appears literally — preGround handles it
      if (lowercaseChunk.includes(alias.toLowerCase())) continue
      targets.push({ form: alias, canonical })
    }
  }
  if (targets.length === 0) {
    return { annotated: chunk, candidates: [] }
  }

  // Tokenise the chunk into word-spans (preserve source positions).
  const wordRe = /[A-Za-z][A-Za-z'\-]*/g
  const wordSpans: Array<{ start: number; end: number; text: string }> = []
  let m: RegExpExecArray | null
  while ((m = wordRe.exec(chunk)) !== null) {
    wordSpans.push({ start: m.index, end: m.index + m[0].length, text: m[0] })
  }

  // For each n-gram size, evaluate every contiguous run of words as a
  // candidate phrase. Track the best canonical match per span position.
  const acceptedByStartEnd = new Map<string, Candidate>()
  for (let n = 1; n <= o.maxNgram; n++) {
    for (let i = 0; i + n <= wordSpans.length; i++) {
      const startSpan = wordSpans[i]
      const endSpan = wordSpans[i + n - 1]
      const phrase = chunk.slice(startSpan.start, endSpan.end)
      if (phrase.length < o.minPhraseLen) continue
      const phraseLower = phrase.toLowerCase()

      // Phonetic comparison: compute Double Metaphone code for the candidate
      // phrase once, then compare against every target's pre-computed code.
      const phraseCode = phoneticCode(phraseLower)
      if (phraseCode.primary.length < o.minCodeLen) continue
      // Try every target form against this phrase.
      let best: Candidate | null = null
      for (const target of targets) {
        const formLower = target.form.toLowerCase()
        if (phraseLower === formLower) continue // exact — preGround handles it
        const targetCode = phoneticCode(formLower)
        if (targetCode.primary.length < o.minCodeLen) continue
        // First-sound discipline: if the first phonetic char differs on
        // BOTH primary and alternate codes, this is almost certainly a
        // different word (M-name vs B-name, etc.). Drops most of the
        // iteration-2 false positives (Yannick→Bhargo passed because they
        // share PR; the cases that didn't share were already filtered).
        const firstPrimaryMatch =
          phraseCode.primary[0] && targetCode.primary[0] &&
          phraseCode.primary[0] === targetCode.primary[0]
        const firstAlternateMatch =
          phraseCode.alternate[0] && targetCode.alternate[0] &&
          phraseCode.alternate[0] === targetCode.alternate[0]
        if (!firstPrimaryMatch && !firstAlternateMatch) continue
        const { distance: dist, maxLen } = phoneticDistance(phraseLower, formLower)
        if (dist === 0) {
          // Phonetic match but different spelling — strongest signal.
          // Use raw-text Levenshtein as the tiebreaker similarity score
          // so subsequent overlap-resolution prefers visually-closer pairs.
          const rawDist = levenshtein(phraseLower, formLower)
          const rawMaxLen = Math.max(phraseLower.length, formLower.length)
          if (rawDist === 0) continue
          const similarity = Math.max(0.7, 1 - rawDist / rawMaxLen)
          if (!best || similarity > best.similarity) {
            best = {
              start: startSpan.start,
              length: endSpan.end - startSpan.start,
              text: phrase,
              canonical: target.canonical,
              matchedAgainst: target.form,
              distance: 0,
              similarity,
            }
          }
          continue
        }
        if (dist > o.maxDistance) continue
        if (dist / maxLen > o.maxRatio) continue
        const similarity = 1 - dist / maxLen
        if (!best || similarity > best.similarity) {
          best = {
            start: startSpan.start,
            length: endSpan.end - startSpan.start,
            text: phrase,
            canonical: target.canonical,
            matchedAgainst: target.form,
            distance: dist,
            similarity,
          }
        }
      }
      if (best) {
        const key = `${best.start}-${best.start + best.length}`
        const prior = acceptedByStartEnd.get(key)
        if (!prior || best.similarity > prior.similarity) {
          acceptedByStartEnd.set(key, best)
        }
      }
    }
  }

  // De-overlap: prefer longer / higher-similarity annotations. Sort by
  // start, then greedily accept non-overlapping with highest similarity.
  const all = [...acceptedByStartEnd.values()].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start
    return b.length - a.length || b.similarity - a.similarity
  })
  const accepted: Candidate[] = []
  let lastEnd = -1
  for (const c of all) {
    if (c.start < lastEnd) continue
    accepted.push(c)
    lastEnd = c.start + c.length
  }
  // Cap on most-confident first if we exceed the limit.
  if (accepted.length > o.maxAnnotations) {
    accepted.sort((a, b) => b.similarity - a.similarity)
    accepted.length = o.maxAnnotations
    accepted.sort((a, b) => a.start - b.start)
  }

  // Rebuild the annotated string. Walk source positions and insert the
  // annotations right after each candidate's text span.
  if (accepted.length === 0) {
    return { annotated: chunk, candidates: [] }
  }
  const parts: string[] = []
  let cursor = 0
  for (const c of accepted) {
    parts.push(chunk.slice(cursor, c.start + c.length))
    const pct = Math.round(c.similarity * 100)
    parts.push(` [≈${c.canonical}? ${pct}%]`)
    cursor = c.start + c.length
  }
  parts.push(chunk.slice(cursor))

  return { annotated: parts.join(''), candidates: accepted }
}

/**
 * Derive deterministic SafeReplacement rules from the alias index. For
 * each entity, every alias that appears LITERALLY in the chunk becomes a
 * safe-replacement to its canonical name. Whole-word boundaries respected
 * via preGround's existing matcher.
 *
 * This is the zero-risk layer: only fires on exact alias matches that
 * are already in the user's lore frontmatter. The fuzzy layer
 * (annotateChunk) handles the harder phonetic cases.
 */
export function aliasIndexToSafeReplacements(
  index: AliasIndex | null,
): Array<{ from: string; to: string }> {
  if (!index) return []
  const rules: Array<{ from: string; to: string }> = []
  for (const [canonical, entity] of Object.entries(index.byEntity)) {
    for (const alias of entity.aliases ?? []) {
      const trimmed = alias.trim()
      if (!trimmed || trimmed.toLowerCase() === canonical.toLowerCase()) continue
      rules.push({ from: trimmed, to: canonical })
    }
  }
  return rules
}
