// Gemini capability-tier classification. Deliberately a leaf module with no
// imports: both the probe (server/api/modelProbe.ts) and the known-model
// validator (server/lib/knownModels.ts) need it, and knownModels already
// imports the probe's cache reader — putting this anywhere else creates an
// import cycle.

/** Coarse Gemini capability tier, used both to group the picker dropdown and
 *  to prioritise which models the probe spends its budget on.
 *
 *  'other' is not a failure state — it is the bucket for a family Google
 *  ships under a name we have never seen. Those models still get probed and
 *  still reach the dropdown, under an "Uncategorised" heading. That is the
 *  point: a naming scheme we did not predict must degrade to "shown,
 *  unclassified", never to "silently absent". */
export type GeminiModelTier = 'pro' | 'flash' | 'flash-lite' | 'other'

/** Classify a Gemini model id into a tier.
 *
 *  Order is load-bearing. Every flash-lite id also contains 'flash'
 *  ('gemini-2.5-flash-lite', 'gemini-flash-lite-latest'), so 'lite' has to be
 *  tested first or flash-lite collapses into flash and the cheapest tier
 *  disappears from the picker. */
export function classifyGeminiTier(modelId: string): GeminiModelTier {
  const m = (modelId || '').toLowerCase()
  if (!m) return 'other'
  if (m.includes('lite')) return 'flash-lite'
  if (m.includes('flash')) return 'flash'
  if (m.includes('pro')) return 'pro'
  return 'other'
}

/** Human-readable heading per tier. Mirrored client-side in
 *  src/lib/availableModels.ts — keep the wording identical so the Settings
 *  dropdown and any server-rendered diagnostic agree. */
export const GEMINI_TIER_LABELS: Record<GeminiModelTier, string> = {
  pro: 'Pro Tier',
  flash: 'Flash Tier',
  'flash-lite': 'Flash Lite Tier',
  other: 'Uncategorised',
}

/** Probe-budget ordering. When the catalog is larger than the probe cap we
 *  truncate, so the tiers the chronicle pipeline actually routes to must be
 *  tested first and 'other' must be tested last. */
export const TIER_PROBE_PRIORITY: Record<GeminiModelTier, number> = {
  pro: 0,
  flash: 1,
  'flash-lite': 2,
  other: 3,
}
