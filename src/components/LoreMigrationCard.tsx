import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Database,
  Download,
  Loader2,
  Sparkles,
  Undo2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

// ─────────────────────────────────────────────────────────────────────────────
// Types matching server/api/lore.ts + scripts/lore/extract-aliases.mjs
// ─────────────────────────────────────────────────────────────────────────────

type MigrationFile = {
  relPath: string
  action: 'proposed' | 'applied' | 'skipped'
  reason?: 'has-frontmatter' | 'no-headings'
  entitiesAdded?: number
  entityNames?: string[]
  proposedFrontmatter?: string
}

type MigrationReport = {
  migratedAt: string
  loreRoot: string
  apply: boolean
  files: MigrationFile[]
}

type AliasIndexSnapshot = {
  status: 'ok' | 'no-lore'
  loreRoot?: string
  index: {
    schema: number
    builtAt: string
    byEntity: Record<string, { file: string; type: string; aliases: string[] }>
    filesWithFrontmatter: string[]
    filesWithoutFrontmatter: string[]
  } | null
}

// ─────────────────────────────────────────────────────────────────────────────

export function LoreMigrationCard() {
  const [snapshot, setSnapshot] = useState<AliasIndexSnapshot | null>(null)
  const [report, setReport] = useState<MigrationReport | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loadingPreview, setLoadingPreview] = useState(false)
  const [applying, setApplying] = useState(false)
  const [revertingFile, setRevertingFile] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/lore/index')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setSnapshot((await res.json()) as AliasIndexSnapshot)
    } catch (err) {
      toast.error(`Failed to load alias index: ${(err as Error).message}`)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const loadPreview = useCallback(async () => {
    setLoadingPreview(true)
    try {
      const res = await fetch('/api/lore/migration/preview')
      const body = (await res.json()) as { ok: boolean; report?: MigrationReport; error?: string }
      if (!body.ok || !body.report) throw new Error(body.error ?? 'preview failed')
      setReport(body.report)
    } catch (err) {
      toast.error(`Preview failed: ${(err as Error).message}`)
    } finally {
      setLoadingPreview(false)
    }
  }, [])

  const applyMigration = useCallback(async () => {
    setApplying(true)
    try {
      const res = await fetch('/api/lore/migration/apply', { method: 'POST' })
      const body = (await res.json()) as { ok: boolean; report?: MigrationReport; error?: string }
      if (!body.ok || !body.report) throw new Error(body.error ?? 'apply failed')
      setReport(body.report)
      const appliedCount = body.report.files.filter((f) => f.action === 'applied').length
      toast.success(
        `Migration applied to ${appliedCount} ${appliedCount === 1 ? 'file' : 'files'}. ` +
          `Original copies saved as .bak siblings — revert any file with the undo button.`,
      )
      await refresh()
    } catch (err) {
      toast.error(`Apply failed: ${(err as Error).message}`)
    } finally {
      setApplying(false)
    }
  }, [refresh])

  const revertFile = useCallback(
    async (relPath: string) => {
      setRevertingFile(relPath)
      try {
        const res = await fetch('/api/lore/migration/revert', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ relPath }),
        })
        const body = (await res.json()) as { ok: boolean; error?: string }
        if (!body.ok) throw new Error(body.error ?? 'revert failed')
        toast.success(`Reverted ${relPath}`)
        await refresh()
        await loadPreview()
      } catch (err) {
        toast.error(`Revert failed: ${(err as Error).message}`)
      } finally {
        setRevertingFile(null)
      }
    },
    [loadPreview, refresh],
  )

  if (!snapshot) {
    return (
      <Card>
        <CardContent className="py-6">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading lore index…
          </div>
        </CardContent>
      </Card>
    )
  }

  if (snapshot.status === 'no-lore') {
    return null // no lore folder = nothing to migrate; the KB card handles the empty state
  }

  const idx = snapshot.index
  const withFm = idx?.filesWithFrontmatter ?? []
  const withoutFm = idx?.filesWithoutFrontmatter ?? []
  const entityCount = Object.keys(idx?.byEntity ?? {}).length
  const allMigrated = withoutFm.length === 0 && withFm.length > 0

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Database className="h-5 w-5" />
              Lore Index
            </CardTitle>
            <CardDescription>
              Structured metadata extracted from your lore docs. The pipeline uses this for
              faster lore grounding and cheaper Chronicle calls. Docs without frontmatter still
              work — they fall back to the proper-noun regex extractor (less precise).
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={refresh}>
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-3 gap-3 text-sm">
          <div className="rounded-md border bg-muted/40 px-3 py-2">
            <div className="text-xs text-muted-foreground">Indexed entities</div>
            <div className="text-lg font-medium">{entityCount}</div>
          </div>
          <div className="rounded-md border bg-muted/40 px-3 py-2">
            <div className="text-xs text-muted-foreground">With frontmatter</div>
            <div className="text-lg font-medium">{withFm.length}</div>
          </div>
          <div className="rounded-md border bg-muted/40 px-3 py-2">
            <div className="text-xs text-muted-foreground">Without (fallback)</div>
            <div className="text-lg font-medium">{withoutFm.length}</div>
          </div>
        </div>

        {allMigrated && (
          <div className="flex items-start gap-2 rounded-md border border-green-500/30 bg-green-500/5 p-3 text-sm">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-500" />
            <div>
              All lore docs have frontmatter. Phase 1 grounding and Phase 3 retrieval are
              running at full precision.
            </div>
          </div>
        )}

        {withoutFm.length > 0 && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            <div className="space-y-1">
              <div>
                <strong>{withoutFm.length}</strong>{' '}
                {withoutFm.length === 1 ? 'doc lacks' : 'docs lack'} structured metadata. The
                pipeline still works — falls back to a regex proper-noun extractor — but lore
                retrieval is less precise.
              </div>
              <div className="text-xs text-muted-foreground">
                {withoutFm.slice(0, 5).join(', ')}
                {withoutFm.length > 5 ? `, +${withoutFm.length - 5} more` : ''}
              </div>
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <a href="/api/lore/template" download="lore-template.md">
              <Download className="mr-2 h-4 w-4" />
              Download lore template
            </a>
          </Button>
          <Button onClick={loadPreview} disabled={loadingPreview} variant="outline">
            {loadingPreview ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="mr-2 h-4 w-4" />
            )}
            Preview proposed frontmatter
          </Button>
          {report && report.files.some((f) => f.action === 'proposed') && (
            <Button onClick={applyMigration} disabled={applying}>
              {applying ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              Apply migration
              <span className="ml-1 text-xs opacity-70">(writes in place, backups to .bak)</span>
            </Button>
          )}
        </div>

        {report && (
          <div className="space-y-2">
            <p className="text-sm font-medium">Migration report</p>
            <p className="text-xs text-muted-foreground">
              Files already migrated show their indexed-entity count. Files marked
              <em className="mx-1">fallback</em> have no extractable entities (chronological,
              session-log, or overview docs) — the pipeline still reads their prose via the
              proper-noun regex extractor.
            </p>
            <ul className="space-y-1.5">
              {report.files.map((f) => {
                const isOpen = expanded.has(f.relPath)
                const isApplied = f.action === 'applied'
                const isProposed = f.action === 'proposed'
                const isAlreadyMigrated = f.action === 'skipped' && f.reason === 'has-frontmatter'
                const isFallback = f.action === 'skipped' && f.reason === 'no-headings'
                // Count entities this file contributes to the live alias index.
                const indexedCount = idx
                  ? Object.values(idx.byEntity).filter((e) => e.file === f.relPath).length
                  : 0
                const displayLabel = isApplied
                  ? 'applied just now'
                  : isProposed
                    ? 'proposed'
                    : isAlreadyMigrated
                      ? 'migrated'
                      : isFallback
                        ? 'fallback (compactKb)'
                        : `skipped (${f.reason ?? 'n/a'})`
                const labelClass = isApplied || isAlreadyMigrated
                  ? 'text-xs text-green-600 dark:text-green-400'
                  : isProposed
                    ? 'text-xs text-primary'
                    : isFallback
                      ? 'text-xs text-amber-600 dark:text-amber-400'
                      : 'text-xs text-muted-foreground'
                const displayEntityCount = isApplied || isProposed
                  ? f.entitiesAdded ?? 0
                  : isAlreadyMigrated
                    ? indexedCount
                    : 0
                return (
                  <li key={f.relPath} className="rounded-md border bg-card">
                    <button
                      type="button"
                      className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted/40"
                      onClick={() => {
                        const next = new Set(expanded)
                        if (next.has(f.relPath)) next.delete(f.relPath)
                        else next.add(f.relPath)
                        setExpanded(next)
                      }}
                    >
                      <span className="flex items-center gap-2">
                        <ChevronRight
                          className={`h-4 w-4 shrink-0 transition-transform ${
                            isOpen ? 'rotate-90' : ''
                          }`}
                        />
                        <code className="font-mono text-xs">{f.relPath}</code>
                        <span className={labelClass}>{displayLabel}</span>
                        {displayEntityCount > 0 && (
                          <span className="text-xs text-muted-foreground">
                            {isAlreadyMigrated ? `${displayEntityCount} entities indexed` : `+${displayEntityCount} entities`}
                          </span>
                        )}
                      </span>
                      {(isApplied || isAlreadyMigrated) && (
                        <span
                          role="button"
                          tabIndex={0}
                          onClick={(e) => {
                            e.stopPropagation()
                            void revertFile(f.relPath)
                          }}
                          className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted"
                          title="Restore the .bak backup"
                        >
                          {revertingFile === f.relPath ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Undo2 className="h-3 w-3" />
                          )}
                          Revert
                        </span>
                      )}
                    </button>
                    {isOpen && f.proposedFrontmatter && (
                      <pre className="overflow-x-auto rounded-b-md bg-muted/40 p-3 text-xs">
                        {f.proposedFrontmatter}
                      </pre>
                    )}
                    {isOpen && f.entityNames && f.entityNames.length > 0 && !f.proposedFrontmatter && (
                      <div className="px-3 py-2 text-xs text-muted-foreground">
                        Entities: {f.entityNames.join(', ')}
                      </div>
                    )}
                    {isOpen && isAlreadyMigrated && idx && (
                      <div className="px-3 py-2 text-xs text-muted-foreground">
                        Indexed entities:{' '}
                        {Object.entries(idx.byEntity)
                          .filter(([, e]) => e.file === f.relPath)
                          .map(([name]) => name)
                          .join(', ') || '(none)'}
                      </div>
                    )}
                    {isOpen && isFallback && (
                      <div className="px-3 py-2 text-xs text-muted-foreground">
                        This document has no markdown headings or recognisable entity blocks.
                        The pipeline still reads its prose via the proper-noun regex extractor —
                        names mentioned here are still groundable, just less precisely. Add{' '}
                        <code className="rounded bg-muted px-1">#</code> headings to entity
                        sections inside this file if you want it indexed.
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
