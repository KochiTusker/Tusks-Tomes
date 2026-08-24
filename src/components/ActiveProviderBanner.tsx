// Compact pill above the Chronicle controls that surfaces which Active
// Provider the next run will use. Clicking "change" switches to the
// Settings tab and fires sbts:open-doc so the user lands on the right
// card. Replaces the run-start ProviderSelectModal.

import { useEffect, useMemo, useState } from 'react'
import { getRouting } from '@/lib/routing'
import {
  getProvidersSummary,
  subscribeProviders,
  type ProvidersSummary,
} from '@/lib/providerSettings'
import {
  listConfiguredCloudKeyOptions,
  optionFromRouting,
  type CloudKeyOption,
} from '@/lib/cloudKeys'
import { ACTIVE_PROVIDER_CHANGED_EVENT, SWITCH_TAB_EVENT } from '@/lib/appEvents'

export function ActiveProviderBanner() {
  const [providers, setProviders] = useState<ProvidersSummary | null>(null)
  const [active, setActive] = useState<CloudKeyOption | null>(null)
  // Distinguishes "first fetch hasn't resolved yet" (don't render anything)
  // from "fetch resolved and the user really has no keys configured" (show
  // the destructive banner). Without this, the banner flashes the
  // "No cloud API key configured" warning for ~half a second on every
  // page load, even when the user has perfectly good keys in their .env.
  // Preship-2026-05-28 Playwright pass caught the flicker.
  const [hasLoaded, setHasLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    function loadAll() {
      Promise.all([getProvidersSummary(), getRouting()])
        .then(([p, r]) => {
          if (cancelled) return
          setProviders(p)
          const opts = listConfiguredCloudKeyOptions(p)
          const match = optionFromRouting(opts, r.lastSelectedProvider, r.geminiTier)
          setActive(match ?? opts[0] ?? null)
          setHasLoaded(true)
        })
        .catch(() => {
          if (!cancelled) {
            setProviders(null)
            setActive(null)
            // Treat fetch failure as "fully loaded with no providers" —
            // the error banner is more useful than rendering nothing
            // forever when /api/providers is down.
            setHasLoaded(true)
          }
        })
    }
    loadAll()
    const unsub = subscribeProviders(() => loadAll())
    const onActive = () => loadAll()
    window.addEventListener(ACTIVE_PROVIDER_CHANGED_EVENT, onActive)
    return () => {
      cancelled = true
      unsub()
      window.removeEventListener(ACTIVE_PROVIDER_CHANGED_EVENT, onActive)
    }
  }, [])

  const options = useMemo(
    () => listConfiguredCloudKeyOptions(providers),
    [providers]
  )

  function jumpToSettings() {
    window.dispatchEvent(new CustomEvent(SWITCH_TAB_EVENT, { detail: { tab: 'settings' } }))
  }

  // First render: providers fetch hasn't resolved. Render nothing rather
  // than flashing the "no key configured" warning at users who have keys.
  if (!hasLoaded) return null

  if (options.length === 0) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs">
        <span>
          <strong className="text-destructive">No cloud API key configured.</strong>{' '}
          Add one in Settings to start running the pipeline.
        </span>
        <button
          type="button"
          onClick={jumpToSettings}
          className="font-medium text-destructive underline-offset-2 hover:underline"
        >
          Open Settings →
        </button>
      </div>
    )
  }

  if (!active) return null

  return (
    <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-card/60 px-3 py-2 text-xs">
      <span>
        Running with <strong>{active.label}</strong>
        {options.length > 1 && (
          <span className="ml-2 text-muted-foreground">
            ({options.length} keys configured)
          </span>
        )}
      </span>
      <button
        type="button"
        onClick={jumpToSettings}
        className="font-medium text-primary underline-offset-2 hover:underline"
      >
        Change in Settings →
      </button>
    </div>
  )
}
