// Soft-error signature library. Each signature is a pure function that
// inspects the diagnostic ring + current state + probe cache + routing
// and decides whether something fishy happened — the kind of "soft"
// failures that complete a run but leave you with a degraded or wrong
// output (a chunk that retried silently; a paid-tier swap mid-run; a
// routing entry pointing at a model the user's key can't reach).
//
// Why this is separate from the verboseLog: the ring captures EVERYTHING
// the pipeline does. The signatures here are the curated subset of
// patterns that mean "investigate this." They power the soft-error
// section of the diagnosis bundle and the optional 60s scan loop.
//
// Adding a new signature: write a pure `(input) => Match | null`
// function, add it to `SIGNATURES`, and add a positive + negative test
// fixture in softErrorSignatures.test.ts. No other wiring needed — the
// bundle assembler iterates SIGNATURES directly.

import type { DiagnosticEntry } from './diagnosticsLog.js'

/** Loose shape mirroring the server-side `RoutingDocument`. We don't
 *  import the client type to keep the server lib free of cross-tree
 *  imports — the matchers only read a handful of fields. */
export type RoutingSnapshot = {
  version?: 1 | 2 | 3
  lastSelectedProvider?: 'gemini' | 'claude' | 'openai' | 'openrouter' | null
  geminiTier?: 'paid' | 'free' | 'auto'
  perPhase?: Record<string, {
    target?: 'cloud' | 'local'
    cloudProvider?: 'gemini' | 'claude' | 'openai' | 'openrouter'
    geminiTier?: 'paid' | 'free' | 'auto'
    modelId?: string
  } | undefined>
}

/** Same loose shape for the probe-availability cache; we only read a
 *  small slice. */
export type ProbeSnapshot = {
  [slot: string]: {
    keyFingerprint?: string
    advertised?: string[]
    probed?: Array<{ id: string; accessible: boolean; reason?: string }>
  } | undefined
}

/** Best-effort snapshot of the live RefinementState — passed by the
 *  client when it requests a bundle. Optional because the server bundle
 *  builder can still emit a useful diagnosis without it. */
export type RefinementStateSnapshot = {
  status?: string
  currentPhase?: string | null
  currentChunkIndex?: number
  totalChunks?: number
  chronicle?: string
  lastError?: string
  outputSelection?: {
    chronicle?: boolean
    extras?: boolean
    condensed?: boolean
  }
}

export type SignatureInput = {
  ring: DiagnosticEntry[]
  routing?: RoutingSnapshot
  probeCache?: ProbeSnapshot
  state?: RefinementStateSnapshot
}

export type Severity = 'critical' | 'warning' | 'info'

export type Match = {
  id: string
  severity: Severity
  /** One-line headline rendered in the bundle's section 2. */
  hint: string
  /** Optional structured evidence — events / entries the match keyed on.
   *  Bundle writer JSON-stringifies this into the markdown for the
   *  diagnosis run. Keep small (< 5 entries) — the goal is "here's the
   *  smoking gun line," not "here are all the related lines." */
  evidence?: Record<string, unknown>
  /** Optional suggested next step. Surfaced in section 8 of the bundle. */
  nextStep?: string
}

export type Signature = {
  id: string
  description: string
  severity: Severity
  match(input: SignatureInput): Omit<Match, 'id' | 'severity'> | null
}

// ─────────────────────────────────────────────────────────────────────────────
// The library. Adding a new signature here automatically wires it through.
// ─────────────────────────────────────────────────────────────────────────────

/** Helper — pull events of a given category from the ring, optionally
 *  filtered by payload.event. */
function eventsOfCategory(
  ring: DiagnosticEntry[],
  cat: string,
  payloadEvent?: string,
): DiagnosticEntry[] {
  return ring.filter((e) => {
    if (e.cat !== cat) return false
    if (!payloadEvent) return true
    const p = e.payload as { event?: string } | null
    return p?.event === payloadEvent
  })
}

