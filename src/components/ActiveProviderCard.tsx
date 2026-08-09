// Step 2 of the Settings flow: pick which configured cloud API key drives
// the pipeline by default. This replaces the run-start ProviderSelectModal;
// the Chronicle tab now just reads what's saved here.
//
// Disabled (with a hint) when no cloud key is configured yet — the API
// Keys card sits above this, so the user knows where to go. Subscribes to
// the providers summary so adding a key in step 1 immediately lights up
// the new option here without a page refresh.

import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { GuardrailsCard } from './GuardrailsCard'
import { getRouting, putRouting, type RoutingDocument } from '@/lib/routing'
import {
  getAvailabilityCache,
  getProvidersSummary,
  subscribeProviders,
  type ProvidersSummary,
} from '@/lib/providerSettings'
import {
  listConfiguredCloudKeyOptions,
  optionFromRouting,
  type CloudKeyId,
  type CloudKeyOption,
} from '@/lib/cloudKeys'
import { getProfiles, putProfiles } from '@/lib/profiles'
import { sanitizeGeminiProfile } from '@/lib/profileSanitizer'

export const ACTIVE_PROVIDER_CHANGED_EVENT = 'sbts:active-provider-changed'

export function emitActiveProviderChanged() {
  window.dispatchEvent(new CustomEvent(ACTIVE_PROVIDER_CHANGED_EVENT))
}

