// Deterministic pre-grounding pass — runs BEFORE any AI call.
//
// Applies whole-word, case-insensitive replacement rules. Replacement casing
// is preserved from the rule exactly. Two sources of rules:
//
//   1. Built-in `dndDictionary` — universal D&D mistranscriptions, hardcoded.
//   2. User-additive glossary — loaded from disk via `src/lib/glossary.ts`,
//      edited in the Tome of Lore tab.
//
// Callers pass the merged rule list in. The pipeline loads the glossary once
// at run start so we don't fan-out fetches per chunk.

import type { ContextualHint, SafeReplacement } from '@/data/corrections'
import { dndDictionary } from '@/data/dndDictionary'

export type PreGroundReport = {
  totalReplacements: number
  perRule: Array<{ from: string; to: string; count: number }>
}

export type PreGroundResult = {
  text: string
  report: PreGroundReport
}

const REGEX_META = /[.*+?^${}()|[\]\\]/g

function escapeRegex(s: string): string {
  return s.replace(REGEX_META, '\\$&')
}

/**
 * Word-boundary replacement that handles multi-word `from` and apostrophes.
 * Standard \b doesn't behave well around apostrophes or non-ASCII, so we
 * use lookarounds for non-letter neighbours.
 */
function buildRuleRegex(from: string): RegExp {
  // Collapse internal whitespace in `from` and allow flexible whitespace in
  // the input (handles "tia mat" matching "tia  mat", "tia\nmat", etc.).
  const escaped = escapeRegex(from.trim()).replace(/\s+/g, '\\s+')
  // Match if the boundary characters are not letters/digits/apostrophes,
  // OR if at start/end of input.
  return new RegExp(
    `(?<![A-Za-z0-9'])(?:${escaped})(?![A-Za-z0-9'])`,
    'gi'
  )
}

/** Apply one safeReplacement rule and return how many times it fired. */
function applyRule(text: string, rule: SafeReplacement): { text: string; count: number } {
  let count = 0
  const re = buildRuleRegex(rule.from)
  const newText = text.replace(re, () => {
    count++
    return rule.to
  })
  return { text: newText, count }
}

/**
 * Combine the built-in dictionary with user-added rules. dndDictionary runs
 * first so campaign-specific rules can override it (last write wins per term).
 */
export function combineRules(userRules: SafeReplacement[]): SafeReplacement[] {
  return [...dndDictionary, ...userRules]
}

export function preGround(
  text: string,
  rules: SafeReplacement[]
): PreGroundResult {
  let working = text
  const perRule: PreGroundReport['perRule'] = []
  let total = 0
  for (const rule of rules) {
    if (!rule.from?.trim() || !rule.to) continue
    const { text: next, count } = applyRule(working, rule)
    working = next
    if (count > 0) {
      perRule.push({ from: rule.from, to: rule.to, count })
      total += count
    }
  }
  return { text: working, report: { totalReplacements: total, perRule } }
}

/**
 * Build the contextual-hints block injected into AI grounding prompts.
 * Returns "" if there are no hints (so the prompt template can omit
 * the section entirely).
 */
export function formatContextualHints(hints: ContextualHint[]): string {
  if (!hints.length) return ''
  const lines: string[] = []
  lines.push('# CONTEXTUAL CORRECTIONS — known traps for this campaign')
  lines.push('The following are known mistranscriptions where the WRONG form is also a real English word.')
  lines.push('Apply each correction ONLY when surrounding context clearly fits the canonical form.')
  lines.push('')
  for (const h of hints) {
    const aliases = h.commonMishears?.length
      ? `  Commonly mis-heard as: ${h.commonMishears.map((s) => `"${s}"`).join(', ')}`
      : null
    lines.push(`• Canonical: "${h.canonical}"`)
    if (aliases) lines.push(aliases)
    lines.push(`  When to apply: ${h.notes}`)
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * Build a contextual-hints block scoped to ONE chunk's text. Returns hints
 * whose canonical form OR any of its `commonMishears` appears in the
 * chunk text (case-insensitive). Hints that don't trigger anywhere in
 * this chunk are omitted.
 *
 * Token-saving rationale: today every chunk's grounding prompt carries
 * the full hints block (~5 kB for a 20-hint glossary). Most chunks only
 * touch 2-3 hints. A 15-chunk Phase 1 ships ~75 kB of hints when ~10 kB
 * would suffice. The matcher includes BOTH the canonical form and the
 * mishears so a hint whose entire purpose is fixing a misspelling
 * doesn't get filtered out when the misspelling appears in raw text.
 *
 * Used by pipeline.ts:runPhase1 inside the buildRequest callback so the
 * filter runs per-chunk; falls back to formatContextualHints (full
 * block) for callers that don't have chunk text in scope.
 */
export function pickHintsFor(chunkText: string, hints: ContextualHint[]): string {
  if (!hints.length || !chunkText) return ''
  const lowered = chunkText.toLowerCase()
  const relevant = hints.filter((h) => {
    const candidates = [h.canonical, ...(h.commonMishears ?? [])]
    return candidates.some((c) => c && lowered.includes(c.toLowerCase()))
  })
  return formatContextualHints(relevant)
}
