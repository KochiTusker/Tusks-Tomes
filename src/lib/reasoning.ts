// Reasoning models (Qwen QwQ, DeepSeek R1, OpenAI o-series, etc.) emit their
// internal chain-of-thought wrapped in a tag pair before the actual answer.
// Different vendors use different tags — strip all known variants so the
// chronicle / JSON / SBV cue output never contains the model's deliberation.

const PATTERNS: RegExp[] = [
  /<think>[\s\S]*?<\/think>\s*/gi,
  /<thinking>[\s\S]*?<\/thinking>\s*/gi,
  /<reasoning>[\s\S]*?<\/reasoning>\s*/gi,
  /<\|thinking\|>[\s\S]*?<\|\/thinking\|>\s*/gi,
  /<reflection>[\s\S]*?<\/reflection>\s*/gi,
]

/**
 * Strip well-formed reasoning blocks from model output. Handles the common
 * vendor variants. If a block was opened but never closed (mid-truncation),
 * we leave it alone rather than guessing where the answer started — better
 * to surface obviously-broken output than to silently slice it wrongly.
 */
export function stripReasoningBlocks(text: string): string {
  let out = text
  for (const re of PATTERNS) {
    out = out.replace(re, '')
  }
  return out.trim()
}
