// One row for every connection — the "you connect it" half of the
// install-or-connect split. Collapsed, the row still answers the only
// question that matters ("is it there, and if not, what do I do?");
// expanded, it reveals the connection's full panel.
//
// A connection is never hidden for being absent: that is exactly how the
// old add-on menu made features undiscoverable. Absent means one visible
// row with a remedy — a next step, not a dead end.

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { CheckCircle2, CircleDashed, Loader2, RefreshCw, TriangleAlert } from 'lucide-react'
import { ExperimentalChip } from '@/components/ui/experimental-chip'
import type { ConnectionProbeResult } from '@/lib/connections'
import { cn } from '@/lib/utils'

const STATE_META = {
  connected: { label: 'Connected', cls: 'bg-green-500/15 text-green-600 dark:text-green-400', Icon: CheckCircle2 },
  attention: { label: 'Needs a step', cls: 'bg-amber-500/15 text-amber-700 dark:text-amber-400', Icon: TriangleAlert },
  absent: { label: 'Not found', cls: 'bg-muted text-muted-foreground', Icon: CircleDashed },
  unknown: { label: "Couldn't check", cls: 'bg-amber-500/15 text-amber-700 dark:text-amber-400', Icon: TriangleAlert },
} as const

export function ConnectionRow({
  name,
  experimental,
  probe,
  children,
}: {
  name: string
  experimental?: boolean
  /** Answers "is it there?" — see src/lib/connections.ts. Re-run by the
   *  row's refresh button; failures render as a checking error, never as
   *  a fake 'absent'. */
  probe: () => Promise<ConnectionProbeResult>
  children: ReactNode
}) {
  const [result, setResult] = useState<ConnectionProbeResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(true)

  const run = useCallback(() => {
    let cancelled = false
    setChecking(true)
    setError(null)
    probe()
      .then((r) => {
        if (!cancelled) setResult(r)
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message)
      })
      .finally(() => {
        if (!cancelled) setChecking(false)
      })
    return () => {
      cancelled = true
    }
  }, [probe])

  useEffect(() => run(), [run])

  const meta = result ? STATE_META[result.state] : null

  return (
    <details className="rounded-md border border-border bg-card/40">
      <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 p-3 [&::-webkit-details-marker]:hidden">
        <span className="flex items-center gap-2 font-medium text-sm">
          {name}
          {experimental && <ExperimentalChip />}
        </span>
        {checking ? (
          <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs bg-muted text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Checking…
          </span>
        ) : meta ? (
          <span className={cn('inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium', meta.cls)}>
            <meta.Icon className="h-3 w-3" />
            {meta.label}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs bg-muted text-muted-foreground">
            <TriangleAlert className="h-3 w-3" /> Couldn't check
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {error
            ? `Status check failed: ${error}`
            : result
              ? result.remedy && result.state !== 'connected'
                ? `${result.detail} ${result.remedy}`
                : result.detail
              : ''}
        </span>
        <button
          type="button"
          className="rounded p-1 text-muted-foreground hover:bg-muted/40 hover:text-foreground"
          title="Check again"
          onClick={(e) => {
            e.preventDefault()
            run()
          }}
        >
          <RefreshCw className={cn('h-3.5 w-3.5', checking && 'animate-spin')} />
        </button>
      </summary>
      <div className="reveal-on-open border-t border-border/60 p-3">{children}</div>
    </details>
  )
}
