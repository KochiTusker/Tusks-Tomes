// Profile sanitization for the active Gemini tier.
//
// `profiles.json` keeps a single per-provider profile (one Gemini, one Claude,
// one OpenAI). When the user flips the active Gemini key from Paid to Free in
// ActiveProviderCard, any saved per-phase model id that the Free key can't
// reach has to be swapped — otherwise the next run fails at Phase 1 with a
// 429/limit:0 from Google. Same problem when modelForPhase is consulted at
// run start with a stale profile.
//
// Source-of-truth precedence (most to least authoritative):
//   1. The probed availability cache. If the Free key was probed and
//      reported a model inaccessible, that's ground truth.
//   2. The PAID_ONLY_PATTERNS heuristic in src/lib/gemini.ts. Conservative —
//      used when no probe data exists for the active key.
//
// Replacement candidates always come from the probed-accessible set when
// available, so the picked model is one we KNOW the key can call.

import { isPaidOnlyGeminiModel } from './gemini'
import { type ProviderProfile } from './profiles'
import { type SlotAvailability } from './providerSettings'

const PHASE_FIELDS = [
  'phase1Model',
  'phase2Model',
  'phase3Model',
  'phase4Model',
  'phase6Model',
] as const

type PhaseField = (typeof PHASE_FIELDS)[number]

export type SanitizeReplacement = {
  phase: PhaseField
  from: string
  to: string
  reason: string
}

export type SanitizeReport = {
  /** Phases whose model was rewritten. */
  changed: SanitizeReplacement[]
  /** Phases whose model is inaccessible AND no candidate could be picked
   *  (e.g. probe data missing or every probed model is also inaccessible).
   *  The caller surfaces this to the user as a "probe your key" prompt. */
  unfixable: Array<{ phase: PhaseField; from: string; reason: string }>
  /** The new profile. Equal to the input by reference if no changes. */
  next: ProviderProfile
}

function family(id: string): 'pro' | 'flash' | 'other' {
  const lower = id.toLowerCase()
  if (lower.includes('flash')) return 'flash'
  if (lower.includes('pro')) return 'pro'
  return 'other'
}

/** Pick a replacement model from the probed-accessible set. Prefers the
 *  same family (Pro→Pro, Flash→Flash) so a "I want the best quality"
 *  saved profile doesn't silently downgrade to Flash on a tier switch.
 *  Within a family, picks the highest-versioned id by lexicographic
 *  descending sort (gemini-2.5-pro > gemini-2.0-pro > gemini-1.5-pro). */
function pickReplacement(
  originalId: string,
  slotAvail: SlotAvailability | undefined,
): string | null {
  if (!slotAvail) return null
  const accessible = slotAvail.probed.filter((p) => p.accessible).map((p) => p.id)
  if (accessible.length === 0) return null
  const wantFamily = family(originalId)
  const sameFamily = accessible.filter((id) => family(id) === wantFamily)
  const candidates = sameFamily.length > 0 ? sameFamily : accessible
  candidates.sort((a, b) => b.localeCompare(a))
  return candidates[0]
}

/**
 * Walk a Gemini profile, replace any per-phase model the active tier can't
 * reach. Returns the rewritten profile + a report of what changed.
 *
 * Behaviour by tier:
 *   - 'paid': no-op. Paid keys can reach everything the picker exposes.
 *   - 'free': replace paid-only ids. Probe data is preferred; heuristic is
 *     the fallback when no probe data exists for the Free slot.
 *   - 'auto': behave like 'free' for safety — the auto fallback will swap
 *     to the Free key on rate limits, and we don't want the swap to land
 *     on a paid-only model.
 */
export function sanitizeGeminiProfile(
  profile: ProviderProfile,
  tier: 'paid' | 'free' | 'auto',
  freeSlotAvail: SlotAvailability | undefined,
): SanitizeReport {
  const report: SanitizeReport = {
    changed: [],
    unfixable: [],
    next: profile,
  }
  if (tier === 'paid') return report

  const accessibleIds = new Set(
    (freeSlotAvail?.probed ?? []).filter((p) => p.accessible).map((p) => p.id),
  )
  let mutated: ProviderProfile | null = null

  for (const field of PHASE_FIELDS) {
    const id = profile[field]
    if (!id) continue

    let needsReplacement = false
    let reason = ''
    if (freeSlotAvail) {
      // Authoritative path: trust the probe.
      const probed = freeSlotAvail.probed.find((p) => p.id === id)
      if (probed && !probed.accessible) {
        needsReplacement = true
        reason = probed.reason ?? 'probed inaccessible'
      } else if (!probed && isPaidOnlyGeminiModel(id)) {
        // Probe ran but didn't cover this id (e.g. it was filtered out
        // because it isn't a Pro/Flash family member) — fall through to
        // the heuristic so we still gate known-paid-only ids.
        needsReplacement = true
        reason = 'paid-only by heuristic (unprobed model)'
      }
    } else if (isPaidOnlyGeminiModel(id)) {
      needsReplacement = true
      reason = 'paid-only by heuristic'
    }

    if (!needsReplacement) continue

    const replacement = pickReplacement(id, freeSlotAvail)
    if (replacement && replacement !== id && (!freeSlotAvail || accessibleIds.has(replacement))) {
      if (!mutated) mutated = { ...profile }
      mutated[field] = replacement
      report.changed.push({ phase: field, from: id, to: replacement, reason })
    } else {
      report.unfixable.push({ phase: field, from: id, reason })
    }
  }

  if (mutated) report.next = mutated
  return report
}
