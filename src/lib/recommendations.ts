// Per-phase routing recommendations.
//
// Inputs:
//   1. A probed local model's capability scores (mini-probe from Step 14).
//   2. The model's parameter count, parsed from its identifier.
//   3. The user's system specs (detected VRAM via nvidia-smi, or a
//      user-supplied HardwareProfile from legacy provider settings).
//
// Output: a recommendation per phase — "send to local model X" or "send to
// cloud" — with a one-line reason the UI surfaces alongside.

import { parseParamSizeB } from './providers/hardware'
import type { ProbeResult } from './localLLM'
import type { SystemInfo } from './system'

export type Phase = 'phase1' | 'phase2' | 'phase3' | 'phase4'

export type Recommendation =
  | { kind: 'local'; modelId: string; baseUrl: string; reason: string }
  | { kind: 'cloud'; reason: string }
  | { kind: 'probe-first'; reason: string }

export type ModelCapability = {
  modelId: string
  baseUrl: string
  paramsB: number | null
  probe: ProbeResult | undefined
}

const PHASE_LABEL: Record<Phase, string> = {
  phase1: 'Grounding',
  phase2: 'Audit',
  phase3: 'Chronicle',
  phase4: 'Extras',
}

/** Rough VRAM cost for inference at Q4 weights + 4-bit KV (matches hardware.ts). */
function estimateVramGb(paramsB: number, contextTokens = 16_000): number {
  const weightsGb = paramsB * 0.7
  const kvGb = (contextTokens * paramsB * 4) / 1_000_000
  return weightsGb + kvGb + 0.6
}

export type VramFit = 'comfortable' | 'tight' | 'overflow' | 'unknown'

export function fitFor(paramsB: number | null, vramGb: number | null): VramFit {
  if (paramsB === null || vramGb === null) return 'unknown'
  const needed = estimateVramGb(paramsB)
  if (needed <= vramGb * 0.75) return 'comfortable'
  if (needed <= vramGb * 1.0) return 'tight'
  return 'overflow'
}

/**
 * Decide a single phase's recommendation given one candidate local model.
 * Caller picks the best among multiple candidates via `recommendRouting`.
 */
function recommendForCandidate(
  phase: Phase,
  candidate: ModelCapability,
  vramGb: number | null
): Recommendation {
  const { modelId, baseUrl, paramsB, probe } = candidate
  if (!probe) {
    return {
      kind: 'probe-first',
      reason: `${modelId}: run the capability probe to evaluate.`,
    }
  }

  const fit = fitFor(paramsB, vramGb)
  if (fit === 'overflow') {
    return {
      kind: 'cloud',
      reason: `${modelId} (${paramsB}B) won't fit in ${vramGb}GB VRAM — keep ${PHASE_LABEL[phase]} on cloud.`,
    }
  }

  // Phase 3 (chronicle) — local is held back regardless until a richer probe
  // validates prose quality. Note this even if the probe scored well.
  if (phase === 'phase3') {
    return {
      kind: 'cloud',
      reason: `Chronicle prose quality is best on cloud models; local is held back until a richer probe lands.`,
    }
  }

  // Phase 1 (grounding) — needs solid recall on lore names + decent throughput.
  if (phase === 'phase1') {
    if (!probe.eligible.phase1) {
      return {
        kind: 'cloud',
        reason: `${modelId}: grounding score ${probe.groundingScore.toFixed(2)} below 0.70 threshold.`,
      }
    }
    if (paramsB !== null && paramsB < 7) {
      return {
        kind: 'cloud',
        reason: `${modelId} (${paramsB}B) is too small for reliable grounding — sub-7B models miss subtle lore corrections.`,
      }
    }
    if (probe.tokensPerSecond < 15) {
      return {
        kind: 'cloud',
        reason: `${modelId}: ${probe.tokensPerSecond.toFixed(0)} tok/s is slow for grounding throughput; cloud finishes faster.`,
      }
    }
    return {
      kind: 'local',
      modelId,
      baseUrl,
      reason: `${modelId}: grounding ${probe.groundingScore.toFixed(2)} ≥ 0.70, ${probe.tokensPerSecond.toFixed(0)} tok/s, fits ${fit}.`,
    }
  }

  // Phase 2 / 4 — mechanical JSON extraction. Smaller models are fine if
  // they hit the structured-JSON bar.
  if (!probe.eligible[phase]) {
    return {
      kind: 'cloud',
      reason: `${modelId}: structured JSON score ${probe.structuredJsonScore.toFixed(2)} below 0.80 threshold.`,
    }
  }
  if (paramsB !== null && paramsB < 3) {
    return {
      kind: 'cloud',
      reason: `${modelId} (${paramsB}B) is too small to reliably hold JSON schemas at chunk scale.`,
    }
  }
  return {
    kind: 'local',
    modelId,
    baseUrl,
    reason: `${modelId}: JSON ${probe.structuredJsonScore.toFixed(2)}, ${probe.tokensPerSecond.toFixed(0)} tok/s, fits ${fit}.`,
  }
}

function pickVramGb(specs: SystemInfo | null, override: number | null): number | null {
  if (override !== null && override > 0) return override
  if (specs?.gpu.detected && specs.gpu.vramGb) return specs.gpu.vramGb
  return null
}

/**
 * Build per-phase recommendations across all probed candidates. Returns the
 * "best" choice for each phase: prefer `local`, otherwise the first
 * informative `cloud` reason. If nothing is probed yet, every phase reports
 * `probe-first`.
 */
export function recommendRouting(args: {
  probes: ProbeResult[]
  detectedModels: Array<{ modelId: string; baseUrl: string }>
  specs: SystemInfo | null
  /** User-supplied VRAM override from the legacy HardwareProfile (in GB). */
  manualVramGb?: number | null
}): Record<Phase, Recommendation> {
  const vramGb = pickVramGb(args.specs, args.manualVramGb ?? null)
  const candidates: ModelCapability[] = args.detectedModels.map((m) => {
    const probe = args.probes.find((p) => p.baseUrl === m.baseUrl && p.modelId === m.modelId)
    return {
      modelId: m.modelId,
      baseUrl: m.baseUrl,
      paramsB: parseParamSizeB(m.modelId),
      probe,
    }
  })

  const phases: Phase[] = ['phase1', 'phase2', 'phase3', 'phase4']
  const out: Partial<Record<Phase, Recommendation>> = {}

  for (const phase of phases) {
    if (candidates.length === 0) {
      out[phase] = {
        kind: 'cloud',
        reason: 'No local backend detected — every phase routes to cloud.',
      }
      continue
    }

    let pick: Recommendation | null = null
    for (const candidate of candidates) {
      const rec = recommendForCandidate(phase, candidate, vramGb)
      if (rec.kind === 'local') {
        // Prefer the largest local model that passes (better quality at no
        // additional risk).
        if (
          !pick ||
          pick.kind !== 'local' ||
          (candidate.paramsB ?? 0) > (parseParamSizeB(pick.modelId) ?? 0)
        ) {
          pick = rec
        }
      } else if (!pick) {
        pick = rec
      }
    }
    out[phase] = pick ?? { kind: 'cloud', reason: 'No suitable candidate.' }
  }

  return out as Record<Phase, Recommendation>
}
