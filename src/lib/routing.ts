// React-side client for /api/routing.
//
// Per-phase routing now carries an explicit (provider, tier, model) tuple so
// users can mix cloud keys across phases — e.g. Claude on phase 1, Gemini
// Paid on phase 3, OpenAI on phase 4. Local routing keeps its existing
// (modelId, baseUrl) shape and lights up only when the local-llm-addon is
// loaded. Entries with `cloudProvider === undefined` fall back to the
// document-level `lastSelectedProvider` + `geminiTier` ("inherit default").

import type { CloudProvider } from './profiles'

export type GeminiTier = 'paid' | 'free' | 'auto'

export type PhaseRouteEntry =
  | {
      target: 'cloud'
      /** When undefined, inherit lastSelectedProvider. */
      cloudProvider?: CloudProvider
      /** Only meaningful when cloudProvider === 'gemini'. */
      geminiTier?: GeminiTier
      /** When undefined, inherit the provider's profile model for this phase. */
      modelId?: string
    }
  | { target: 'local'; modelId: string; baseUrl?: string }

export type RoutingDocument = {
  version: 1 | 2 | 3
  lastSelectedProvider: CloudProvider | null
  geminiTier?: GeminiTier
  perPhase?: {
    phase1?: PhaseRouteEntry
    phase2?: PhaseRouteEntry
    phase3?: PhaseRouteEntry
    phase4?: PhaseRouteEntry
    phase6?: PhaseRouteEntry
  }
}

/** Mirrors server/api/routing.ts:RoutingValidationError. The server returns
 *  this shape on HTTP 400 when strict PUT validation rejects a field. */
export interface RoutingValidationError extends Error {
  /** Which field failed validation (e.g. 'lastSelectedProvider'). */
  field?: string
  /** Allowed values for the field, when enumerable. */
  allowedValues?: readonly (string | number | null)[]
  /** The offending value (for diagnose-bundle capture). */
  received?: unknown
  /** Original HTTP status — currently always 400 for validation. */
  status?: number
}

/** Successful PUT response. `warnings` carries soft-failure messages
 *  (e.g. unknown modelId) that the UI surfaces as toasts but didn't
 *  block the save. */
export type PutRoutingResponse = RoutingDocument & { warnings?: string[] }

export async function getRouting(): Promise<RoutingDocument> {
  const res = await fetch('/api/routing')
  if (!res.ok) throw new Error(`GET /api/routing failed: HTTP ${res.status}`)
  return (await res.json()) as RoutingDocument
}

export async function putRouting(doc: RoutingDocument): Promise<PutRoutingResponse> {
  const res = await fetch('/api/routing', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(doc),
  })
  if (!res.ok) {
    // Try to parse the structured 400 body first so the toast can name
    // the offending field. Falls back to text-snippet if the body isn't
    // valid JSON (e.g. 500 from an unexpected throw).
    const text = await res.text().catch(() => '')
    type ServerErrorBody = {
      error?: string
      field?: string
      allowedValues?: readonly (string | number | null)[]
      received?: unknown
    }
    let parsed: ServerErrorBody | null = null
    try {
      parsed = text ? (JSON.parse(text) as ServerErrorBody) : null
    } catch {
      parsed = null
    }
    const message =
      parsed && typeof parsed.error === 'string'
        ? `PUT /api/routing failed: HTTP ${res.status}. ${parsed.error}`
        : `PUT /api/routing failed: HTTP ${res.status}. ${text.slice(0, 300)}`
    const err = new Error(message) as RoutingValidationError
    err.status = res.status
    if (parsed) {
      err.field = parsed.field
      err.allowedValues = parsed.allowedValues
      err.received = parsed.received
    }
    throw err
  }
  return (await res.json()) as PutRoutingResponse
}
