// Canonical list of cloud-key "options" that the user can pick at run start.
// Each option flattens (provider, geminiTier) into a single selectable so
// the AI Provider & Model Selection UI doesn't need a nested tier sub-radio
// — Gemini Paid and Gemini Free are just two more entries in the list.
//
// The keystore still stores Gemini's free-tier key under the legacy
// `geminiFallback` slot so existing encrypted bundles keep decrypting.

import type { CloudProvider } from './profiles'
import { getProvidersSummary, type ProvidersSummary } from './providerSettings'
import { getRouting } from './routing'
import type { GeminiTier } from './routing'

export type CloudKeyId = 'gemini-paid' | 'gemini-free' | 'openrouter' | 'claude-code' | 'codex'

export type CloudKeyOption = {
  id: CloudKeyId
  provider: CloudProvider
  /** Only set for Gemini options. */
  geminiTier?: GeminiTier
  label: string
  short: string
  /** Slot that must be present in the providers summary for this option to
   *  be selectable. Usually an encrypted keystore slot; `claudeCode` is a
   *  VIRTUAL slot with no stored key — the server reports it as configured
   *  when the Claude Code add-on is loaded and the CLI is present. */
  slot: 'gemini' | 'geminiFallback' | 'openrouter' | 'claudeCode' | 'codex'
}

export const ALL_CLOUD_KEY_OPTIONS: CloudKeyOption[] = [
  {
    id: 'gemini-paid',
    provider: 'gemini',
    geminiTier: 'paid',
    label: 'Google Gemini — Paid',
    short: 'Gemini Paid',
    slot: 'gemini',
  },
  {
    id: 'gemini-free',
    provider: 'gemini',
    geminiTier: 'free',
    label: 'Google Gemini — Free',
    short: 'Gemini Free',
    slot: 'geminiFallback',
  },
  // OpenRouter reaches roughly four hundred models on one key, including every
  // Anthropic and OpenAI model at pass-through rates. Its catalogue is far too
  // large for the per-phase dropdown, so the routing editor offers a dedicated
  // browser alongside it rather than listing them all inline.
  {
    id: 'openrouter',
    provider: 'openrouter',
    label: 'OpenRouter',
    short: 'OpenRouter',
    slot: 'openrouter',
  },
  {
    id: 'claude-code',
    provider: 'claudeCode',
    label: 'Claude Code (your subscription)',
    short: 'Claude Code',
    slot: 'claudeCode',
  },
  // Codex is the second virtual slot: no stored key, the server reports it
  // configured when the codex-addon is loaded and the CLI is installed.
  {
    id: 'codex',
    provider: 'codex',
    label: 'Codex (your ChatGPT subscription)',
    short: 'Codex',
    slot: 'codex',
  },
]

export function listConfiguredCloudKeyOptions(
  summary: ProvidersSummary | null
): CloudKeyOption[] {
  if (!summary) return []
  const slots = new Set(summary.configured)
  return ALL_CLOUD_KEY_OPTIONS.filter((option) => slots.has(option.slot))
}

export async function fetchConfiguredCloudKeyOptions(): Promise<CloudKeyOption[]> {
  const summary = await getProvidersSummary()
  return listConfiguredCloudKeyOptions(summary)
}

// Static fallback model lists for providers without an anonymous discovery
// endpoint. Claude and OpenAI both need a key just to enumerate models, and
// we'd rather not fire background API calls from the Settings UI just to
// populate a select. Users who want a model outside this list type the ID
// directly into routing.json (or paste it into a phase override).
export const STATIC_PROVIDER_MODELS: Record<Exclude<CloudProvider, 'gemini'>, string[]> = {
  // OpenRouter is the one provider with a public, key-less catalogue
  // (/api/v1/models), so this list is only what the picker shows before the
  // first fetch lands. Every entry is unmoderated, supports structured
  // outputs, and declares an output ceiling at or above MAX_OUTPUT_TOKENS.
  openrouter: [
    'openai/gpt-oss-120b',
    'deepseek/deepseek-v4-flash',
    'nvidia/nemotron-3.5-lightning',
    'google/gemini-2.5-flash',
    'google/gemini-2.5-pro',
  ],
  // Claude Code accepts model aliases (resolved by the CLI to the latest
  // matching model) plus full IDs. Aliases first so the default stays
  // stable across model upgrades.
  claudeCode: [
    // Bare aliases first, and deliberately: they resolve to whatever the CLI
    // currently calls its opus/sonnet/haiku tier, so a CLI upgrade moves them
    // forward on its own. A pinned id does not, which is how a profile ends up
    // still naming a superseded model months later.
    'sonnet',
    'opus',
    'haiku',
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-haiku-4-5',
    'claude-opus-4-8',
    'claude-sonnet-4-6',
  ],
  // Codex: 'default' lets the CLI pick its current default model, so a CLI
  // upgrade moving the default forward is inherited without a code change.
  codex: [
    'default',
    'gpt-5-codex',
    'gpt-5',
    'gpt-5-mini',
    'o3',
  ],
}

/** Round-trip routing.json → CloudKeyOption (matches provider AND tier when Gemini). */
export function optionFromRouting(
  options: CloudKeyOption[],
  lastSelectedProvider: CloudProvider | null,
  geminiTier: GeminiTier | undefined
): CloudKeyOption | null {
  if (!lastSelectedProvider) return null
  return (
    options.find((o) => {
      if (o.provider !== lastSelectedProvider) return false
      if (o.provider !== 'gemini') return true
      // Gemini: match the tier explicitly. 'auto' or undefined → prefer Paid.
      const wantTier = geminiTier === 'free' ? 'free' : 'paid'
      return o.geminiTier === wantTier
    }) ?? null
  )
}

/** Read the user's last-selected option from the saved routing config. */
export async function readLastSelectedOption(
  options: CloudKeyOption[]
): Promise<CloudKeyOption | null> {
  const routing = await getRouting()
  return optionFromRouting(options, routing.lastSelectedProvider, routing.geminiTier)
}
