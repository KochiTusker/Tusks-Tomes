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

import { safeSetRaw } from './storage'

export const CLAUDE_FAILSAFE_EVENT = 'sbts:claude-failsafe-changed'

/** Where a repair runs. `provider` is the routing target; `modelId` is in
 *  that provider's own namespace. */
export interface FailsafeTarget {
  provider: 'gemini' | 'openrouter'
  modelId: string
  label: string
  /** Why this one is offered, in one line. */
  why: string
}

/**
 * The models offered for repair.
 *
 * Every entry was measured writing up a deliberately graphic passage — axe
 * wounds, a throat cut, crude sexual insults — without softening it. Nothing
 * is here on reputation, and nothing on the catalogue's moderation flag, which
 * turned out not to predict refusal at all.
 */
export const FAILSAFE_TARGETS: FailsafeTarget[] = [
  {
    provider: 'gemini',
    modelId: 'gemini-2.5-flash',
    label: 'Gemini Flash — your Gemini key',
    why: 'Cheap, and a repair only ever redoes the chunks that refused. Sends BLOCK_NONE on all four harm categories.',
  },
  {
    provider: 'openrouter',
    modelId: 'deepseek/deepseek-v4-pro',
    label: 'DeepSeek V4 Pro — OpenRouter',
    why: 'The best non-Gemini chronicle model graded, on a provider carrying no prompt-level moderation filter at all.',
  },
  {
    provider: 'openrouter',
    modelId: 'x-ai/grok-4.20',
    label: 'Grok 4.20 — OpenRouter',
    why: 'Kept every violent detail and expletive intact when measured. Fast and cheap for a per-chunk repair.',
  },
  {
    provider: 'openrouter',
    modelId: 'moonshotai/kimi-k2.6',
    label: 'Kimi K2.6 — OpenRouter',
    why: 'Unmoderated and strong on prose, but slow — around five minutes for a single chunk.',
  },
  {
    provider: 'openrouter',
    modelId: 'z-ai/glm-4.7',
    label: 'GLM 4.7 — OpenRouter',
    why: 'Unmoderated, inexpensive, and measured carrying the same passage without complaint.',
  },
]

/** The default: Gemini, matching the behaviour this had before it was a choice. */
export const DEFAULT_FAILSAFE_TARGET = FAILSAFE_TARGETS[0]

/**
 * Which model repairs a refused chunk.
 *
 * Falls back to the default when the stored id is one this build no longer
 * offers — a model can leave a catalogue between releases, and a stale
 * preference must not silently disable the failsafe.
 */
export function getFailsafeTarget(): FailsafeTarget {
  try {
    if (typeof localStorage === 'undefined') return DEFAULT_FAILSAFE_TARGET
    const stored = localStorage.getItem(LS_MODEL)
    return FAILSAFE_TARGETS.find((t) => t.modelId === stored) ?? DEFAULT_FAILSAFE_TARGET
  } catch {
    return DEFAULT_FAILSAFE_TARGET
  }
}

export function setFailsafeTarget(modelId: string): void {
  try {
    if (typeof localStorage === 'undefined') return
    safeSetRaw(LS_MODEL, modelId)
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(CLAUDE_FAILSAFE_EVENT, { detail: true }))
    }
  } catch {
    /* ignore */
  }
}

export function getClaudeFailsafeEnabled(): boolean {
  try {
    if (typeof localStorage === 'undefined') return false
    return localStorage.getItem(LS_KEY) === 'true'
  } catch {
    return false
  }
}

export function setClaudeFailsafeEnabled(on: boolean): void {
  try {
    if (typeof localStorage === 'undefined') return
    safeSetRaw(LS_KEY, on ? 'true' : 'false')
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(CLAUDE_FAILSAFE_EVENT, { detail: on }))
    }
  } catch {
    /* ignore */
  }
}
