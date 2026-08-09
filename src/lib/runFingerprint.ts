// Run fingerprint — hash of the inputs that drive Phase 1 chunk
// boundaries. Recorded in RunCheckpoint at pause time and re-computed
// at resume time so the UI can warn the user when the saved snapshot
// no longer matches the live world (the user edited the glossary, the
// alias index rebuilt, the raw transcript was changed externally).
//
// Cryptographic strength is not the goal — collision-resistance against
// realistic glossary diffs is. We use Web Crypto's SHA-256 (available in
// the browser context this module runs in) for the deterministic-output
// guarantee, and slice to 16 hex chars (~64 bits) for the stored value.
//
// Implementation note: this file is browser-only. SSR/Node contexts that
// import the type-only shape are fine; calling computeRunFingerprint()
// outside a browser context will throw via `globalThis.crypto.subtle`.

import type { GlossaryDocument } from './glossary'
import type { AliasIndex } from './aliasIndexClient'

/** Inputs that, if changed between pause and resume, would invalidate
 *  the cached Phase 1 chunk boundaries. Keep this list in sync with the
 *  prep stage in [src/lib/pipeline.ts] runPhase1. */
export interface RunFingerprintInputs {
  rawTranscript: string
  glossary: GlossaryDocument
  aliasIndex: AliasIndex | null
  /** Phase 1 alias-hints toggle — if it changed between pause and
   *  resume, aliasIndexToSafeReplacements() would inject different
   *  rules into preGround, shifting boundaries. */
  phase1AliasHints: boolean
}

/** Stable JSON serialisation. Sorts object keys so the same logical
 *  state always produces the same hash regardless of construction
 *  order. Arrays are NOT sorted — order is semantically meaningful in
 *  GlossaryDocument.safeReplacements (preGround applies them in order). */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']'
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}'
}

/** Compute a 16-hex-char fingerprint over the prep-stage inputs.
 *  Returns null if Web Crypto is unavailable (server-side, ancient
 *  browser) — callers treat null as "fingerprint feature disabled" and
 *  skip the comparison rather than failing the resume. */
export async function computeRunFingerprint(
  inputs: RunFingerprintInputs,
): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) return null
  const payload = stableStringify({
    rawTranscript: inputs.rawTranscript,
    glossary: {
      safeReplacements: inputs.glossary.safeReplacements,
      contextualHints: inputs.glossary.contextualHints,
    },
    // The alias index's `builtAt` is non-deterministic across rebuilds
    // (timestamp baked in), so we exclude it. The semantically-relevant
    // parts are the entities themselves and their aliases.
    aliasIndex: inputs.aliasIndex
      ? { byEntity: inputs.aliasIndex.byEntity, aliases: inputs.aliasIndex.aliases }
      : null,
    phase1AliasHints: inputs.phase1AliasHints,
  })
  const bytes = new TextEncoder().encode(payload)
  const digest = await subtle.digest('SHA-256', bytes)
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return hex.slice(0, 16)
}
