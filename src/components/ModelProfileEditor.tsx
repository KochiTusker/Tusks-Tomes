// Step 3 of the Settings flow: pick which model handles each pipeline phase
// for the active provider. Hard-gated on the ActiveProviderCard above — the
// editor doesn't render its phase rows until a cloud key is selected. The
// header label includes the active key ("Models for Gemini Free") so the
// user is never unsure which tier the dropdown options come from.
//
// For Gemini Free the dropdown is filtered to free-tier-available models
// only (paid-only entries are dropped, not just badged) so you can't
// accidentally configure a phase that would silently spend on the Paid key.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import {
  getProfiles,
  putProfiles,
  type CloudProvider,
  type ProfilesDocument,
  type ProviderProfile,
} from '@/lib/profiles'
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
import {
  availableModelsFor,
  hasUnverified,
  optgroupLabel,
} from '@/lib/availableModels'
import { useAvailabilityCache } from '@/hooks/useAvailabilityCache'
import { ACTIVE_PROVIDER_CHANGED_EVENT } from './ActiveProviderCard'

const PHASE_LABELS: Array<{ key: keyof ProviderProfile; label: string }> = [
  { key: 'phase1Model', label: 'Phase 1 — Grounding' },
  { key: 'phase2Model', label: 'Phase 2 — Audit' },
  { key: 'phase3Model', label: 'Phase 3 — Chronicle' },
  { key: 'phase4Model', label: 'Phase 4 — Extras' },
]