/** Median of a numeric sample. Returns 0 for empty input. */
function median(nums: number[]): number {
  if (nums.length === 0) return 0
  const sorted = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/** Signature #1: chunk_latency_outlier — any chunk_finished whose
 *  latencyMs exceeds 3× the median for the phase. Surfaces retries that
 *  the user didn't notice. */
const sigChunkLatencyOutlier: Signature = {
  id: 'chunk_latency_outlier',
  description: 'A chunk took >3× the median latency for its phase — likely a retried call.',
  severity: 'warning',
  match({ ring }) {
    const finished = eventsOfCategory(ring, 'chunk', 'chunk_finished')
    if (finished.length < 4) return null // not enough samples for a median
    // Group by phase.
    const byPhase = new Map<string, number[]>()
    for (const e of finished) {
      const p = e.payload as { phase?: string; latencyMs?: number }
      if (!p?.phase || typeof p.latencyMs !== 'number') continue
      const arr = byPhase.get(p.phase) ?? []
      arr.push(p.latencyMs)
      byPhase.set(p.phase, arr)
    }
    const outliers: Array<{ phase: string; index: number; latencyMs: number; median: number }> = []
    for (const [phase, latencies] of byPhase) {
      if (latencies.length < 4) continue
      const med = median(latencies)
      for (const e of finished) {
        const p = e.payload as { phase?: string; index?: number; latencyMs?: number }
        if (p?.phase !== phase || typeof p.latencyMs !== 'number') continue
        if (p.latencyMs > med * 3) {
          outliers.push({
            phase,
            index: typeof p.index === 'number' ? p.index : -1,
            latencyMs: p.latencyMs,
            median: med,
          })
        }
      }
    }
    if (outliers.length === 0) return null
    return {
      hint: `Found ${outliers.length} chunk${outliers.length === 1 ? '' : 's'} with latency >3× the phase median. Likely retried under the hood.`,
      evidence: { outliers: outliers.slice(0, 5) },
      nextStep: 'Inspect retry_waiting events on either side of the outlier chunk(s) to see what triggered the retry.',
    }
  },
}

/** Signature #2: auto_fallback_mid_run — any auto_fallback event during
 *  the current run. Tells the user their singleton soft-swapped tier. */
const sigAutoFallbackMidRun: Signature = {
  id: 'auto_fallback_mid_run',
  description: 'The Gemini auto-tier singleton swapped to the fallback key mid-run.',
  severity: 'warning',
  match({ ring }) {
    const events = eventsOfCategory(ring, 'pipeline').filter((e) => {
      const p = e.payload as { type?: string } | null
      return p?.type === 'auto_fallback'
    })
    // Also pick up the lower-level provider-side event (some emit through
    // the provider channel before the pipeline forwards it).
    const providerEvents = eventsOfCategory(ring, 'provider').filter((e) => {
      const p = e.payload as { event?: { kind?: string } } | null
      return p?.event?.kind === 'auto_fallback'
    })
    const all = [...events, ...providerEvents]
    if (all.length === 0) return null
    const reasons = all.map((e) => {
      const p = e.payload as { reason?: string; event?: { reason?: string } }
      return p.reason ?? p.event?.reason ?? 'unknown'
    })
    return {
      hint: `auto_fallback fired ${all.length} time${all.length === 1 ? '' : 's'} during this run (reasons: ${[...new Set(reasons)].join(', ')}). Subsequent chunks dispatched to the Free key even though the run started on Paid.`,
      evidence: { reasons, count: all.length },
      nextStep: 'Verify which singleton handled chunks AFTER the fallback by checking chunk_started.tier in the next events.',
    }
  },
}

/** Signature #3: probed_model_inaccessible_but_selected — routing.json
 *  names a model that the probe cache marked accessible:false for the
 *  resolved slot. */
const sigProbedModelInaccessibleButSelected: Signature = {
  id: 'probed_model_inaccessible_but_selected',
  description: 'Routing references a model the probe says is inaccessible with the configured key.',
  severity: 'critical',
  match({ routing, probeCache }) {
    if (!routing?.perPhase || !probeCache) return null
    const findings: Array<{ phase: string; slot: string; model: string; reason?: string }> = []
    for (const [phase, entry] of Object.entries(routing.perPhase)) {
      if (!entry || entry.target !== 'cloud' || !entry.modelId || !entry.cloudProvider) continue
      // Map the entry to a slot name. For Gemini the tier picks the slot.
      let slot: string = entry.cloudProvider
      if (entry.cloudProvider === 'gemini') {
        slot = entry.geminiTier === 'free' ? 'geminiFallback' : 'gemini'
      }
      const slotData = probeCache[slot]
      if (!slotData?.probed) continue
      const probeEntry = slotData.probed.find((p) => p.id === entry.modelId)
      if (probeEntry && probeEntry.accessible === false) {
        findings.push({
          phase,
          slot,
          model: entry.modelId,
          reason: probeEntry.reason,
        })
      }
    }
    if (findings.length === 0) return null
    return {
      hint: `${findings.length} phase${findings.length === 1 ? '' : 's'} pinned to model${findings.length === 1 ? '' : 's'} the probe marked inaccessible. The run will throw mid-phase unless escalation kicks in.`,
      evidence: { findings },
      nextStep: 'Either re-probe the slot in case access changed, OR pick a different model in Hybrid Routing.',
    }
  },
}

/** Signature #4: empty_phase_output — phase_complete fired for phase 3
 *  but state.chronicle is suspiciously short. Catches the case where the
 *  pipeline thinks it succeeded but produced nothing. */
const sigEmptyPhaseOutput: Signature = {
  id: 'empty_phase_output',
  description: 'A phase ran to completion but the output is suspiciously short — possible silent failure.',
  severity: 'warning',
  match({ ring, state }) {
    const phaseComplete = eventsOfCategory(ring, 'pipeline').filter((e) => {
      const p = e.payload as { type?: string; phase?: string } | null
      return p?.type === 'phase_complete' && p?.phase === 'phase3_chronicle'
    })
    if (phaseComplete.length === 0) return null
    const chronicle = state?.chronicle ?? ''
    if (chronicle.length >= 100) return null
    return {
      hint: `phase3_chronicle complete but state.chronicle is ${chronicle.length} chars. Phase ran but produced ~nothing.`,
      evidence: { chronicleLength: chronicle.length, sample: chronicle.slice(0, 200) },
      nextStep: 'Check the last chunk_finished.outputChars and any safety-filter blocks in the provider event stream.',
    }
  },
}

/** Signature #5: stale_perPhase_override — perPhase entry on a phase
 *  resolves to a different tier than the global selector. The user's
 *  most recent intent (the global flip) is being silently overridden. */
const sigStalePerPhaseOverride: Signature = {
  id: 'stale_perPhase_override',
  description: 'A perPhase routing override pins a phase to a tier different from the global geminiTier.',
  severity: 'warning',
  match({ routing }) {
    if (!routing?.perPhase) return null
    const globalTier = routing.geminiTier ?? 'auto'
    const findings: Array<{ phase: string; phaseTier: string; globalTier: string }> = []
    for (const [phase, entry] of Object.entries(routing.perPhase)) {
      if (!entry || entry.target !== 'cloud' || entry.cloudProvider !== 'gemini') continue
      const phaseTier = entry.geminiTier ?? 'auto'
      if (phaseTier !== globalTier) {
        findings.push({ phase, phaseTier, globalTier })
      }
    }
    if (findings.length === 0) return null
    return {
      hint: `${findings.length} phase${findings.length === 1 ? '' : 's'} have a perPhase tier override that differs from the global selector (${globalTier}).`,
      evidence: { findings },
      nextStep: 'Clear the perPhase entries via the override banner in Hybrid Routing if you intended the global tier flip to apply uniformly.',
    }
  },
}

/** Signature #6: provider_keys_mismatch_with_fingerprint — the most
 *  recent quota_exhausted event reports a key fingerprint that doesn't
 *  appear in any current probe-cache slot. Suggests the singleton was
 *  built from a key the keystore no longer holds. */
const sigProviderKeysMismatchWithFingerprint: Signature = {
  id: 'provider_keys_mismatch_with_fingerprint',
  description: "A quota event's key fingerprint doesn't match any probed slot — singleton may be stale.",
  severity: 'critical',
  match({ ring, probeCache }) {
    if (!probeCache) return null
    const quotaEvents = eventsOfCategory(ring, 'pipeline').filter((e) => {
      const p = e.payload as { type?: string } | null
      return p?.type === 'quota_exhausted'
    })
    if (quotaEvents.length === 0) return null
    const lastQuota = quotaEvents[quotaEvents.length - 1].payload as {
      keyFingerprint?: string
      tier?: string
      provider?: string
    }
    const eventFp = lastQuota?.keyFingerprint
    if (!eventFp) return null
    // Check every probe slot's fingerprint.
    const knownFps = Object.entries(probeCache)
      .map(([slot, data]) => ({ slot, fp: data?.keyFingerprint }))
      .filter((x) => !!x.fp)
    if (knownFps.length === 0) return null
    const match = knownFps.find((x) => x.fp === eventFp)
    if (match) return null
    return {
      hint: `Last quota_exhausted fingerprint (${eventFp}) doesn't match any probed slot. Singleton may be running off a stale key — refreshProviders() likely needed.`,
      evidence: { eventFingerprint: eventFp, probedFingerprints: knownFps },
      nextStep: 'Call refreshProviders() (Settings → toggle key → refresh) or restart the dev server to rebuild singletons from the current keystore.',
    }
  },
}

/** Signature #7: hidden_500_retries — ≥ 3 retry_waiting events for the
 *  same phase within 60 seconds. Surfaces intermittent transient errors
 *  that completed the run but added significant latency. */
const sigHidden500Retries: Signature = {
  id: 'hidden_500_retries',
  description: '≥ 3 transient retries for one phase in a 60s window — degraded reliability worth investigating.',
  severity: 'info',
  match({ ring }) {
    const retries = eventsOfCategory(ring, 'pipeline').filter((e) => {
      const p = e.payload as { type?: string } | null
      return p?.type === 'retry_waiting'
    })
    if (retries.length < 3) return null
    // Group by phase, then scan a 60s sliding window.
    const byPhase = new Map<string, number[]>()
    for (const e of retries) {
      const p = e.payload as { phase?: string }
      if (!p?.phase) continue
      const arr = byPhase.get(p.phase) ?? []
      arr.push(e.ts)
      byPhase.set(p.phase, arr)
    }
    const findings: Array<{ phase: string; count: number; spanSeconds: number }> = []
    for (const [phase, timestamps] of byPhase) {
      timestamps.sort((a, b) => a - b)
      // Sliding window of 60_000ms.
      for (let i = 0; i < timestamps.length; i++) {
        let count = 1
        for (let j = i + 1; j < timestamps.length; j++) {
          if (timestamps[j] - timestamps[i] <= 60_000) count++
          else break
        }
        if (count >= 3) {
          findings.push({ phase, count, spanSeconds: 60 })
          break
        }
      }
    }
    if (findings.length === 0) return null
    return {
      hint: `${findings.length} phase${findings.length === 1 ? '' : 's'} hit ≥ 3 transient retries in a 60s window.`,
      evidence: { findings },
      nextStep: 'Check provider status pages for incidents during the run. If repeating, consider lowering chunk size for that phase.',
    }
  },
}

/** Signature #8: tier_escalated_silently — pipeline emitted tier_escalated
 *  for a chunk, but the next chunk_started reports the OLD tier still.
 *  Indicates the session-rebuild path didn't pick up the escalation. */
const sigTierEscalatedSilently: Signature = {
  id: 'tier_escalated_silently',
  description: 'A tier_escalated event fired but the next chunk_started reports the original tier.',
  severity: 'critical',
  match({ ring }) {
    const escalations = ring
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => {
        const p = e.payload as { type?: string } | null
        return p?.type === 'tier_escalated'
      })
    if (escalations.length === 0) return null
    const findings: Array<{ at: number; expected: string; actual: string }> = []
    for (const { e, i } of escalations) {
      const p = e.payload as { toTier?: string; phase?: string }
      const expected = p.toTier ?? 'paid'
      // Find the next chunk_started for the same phase.
      const next = ring.slice(i + 1).find((later) => {
        const lp = later.payload as { event?: string; phase?: string }
        return lp?.event === 'chunk_started' && lp?.phase === p.phase
      })
      if (!next) continue
      const nextPayload = next.payload as { tier?: string }
      if (nextPayload.tier && nextPayload.tier !== expected) {
        findings.push({ at: e.ts, expected, actual: nextPayload.tier })
      }
    }
    if (findings.length === 0) return null
    return {
      hint: `${findings.length} tier_escalated event${findings.length === 1 ? '' : 's'} did NOT take effect on the subsequent chunk.`,
      evidence: { findings },
      nextStep: 'Inspect chunkedGenerate dispatch — likely a stale closure over the resolved provider singleton.',
    }
  },
}

