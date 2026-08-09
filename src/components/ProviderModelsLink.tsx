// Compact "Provider & models" link rendered in the app header (top-right)
// and at the bottom of the refinement pipeline. Replaces the ModelDiagnostics
// dialog trigger so there's exactly one source of truth for provider /
// tier / model selection: the Settings tab.
//
// Before this component existed, the same button opened a full picker modal
// whose state could drift from what Settings showed (different stale-cache
// behaviour, different filter logic). Users reported "the Provider & models
// menu shows different model availability to Settings" — this link is the
// fix: clicking it now navigates to Settings, where ProviderSettings /
// ActiveProviderCard / ModelProfileEditor are the canonical UI.

import { useEffect, useState } from 'react'
import { Cog } from 'lucide-react'
import { Button } from '@/components/ui/button'
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
import { getRouting } from '@/lib/routing'
import { SWITCH_TAB_EVENT } from './ActiveProviderBanner'
import { ACTIVE_PROVIDER_CHANGED_EVENT } from './ActiveProviderCard'

export function ProviderModelsLink() {
  const [active, setActive] = useState<CloudKeyOption | null>(null)
  const [hasAnyKey, setHasAnyKey] = useState<boolean>(false)

  useEffect(() => {
    let cancelled = false
    function load() {
      Promise.all([getProvidersSummary(), getRouting()])
        .then(([summary, routing]: [ProvidersSummary, Awaited<ReturnType<typeof getRouting>>]) => {
          if (cancelled) return
          const opts = listConfiguredCloudKeyOptions(summary)
          setHasAnyKey(opts.length > 0)
          const match = optionFromRouting(opts, routing.lastSelectedProvider, routing.geminiTier)
          setActive(match ?? opts[0] ?? null)
        })
        .catch(() => {
          if (!cancelled) {
            setActive(null)
            setHasAnyKey(false)
          }
        })
    }
    load()
    const unsub = subscribeProviders(load)
    const onActive = () => load()
    window.addEventListener(ACTIVE_PROVIDER_CHANGED_EVENT, onActive)
    return () => {
      cancelled = true
      unsub()
      window.removeEventListener(ACTIVE_PROVIDER_CHANGED_EVENT, onActive)
    }
  }, [])

  function open() {
    window.dispatchEvent(new CustomEvent(SWITCH_TAB_EVENT, { detail: { tab: 'settings' } }))
  }

  const label = !hasAnyKey
    ? 'Provider & models'
    : active
      ? `Provider & models · ${active.label}`
      : 'Provider & models'

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={open}
      className="text-xs"
      title="Open Settings to change provider, tier, and per-phase models."
    >
      <Cog className="mr-1 h-3.5 w-3.5" />
      {label}
    </Button>
  )
}
