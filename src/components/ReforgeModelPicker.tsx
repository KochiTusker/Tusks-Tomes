// Reforge model picker — a modal that asks which provider + model to reforge
// on before the run starts. Sources its provider list from the configured
// cloud keys (Gemini paid/free, Claude, OpenAI) and its per-provider model
// list from the same probe-availability cache the routing + profile editors
// use, so the three surfaces never disagree about what's accessible.
//
// Claude Code is intentionally excluded: reforge exists to redo work that the
// Claude Code subscription refused or underperformed on, so reforging back
// onto it defeats the purpose. (The API-key Claude provider is still offered.)
//
// The chosen model also drives chunk sizing downstream — a fast-tier id
// (Gemini Flash-Lite, Claude Haiku, OpenAI -mini/-nano) classifies as `:fast`
// and automatically gets the smaller chunk row, so the model has room to both
// hold the context and emit a full-length output.

import { useEffect, useMemo, useState } from 'react'
import { Wand2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { useAvailabilityCache } from '@/hooks/useAvailabilityCache'
import { fetchConfiguredCloudKeyOptions, type CloudKeyOption } from '@/lib/cloudKeys'
import { availableModelsFor, groupModels, hasUnverified } from '@/lib/availableModels'
import { classifyModelTier } from '@/lib/modelTier'
import type { GeminiTier } from '@/lib/providers'
import type { CloudProvider } from '@/lib/profiles'

export type ReforgeModelChoice = {
  provider: CloudProvider
  model: string
  /** Only meaningful when provider === 'gemini'. */
  geminiTier: GeminiTier
  /** For the run summary / label. */
  label: string
}

type Props = {
  open: boolean
  onCancel: () => void
  onConfirm: (choice: ReforgeModelChoice) => void
}

const TIER_NOTE: Record<string, string> = {
  fast: 'Fast tier — cheaper and quicker; chunking auto-shrinks so it keeps context and still writes full-length output.',
  flagship: 'Flagship tier — the strongest quality / largest chunks.',
  frontier: 'Frontier tier — top quality (slower, pricier).',
}

export function ReforgeModelPicker({ open, onCancel, onConfirm }: Props) {
  const { cache } = useAvailabilityCache()
  const [options, setOptions] = useState<CloudKeyOption[]>([])
  const [optId, setOptId] = useState('')
  const [model, setModel] = useState('')

  // Load the configured providers when the dialog opens. Exclude Claude Code.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void fetchConfiguredCloudKeyOptions()
      .then((opts) => {
        if (cancelled) return
        const usable = opts.filter((o) => o.provider !== 'claudeCode' && o.provider !== 'codex')
        setOptions(usable)
        // Default selection: prefer paid Gemini, else the first option.
        const preferred = usable.find((o) => o.id === 'gemini-paid') ?? usable[0]
        if (preferred) setOptId(preferred.id)
      })
      .catch(() => {
        if (!cancelled) setOptions([])
      })
    return () => {
      cancelled = true
    }
  }, [open])

  const selected = useMemo(
    () => options.find((o) => o.id === optId) ?? null,
    [options, optId],
  )

  const models = useMemo(
    () => (selected ? availableModelsFor(selected, cache) : []),
    [selected, cache],
  )

  /** Gemini splits into tier subgroups; other providers stay one flat group.
   *  The label is the plain provider name here — this picker already scopes
   *  to a single key via the selector above it, so a fingerprint suffix would
   *  just be noise. */
  const modelGroups = useMemo(
    () => (selected ? groupModels(selected, models, selected.label) : []),
    [selected, models],
  )

  // Reset the model selection to the first available whenever the provider
  // changes (or its model list resolves).
  useEffect(() => {
    if (!models.length) {
      setModel('')
      return
    }
    if (!models.some((m) => m.id === model)) setModel(models[0].id)
  }, [models, model])

  const tier = selected && model ? classifyModelTier(model, selected.provider) : null

  const confirm = () => {
    if (!selected || !model) return
    onConfirm({
      provider: selected.provider,
      model,
      geminiTier: selected.geminiTier ?? 'auto',
      label: `${selected.short} · ${model}`,
    })
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wand2 className="h-4 w-4" /> Choose a reforge model
          </DialogTitle>
          <DialogDescription>
            Pick the provider and model to reforge on. Only providers you've
            configured an API key for appear here.
          </DialogDescription>
        </DialogHeader>

        {options.length === 0 ? (
          <p className="text-sm text-amber-700 dark:text-amber-300">
            No cloud API keys configured. Add a Gemini, Claude, or OpenAI key in
            Settings → API Keys to reforge.
          </p>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="reforge-provider">Provider</Label>
              <select
                id="reforge-provider"
                className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm"
                value={optId}
                onChange={(e) => setOptId(e.target.value)}
              >
                {options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="reforge-model">Model</Label>
              {models.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No models found for this provider. Run a probe in Settings →
                  API Keys, then reopen this picker.
                </p>
              ) : (
                <select
                  id="reforge-model"
                  className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                >
                  {modelGroups.map((group) => (
                    <optgroup key={group.label} label={group.label}>
                      {group.models.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.id}
                          {m.verified ? '' : ' (unverified)'}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              )}
              {hasUnverified(models) && (
                <p className="text-xs text-muted-foreground">
                  Unverified models haven't been probe-checked — run a probe in
                  Settings → API Keys to confirm access.
                </p>
              )}
              {tier && (
                <p className="text-xs text-muted-foreground">{TIER_NOTE[tier]}</p>
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={confirm} disabled={!selected || !model}>
            <Wand2 className="mr-1 h-4 w-4" /> Reforge
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