/** Signature #9: silent_model_substitution_to_lite — buildSession swapped
 *  a configured model for a `-lite-` / experimental / `-latest` variant.
 *  These swaps usually surface as bad output quality OR (the specific
 *  case this signature exists for) the lite variant's more aggressive
 *  safety filter blocking a chunk that the user's configured model would
 *  have passed through fine.
 *
 *  Real-world failure mode this catches: user picks `gemini-2.5-flash`
 *  for Phase 2, Free probe (transiently) marks it inaccessible,
 *  `pickGeminiSubstitution` swaps to `gemini-flash-lite-latest`, Phase 2
 *  hits PROHIBITED_CONTENT mid-run. The user sees the lite-model name
 *  in the error and is confused because they never picked it. */
const sigSilentModelSubstitutionToLite: Signature = {
  id: 'silent_model_substitution_to_lite',
  description: 'buildSession swapped a configured model for a lite/experimental/latest variant — likely NOT what the user wanted.',
  severity: 'warning',
  match({ ring }) {
    const substitutions = eventsOfCategory(ring, 'sessions', 'model_substitution')
    const dubious = substitutions.filter((e) => {
      const p = e.payload as { dubious?: boolean } | null
      return p?.dubious === true
    })
    if (dubious.length === 0) return null
    const summary = dubious.map((e) => {
      const p = e.payload as { phase?: string; from?: string; to?: string; reason?: string }
      return { phase: p.phase, from: p.from, to: p.to, reason: p.reason }
    })
    return {
      hint: `${dubious.length} dubious model substitution${dubious.length === 1 ? '' : 's'} at session-build time — configured model swapped for a lite/experimental/latest variant.`,
      evidence: { substitutions: summary },
      nextStep:
        'Re-probe the Gemini Free slot in Settings → API Keys (the original model may have been transiently inaccessible). ' +
        "If the configured model is genuinely unreachable on Free, pin the substitute in Hybrid Routing explicitly so the swap is intentional.",
    }
  },
}

