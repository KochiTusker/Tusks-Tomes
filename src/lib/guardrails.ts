// User-controlled guardrail toggles applied at every cloud-provider
// generate() call. Default is all-off — matches the pre-existing pipeline
// behaviour where every phase ran with `safetyMode: 'permissive'`.
//
// Asymmetry (intentional, surfaced in the UI):
//   - The four category flags map directly to Gemini's safetySettings.
//     When `false` the category is forced to BLOCK_NONE; when `true` the
//     setting is omitted so Gemini's API default (BLOCK_MEDIUM_AND_ABOVE)
//     applies.
//   - `strictFraming` controls the TTRPG framing block that claude.ts and
//     openai.ts always prepend to the system prompt. When `false` (default)
//     the framing is sent — Claude/OpenAI preserve mature themes. When
//     `true` the framing is dropped — those providers fall back to their
//     own sanitising defaults.
//
// Claude and OpenAI do NOT expose per-category safety knobs; the category
// flags are no-ops there. The UI labels each toggle with which provider it
// actually affects.

import { safeSet } from './storage'

const LS_KEY = 'guardrails_settings'

export const GUARDRAILS_EVENT = 'sbts:guardrails-changed'

export type GuardrailsSettings = {
  /** Gemini HARM_CATEGORY_HARASSMENT. true = filter on (Gemini default), false = BLOCK_NONE. */
  harassment: boolean
  /** Gemini HARM_CATEGORY_HATE_SPEECH. */
  hateSpeech: boolean
  /** Gemini HARM_CATEGORY_SEXUALLY_EXPLICIT. */
  sexuallyExplicit: boolean
  /** Gemini HARM_CATEGORY_DANGEROUS_CONTENT. */
  dangerousContent: boolean
  /** Claude + OpenAI: when true, drop the "preserve mature themes verbatim"
   *  TTRPG framing block from the system prompt. */
  strictFraming: boolean
}

export const DEFAULT_GUARDRAILS: GuardrailsSettings = {
  harassment: false,
  hateSpeech: false,
  sexuallyExplicit: false,
  dangerousContent: false,
  strictFraming: false,
}

export type GuardrailKey = keyof GuardrailsSettings
export const GUARDRAIL_KEYS: GuardrailKey[] = [
  'harassment',
  'hateSpeech',
  'sexuallyExplicit',
  'dangerousContent',
  'strictFraming',
]

export function getGuardrails(): GuardrailsSettings {
  try {
    if (typeof localStorage === 'undefined') return DEFAULT_GUARDRAILS
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return DEFAULT_GUARDRAILS
    const parsed = JSON.parse(raw) as Partial<GuardrailsSettings>
    return {
      harassment: parsed.harassment === true,
      hateSpeech: parsed.hateSpeech === true,
      sexuallyExplicit: parsed.sexuallyExplicit === true,
      dangerousContent: parsed.dangerousContent === true,
      strictFraming: parsed.strictFraming === true,
    }
  } catch {
    return DEFAULT_GUARDRAILS
  }
}

export function setGuardrails(next: GuardrailsSettings): void {
  if (typeof localStorage === 'undefined') return
  // Same JSON format as before — but the write now goes through the
  // quota guard, so a full store surfaces a toast instead of silently
  // dropping a safety-relevant setting.
  safeSet(LS_KEY, next)
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(GUARDRAILS_EVENT, { detail: next }))
  }
}

/** Count of guardrails that are currently ON. Used for the status pill. */
export function countActiveGuardrails(g: GuardrailsSettings = getGuardrails()): number {
  return GUARDRAIL_KEYS.reduce((n, k) => n + (g[k] ? 1 : 0), 0)
}
