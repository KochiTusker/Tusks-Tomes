// "Model lists" strip: when each polled model list was last checked, with a
// re-check button per list.
//
// Claude Code has no list of its own. The server derives it from the
// OpenRouter catalogue, so its timestamp is the catalogue's and one button
// serves both. Codex ships a fixed list with the app, so it has nothing to
// check.

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/platform/ui/button'
import type { CloudKeyOption } from '@/features/providers/lib/cloudKeys'
import { probeProviderKey, type AvailabilityCache } from '@/features/providers/lib/providerSettings'
import { getOpenRouterCatalogue, type CatalogueResult } from '@/features/providers/lib/openrouterModelsClient'
import { formatAbsolute, formatAgo, isStale } from '@/platform/lib/relativeTime'

export interface ModelListFreshnessProps {
  cloudKeyOptions: CloudKeyOption[]
  availability: AvailabilityCache
  /** The catalogue's own timestamp, when the editor has loaded it. */
  catalogueFetchedAt?: string | null
  /** Called with the refreshed catalogue after a re-check that succeeded. */
  onCatalogueRefreshed?: (result: CatalogueResult) => void
}

type RowKey = 'gemini-paid' | 'gemini-free' | 'catalogue'

function Stamp({ iso }: { iso: string | null | undefined }) {
  const label = formatAgo(iso)
  const never = label === 'never'
  return (
    <span
      title={formatAbsolute(iso) || undefined}
      className={
        never
          ? 'text-muted-foreground'
          : isStale(iso)
            ? 'text-amber-700 dark:text-amber-400'
            : 'text-foreground/80'
      }
    >
      {never ? 'never checked' : `checked ${label}`}
    </span>
  )
}

function validIso(iso: string | null | undefined): string | null {
  return formatAgo(iso) === 'never' ? null : (iso ?? null)
}

