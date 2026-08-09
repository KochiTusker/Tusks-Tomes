// Phase 6 condense bullet-point dedup.
//
// runPhase6() chunks the chronicle and condenses each chunk independently.
// When a notable event sits at a chunk boundary (last few lines of chunk N,
// first few of chunk N+1), both chunks' condensed bullet sets may mention
// it — phrased slightly differently. Without dedup, a long session can land
// 60-90 bullets where the headline count is meant to be ~15.
//
// Two-pass strategy:
//   1. Exact match after light normalisation (trim + collapse whitespace
//      + lowercase + strip trailing punctuation). Catches the obvious case
//      where the same event lands as the identical string twice.
//   2. Levenshtein-distance check against already-kept bullets. Two bullets
//      with >= 80% similarity (relative to the longer length) are treated
//      as duplicates. Catches paraphrase-duplicates like:
//        "The party reached Thornholt at dusk."
//        "The party reached Thornholt as the sun set."
//      which are the same event with different prose.
//
// We keep the FIRST occurrence in each duplicate cluster so the resulting
// list stays in chronological order (chunks are processed in order).

import { distance as levenshtein } from 'fastest-levenshtein'

/** Similarity threshold above which two bullets are treated as duplicates.
 *  0.80 means "20% of characters can differ" — empirically catches paraphrase
 *  drift on adjacent-chunk boundary events without false-positiving on
 *  genuinely-different events that happen to share a few words. */
export const BULLET_DEDUP_SIMILARITY = 0.8

function normaliseBullet(s: string): string {
  return s
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/[.!?…,;:]+$/, '')
}

/** Drop near-duplicate bullet points from a Phase 6 accumulated set, keeping
 *  the first occurrence in each duplicate cluster. */
export function dedupeBullets(bullets: string[]): string[] {
  if (bullets.length <= 1) return bullets.slice()

  const seenExact = new Set<string>()
  const kept: string[] = []
  const keptNormalised: string[] = []

  for (const bullet of bullets) {
    if (!bullet || !bullet.trim()) continue
    const norm = normaliseBullet(bullet)
    if (!norm) continue

    // Pass 1: exact-after-normalisation duplicate? Skip.
    if (seenExact.has(norm)) continue

    // Pass 2: Levenshtein vs already-kept bullets. If similarity to any
    // existing bullet exceeds the threshold, treat as duplicate.
    let isDup = false
    for (const prev of keptNormalised) {
      // Cheap pre-filter: if length difference alone exceeds the dissimilarity
      // budget, the candidates can't possibly be similar enough. Skip the
      // Levenshtein call (O(n*m)) on those.
      const maxLen = Math.max(norm.length, prev.length)
      const lenDelta = Math.abs(norm.length - prev.length)
      if (lenDelta / maxLen > 1 - BULLET_DEDUP_SIMILARITY) continue

      const dist = levenshtein(norm, prev)
      const similarity = 1 - dist / maxLen
      if (similarity >= BULLET_DEDUP_SIMILARITY) {
        isDup = true
        break
      }
    }

    if (isDup) continue

    seenExact.add(norm)
    keptNormalised.push(norm)
    kept.push(bullet)
  }

  return kept
}
