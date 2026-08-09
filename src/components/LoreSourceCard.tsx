// Unified "Lore Source" control at the top of the Tome of Lore tab. Shows which
// source grounds chronicles right now — the Tusks-Lore folder or a read-only
// Obsidian vault — and, when the Obsidian add-on is loaded, lets the user switch
// between them in one place. The detailed vault config (path, readiness, Mode-B,
// graphify) stays in Settings; this card and the Settings panel both POST the
// same /api/obsidian/config and refresh the shared lore-documents cache, so they
// stay in sync.

import { useCallback, useState } from 'react'
import { BookMarked, FolderTree } from 'lucide-react'
import { toast } from 'sonner'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useAddons } from '@/contexts/AddonContext'
import { refreshLoreDocuments, useLoreDocuments } from '@/hooks/useLoreDocuments'
import { SWITCH_TAB_EVENT } from '@/components/ActiveProviderBanner'

export function LoreSourceCard() {
  const { isLoaded } = useAddons()
  const obsidianLoaded = isLoaded('obsidian-vault-addon')
  const lore = useLoreDocuments()
  const [busy, setBusy] = useState(false)

  const onObsidian = lore.source === 'obsidian-vault'

  // POST the same config endpoint the Settings panel uses, then refresh the
  // shared cache so every surface (this card, the KB view, Settings) re-syncs.
  const setSource = useCallback(
    async (next: 'tusks-lore' | 'obsidian-vault') => {
      if (busy) return
      if (next === 'obsidian-vault' && onObsidian) return
      if (next === 'tusks-lore' && !onObsidian) return
      setBusy(true)
      try {
        // Read the saved vault config so we preserve vaultPath/modeB.
        const statusRes = await fetch('/api/obsidian/status')
        const cfg = statusRes.ok
          ? ((await statusRes.json()) as { vaultPath: string; modeB: boolean })
          : { vaultPath: '', modeB: false }

        if (next === 'obsidian-vault') {
          if (!cfg.vaultPath) {
            toast.info('Set your Obsidian vault path in Settings first, then switch here.')
            window.dispatchEvent(new CustomEvent(SWITCH_TAB_EVENT, { detail: { tab: 'settings' } }))
            return
          }
          const ok = window.confirm(
            'Use your Obsidian vault for grounding instead of the Tusks-Lore folder?\n\nYour Tusks-Lore folder stays on disk, untouched — switch back anytime.',
          )
          if (!ok) return
        }

        const res = await fetch('/api/obsidian/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            enabled: next === 'obsidian-vault',
            vaultPath: cfg.vaultPath,
            modeB: cfg.modeB,
          }),
        })
        const body = await res.json()
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
        await refreshLoreDocuments()
        toast.success(
          next === 'obsidian-vault'
            ? 'Lore source: Obsidian Vault (read-only).'
            : 'Lore source: Tusks-Lore folder.',
        )
      } catch (err) {
        toast.error(`Couldn't switch lore source: ${(err as Error).message}`)
      } finally {
        setBusy(false)
      }
    },
    [busy, onObsidian],
  )

  // Without the Obsidian add-on there's nothing to switch between — show the
  // single active source (Tusks-Lore) so the card stays informative, not a
  // dead toggle.
  if (!obsidianLoaded) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FolderTree className="h-5 w-5 text-amber-500" />
            Lore Source — Tusks-Lore folder
          </CardTitle>
          <CardDescription>
            Chronicles are grounded against your Tusks-Lore folder
            {lore.loreRoot ? (
              <>
                {' '}(<code>{lore.loreRoot}</code>)
              </>
            ) : null}
            . Want to ground against an Obsidian vault instead? Enable the Obsidian Vault Lore add-on
            in Settings → Add-ons.
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BookMarked className="h-5 w-5 text-amber-500" />
          Lore Source
        </CardTitle>
        <CardDescription>
          Choose which source grounds your chronicles. Everything below reflects the active source.
          Configure the vault path, readiness, and Mode-B in Settings → Obsidian Vault Lore.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div
          role="radiogroup"
          aria-label="Active lore source"
          className="inline-flex rounded-md border border-border bg-muted/40 p-0.5"
        >
          <button
            type="button"
            role="radio"
            aria-checked={!onObsidian}
            disabled={busy}
            onClick={() => void setSource('tusks-lore')}
            className={`inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium transition-colors ${
              !onObsidian ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <FolderTree className="h-3.5 w-3.5" /> Tusks-Lore folder
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={onObsidian}
            disabled={busy}
            onClick={() => void setSource('obsidian-vault')}
            className={`inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium transition-colors ${
              onObsidian ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <BookMarked className="h-3.5 w-3.5" /> Obsidian vault
          </button>
        </div>
        <p className="text-xs text-muted-foreground">
          {onObsidian ? (
            <>
              Active: <strong>Obsidian Vault</strong> (read-only). The Tusks-Lore folder is on standby
              and not used for grounding or processing.
            </>
          ) : (
            <>
              Active: <strong>Tusks-Lore folder</strong>. Your Obsidian vault is configured but not in
              use.
            </>
          )}
        </p>
      </CardContent>
    </Card>
  )
}
