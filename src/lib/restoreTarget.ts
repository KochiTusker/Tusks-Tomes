// Which model repairs a refused chunk.
//
// Both failsafes — the in-run retry when Claude Code refuses a chunk, and the
// post-hoc restore pass — used to name Gemini directly. That was a reasonable
// default when Gemini was the only permissive provider configured, and it has
// one hard failure mode: a user with no Gemini key gets no repair at all, and
// the refusal becomes a durable hole in the chronicle.
//
// The requirement a repair model has to meet is narrower than a phase model's.
// It is invoked precisely because something already refused this content, so
// the only disqualifying property is being likely to refuse it again. After
// that, prose quality on the chronicle phase is what matters, since that is
// what it is rewriting.
//
// DeepSeek V4 Pro is the OpenRouter pick on both counts: the best-graded
// non-Gemini chronicle model measured (B+ in blind review, 2026-08-18), on a
// provider with no prompt-level moderation filter. It is also cheap, which
// matters less than it looks — a repair only ever runs on the chunks that
// actually refused.

import { getCloudProvider } from './providers'
import type { CloudProvider } from './profiles'

export interface RestoreTarget {
  provider: CloudProvider
  /** Model id, in that provider's own namespace. */
  model: string
  /** Shown in the run log so the user can see what repaired the chunk. */
  label: string
}

/** Gemini, permissive, as both failsafes have always used. */
const GEMINI_INRUN: RestoreTarget = {
  provider: 'gemini',
  // Flash deliberately: the in-run failsafe redoes ONE refused chunk, small in
  // and small out, so the cheap tier keeps it cheap.
  model: 'gemini-2.5-flash',
  label: 'gemini restore',
}
const GEMINI_PASS: RestoreTarget = {
  provider: 'gemini',
  // The post-hoc pass reconciles a WHOLE chronicle against a whole transcript
  // in one call, so it takes the stronger tier.
  model: 'gemini-2.5-pro',
  label: 'gemini restore',
}
const OPENROUTER: RestoreTarget = {
  provider: 'openrouter',
  model: 'deepseek/deepseek-v4-pro',
  label: 'openrouter restore',
}

function hasKey(provider: CloudProvider): boolean {
  try {
    const p = getCloudProvider(provider, { geminiTier: 'auto' })
    return (p as { hasKey?: () => boolean }).hasKey?.() ?? false
  } catch {
    return false
  }
}

export type RestoreKind = 'in-run' | 'pass'

/**
 * Resolve who repairs a refused chunk.
 *
 * `prefer` is what a routing preset asks for; availability is what actually
 * decides. Preferring OpenRouter and having no OpenRouter key falls back to
 * Gemini rather than failing, and vice versa — a repair that cannot run is
 * the one outcome worse than a repair on the second-choice model.
 */
export function resolveRestoreTarget(
  kind: RestoreKind,
  prefer: 'gemini' | 'openrouter' = 'gemini',
): RestoreTarget | null {
  const gemini = kind === 'in-run' ? GEMINI_INRUN : GEMINI_PASS
  const first = prefer === 'openrouter' ? OPENROUTER : gemini
  const second = prefer === 'openrouter' ? gemini : OPENROUTER
  if (hasKey(first.provider)) return first
  if (hasKey(second.provider)) return second
  return null
}

/** True iff any provider can repair a refusal. */
export function restoreAvailable(prefer: 'gemini' | 'openrouter' = 'gemini'): boolean {
  return resolveRestoreTarget('pass', prefer) !== null
}
