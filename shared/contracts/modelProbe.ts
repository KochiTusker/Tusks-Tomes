// The per-key model availability cache: what the probe wrote and what the
// model picker reads, as sent over /api/model-probe.
import type { GeminiModelTier } from '../models/geminiTier.js'

/** Single per-model probe result. */
export type ProbeEntry = {
  id: string
  /** True iff the 1-token generateContent succeeded. */
  accessible: boolean
  /** Gemini capability tier, stamped at probe time so the picker can group
   *  the dropdown without re-deriving it client-side. Absent for non-Gemini
   *  entries, whose ids carry no parseable tier, and on Gemini entries
   *  written by a server build older than tier stamping: callers must fall
   *  back to classifying the id themselves. */
  tier?: GeminiModelTier
  /** Human-readable failure cause when accessible=false. Stable enough for
   *  the UI to switch on (e.g. "Free tier quota: 0" → grey out with
   *  "Paid only" chip). */
  reason?: string
  /** Round-trip latency for the probe call, ms. Diagnostic only. */
  latencyMs?: number
}

export type SlotAvailability = {
  /** ISO timestamp when this probe ran. UI can show "Probed 12 minutes ago". */
  fetchedAt: string
  /** Short SHA-256 prefix of the key that produced this probe. Lets the UI
   *  detect when two slots accidentally hold identical key strings (one
   *  cause of "probes returned the same result for paid and free"). */
  keyFingerprint?: string
  /** Every model id the key's /v1beta/models endpoint advertised (regardless
   *  of whether we probed it). Includes embedding / specialty models the
   *  text pipeline never uses but the Settings UI may want to show. */
  advertised: string[]
  /** Per-model probe outcome for the subset we actually tested. The picker
   *  uses `accessible: true` entries as the dropdown source. */
  probed: ProbeEntry[]
}

/** What the availability cache is keyed on: the server keystore slots, plus
 *  `claudeCode`, a virtual slot the server fills from the OpenRouter catalogue
 *  (no key, never probed). */
export type AvailabilitySlot = 'gemini' | 'geminiFallback' | 'openrouter' | 'claudeCode'

/** The key set is a type parameter: the server's keystore still has slots for
 *  the retired providers, the client only sees the current ones. */
export type AvailabilityCache<K extends string = AvailabilitySlot> = Partial<Record<K, SlotAvailability>>