/** Signature #10: free_tier_daily_quota_hit — quota_exhausted with
 *  quotaKind='daily_quota' and tier='free' (or 'auto' that swapped).
 *  The Free-tier daily bucket is empty for the configured model; no
 *  amount of retrying will fix it before midnight UTC. The diagnose
 *  bundle should surface this as critical with the specific recovery
 *  paths: wait, switch model bucket, or add a paid key. */
const sigFreeTierDailyQuotaHit: Signature = {
  id: 'free_tier_daily_quota_hit',
  description: 'Free-tier daily quota exhausted — the daily bucket is empty until midnight UTC.',
  severity: 'critical',
  match({ ring, probeCache }) {
    const events = eventsOfCategory(ring, 'pipeline').filter((e) => {
      const p = e.payload as { type?: string; quotaKind?: string; tier?: string } | null
      if (p?.type !== 'quota_exhausted') return false
      if (p.quotaKind !== 'daily_quota') return false
      // Tier locked to free OR auto-tier that ended up on free fallback.
      return p.tier === 'free' || p.tier === 'auto'
    })
    if (events.length === 0) return null
    const lastEvent = events[events.length - 1].payload as {
      tier?: string
      model?: string
      keyFingerprint?: string
    }
    // Is a Paid Gemini key configured? Check the probe cache for the
    // gemini slot (Paid is the canonical slot; geminiFallback is Free).
    const hasPaidKey = !!probeCache?.gemini?.keyFingerprint
    const paidAdvice = hasPaidKey
      ? 'Switch to Gemini Paid in Settings → Active Provider, then click Resume.'
      : 'Add a Paid Gemini key in Settings → API Keys → Gemini Paid slot, then switch to it.'
    return {
      hint: `Free-tier daily quota exhausted on ${lastEvent.model ?? 'this model'}. Bucket resets at midnight UTC.`,
      evidence: {
        tier: lastEvent.tier,
        model: lastEvent.model,
        keyFingerprint: lastEvent.keyFingerprint,
        paidKeyConfigured: hasPaidKey,
        eventCount: events.length,
      },
      nextStep:
        `Three options: (1) Wait for the daily reset and click Resume. ` +
        `(2) ${paidAdvice} ` +
        `(3) Switch Phase 1's model in Hybrid Routing to a different Gemini model (separate daily quota bucket per model).`,
    }
  },
}

