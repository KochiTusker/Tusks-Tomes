// Type definitions for user-additive corrections. The data itself now lives
// on disk at `{configDir}/glossary.json` and is edited via the Tome of Lore
// tab's Glossary Editor — see `src/lib/glossary.ts` for the client.
//
// The built-in baseline (universal D&D mistranscriptions) is still hardcoded
// in `src/data/dndDictionary.ts` and applied before the user glossary at
// pipeline time.

export type SafeReplacement = {
  /** Mistranscribed form. Matched case-insensitively as a whole word. */
  from: string
  /** Canonical form. Casing preserved exactly as written here. */
  to: string
}

export type ContextualHint = {
  /** Correct canonical form. */
  canonical: string
  /** Wrong forms YouTube tends to produce. Optional but helps the model. */
  commonMishears?: string[]
  /** Plain-English instruction for the AI on when to apply this. */
  notes: string
}

export type CorrectionsConfig = {
  safeReplacements: SafeReplacement[]
  contextualHints: ContextualHint[]
}
