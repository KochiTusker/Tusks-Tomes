// The routing document and the body of its validation error, as they cross the
// wire between /api/routing and the client.
//
// The provider is a type parameter so the server can keep accepting the
// retired provider names on disk and in a request while the client only ever
// sees the current four.

import type { CloudProvider, GeminiTier } from './providers.js'

export type PhaseRouteEntry<P extends string = CloudProvider> =
  | {
      target: 'cloud'
      /** When undefined, inherit lastSelectedProvider. */
      cloudProvider?: P
      /** Only meaningful when cloudProvider === 'gemini'. */
      geminiTier?: GeminiTier
      /** When undefined, inherit the provider's profile model for this phase. */
      modelId?: string
    }
  | { target: 'local'; modelId: string; baseUrl?: string }

export type RoutingDocument<P extends string = CloudProvider> = {
  version: 1 | 2 | 3
  lastSelectedProvider: P | null
  geminiTier?: GeminiTier
  perPhase?: {
    phase1?: PhaseRouteEntry<P>
    phase2?: PhaseRouteEntry<P>
    phase3?: PhaseRouteEntry<P>
    phase4?: PhaseRouteEntry<P>
    phase6?: PhaseRouteEntry<P>
  }
}

/** Structured 400 body returned by the PUT handler when a field fails
 *  strict validation. The client toast renders `error` verbatim and the
 *  diagnose bundle captures the full body so a fresh Claude session can
 *  trace the rejected request back to its origin. */
export interface RoutingValidationBody {
  error: string
  field: string
  allowedValues?: readonly (string | number | null)[]
  received?: unknown
}