export function ActiveProviderCard() {
  const [providers, setProviders] = useState<ProvidersSummary | null>(null)
  const [routing, setRouting] = useState<RoutingDocument | null>(null)
  const [pendingId, setPendingId] = useState<CloudKeyId | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    function loadAll() {
      Promise.all([getProvidersSummary(), getRouting()])
        .then(([p, r]) => {
          if (cancelled) return
          setProviders(p)
          setRouting(r)
        })
        .catch((err) => {
          if (!cancelled) toast.error(`Failed to load active provider: ${(err as Error).message}`)
        })
    }
    loadAll()
    const unsubscribe = subscribeProviders(() => loadAll())
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const options = useMemo<CloudKeyOption[]>(
    () => listConfiguredCloudKeyOptions(providers),
    [providers]
  )

  const savedActive: CloudKeyOption | null = useMemo(() => {
    if (!routing) return null
    return optionFromRouting(options, routing.lastSelectedProvider, routing.geminiTier)
  }, [routing, options])

  const activeId: CloudKeyId | null = pendingId ?? savedActive?.id ?? options[0]?.id ?? null
  const dirty = pendingId !== null && pendingId !== savedActive?.id

  async function save() {
    if (!routing || !activeId) return
    const option = options.find((o) => o.id === activeId)
    if (!option) return
    setSaving(true)
    try {
      const next: RoutingDocument = {
        ...routing,
        lastSelectedProvider: option.provider,
        geminiTier:
          option.provider === 'gemini'
            ? option.geminiTier ?? 'auto'
            : routing.geminiTier,
      }
      const saved = await putRouting(next)
      const { warnings, ...savedDoc } = saved
      setRouting(savedDoc)
      setPendingId(null)
      if (warnings && warnings.length > 0) {
        toast.warning('Provider saved with warnings.', {
          description: warnings.join(' '),
          duration: 10_000,
        })
      }

      // Sanitize the Gemini profile if we're now on a Free / Auto tier —
      // a previously-saved paid-only model id would otherwise fail at the
      // first chunk. Probe data, when present, is the authoritative source;
      // heuristic is the fallback.
      if (option.provider === 'gemini') {
        const tier = option.geminiTier ?? 'auto'
        if (tier !== 'paid') {
          try {
            const [profilesDoc, cache] = await Promise.all([
              getProfiles(),
              getAvailabilityCache().catch(() => ({} as Awaited<ReturnType<typeof getAvailabilityCache>>)),
            ])
            const freeAvail = cache.geminiFallback
            const report = sanitizeGeminiProfile(
              profilesDoc.profiles.gemini,
              tier,
              freeAvail,
            )
            if (report.changed.length > 0) {
              await putProfiles({
                ...profilesDoc,
                profiles: { ...profilesDoc.profiles, gemini: report.next },
              })
              const summary = report.changed
                .map((c) => `${c.phase.replace('Model', '')}: ${c.from} → ${c.to}`)
                .join('; ')
              toast.warning(
                `Switched to ${option.label}. Replaced paid-only models — ${summary}`,
              )
            } else if (report.unfixable.length > 0) {
              const ids = report.unfixable.map((u) => u.from).join(', ')
              toast.warning(
                `Switched to ${option.label}. ${ids} appear paid-only but no probed alternative was found — run "Probe models" in API Keys to populate the picker.`,
              )
            } else {
              toast.success(`Active provider set to ${option.label}.`)
            }
          } catch (err) {
            // Sanitization is best-effort. If profiles failed to load,
            // surface the tier change anyway — the run-time gate in
            // buildSession will catch the mismatch.
            console.warn('[ActiveProviderCard] profile sanitization failed:', err)
            toast.success(`Active provider set to ${option.label}.`)
          }
        } else {
          toast.success(`Active provider set to ${option.label}.`)
        }
      } else {
        toast.success(`Active provider set to ${option.label}.`)
      }

      emitActiveProviderChanged()
    } catch (err) {
      toast.error(`Save failed: ${(err as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle>Active Provider</CardTitle>
          <CardDescription>
            Pick which configured cloud API key the pipeline uses by default.
            Model Profiles below populates from this choice — selecting Gemini
            Free hides paid-only models entirely so you can't accidentally
            spend on the Paid key.
          </CardDescription>
        </div>
        <Button variant="default" size="sm" disabled={!dirty || saving} onClick={save}>
          <Save className="mr-2 h-4 w-4" />
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </CardHeader>
      <CardContent>
        {options.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No cloud API key configured yet. Add one in the{' '}
            <strong>API Keys</strong> card above; the options will appear here
            once a key is saved.
          </p>
        ) : (
          <div className="space-y-2">
            {options.map((option) => (
              <label
                key={option.id}
                className={`flex cursor-pointer items-center gap-3 rounded-md border p-3 text-sm transition ${
                  activeId === option.id
                    ? 'border-primary bg-accent/40'
                    : 'border-border hover:bg-accent/20'
                }`}
              >
                <input
                  type="radio"
                  name="active-cloud-key"
                  checked={activeId === option.id}
                  onChange={() => setPendingId(option.id)}
                />
                <div>
                  <div className="font-medium">{option.label}</div>
                  {option.id === 'gemini-free' && (
                    <p className="text-xs text-muted-foreground">
                      Free-tier key only. Paid-only Gemini models won't appear
                      in the Model Profiles dropdown when this is active.
                    </p>
                  )}
                  {option.id === 'gemini-paid' && (
                    <p className="text-xs text-muted-foreground">
                      Billing-enabled key. All Gemini models — including
                      gemini-3.x — are available.
                    </p>
                  )}
                </div>
              </label>
            ))}
          </div>
        )}
        {dirty && (
          <p className="mt-3 text-xs text-amber-600 dark:text-amber-400">
            Unsaved change — click Save to apply. Until saved, the pipeline
            continues to use the previous active provider.
          </p>
        )}
        {options.length > 0 && (
          <p className="mt-3 text-xs text-muted-foreground">
            Want to mix providers across phases (e.g. Free Flash for
            grounding, Paid Pro for the chronicle, or all-free)?{' '}
            <button
              type="button"
              className="font-medium text-primary underline-offset-2 hover:underline"
              onClick={() => {
                const target = document.getElementById('hybrid-routing')
                if (target instanceof HTMLDetailsElement) target.open = true
                target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }}
            >
              Customise per-phase routing →
            </button>
          </p>
        )}
        <GuardrailsCard />
      </CardContent>
    </Card>
  )
}
