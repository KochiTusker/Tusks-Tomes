// Stage 2 — Routing config validation.
//
// Surfaces problems BEFORE the user clicks Save in HybridRoutingEditor.
// Historically, broken routing configurations have caused mid-run
// pipeline failures (stale per-phase overrides, models the pricing
// table doesn't know about, etc). This module is the editor-side gate
// that catches them at edit time instead of run time.
//
// Pure functions only — no React, no fetches. The editor calls
// `validateRouting(doc)` after every change and renders the result.

import type { RoutingDocument, PhaseRouteEntry } from './routing'
import { GEMINI_PRICING, CLAUDE_PRICING, OPENAI_PRICING } from './pricing'

export type ValidationSeverity = 'error' | 'warning'

export interface ValidationFinding {
  severity: ValidationSeverity
  phase?: keyof NonNullable<RoutingDocument['perPhase']>
  /** Short label for inline display. */
  title: string
  /** Longer prose for tooltips / expanded views. */
  detail: string
  /** Suggested user action. */
  remedy?: string
}

export interface ValidationResult {
  findings: ValidationFinding[]
  hasErrors: boolean
  hasWarnings: boolean
  /** True when no findings at all. */
  clean: boolean
}

const PHASES = ['phase1', 'phase2', 'phase3', 'phase4', 'phase6'] as const

function isKnownPricedModel(provider: string | undefined, modelId: string | undefined): boolean {
  if (!modelId) return true // inherit from defaults — known by construction
  if (provider === 'gemini') {
    if (modelId in GEMINI_PRICING.paid) return true
    // Heuristic fallback also handles preview names — only warn if no fallback would match
    const m = modelId.toLowerCase()
    if (m.includes('lite') || m.includes('flash') || m.includes('pro')) return true
    return false
  }
  if (provider === 'claude') return modelId in CLAUDE_PRICING
  if (provider === 'openai') return modelId in OPENAI_PRICING
  return true // unknown provider — let the downstream pipeline handle it
}

export function validateRouting(doc: RoutingDocument | null): ValidationResult {
  const findings: ValidationFinding[] = []
  if (!doc) {
    return { findings, hasErrors: false, hasWarnings: false, clean: true }
  }

  const globalProvider = doc.lastSelectedProvider
  const globalTier = doc.geminiTier
  const overrides = doc.perPhase ?? {}

  for (const phase of PHASES) {
    const entry: PhaseRouteEntry | undefined = overrides[phase]
    if (!entry) continue

    if (entry.target === 'local') {
      if (!entry.modelId) {
        findings.push({
          severity: 'error',
          phase,
          title: `${phase} has no local model id`,
          detail: 'A local routing entry was created but no modelId was set. The pipeline cannot dispatch this phase.',
          remedy: 'Pick a local model in the dropdown or clear this per-phase override.',
        })
      }
      continue
    }

    // Cloud entry
    const effectiveProvider = entry.cloudProvider ?? globalProvider
    if (!effectiveProvider) {
      findings.push({
        severity: 'warning',
        phase,
        title: `${phase} has no provider`,
        detail: 'Per-phase override sets the target to cloud but no provider is selected — neither in this entry nor as the global active provider.',
        remedy: 'Pick a global Active Provider in Settings or set cloudProvider explicitly for this phase.',
      })
      continue
    }

    // Unknown model — warn but don't block (the pipeline silently falls back
    // to flagship-tier chunk sizing, which is safe but means cost estimates
    // will be wrong).
    if (!isKnownPricedModel(effectiveProvider, entry.modelId)) {
      findings.push({
        severity: 'warning',
        phase,
        title: `${phase} uses an unrecognised model`,
        detail: `"${entry.modelId}" is not in the pricing table for ${effectiveProvider}. The pipeline will still run (with flagship-default chunk sizing) but cost estimates for this phase will be missing or inaccurate.`,
        remedy: 'Pick a known model from the dropdown, or accept that the cost preview won\'t reflect this phase.',
      })
    }

    // Stale per-phase tier override (Gemini-specific).
    if (
      effectiveProvider === 'gemini' &&
      entry.geminiTier &&
      globalTier &&
      entry.geminiTier !== globalTier &&
      // 'auto' for either side is a "match anything" — don't warn
      entry.geminiTier !== 'auto' &&
      globalTier !== 'auto'
    ) {
      findings.push({
        severity: 'warning',
        phase,
        title: `${phase} pinned to ${entry.geminiTier} but global tier is ${globalTier}`,
        detail: `This per-phase override pins ${phase} to Gemini ${entry.geminiTier} regardless of the global tier selector. That's usually intentional (e.g. Free for grounding, Paid for chronicle), but if you didn't mean to keep it pinned after flipping the global tier, the override survived your flip.`,
        remedy: `Clear the ${phase} per-phase override if the global tier (${globalTier}) is what you actually want for this phase.`,
      })
    }
  }

  const hasErrors = findings.some((f) => f.severity === 'error')
  const hasWarnings = findings.some((f) => f.severity === 'warning')
  return { findings, hasErrors, hasWarnings, clean: findings.length === 0 }
}

/** Convenience: format findings as a short bullet list for tooltip / toast. */
export function formatFindings(findings: ValidationFinding[]): string {
  if (findings.length === 0) return 'No issues.'
  return findings
    .map((f) => {
      const prefix = f.severity === 'error' ? '✗' : '⚠'
      return `${prefix} ${f.title}${f.remedy ? ' — ' + f.remedy : ''}`
    })
    .join('\n')
}
