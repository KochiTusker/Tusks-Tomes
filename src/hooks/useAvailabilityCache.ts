// Reactive subscriber for the per-key probe availability cache. Used by
// HybridRoutingEditor + ModelProfileEditor to source their model dropdowns
// directly from "what the probe certified is accessible" instead of static
// catalogs. Refetches automatically on three signals:
//
//   1. Component mount (initial fetch).
//   2. `subscribeProviders()` callback fires (key save/delete via
//      providerSettings.ts).
//   3. `PROBE_COMPLETED_EVENT` dispatched on `window` (probe finished —
//      defined in providerSettings.ts).
//
// The hook exposes the merged availability cache + a `loading` flag for
// the first-load state + a `refresh()` escape hatch for components that
// need to force a manual refetch (e.g. a "Reload availability" button).
//
// SSR-safe: returns an empty cache and skips the fetch when window is
// undefined.

import { useCallback, useEffect, useState } from 'react'
import {
  getAvailabilityCache,
  PROBE_COMPLETED_EVENT,
  subscribeProviders,
  type AvailabilityCache,
} from '@/lib/providerSettings'
import { ACTIVE_PROVIDER_CHANGED_EVENT } from '@/lib/appEvents'

export function useAvailabilityCache(): {
  cache: AvailabilityCache
  loading: boolean
  refresh: () => Promise<void>
} {
  const [cache, setCache] = useState<AvailabilityCache>({})
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const next = await getAvailabilityCache()
      setCache(next)
    } catch (err) {
      // Treat fetch failures as "we don't know anything" rather than
      // surfacing an error UI. The downstream `availableModelsFor`
      // helper falls back to the advertised list or static catalog so
      // the dropdown stays usable.
      console.warn('[useAvailabilityCache] refresh failed:', err)
      setCache({})
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') {
      setLoading(false)
      return
    }
    let cancelled = false
    // Initial fetch.
    void refresh().catch(() => {
      if (!cancelled) setLoading(false)
    })

    // Subscribe to all three signals that should invalidate the cache.
    const offProviders = subscribeProviders(() => {
      if (!cancelled) void refresh()
    })
    const onProbe = () => { if (!cancelled) void refresh() }
    const onActive = () => { if (!cancelled) void refresh() }
    window.addEventListener(PROBE_COMPLETED_EVENT, onProbe)
    window.addEventListener(ACTIVE_PROVIDER_CHANGED_EVENT, onActive)
    // Storage event picks up changes made in other tabs (Settings open
    // in a second window etc.). Mirrors the pattern in useVerboseFlag.
    const onStorage = () => { if (!cancelled) void refresh() }
    window.addEventListener('storage', onStorage)

    return () => {
      cancelled = true
      offProviders()
      window.removeEventListener(PROBE_COMPLETED_EVENT, onProbe)
      window.removeEventListener(ACTIVE_PROVIDER_CHANGED_EVENT, onActive)
      window.removeEventListener('storage', onStorage)
    }
  }, [refresh])

  return { cache, loading, refresh }
}
