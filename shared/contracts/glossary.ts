// The glossary document, as stored and as sent over /api/glossary.

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

export type GlossaryDocument = {
  version: 1
  safeReplacements: SafeReplacement[]
  contextualHints: ContextualHint[]
}