export function ModelProfileEditor() {
  const [doc, setDoc] = useState<ProfilesDocument | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [providers, setProviders] = useState<ProvidersSummary | null>(null)
  const [activeOption, setActiveOption] = useState<CloudKeyOption | null>(null)
  // Probe-driven dropdown source. The previous direct
  // listGeminiModelAvailability + listAvailableModelsForTier paths are
  // replaced — see availableModelsFor for the precedence chain.
  // The cache auto-refreshes on key save/delete and on probe completion,
  // so every dropdown stays in sync with what the probe certified.
  const { cache: availabilityCache } = useAvailabilityCache()

  const loadAll = useCallback(() => {
    let cancelled = false
    Promise.all([getProfiles(), getRouting(), getProvidersSummary()])
      .then(([d, r, prov]) => {
        if (cancelled) return
        setDoc(d)
        setProviders(prov)
        const opts = listConfiguredCloudKeyOptions(prov)
        const match = optionFromRouting(opts, r.lastSelectedProvider, r.geminiTier)
        setActiveOption(match ?? opts[0] ?? null)
      })
      .catch((err) => {
        if (!cancelled) toast.error(`Failed to load profiles: ${(err as Error).message}`)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const cleanup = loadAll()
    const unsubscribe = subscribeProviders(() => loadAll())
    const onActive = () => loadAll()
    window.addEventListener(ACTIVE_PROVIDER_CHANGED_EVENT, onActive)
    return () => {
      cleanup()
      unsubscribe()
      window.removeEventListener(ACTIVE_PROVIDER_CHANGED_EVENT, onActive)
    }
  }, [loadAll])

  /** Dropdown options for the active provider. For Claude/OpenAI this is
   *  a single optgroup. For Gemini, the editor scopes to the active tier
   *  (Paid OR Free) — the dropdown matches exactly what the user picked
   *  in the Active Provider card, so each phase row gets a single
   *  optgroup labelled with the fingerprint of THAT tier's key.
   *
   *  Returns `{ groupLabel, models: AvailableModel[] }` so the JSX can
   *  render an `<optgroup>` and flag unverified entries the same way
   *  HybridRoutingEditor does. */
  const dropdownGroup = useMemo(() => {
    if (!activeOption) return null
    const models = availableModelsFor(activeOption, availabilityCache)
    return {
      label: optgroupLabel(activeOption, availabilityCache),
      models,
    }
  }, [activeOption, availabilityCache])

  /** True when the dropdown includes any unverified entries — drives the
   *  same inline "Run Probe in API Keys" hint as HybridRoutingEditor. */
  const dropdownHasUnverified = dropdownGroup ? hasUnverified(dropdownGroup.models) : false

  function update(provider: CloudProvider, patch: Partial<ProviderProfile>) {
    if (!doc) return
    setDoc({
      ...doc,
      profiles: {
        ...doc.profiles,
        [provider]: { ...doc.profiles[provider], ...patch },
      },
    })
    setDirty(true)
  }

  async function save() {
    if (!doc) return
    setSaving(true)
    try {
      const saved = await putProfiles(doc)
      setDoc(saved)
      setDirty(false)
      toast.success('Model profiles saved.')
    } catch (err) {
      toast.error(`Save failed: ${(err as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  const noKeysConfigured =
    providers !== null && listConfiguredCloudKeyOptions(providers).length === 0

  // Hard gate: the editor's phase rows are hidden until step 2 has a
  // selection. We keep the card visible so the user can see the gating
  // hint — disappearing UI confuses people more than a labelled empty state.
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle>
            Model Profiles
            {activeOption && (
              <span className="ml-2 rounded bg-accent/40 px-2 py-0.5 text-xs font-normal text-muted-foreground">
                Models for: {activeOption.label}
              </span>
            )}
          </CardTitle>
          <CardDescription>
            Per-phase model assignment for the active provider. The pipeline
            reads this at run start. To configure a different provider's
            profile, change the Active Provider above first — the dropdown
            options below repopulate from the selected key.
          </CardDescription>
        </div>
        <Button
          variant="default"
          size="sm"
          disabled={!dirty || saving || !activeOption}
          onClick={save}
        >
          <Save className="mr-2 h-4 w-4" />
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {noKeysConfigured ? (
          <p className="text-sm text-muted-foreground">
            Add a cloud API key above to enable per-phase model selection.
          </p>
        ) : !activeOption ? (
          <p className="text-sm text-muted-foreground">
            Pick an Active Provider above to load its phase models.
          </p>
        ) : !doc ? (
          <p className="text-sm text-muted-foreground">Loading profiles…</p>
        ) : (
          (() => {
            const provider = activeOption.provider
            const profile = doc.profiles[provider]
            return (
              <div className="space-y-4">
                {dropdownHasUnverified && (
                  <div className="rounded border border-amber-500/40 bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
                    <strong>Some model entries are unverified.</strong> The
                    dropdown shows models the provider's catalog advertises
                    but that haven't been confirmed accessible with this key.
                    Run <strong>Probe</strong> on this key in the{' '}
                    <em>API Keys</em> card above to filter the list down to
                    only models that actually work.
                  </div>
                )}
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  {PHASE_LABELS.map((row) => {
                    const value = profile[row.key] as string
                    const id = `${provider}-${row.key}`
                    const models = dropdownGroup?.models ?? []
                    // Preserve a previously-saved value even if it's not in
                    // the current dropdown (e.g. user manually entered a
                    // beta model into profiles.json). Render it as a
                    // top-level option outside the optgroup so it's still
                    // selectable.
                    const valueIsCustom =
                      !!value && !models.some((m) => m.id === value)
                    return (
                      <div key={row.key} className="space-y-1">
                        <Label htmlFor={id}>{row.label}</Label>
                        <select
                          id={id}
                          value={value}
                          onChange={(e) =>
                            update(
                              provider,
                              { [row.key]: e.target.value } as Partial<ProviderProfile>
                            )
                          }
                          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm"
                        >
                          {valueIsCustom && (
                            <option key={value} value={value}>
                              {value} (custom — not in probed list)
                            </option>
                          )}
                          {dropdownGroup && dropdownGroup.models.length > 0 && (
                            <optgroup label={dropdownGroup.label}>
                              {dropdownGroup.models.map((m) => (
                                <option key={m.id} value={m.id}>
                                  {m.id}
                                  {m.verified ? '' : ' (unverified)'}
                                </option>
                              ))}
                            </optgroup>
                          )}
                          {dropdownGroup && dropdownGroup.models.length === 0 && !valueIsCustom && (
                            <option value="" disabled>
                              No models — click Probe in API Keys to populate
                            </option>
                          )}
                        </select>
                      </div>
                    )
                  })}
                </div>

                {(provider === 'gemini' || provider === 'claude') && (
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={
                        provider === 'gemini'
                          ? !!profile.useContextCache
                          : !!profile.useCacheControl
                      }
                      onChange={(e) =>
                        update(
                          provider,
                          provider === 'gemini'
                            ? { useContextCache: e.target.checked }
                            : { useCacheControl: e.target.checked }
                        )
                      }
                    />
                    Enable prompt caching for repeated KB / glossary content
                  </label>
                )}

                {provider === 'gemini' && activeOption.geminiTier === 'free' && (
                  <p className="text-xs text-muted-foreground">
                    Only free-tier-available Gemini models are listed. Switch
                    the Active Provider above to Gemini Paid to use gemini-3.x
                    and other billing-only models.
                  </p>
                )}
              </div>
            )
          })()
        )}
      </CardContent>
    </Card>
  )
}
