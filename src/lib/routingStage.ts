// Staging a routing preset into a RoutingDocument.
//
// This tiny function carries the single most dangerous invariant in the
// app's configuration model: `lastSelectedProvider` must never be left
// null by a preset apply. It is read at run start (provider dispatch), on
// resume (checkpoints store and compare it), and by every "what's active"
// surface. The old Active Provider card was one of only two writers; with
// that card gone, every plan rung MUST write it — so the write lives in
// one pure, tested function instead of inside a component.

import type { RoutingDocument } from './routing'
import type { GeminiTier } from './routing'
import type { CloudProvider } from './profiles'

/** Where a preset's "centre of gravity" is: the provider a run should
 *  identify with (and bill expectations against) after applying it. */
export type PresetPrimary = {
  provider: CloudProvider
  /** Only meaningful for gemini. */
  geminiTier?: GeminiTier
}

export function stageRoutingFromPreset(
  current: RoutingDocument | null,
  perPhase: NonNullable<RoutingDocument['perPhase']>,
  primary: PresetPrimary,
): RoutingDocument {
  return {
    version: 3,
    // The invariant. Never `current?.lastSelectedProvider ?? null` — a
    // fresh install applying its first plan is exactly the case where
    // current is null.
    lastSelectedProvider: primary.provider,
    geminiTier:
      primary.provider === 'gemini'
        ? (primary.geminiTier ?? current?.geminiTier ?? 'paid')
        : current?.geminiTier,
    perPhase,
  }
}