/** Signature #11: prompt_blocked_prohibited_content — a chunk's prompt
 *  was rejected by Gemini's unconfigurable PROHIBITED_CONTENT/BLOCKLIST/
 *  SPII filter. These cannot be relaxed via safetySettings; the only
 *  recoveries are (a) move that phase to a more permissive model (Pro
 *  vs Flash; cloud vs cloud), (b) accept the soft-skipped chunk's
 *  degraded output (Phase 2/4 only), or (c) edit the transcript to
 *  remove the trigger content. Common cause on D&D transcripts: combat
 *  damage / gore descriptions tripping Flash's stricter calibration.
 *
 *  Matches chunk_soft_skipped events (Phase 2/4 recovered) OR raw
 *  chunk_error events where the error preview includes the block
 *  reason string (Phase 1/3/5/6 hard-failed). Surfaces the affected
 *  phase + model in the hint so the recommended fix is concrete. */
const sigPromptBlockedProhibitedContent: Signature = {
  id: 'prompt_blocked_prohibited_content',
  description:
    'A chunk was rejected by Gemini\'s unconfigurable safety filter (PROHIBITED_CONTENT / BLOCKLIST / SPII) — cannot be relaxed via safetySettings.',
  severity: 'warning',
  match({ ring }) {
    const softSkipped = eventsOfCategory(ring, 'chunk').filter((e) => {
      const p = e.payload as { event?: string; reason?: string } | null
      return p?.event === 'chunk_soft_skipped' && p.reason === 'prohibited_content'
    })
    // Hard errors: chunk_error events whose preview names the block reason.
    // The pipeline error message includes "Reason: PROHIBITED_CONTENT" /
    // "BLOCKLIST" / "SPII" from formatEmptyResponseError.
    const hardBlocks = eventsOfCategory(ring, 'chunk').filter((e) => {
      const p = e.payload as { event?: string; errorPreview?: string } | null
      if (p?.event !== 'chunk_error') return false
      const preview = String(p.errorPreview ?? '')
      return (
        preview.includes('PROHIBITED_CONTENT') ||
        preview.includes('BLOCKLIST') ||
        preview.includes('SPII')
      )
    })
    if (softSkipped.length === 0 && hardBlocks.length === 0) return null
    const examples = [...softSkipped, ...hardBlocks].slice(0, 3).map((e) => {
      const p = e.payload as {
        event?: string
        phase?: string
        index?: number
        model?: string
        tier?: string
        reason?: string
        blockReason?: string
        errorPreview?: string
      }
      return {
        event: p.event,
        phase: p.phase,
        index: p.index,
        model: p.model,
        tier: p.tier,
        blockReason: p.blockReason ?? (p.errorPreview ? extractBlockReason(p.errorPreview) : undefined),
      }
    })
    const affectedModels = Array.from(
      new Set(examples.map((e) => e.model).filter((m): m is string => typeof m === 'string')),
    )
    const affectedPhases = Array.from(
      new Set(examples.map((e) => e.phase).filter((p): p is string => typeof p === 'string')),
    )
    const flashAffected = affectedModels.some((m) => /flash/i.test(m))
    const swapAdvice = flashAffected
      ? ' Flash models calibrate PROHIBITED_CONTENT more aggressively than Pro on D&D combat/violence content — switch the affected phase(s) to gemini-2.5-pro in Hybrid Routing for more permissive handling.'
      : ' Try swapping to a more permissive model in Hybrid Routing, or edit the source transcript to remove the trigger content (combat damage / explicit gore / harassment-like dialogue).'
    return {
      hint: `${softSkipped.length} chunk(s) soft-skipped + ${hardBlocks.length} chunk(s) hard-failed by Gemini's unconfigurable safety filter${affectedPhases.length ? ` (${affectedPhases.join(', ')})` : ''}.`,
      evidence: {
        softSkippedCount: softSkipped.length,
        hardBlockCount: hardBlocks.length,
        affectedPhases,
        affectedModels,
        examples,
      },
      nextStep:
        `These blocks are server-side at Google and cannot be bypassed via safetySettings (BLOCK_NONE on the configurable HARM_CATEGORY_* thresholds has no effect on PROHIBITED_CONTENT/BLOCKLIST/SPII).${swapAdvice}`,
    }
  },
}

