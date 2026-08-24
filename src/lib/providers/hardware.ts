// Hardware-aware advisor for local LLMs. Given a model identifier, the
// user's VRAM, and a typical context size, this estimates whether the
// model will run, and tells the user which runner-specific optimisations
// they need to enable (FlashAttention, 4-bit KV cache, etc.).
//
// We can't actually flip those flags via the runner's HTTP API — they're
// startup-time options. So this surface is *advisory*: it tells the user
// what to set in their runner's config / env vars, then they flip it once
// per model.

import type { HardwareProfile, ProviderId } from './types'

/** Rough verdict for a model on a hardware profile. */
export type FitVerdict = 'comfortable' | 'tight' | 'overflow' | 'unknown'

export type FitEstimate = {
  verdict: FitVerdict
  /** Estimated total VRAM usage in GB at 4-bit weights + 4-bit KV cache + FA-2. */
  estimatedVramGb: number | null
  /** Parsed parameter size in billions, or null if unparseable. */
  paramsB: number | null
  /** Whether the verdict assumes 4-bit KV cache + FlashAttention is enabled. */
  requiresOptimisation: boolean
  /** Per-runner instructions to enable the recommended optimisations. */
  recommendations: string[]
  /** A one-line human summary the UI can render directly. */
  summary: string
}

const DEFAULT_CONTEXT_TOKENS = 50_000

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

/**
 * Rough VRAM estimate for a model under "best practice" 4-bit weights + 4-bit
 * KV cache + FlashAttention-2 + GQA-style architecture (Llama 3+, Qwen 2.5+,
 * Gemma 2+). Calibrated against published numbers — accurate to ±20%, which
 * is enough for a "fits / tight / overflow" verdict.
 */
function estimateVramGb(paramsB: number, contextTokens: number): number {
  // Q4_K_M quantised weights, including embeddings and norms.
  const weightsGb = paramsB * 0.7
  // KV cache at 4-bit, GQA (~4× compression vs MHA).
  // Empirically: ~32 KB/token for an 8B GQA model. Scales ~linearly with params.
  const kvKbPerToken = paramsB * 4
  const kvGb = (contextTokens * kvKbPerToken) / 1_000_000
  // Activation / runtime overhead (CUDA workspace, attention, etc.).
  const overheadGb = 0.6
  return weightsGb + kvGb + overheadGb
}

function recommendationsFor(provider: ProviderId): string[] {
  switch (provider) {
    case 'ollama':
      return [
        'Set environment variable: OLLAMA_FLASH_ATTENTION=1',
        'Set environment variable: OLLAMA_KV_CACHE_TYPE=q4_0',
        '(Restart `ollama serve` after setting these — or use this app\'s "Launch Ollama" button which sets them automatically.)',
      ]
    case 'lmstudio':
      return [
        'In LM Studio → "My Models" → click your model → toggle "Flash Attention"',
        'Set "K cache quantization" and "V cache quantization" to Q4_0',
        'Reload the model after changing these.',
      ]
    case 'unsloth':
      // Unsloth's runtime auto-adapts FA / KV cache / quantisation based on
      // the host's VRAM. Manual config isn't required — and isn't reachable
      // via the API even if it were. Just pick a model that fits and run.
      return []
    default:
      return [
        'In your runner config, enable FlashAttention-2.',
        'Quantise the KV cache to 4-bit (Q4_0 or equivalent).',
        'Reload the model after changing these.',
      ]
  }
}

/**
 * Estimate fit for a model on the user's hardware. If the user hasn't
 * supplied a hardware profile, returns "unknown" with no commitment.
 */
export function estimateFit(args: {
  modelIdOrLabel: string
  hardware?: HardwareProfile
  provider: ProviderId
}): FitEstimate {
  const { modelIdOrLabel, hardware, provider } = args
  const paramsB = parseParamSizeB(modelIdOrLabel)
  const contextTokens = hardware?.expectedContextTokens ?? DEFAULT_CONTEXT_TOKENS

  if (!hardware?.vramGb || !paramsB) {
    return {
      verdict: 'unknown',
      estimatedVramGb: paramsB ? estimateVramGb(paramsB, contextTokens) : null,
      paramsB,
      requiresOptimisation: false,
      recommendations: [],
      summary: !hardware?.vramGb
        ? "VRAM not set — can't estimate fit. Enter your GPU's VRAM in Hardware below."
        : 'Param size not detectable from name — can\'t estimate fit.',
    }
  }

  const optimisedGb = estimateVramGb(paramsB, contextTokens)
  const unoptimisedGb = optimisedGb + paramsB * contextTokens * 4 / 1_000_000 // double KV (fp16 vs q4)

  const fitsComfortablyUnoptimised = unoptimisedGb < hardware.vramGb * 0.85
  const fitsOptimised = optimisedGb < hardware.vramGb * 0.95
  const tight = optimisedGb < hardware.vramGb * 1.05

  if (fitsComfortablyUnoptimised) {
    return {
      verdict: 'comfortable',
      estimatedVramGb: unoptimisedGb,
      paramsB,
      requiresOptimisation: false,
      recommendations: [],
      summary: `~${unoptimisedGb.toFixed(1)} GB needed (you have ${hardware.vramGb} GB) — comfortable, no optimisation required.`,
    }
  }

  if (fitsOptimised) {
    return {
      verdict: 'tight',
      estimatedVramGb: optimisedGb,
      paramsB,
      requiresOptimisation: true,
      recommendations: recommendationsFor(provider),
      summary: `~${optimisedGb.toFixed(1)} GB with 4-bit KV + FlashAttention (you have ${hardware.vramGb} GB) — fits, but you must enable both optimisations or it will crash mid-run.`,
    }
  }

  if (tight) {
    return {
      verdict: 'tight',
      estimatedVramGb: optimisedGb,
      paramsB,
      requiresOptimisation: true,
      recommendations: recommendationsFor(provider),
      summary: `~${optimisedGb.toFixed(1)} GB needed even with 4-bit KV + FA (you have ${hardware.vramGb} GB) — borderline. Reduce context size or expect occasional OOMs.`,
    }
  }

  return {
    verdict: 'overflow',
    estimatedVramGb: optimisedGb,
    paramsB,
    requiresOptimisation: true,
    recommendations: recommendationsFor(provider),
    summary: `~${optimisedGb.toFixed(1)} GB needed (you have ${hardware.vramGb} GB) — won't fit, even with optimisation. Pick a smaller model or reduce context.`,
  }
}
