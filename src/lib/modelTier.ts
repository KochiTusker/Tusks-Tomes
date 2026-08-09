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

  // Claude Code uses the same Claude model family (incl. bare aliases
  // 'opus' / 'sonnet' / 'haiku'), so it classifies identically.
  if (provider === 'claude' || provider === 'claudeCode') {
    if (/opus/.test(m)) return 'frontier'
    if (/haiku/.test(m)) return 'fast'
    if (/sonnet/.test(m)) return 'flagship'
    return 'flagship'
  }

  // OpenAI + Codex: -mini / -nano are fast, gpt-5 / gpt-4o etc are
  // flagship (Codex runs the same GPT family via subscription).
  if (provider === 'openai' || provider === 'codex') {
    if (/-mini\b/.test(m) || /-nano\b/.test(m)) return 'fast'
    return 'flagship'
  }

  return 'flagship'
}