/** Extract the block reason token (PROHIBITED_CONTENT / BLOCKLIST / SPII)
 *  from a chunk_error preview. Returns the first matching token or undefined. */
function extractBlockReason(preview: string): string | undefined {
  const m = preview.match(/(PROHIBITED_CONTENT|BLOCKLIST|SPII)/)
  return m ? m[1] : undefined
}

/** The exported library. The bundle assembler iterates this — add a new
 *  signature here and it surfaces automatically. */
export const SIGNATURES: ReadonlyArray<Signature> = [
  sigChunkLatencyOutlier,
  sigAutoFallbackMidRun,
  sigProbedModelInaccessibleButSelected,
  sigEmptyPhaseOutput,
  sigStalePerPhaseOverride,
  sigProviderKeysMismatchWithFingerprint,
  sigHidden500Retries,
  sigTierEscalatedSilently,
  sigSilentModelSubstitutionToLite,
  sigFreeTierDailyQuotaHit,
  sigPromptBlockedProhibitedContent,
]

/** Run every signature against the input and return the matches. Pure
 *  function; safe to call repeatedly. */
export function runSignatures(input: SignatureInput): Match[] {
  const out: Match[] = []
  for (const sig of SIGNATURES) {
    try {
      const result = sig.match(input)
      if (result) {
        out.push({
          id: sig.id,
          severity: sig.severity,
          ...result,
        })
      }
    } catch (err) {
      // A misbehaving matcher should NOT crash the bundle build. Log to
      // console + skip; downstream tools see one missing signature.
      console.warn(`[softErrorSignatures] matcher "${sig.id}" threw:`, err)
    }
  }
  // Sort: critical first, then warning, then info. Within tier, by id.
  const order: Record<Severity, number> = { critical: 0, warning: 1, info: 2 }
  out.sort((a, b) => order[a.severity] - order[b.severity] || a.id.localeCompare(b.id))
  return out
}
