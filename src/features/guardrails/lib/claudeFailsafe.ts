// The explicit-content failsafe, and which model performs the repair.
//
// When ON, two safety nets activate for Claude Code runs:
//   1. real-time — a chunk that looks like a refusal, or comes back empty, is
//      redone mid-run on a permissive model;
//   2. post-hoc — detected refusals offer a reconciliation pass over the
//      finished chronicle and extras.
//
// OFF by default, per the project's "risky features default off" rule: with it
// off, Claude Code behaves exactly as it would without the failsafe.
//
// The repair model used to be Gemini, hardcoded. That was reasonable when
// Gemini was the only permissive provider wired up, and it had one hard edge:
// a user with no Gemini key got no repair at all, and the refusal became a
// permanent hole in the chronicle. It is a choice now, and the choice is
// restricted to models actually MEASURED carrying graphic content — a repair
// runs precisely because something already refused this material, so routing
// it somewhere unproven invites the same refusal twice.

const LS_KEY = 'claude_failsafe_enabled'
const LS_MODEL = 'claude_failsafe_model'

import { safeGetRaw, safeSetRaw } from '../../../platform/lib/storage'
import { DEFAULT_FAILSAFE_TARGET, FAILSAFE_TARGETS, type FailsafeTarget } from './failsafeTargets'

export { DEFAULT_FAILSAFE_TARGET, FAILSAFE_TARGETS, type FailsafeTarget }

/**
 * Which model repairs a refused chunk.
 *
 * Falls back to the default when the stored id is one this build no longer
 * offers — a model can leave a catalogue between releases, and a stale
 * preference must not silently disable the failsafe.
 */
export function getFailsafeTarget(): FailsafeTarget {
  const stored = safeGetRaw(LS_MODEL)
  return FAILSAFE_TARGETS.find((t) => t.modelId === stored) ?? DEFAULT_FAILSAFE_TARGET
}

export function setFailsafeTarget(modelId: string): void {
  safeSetRaw(LS_MODEL, modelId)
}

export function getClaudeFailsafeEnabled(): boolean {
  return safeGetRaw(LS_KEY) === 'true'
}

export function setClaudeFailsafeEnabled(on: boolean): void {
  safeSetRaw(LS_KEY, on ? 'true' : 'false')
}
