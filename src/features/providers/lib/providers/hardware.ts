// Hardware-aware advisor for local LLMs. Given a model identifier, the
// user's VRAM, and a typical context size, this estimates whether the
// model will run, and tells the user which runner-specific optimisations
// they need to enable (FlashAttention, 4-bit KV cache, etc.).
//
// We can't actually flip those flags via the runner's HTTP API — they're
// startup-time options. So this surface is *advisory*: it tells the user
// what to set in their runner's config / env vars, then they flip it once
// per model.

/**
 * Pulls a parameter-size hint out of a model identifier or display string.
 * Returns the size in billions of parameters, or null when no signal is
 * available (the user must then judge for themselves).
 *
 * Examples:
 *   "gemma3:27b" → 27
 *   "llama-3.1-8b-instruct" → 8
 *   "qwen2.5-7b" → 7
 *   "DeepSeek-R1-Distill-Llama-8B" → 8
 */
export function parseParamSizeB(idOrLabel: string): number | null {
  const lower = idOrLabel.toLowerCase()
  // Match "<num>b" with an optional decimal, bounded so "100b" doesn't match a hash.
  const matches = lower.matchAll(/(?:^|[^a-z0-9])(\d+(?:\.\d+)?)\s*b\b/g)
  let best: number | null = null
  for (const m of matches) {
    const n = parseFloat(m[1])
    if (!Number.isFinite(n) || n <= 0 || n > 1000) continue
    // Pick the largest plausible match — model names sometimes contain "v3" etc.
    if (best === null || n > best) best = n
  }
  return best
}

