// Classifies an LLM model name into a coarse tier so chunk sizes and other
// per-model tunings can key off it without a giant if/else everywhere.
//
// 'flagship' is the safe default — bigger chunks just mean fewer calls, not
// worse output. Unknown model strings (e.g. preview IDs, custom user
// overrides) fall through to 'flagship'.

import type { CloudProvider } from './profiles'

export type ModelTier = 'flagship' | 'fast' | 'frontier'

export function classifyModelTier(model: string, provider: CloudProvider): ModelTier {
  const m = (model || '').toLowerCase()
  if (!m) return 'flagship'

  if (provider === 'gemini') {
    // Test 'pro' before 'flash' so a hypothetical 'flashy-pro' lands on flagship.
    if (/\bpro\b/.test(m) || /-pro\b/.test(m) || m.endsWith('-pro')) return 'flagship'
    if (/\bflash\b/.test(m) || /-flash(-|\b)/.test(m)) return 'fast'
    return 'flagship'
  }

  // Claude Code uses the Claude model family, including the bare aliases
  // 'opus' / 'sonnet' / 'haiku'.
  if (provider === 'claudeCode') {
    if (/opus/.test(m)) return 'frontier'
    if (/haiku/.test(m)) return 'fast'
    if (/sonnet/.test(m)) return 'flagship'
    return 'flagship'
  }

  // Codex runs the GPT family via subscription: -mini / -nano are fast,
  // everything else flagship.
  if (provider === 'codex') {
    if (/-mini\b/.test(m) || /-nano\b/.test(m)) return 'fast'
    return 'flagship'
  }

  return 'flagship'
}
