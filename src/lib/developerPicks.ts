// What the maintainer would actually pick for a phase, and why.
//
// This is deliberately NOT the grade ordering. A grade answers "how good is
// the output"; a pick answers "what should I run", which also weighs cost,
// speed and reliability. The two come apart often enough to be worth stating
// separately:
//
//   - The best-graded chronicle model outside Gemini takes roughly an hour to
//     carry the phase. Excellent, and not what you want on a weeknight.
//   - The cheapest usable model is around a hundred times cheaper than the
//     reference and roughly six minutes per chunk. Right for a bulk backfill,
//     wrong for a session you want to read tonight.
//   - One model needs a specific configuration before it is safe to route
//     through at all, which is a fact about running it rather than about its
//     output quality.
//
// Every entry names a measured reason. Nothing is here on reputation.

import type { Phase } from './phaseGrades'

export interface DeveloperPick {
  modelId: string
  /** Why this one, in the maintainer's words. Shown under the model row. */
  reason: string
  /** Shorthand for the trade this pick makes. */
  tag: 'balanced' | 'value' | 'quality' | 'fastest' | 'cheapest'
  /** Config the model needs before it can be trusted, if any. */
  requires?: string
}

/**
 * Ordered best-first per phase. Position IS the recommendation — the first
 * entry is what the maintainer would route by default.
 *
 * Phases with no entry have not been measured enough to have an opinion, and
 * say so rather than guessing.
 */
export const DEVELOPER_PICKS: Partial<Record<Phase, DeveloperPick[]>> = {
  phase1: [
    {
      modelId: 'anthropic/claude-haiku-4.5',
      reason:
        'Corrected 5 of 6 known transcription errors at exactly 1:1 length with all 609 speaker tags intact — the strongest non-Gemini grounder measured.',
      tag: 'quality',
    },
    {
      modelId: 'qwen/qwen3-30b-a3b-instruct-2507',
      reason:
        'Fixed 4 of 6 with length and tags perfect, at roughly a twenty-fifth of the reference price. Grounding is the largest block of calls in a session, so this is where cheap actually shows up.',
      tag: 'value',
    },
    {
      modelId: 'openai/gpt-oss-120b',
      reason: 'Also 4 of 6, but shrank the transcript slightly — worth watching on a phase that must not compress.',
      tag: 'cheapest',
    },
  ],
  phase3: [
    {
      modelId: 'deepseek/deepseek-v4-pro',
      reason:
        'The best non-Gemini chronicle graded that also runs at a sensible speed. A step below Gemini rather than better than it, for a small fraction of the cost.',
      tag: 'balanced',
    },
    {
      modelId: 'moonshotai/kimi-k3',
      reason:
        'Good prose and genuinely fast once configured — but it returns an empty body on most long generations at its default settings.',
      tag: 'fastest',
      requires: 'reasoning effort low, provider pinned to moonshotai',
    },
    {
      modelId: 'deepseek/deepseek-v4-flash',
      reason:
        'Graded surprisingly well for the price — around a hundred times cheaper than the reference. Slow: roughly six minutes per chunk, so budget over an hour for the phase.',
      tag: 'cheapest',
    },
  ],
  phase4: [
    {
      modelId: 'z-ai/glm-5.2',
      reason:
        'The best reliable extras model measured, and it beats both Gemini tiers on this phase rather than merely undercutting them.',
      tag: 'balanced',
    },
    {
      modelId: 'moonshotai/kimi-k3',
      reason:
        'Graded highest of anything tested here — strongest at capturing the context around an exchange — but only with its reasoning capped and its provider pinned.',
      tag: 'quality',
      requires: 'reasoning effort low, provider pinned to moonshotai',
    },
    {
      modelId: 'x-ai/grok-4.20',
      reason: 'Captured the whole run of a dark exchange where others took one line out of it. Cheap and quick.',
      tag: 'value',
    },
  ],
  phase6: [
    {
      modelId: 'deepseek/deepseek-v4-pro',
      reason:
        'Condense has not been graded directly. This is the chronicle pick carried across, prose quality being the closest proxy available — treat it as a starting point rather than a measurement.',
      tag: 'balanced',
    },
  ],
}

/** Rank of a model within a phase's picks. Lower is better; unpicked models
 *  sort last. */
export function pickRank(phase: Phase, modelId: string): number {
  const picks = DEVELOPER_PICKS[phase]
  if (!picks) return Number.MAX_SAFE_INTEGER
  const i = picks.findIndex((p) => p.modelId === modelId)
  return i === -1 ? Number.MAX_SAFE_INTEGER : i
}

export function pickFor(phase: Phase, modelId: string): DeveloperPick | undefined {
  return DEVELOPER_PICKS[phase]?.find((p) => p.modelId === modelId)
}

/** True when a phase has any opinion at all recorded. */
export function hasPicks(phase: Phase): boolean {
  return (DEVELOPER_PICKS[phase]?.length ?? 0) > 0
}

/**
 * The vendor a model belongs to, from its id namespace.
 *
 * OpenRouter namespaces every id as `vendor/model`, so the folder structure is
 * already in the data and does not need a hand-maintained mapping that would
 * go stale as models are added.
 */
export function vendorOf(modelId: string): string {
  const slash = modelId.indexOf('/')
  if (slash <= 0) return 'other'
  // Some ids carry a leading '~' for floating "latest" aliases.
  return modelId.slice(0, slash).replace(/^~/, '')
}

/** Display name for a vendor namespace. Anything unlisted falls back to the
 *  namespace itself, so a newly-added vendor still groups correctly. */
const VENDOR_LABELS: Record<string, string> = {
  'anthropic': 'Anthropic',
  'openai': 'OpenAI',
  'google': 'Google',
  'x-ai': 'xAI',
  'moonshotai': 'Moonshot',
  'deepseek': 'DeepSeek',
  'z-ai': 'Z.AI',
  'qwen': 'Qwen',
  'minimax': 'MiniMax',
  'nvidia': 'NVIDIA',
  'mistralai': 'Mistral',
  'meta-llama': 'Meta',
  'cohere': 'Cohere',
  'perplexity': 'Perplexity',
  'inclusionai': 'InclusionAI',
  'nousresearch': 'Nous Research',
  'microsoft': 'Microsoft',
  'amazon': 'Amazon',
  'baidu': 'Baidu',
  'liquid': 'Liquid',
  'ibm-granite': 'IBM Granite',
}

export function vendorLabel(vendor: string): string {
  return VENDOR_LABELS[vendor] ?? vendor.replace(/(^|[-_])([a-z])/g, (_m, s, c) => s + c.toUpperCase())
}
