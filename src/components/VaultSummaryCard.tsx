// Read-only summary of the active Obsidian vault, shown in the Tome of Lore tab
// IN PLACE OF the Tusks-Lore Knowledge Base manager whenever the vault is the
// active lore source. Makes it unmistakable that grounding reads the vault
// (read-only) and the Tusks-Lore folder is on standby — there are deliberately
// no upload/delete/convert affordances here.
//
// When BOTH the Obsidian and Claude Code add-ons are loaded, it also offers the
// one-click "Generate CLAUDE.md for your vault" navigation-guide write.

import { useCallback, useEffect, useState } from 'react'
import { BookMarked, CheckCircle2, FileText, FolderTree, RefreshCw, Settings2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useAddons } from '@/contexts/AddonContext'
import { refreshLoreDocuments } from '@/hooks/useLoreDocuments'
import { SWITCH_TAB_EVENT } from '@/components/ActiveProviderBanner'

type ObsidianStatus = {
  enabled: boolean
  vaultPath: string
  modeB: boolean
  vaultExists: boolean
  entityIndexExists: boolean
  claudeMdPresent: boolean
  entityCount: number | null
  indexCachedAt: string | null
}

function fmtWhen(iso: string | null): string {
  if (!iso) return 'not yet indexed'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? 'unknown' : d.toLocaleString()
}

export function VaultSummaryCard() {
  const { isLoaded } = useAddons()
  const claudeCodeLoaded = isLoaded('claude-code-addon')
  const [status, setStatus] = useState<ObsidianStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch('/api/obsidian/status')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setStatus((await res.json()) as ObsidianStatus)
    } catch (err) {
      setError((err as Error).message)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const reindex = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/obsidian/reindex', { method: 'POST' })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      toast.success(`Reindexed vault — ${body.entityCount} entities.`)
      await refresh()
      await refreshLoreDocuments()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }, [refresh])

  const generateClaudeMd = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const send = (overwrite: boolean) =>
        fetch('/api/obsidian/generate-claude-md', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ overwrite }),
        })
      let res = await send(false)
      if (res.status === 409) {
        const body = (await res.json()) as { existingPreview?: string }
        const preview = (body.existingPreview ?? '').slice(0, 600)
        const ok = window.confirm(
          `A CLAUDE.md already exists in this vault:\n\n${preview}\n\nReplace it with a freshly generated navigation guide?`,
        )
        if (!ok) {
          setBusy(false)
          return
        }
        res = await send(true)
      }
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      toast.success(
        body.replaced ? 'Replaced CLAUDE.md in your vault.' : 'Generated CLAUDE.md in your vault.',
      )
      await refresh()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }, [refresh])

  const openSettings = useCallback(() => {
    window.dispatchEvent(new CustomEvent(SWITCH_TAB_EVENT, { detail: { tab: 'settings' } }))
  }, [])

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2">
              <BookMarked className="h-5 w-5 text-amber-500" />
              Knowledge Base — Obsidian Vault (read-only)
            </CardTitle>
            <CardDescription>
              Grounding and the chronicle Knowledge Base are read from your Obsidian vault. The
              Tusks-Lore folder is on standby and not used while this source is active. Tusk's Tomes
              never writes into the vault (except the explicit actions below). Edit your lore in
              Obsidian; switch back to Tusks-Lore from the Lore Source card above.
            </CardDescription>
          </div>
          <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={busy} aria-label="Refresh vault status">
            <RefreshCw className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {error && <p className="text-destructive text-xs">Error: {error}</p>}

        {status && (
          <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <dt className="font-medium">Vault path</dt>
            <dd className="break-all">
              <code>{status.vaultPath || '(none set)'}</code>
            </dd>
            <dt className="font-medium">Entities</dt>
            <dd>{status.entityCount != null ? `${status.entityCount} indexed` : 'not yet indexed'}</dd>
            <dt className="font-medium">Index source</dt>
            <dd>{status.entityIndexExists ? 'curated _system/entity-index.json' : 'note frontmatter (walked)'}</dd>
            <dt className="font-medium">Last indexed</dt>
            <dd>{fmtWhen(status.indexCachedAt)}</dd>
            {status.modeB && (
              <>
                <dt className="font-medium">Mode-B</dt>
                <dd className="inline-flex items-center gap-1 text-green-600 dark:text-green-400">
                  <CheckCircle2 className="h-3 w-3" /> relationship enrichment on
                </dd>
              </>
            )}
          </dl>
        )}

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={() => void reindex()} disabled={busy || !status?.vaultExists}>
            <RefreshCw className="mr-1 h-3.5 w-3.5" /> Reindex vault
          </Button>
          {claudeCodeLoaded && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void generateClaudeMd()}
              disabled={busy || !status?.vaultExists}
              title="Writes a CLAUDE.md navigation guide into your vault so Claude Code can navigate it"
            >
              <FileText className="mr-1 h-3.5 w-3.5" />
              {status?.claudeMdPresent ? 'Regenerate CLAUDE.md' : 'Generate CLAUDE.md for your vault'}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={openSettings}>
            <Settings2 className="mr-1 h-3.5 w-3.5" /> Configure in Settings
          </Button>
        </div>

        {claudeCodeLoaded && (
          <p className="text-xs text-muted-foreground">
            <FolderTree className="mr-1 inline h-3 w-3" />
            CLAUDE.md is a navigation guide derived from your vault's folders, entity types, and
            frontmatter — it helps Claude Code (and you) navigate the vault. Tusk's Tomes still reads
            the vault directly; this file is for your own Claude Code sessions.
          </p>
        )}

        <p className="rounded-md border border-border bg-muted/40 p-2 text-xs text-muted-foreground">
          The Glossary and Speaker mappings below apply to <strong>every</strong> lore source,
          including this vault — they run before AI grounding regardless of which source is active.
        </p>
      </CardContent>
    </Card>
  )
}
