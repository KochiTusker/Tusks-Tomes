// React-side client for /api/routing.
//
// Per-phase routing now carries an explicit (provider, tier, model) tuple so
// users can mix cloud keys across phases — e.g. Claude on phase 1, Gemini
// Paid on phase 3, OpenAI on phase 4. Local routing keeps its existing
// (modelId, baseUrl) shape and lights up only when the local-llm-addon is
// loaded. Entries with `cloudProvider === undefined` fall back to the
// document-level `lastSelectedProvider` + `geminiTier` ("inherit default").

import { apiJson } from '@/platform/apiClient'
import type { GeminiTier } from '@shared/contracts/providers'
import type { PhaseRouteEntry, RoutingDocument, RoutingValidationBody } from '@shared/contracts/routing'

export type { GeminiTier, PhaseRouteEntry, RoutingDocument }

/** The server's 400 body (`RoutingValidationBody`) as thrown on the client:
 *  the same fields, optional, on an Error. */
export interface RoutingValidationError extends Error, Partial<Omit<RoutingValidationBody, 'error'>> {
  /** Original HTTP status — currently always 400 for validation. */
  status?: number
}

/** Successful PUT response. `warnings` carries soft-failure messages
 *  (e.g. unknown modelId) that the UI surfaces as toasts but didn't
 *  block the save. */
export type PutRoutingResponse = RoutingDocument & { warnings?: string[] }

export async function getRouting(): Promise<RoutingDocument> {
  return apiJson<RoutingDocument>('/api/routing', { errorMode: 'status' })
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
    type ServerErrorBody = Partial<RoutingValidationBody>
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
