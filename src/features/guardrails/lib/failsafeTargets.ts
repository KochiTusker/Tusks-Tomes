// The models a refused chunk can be repaired on: the choices the Claude Code
// failsafe setting offers, and the default it starts from.
import { GEMINI_FLASH, OPENROUTER_DEEPSEEK_V4_PRO } from '@shared/models/catalogue'

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
    modelId: GEMINI_FLASH,
    label: 'Gemini Flash — your Gemini key',
    why: 'Cheap, and a repair only ever redoes the chunks that refused. Sends BLOCK_NONE on all four harm categories.',
  },
  {
    provider: 'openrouter',
    modelId: OPENROUTER_DEEPSEEK_V4_PRO,
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