export function ModelListFreshness({
  cloudKeyOptions,
  availability,
  catalogueFetchedAt,
  onCatalogueRefreshed,
}: ModelListFreshnessProps) {
  const [busy, setBusy] = useState<RowKey | null>(null)
  const [autoUpdate, setAutoUpdate] = useState<boolean | null>(null)
  const [failed, setFailed] = useState(false)
  const has = (id: CloudKeyOption['id']) => cloudKeyOptions.some((o) => o.id === id)
  const hasOpenRouter = has('openrouter')
  const hasClaudeCode = has('claude-code')
  const hasCatalogue = hasOpenRouter || hasClaudeCode

  useEffect(() => {
    if (!hasCatalogue) return
    let live = true
    void (async () => {
      try {
        const res = await fetch('/api/settings')
        if (res.ok) {
          const body = (await res.json()) as { autoUpdateModelList?: boolean }
          if (live) setAutoUpdate(body.autoUpdateModelList !== false)
        }
      } catch {
        // Settings unreadable: the strip simply leaves the switch out.
      }
      try {
        const cat = await getOpenRouterCatalogue()
        if (live) setFailed(cat?.status?.stale === true && !!cat.status.lastError)
      } catch {
        // The strip still works without the stale flag.
      }
    })()
    return () => {
      live = false
    }
  }, [hasCatalogue])

  async function changeAutoUpdate(next: boolean) {
    const prev = autoUpdate
    setAutoUpdate(next)
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoUpdateModelList: next }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    } catch (err) {
      setAutoUpdate(prev)
      toast.error(`Couldn’t save that setting: ${(err as Error).message}`)
    }
  }

  if (!has('gemini-paid') && !has('gemini-free') && !hasCatalogue && !has('codex')) return null

  const catalogueStamp =
    validIso(catalogueFetchedAt) ?? validIso(availability.claudeCode?.fetchedAt)

  async function probeGemini(which: 'gemini-paid' | 'gemini-free') {
    const name = which === 'gemini-paid' ? 'gemini' : 'geminiFree'
    const label = which === 'gemini-paid' ? 'Gemini paid key' : 'Gemini free key'
    setBusy(which)
    try {
      const result = await probeProviderKey(name)
      if (result.ok && result.availability) {
        const ok = result.availability.probed.filter((p) => p.accessible).length
        toast.success(`${label}: ${ok} of ${result.availability.probed.length} models accessible.`)
      } else {
        toast.error(`${label} check failed: ${result.error ?? 'unknown error'}`)
      }
    } catch (err) {
      toast.error(`${label} check failed: ${(err as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  async function recheckCatalogue() {
    const before = catalogueStamp
    setBusy('catalogue')
    try {
      const result = await getOpenRouterCatalogue({ force: true })
      if (result.error) {
        // Leave the editor's list and the timestamp as they were.
        toast.error(`Could not reach OpenRouter: ${result.error}`)
        return
      }
      const after = validIso(result.fetchedAt)
      const advanced =
        after !== null && (before === null || Date.parse(after) > Date.parse(before))
      if (!advanced) {
        // The server falls back to its saved copy when the fetch fails, so a
        // timestamp that did not move is the only sign it did not answer.
        toast.warning(
          before
            ? `OpenRouter did not answer. The list is still from ${formatAbsolute(before)}.`
            : 'OpenRouter did not answer, so there is no list yet.',
        )
        return
      }
      setFailed(false)
      onCatalogueRefreshed?.(result)
      toast.success(`Model list updated: ${result.models.length} models from OpenRouter.`)
    } catch (err) {
      toast.error(`Could not reach OpenRouter: ${(err as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  const catalogueLabel =
    hasOpenRouter && hasClaudeCode
      ? 'OpenRouter and Claude Code'
      : hasOpenRouter
        ? 'OpenRouter'
        : 'Claude Code'

  const renderRow = (
    key: RowKey,
    label: string,
    iso: string | null | undefined,
    onClick: () => void,
    pendingText: string,
    note?: string,
  ) => {
    const running = busy === key
    const never = formatAgo(iso) === 'never'
    return (
      <li key={key} className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1">
          <span className="font-medium text-foreground">{label}</span>
          <span className="ml-2">
            <Stamp iso={iso} />
          </span>
          {running && <span className="ml-2 text-muted-foreground">{pendingText}</span>}
          {note && <div className="text-muted-foreground">{note}</div>}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy !== null}
          onClick={onClick}
          aria-label={`${never ? 'Check' : 'Re-check'} ${label}`}
          className="h-7 px-2"
        >
          {running ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          {never ? 'Check' : 'Re-check'}
        </Button>
      </li>
    )
  }

  return (
    <div className="rounded-md border border-border/70 bg-card/30 p-3 text-xs text-muted-foreground">
      <div className="mb-2 text-sm font-medium text-foreground">Model lists</div>
      <ul className="space-y-2">
        {has('gemini-paid') &&
          renderRow(
            'gemini-paid',
            'Gemini paid key',
            availability.gemini?.fetchedAt,
            () => void probeGemini('gemini-paid'),
            'Checking… (about 30 test calls)',
          )}
        {has('gemini-free') &&
          renderRow(
            'gemini-free',
            'Gemini free key',
            availability.geminiFallback?.fetchedAt,
            () => void probeGemini('gemini-free'),
            'Checking… (about 30 test calls)',
          )}
        {hasCatalogue &&
          renderRow(
            'catalogue',
            catalogueLabel,
            catalogueStamp,
            () => void recheckCatalogue(),
            'Checking…',
            hasClaudeCode ? 'Claude Code’s list comes from the OpenRouter catalogue.' : undefined,
          )}
        {hasCatalogue && (
          <li className="space-y-1">
            <div>
              From openrouter.ai
              {autoUpdate === null
                ? ''
                : !autoUpdate
                  ? ' · automatic updates off'
                  : failed
                    ? ' · last update failed, showing the saved list'
                    : ' · updates automatically, at most once a day'}
            </div>
            {autoUpdate !== null && (
              <label className="flex cursor-pointer items-center gap-2 text-foreground/80">
                <input
                  type="checkbox"
                  className="h-4 w-4 shrink-0"
                  checked={autoUpdate}
                  onChange={(e) => void changeAutoUpdate(e.target.checked)}
                />
                Keep the model list up to date automatically
              </label>
            )}
            {autoUpdate === false && (
              <div>The saved list is used as it is; only Re-check contacts openrouter.ai.</div>
            )}
          </li>
        )}
        {has('codex') && (
          <li>
            <span className="font-medium text-foreground">Codex</span>
            <span className="ml-2">built-in list, updated with the app</span>
          </li>
        )}
      </ul>
    </div>
  )
}
