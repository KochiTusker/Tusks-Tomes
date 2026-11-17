// React-side client for /api/providers (encrypted keystore summary + edits).
// Doesn't expose the raw keys — the bundle is fetched separately by
// `providers/index.ts` on init, never by UI code.

import { apiJson } from '@/platform/apiClient'
import type {
  AvailabilityCache,
  AvailabilitySlot,
  SlotAvailability,
} from '@shared/contracts/modelProbe'

export type ProviderName = 'gemini' | 'geminiFree' | 'openrouter'

export type ProvidersSummary = {
  configured: Array<
    'gemini' | 'geminiFallback' | 'claudeCode' | 'codex' | 'openrouter'
  >
  hasFallback: { gemini: boolean }
}

const listeners = new Set<() => void>()

export function subscribeProviders(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function emit(): void {
  for (const l of listeners) l()
}

export async function getProvidersSummary(): Promise<ProvidersSummary> {
  return apiJson<ProvidersSummary>('/api/providers', { errorMode: 'status' })
}

export async function putProviderKey(name: ProviderName, key: string): Promise<ProvidersSummary> {
  const summary = await apiJson<ProvidersSummary>(`/api/providers/${name}`, {
    method: 'PUT',
    body: { key },
    errorMode: 'text',
    bodySlice: 300,
  })
  emit()
  return summary
}

export async function deleteProviderKey(name: ProviderName): Promise<ProvidersSummary> {
  const summary = await apiJson<ProvidersSummary>(`/api/providers/${name}`, {
    method: 'DELETE',
    errorMode: 'text',
    bodySlice: 300,
  })
  emit()
  return summary
}

export async function testProviderKey(name: ProviderName): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`/api/providers/${name}/test`, { method: 'POST' })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    return { ok: false, error: `HTTP ${res.status}: ${body.slice(0, 300)}` }
  }
  return (await res.json()) as { ok: boolean; error?: string }
}

// --- Per-key model availability (probe cache) --------------------------------

export type { AvailabilityCache, AvailabilitySlot, SlotAvailability }

/** Map a user-facing provider name to the server-side keystore slot. The
 *  picker UI thinks in `geminiFree`; the cache file thinks in `geminiFallback`. */
export function slotForProvider(name: ProviderName): AvailabilitySlot {
  return name === 'geminiFree' ? 'geminiFallback' : name
}

/** Event dispatched on `window` after a probe completes (success OR a
 *  graceful 200-with-`ok:false` error response) so any subscriber can
 *  refetch the availability cache. The detail carries the slot that was
 *  probed so consumers can do a targeted refresh, but the default
 *  consumer (`useAvailabilityCache`) just refetches the whole thing.
 *
 *  Why a `window` CustomEvent instead of the existing `subscribeProviders`
 *  listener set: cross-cutting components (HybridRoutingEditor,
 *  ModelProfileEditor) live in different parts of the tree and need to
 *  refresh on probe completion without prop-drilling. The window-event
 *  pattern is the same one used by VERBOSE_CHANGED_EVENT in verboseLog.ts
 *  and ACTIVE_PROVIDER_CHANGED_EVENT in ActiveProviderCard.tsx. */
export const PROBE_COMPLETED_EVENT = 'sbts:probe-completed'

export type ProbeCompletedDetail = {
  slot: AvailabilitySlot
  /** True when the probe call itself succeeded (regardless of how many
   *  individual model probes within it came back inaccessible). */
  ok: boolean
}

export async function probeProviderKey(
  name: ProviderName,
): Promise<{ ok: boolean; availability?: SlotAvailability; error?: string }> {
  const res = await fetch(`/api/providers/${name}/probe`, { method: 'POST' })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    // Even on a network/HTTP failure, fire the event so consumers can
    // re-render the (unchanged) cache — keeps the UI honest about the
    // attempt without forcing them to track HTTP outcomes themselves.
    dispatchProbeCompleted({ slot: slotForProvider(name), ok: false })
    return { ok: false, error: `HTTP ${res.status}: ${body.slice(0, 300)}` }
  }
  const json = (await res.json()) as {
    ok: boolean
    availability?: SlotAvailability
    error?: string
  }
  // Fire after the server response lands. Subscribers fetch the latest
  // cache themselves; they don't read the event's detail beyond `slot`.
  dispatchProbeCompleted({ slot: slotForProvider(name), ok: json.ok })
  return json
}

/** Helper — kept private to enforce that probe completion fires only from
 *  here. Tests can import `PROBE_COMPLETED_EVENT` and listen for it. */
function dispatchProbeCompleted(detail: ProbeCompletedDetail): void {
  if (typeof window === 'undefined') return
  try {
    window.dispatchEvent(new CustomEvent(PROBE_COMPLETED_EVENT, { detail }))
  } catch {
    /* swallow — diagnostic-only signal */
  }
}

export async function getAvailabilityCache(): Promise<AvailabilityCache> {
  return apiJson<AvailabilityCache>('/api/providers/availability', { errorMode: 'status' })
}
