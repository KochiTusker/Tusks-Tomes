// Live model rates from the OpenRouter catalogue — for BOTH OpenRouter and
// Gemini estimates.
//
// The decision this encodes (operator, 2026-08-19): the OpenRouter
// catalogue is the price authority for cost estimates. For OpenRouter
// models that was always the only honest source (rateFor had no catalogue
// access and priced every OR phase at the generic fallback). For Gemini it
// resolves the long-standing discrepancy the OpenRouter branch handover
// flagged: pricing.ts carried 2.5-generation rates while the live
// catalogue shows the 3.x generation at roughly $2/$12 — and since the
// operator runs on purchased OpenRouter credit, the catalogue's figures
// are the ones a session actually costs.
//
// The static tables in pricing.ts remain the OFFLINE FALLBACK, and the
// no-catalogue path must keep producing byte-identical estimates — the
// characterisation test pins that.
//
// Gemini mapping rules, deliberately conservative:
//   - a PINNED native id (gemini-2.5-pro) maps only to the catalogue entry
//     of the SAME family and version ("-preview" of that version accepted
//     when the plain id is absent). No cross-version guessing: a pinned id
//     with no catalogue match falls back to the static table.
//   - a FLOATING alias (gemini-pro-latest) maps to the NEWEST catalogue
//     version of its family, preferring a non-preview id at that version.
//   - image / batch / customtools variants are never candidates.

import type { ModelRate } from './pricing'
import type { OpenRouterModelInfo } from './openrouterModelsClient'

type Family = 'pro' | 'flash' | 'flash-lite'

type Candidate = {
  id: string
  family: Family
  version: number
  preview: boolean
  rate: ModelRate
}

/** Parse a catalogue id into a Gemini candidate, or null if it is not a
 *  plain text-model entry (image, batch, customtools, unversioned). */
export function parseCatalogueGemini(id: string, rate: ModelRate): Candidate | null {
  const m = id.match(/^google\/gemini-(\d+(?:\.\d+)?)-(pro|flash-lite|flash)(-preview)?$/)
  if (!m) return null
  return {
    id,
    family: m[2] as Family,
    version: parseFloat(m[1]),
    preview: m[3] === '-preview',
    rate,
  }
}

/** Parse a NATIVE Gemini model id into (family, version|floating). */
export function parseNativeGemini(
  model: string,
): { family: Family; version: number | 'latest' } | null {
  const id = model.toLowerCase().trim()
  // Floating aliases: gemini-pro-latest / gemini-flash-latest / gemini-flash-lite-latest
  const floating = id.match(/^gemini-(pro|flash-lite|flash)-latest$/)
  if (floating) return { family: floating[1] as Family, version: 'latest' }
  // Pinned ids: gemini-2.5-pro, gemini-3.6-flash, gemini-3.1-pro-preview…
  const pinned = id.match(/^gemini-(\d+(?:\.\d+)?)-(pro|flash-lite|flash)(-preview)?$/)
  if (pinned) return { family: pinned[2] as Family, version: parseFloat(pinned[1]) }
  return null
}

export type LiveRateResolver = {
  /** Rate for an exact OpenRouter catalogue id, or null when absent. */
  openrouter(modelId: string): ModelRate | null
  /** Rate for a native Gemini id via the mapping rules, or null. */
  gemini(modelId: string): ModelRate | null
}

export function buildLiveRateResolver(
  models: readonly OpenRouterModelInfo[] | null | undefined,
): LiveRateResolver | null {
  if (!models || models.length === 0) return null

  const byId = new Map<string, ModelRate>()
  const geminiCandidates: Candidate[] = []
  for (const m of models) {
    const rate: ModelRate = {
      input: m.inputPerM,
      output: m.outputPerM,
      cachedInput: m.cachedInputPerM ?? undefined,
    }
    byId.set(m.id, rate)
    const cand = parseCatalogueGemini(m.id, rate)
    if (cand) geminiCandidates.push(cand)
  }

  function pick(family: Family, version: number | 'latest'): ModelRate | null {
    const inFamily = geminiCandidates.filter((c) => c.family === family)
    if (inFamily.length === 0) return null
    if (version === 'latest') {
      // Newest version wins; plain beats preview at the same version.
      inFamily.sort((a, b) => b.version - a.version || Number(a.preview) - Number(b.preview))
      return inFamily[0].rate
    }
    const exact = inFamily.filter((c) => c.version === version)
    if (exact.length === 0) return null
    exact.sort((a, b) => Number(a.preview) - Number(b.preview))
    return exact[0].rate
  }

  return {
    openrouter(modelId) {
      return byId.get(modelId) ?? null
    },
    gemini(modelId) {
      const parsed = parseNativeGemini(modelId)
      if (!parsed) return null
      return pick(parsed.family, parsed.version)
    },
  }
}
