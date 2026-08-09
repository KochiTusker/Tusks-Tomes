// Obsidian Vault lore-source panel. Lets the user point grounding at a
// read-only Obsidian vault instead of the Tusks-Lore folder. Ships OFF —
// enabling is an explicit opt-in with a "replace Tusks-Lore?" confirmation.
//
// The grounding path is strictly read-only. The one exception is the explicit
// "Build graphify map" button, which writes graphify-out/ INTO the vault.

import { useCallback, useEffect, useState } from 'react'
import { BookMarked, CheckCircle2, FolderTree, FolderSearch, Network, RefreshCw, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { refreshLoreDocuments } from '@/hooks/useLoreDocuments'

type ObsidianStatus = {
  enabled: boolean
  vaultPath: string
  modeB: boolean
  useClaudeMdContext: boolean
  vaultExists: boolean
  entityIndexExists: boolean
  claudeMdPresent: boolean
  entityCount: number | null
  indexCachedAt: string | null
}

type Readiness = {
  hasEntityIndex: boolean
  plugins: Array<{ id: string; label: string; why: string; present: boolean }>
  graphifyOutPresent: boolean
  graphify: { cliAvailable: boolean; version?: string; outPresent: boolean }
}

function Badge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs ${
        ok ? 'bg-green-500/15 text-green-600 dark:text-green-400' : 'bg-muted text-muted-foreground'
      }`}
    >
      {ok ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
      {label}
    </span>
  )
}

export function ObsidianVaultSettings() {
  const [status, setStatus] = useState<ObsidianStatus | null>(null)
  const [readiness, setReadiness] = useState<Readiness | null>(null)
  const [vaultPath, setVaultPath] = useState('')
  const [enabled, setEnabled] = useState(false)
  const [modeB, setModeB] = useState(false)
  const [useClaudeMdContext, setUseClaudeMdContext] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirmReplace, setConfirmReplace] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loadReadiness = useCallback(async () => {
    try {
      const res = await fetch('/api/obsidian/readiness')
      if (res.ok) setReadiness((await res.json()) as Readiness)
      else setReadiness(null)
    } catch {
      setReadiness(null)
    }
  }, [])

  const refresh = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch('/api/obsidian/status')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const s = (await res.json()) as ObsidianStatus
      setStatus(s)
      setVaultPath(s.vaultPath)
      setEnabled(s.enabled)
      setModeB(s.modeB)
      setUseClaudeMdContext(s.useClaudeMdContext)
      if (s.vaultExists) void loadReadiness()
    } catch (err) {
      setError((err as Error).message)
    }
  }, [loadReadiness])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const doSave = useCallback(
    async (enabledValue: boolean) => {
      setBusy(true)
      setMsg(null)
      setError(null)
      setConfirmReplace(false)
      try {
        const res = await fetch('/api/obsidian/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ vaultPath, enabled: enabledValue, modeB, useClaudeMdContext }),
        })
        const body = await res.json()
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
        setMsg(
          enabledValue
            ? `Saved. Lore source: Obsidian Vault (read-only)${body.entityCount != null ? ` — ${body.entityCount} entities` : ''}.`
            : 'Saved. Lore source: Tusks-Lore folder.',
        )
        await refresh()
        // Reciprocal of the Lore Source card's switch: refresh the shared
        // lore-documents cache so the Tome of Lore tab (active-source banner +
        // KB-vs-vault view) re-syncs without a manual reload.
        await refreshLoreDocuments()
      } catch (err) {
        setError((err as Error).message)
      } finally {
        setBusy(false)
      }
    },
    [vaultPath, modeB, useClaudeMdContext, refresh],
  )

  // Turning Obsidian ON replaces Tusks-Lore for grounding — confirm first.
  const onSave = useCallback(() => {
    if (enabled && !status?.enabled) {
      setConfirmReplace(true)
      return
    }
    void doSave(enabled)
  }, [enabled, status?.enabled, doSave])

  const browse = useCallback(async () => {
    setBusy(true)
    setError(null)
    setMsg(null)
    try {
      const res = await fetch('/api/obsidian/pick-folder', { method: 'POST' })
      const body = (await res.json()) as { ok: boolean; path?: string; reason?: string; detail?: string }
      if (body.ok && body.path) {
        setVaultPath(body.path)
        setMsg('Folder selected — review the options below, then Save.')
      } else if (body.reason === 'cancelled') {
        // no-op
      } else {
        setError(
          `Couldn't open a folder dialog (${body.detail ?? body.reason}). Paste the vault path manually instead.`,
        )
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }, [])

  const reindex = useCallback(async () => {
    setBusy(true)
    setMsg(null)
    setError(null)
    try {
      const res = await fetch('/api/obsidian/reindex', { method: 'POST' })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      setMsg(`Reindexed — ${body.entityCount} entities.`)
      await refresh()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }, [refresh])

  const buildGraphify = useCallback(async () => {
    if (
      !window.confirm(
        'Build a graphify map of this vault?\n\nThis runs the graphify CLI and writes a graphify-out/ folder INTO your vault (it is excluded from grounding). Add it to your vault’s .gitignore / Obsidian exclusions if you sync the vault.',
      )
    )
      return
    setBusy(true)
    setMsg(null)
    setError(null)
    try {
      const res = await fetch('/api/obsidian/graphify-build', { method: 'POST' })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      setMsg('graphify map built into the vault (graphify-out/).')
      await loadReadiness()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }, [loadReadiness])

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2">
              <BookMarked className="h-4 w-4" />
              Obsidian Vault Lore (read-only)
            </CardTitle>
            <CardDescription>
              Ground chronicles against an Obsidian vault instead of the Tusks-Lore folder. The app
              reads your notes' frontmatter aliases + bodies — it never writes into the vault
              (except the explicit "Build graphify map" action below). Off by default.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={busy}>
            <RefreshCw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} />
            <span className="ml-1">Refresh</span>
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {error && <p className="text-destructive">Error: {error}</p>}
        {msg && <p className="text-green-600 dark:text-green-400">{msg}</p>}

        <label className="block">
          <span className="mb-1 flex items-center gap-1 font-medium">
            <FolderTree className="h-3.5 w-3.5" /> Vault path
          </span>
          <div className="flex gap-2">
            <input
              type="text"
              value={vaultPath}
              onChange={(e) => setVaultPath(e.target.value)}
              placeholder="e.g. D:\\Obsidian or ~/Vault"
              className="flex-1 rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs"
              spellCheck={false}
            />
            <Button variant="outline" size="sm" onClick={() => void browse()} disabled={busy}>
              <FolderSearch className="h-3.5 w-3.5" />
              <span className="ml-1">Browse…</span>
            </Button>
          </div>
        </label>

        {status && (
          <div className="flex flex-wrap items-center gap-2">
            <Badge ok={status.vaultExists} label={status.vaultExists ? 'Vault found' : 'Vault not found'} />
            <Badge
              ok={status.entityIndexExists}
              label={status.entityIndexExists ? '_system/entity-index.json' : 'no entity-index (will walk notes)'}
            />
            {status.entityCount != null && <Badge ok label={`${status.entityCount} entities cached`} />}
          </div>
        )}

        {/* Vault readiness: recommended community plugins + graphify */}
        {readiness && (
          <div className="rounded-md border border-border bg-muted/30 p-2 text-xs space-y-2">
            <span className="font-medium">Vault readiness</span>
            <div className="flex flex-wrap gap-1.5">
              {readiness.plugins.map((p) => (
                <span
                  key={p.id}
                  title={p.why}
                  className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 ${
                    p.present
                      ? 'bg-green-500/15 text-green-600 dark:text-green-400'
                      : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {p.present ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
                  {p.label}
                </span>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Badge
                ok={readiness.graphify.cliAvailable}
                label={readiness.graphify.cliAvailable ? `graphify CLI${readiness.graphify.version ? ` ${readiness.graphify.version}` : ''}` : 'graphify CLI not found'}
              />
              {readiness.graphifyOutPresent && <Badge ok label="graphify-out/ built" />}
              <Button
                variant="outline"
                size="sm"
                onClick={() => void buildGraphify()}
                disabled={busy || !readiness.graphify.cliAvailable}
                title={readiness.graphify.cliAvailable ? 'Writes graphify-out/ into your vault' : 'Install graphify first: pip install graphifyy'}
              >
                <Network className="h-3.5 w-3.5" />
                <span className="ml-1">Build graphify map (writes into vault)</span>
              </Button>
            </div>
            {!readiness.graphify.cliAvailable && (
              <p className="text-muted-foreground">
                Install with <code className="rounded bg-background px-1">pip install graphifyy</code> to enable the
                graphify mapping build.
              </p>
            )}
          </div>
        )}

        <label className="flex cursor-pointer items-start gap-2">
          <input type="checkbox" className="mt-1" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span>
            <span className="font-medium">Use this vault as the lore source</span>
            <span className="block text-muted-foreground">
              When on, grounding + the chronicle Knowledge Base come from the vault instead of
              Tusks-Lore. When off, Tusks-Lore is used (unchanged).
            </span>
          </span>
        </label>

        <label className="flex cursor-pointer items-start gap-2">
          <input type="checkbox" className="mt-1" checked={modeB} onChange={(e) => setModeB(e.target.checked)} />
          <span>
            <span className="font-medium">Relationship enrichment (Mode-B)</span>
            <span className="block text-muted-foreground">
              Prepend each note with a one-line summary of its frontmatter relationships
              (affiliations, related, patron, allies/enemies) so the chronicle has richer context.
            </span>
          </span>
        </label>

        <label className="flex cursor-pointer items-start gap-2">
          <input
            type="checkbox"
            className="mt-1"
            checked={useClaudeMdContext}
            onChange={(e) => setUseClaudeMdContext(e.target.checked)}
          />
          <span>
            <span className="font-medium">Use the vault's CLAUDE.md as grounding context</span>
            <span className="block text-muted-foreground">
              Off by default. When on, your vault's <code className="rounded bg-background px-1">CLAUDE.md</code>{' '}
              navigation guide is injected as a bounded context block so grounding understands how
              your lore is organised. Changes grounding output — leave off unless you've tuned a
              CLAUDE.md for this.
              {status && !status.claudeMdPresent && (
                <span className="mt-0.5 block text-amber-600 dark:text-amber-400">
                  No CLAUDE.md in this vault yet — generate one from the Tome of Lore tab (needs the
                  Claude Code add-on) or add your own. Until then this toggle has no effect.
                </span>
              )}
            </span>
          </span>
        </label>

        {confirmReplace && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-amber-700 dark:text-amber-300">
            <p className="font-medium">Use your Obsidian vault instead of Tusks-Lore for grounding?</p>
            <p className="mt-1 text-xs">
              Your Tusks-Lore folder stays on disk, untouched — nothing is deleted or migrated, and
              you can switch back anytime by turning this off.
            </p>
            <div className="mt-2 flex gap-2">
              <Button size="sm" onClick={() => void doSave(true)} disabled={busy}>
                Use Obsidian vault
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setConfirmReplace(false)
                  setEnabled(false)
                }}
                disabled={busy}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}

        {!confirmReplace && (
          <div className="flex gap-2">
            <Button size="sm" onClick={onSave} disabled={busy}>
              Save
            </Button>
            <Button variant="outline" size="sm" onClick={() => void reindex()} disabled={busy || !vaultPath}>
              Reindex vault
            </Button>
          </div>
        )}

        <div className="rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
          <p className="font-medium text-foreground">Get the most out of your vault</p>
          <ul className="ml-4 mt-1 list-disc space-y-0.5">
            <li>
              The single highest-value field is <code className="rounded bg-background px-1">aliases:</code> in each
              note's frontmatter — list nicknames / alternate spellings so grounding can map them to canonical names.
            </li>
            <li>One note per entity, with a <code className="rounded bg-background px-1">type:</code> (npc, pc, location, faction, deity…).</li>
            <li>Recommended plugins are shown above with live status (read from your vault's enabled-plugins list).</li>
          </ul>
        </div>
      </CardContent>
    </Card>
  )
}
