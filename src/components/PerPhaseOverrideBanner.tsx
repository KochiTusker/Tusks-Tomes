// Sticky banner shown above the running-phase view when the current run's
// `routing.perPhase` overrides force one or more phases onto a different
// provider/tier than the global selector. Dismissible per-session — once
// the user clicks the X, it stays hidden for the lifetime of THIS run.
// A fresh run (new `runId`) re-surfaces it so an accidental override
// doesn't go unnoticed; an intentional one stays out of the way after
// one click.
//
// Surfaces the "Clear all per-phase overrides" affordance — single click
// (with confirmation) zeroes routing.perPhase so subsequent runs respect
// the global selector verbatim.

import { useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { getRouting, putRouting } from '@/lib/routing'
import type { RunSession } from '@/lib/sessions'

type Props = {
  overrides: NonNullable<RunSession['perPhaseOverrides']>
  /** Used to reset the dismissed-state when a new run starts. */
  runIdSignal: string | null
  /** Optional: bumped when the banner clears overrides, so the parent can
   *  refresh its view of routing/session state (eg via ActiveProviderCard). */
  onCleared?: () => void
}

function formatPhase(phase: string): string {
  // 'phase1' -> 'Phase 1'
  const m = phase.match(/^phase(\d+)$/)
  return m ? `Phase ${m[1]}` : phase
}

function describeOverride(
  o: NonNullable<RunSession['perPhaseOverrides']>[number],
): string {
  const expectedTier = o.expected.tier ? ` ${o.expected.tier}` : ''
  const resolvedTier = o.resolved.tier ? ` ${o.resolved.tier}` : ''
  return (
    `${formatPhase(o.phase)} is pinned to ${o.resolved.provider}${resolvedTier} ` +
    `(model: ${o.resolved.model}), but the global selector is ` +
    `${o.expected.provider}${expectedTier}. ${o.reason}.`
  )
}

export function PerPhaseOverrideBanner({ overrides, runIdSignal, onCleared }: Props) {
  // useState seeded on every fresh runIdSignal — the key prop on the parent's
  // render gives us per-run state automatically without manual reset.
  void runIdSignal
  const [dismissed, setDismissed] = useState(false)
  const [clearing, setClearing] = useState(false)

  if (dismissed || overrides.length === 0) return null

  async function clearAll() {
    const ok = window.confirm(
      `Clear all per-phase routing overrides? This affects ${overrides.length} ` +
        `phase${overrides.length === 1 ? '' : 's'} and CANNOT be undone for the current ` +
        `run (which has already resolved its routing). Future runs will use only the ` +
        `global selector. Proceed?`,
    )
    if (!ok) return
    setClearing(true)
    try {
      const routing = await getRouting()
      await putRouting({ ...routing, perPhase: undefined })
      toast.success('Cleared all per-phase overrides. Subsequent runs will use the global selector.')
      setDismissed(true)
      onCleared?.()
    } catch (err) {
      toast.error(`Failed to clear overrides: ${(err as Error).message}`)
    } finally {
      setClearing(false)
    }
  }

  return (
    <Card className="border-amber-500/50 bg-amber-50 dark:border-amber-500/30 dark:bg-amber-950/30">
      <CardContent className="flex items-start gap-3 p-3">
        <AlertTriangle
          className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400"
          aria-hidden="true"
        />
        <div className="flex-1 space-y-2 text-sm">
          <p className="font-medium">
            Per-phase routing overrides active for this run
          </p>
          <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
            {overrides.map((o) => (
              <li key={o.phase}>{describeOverride(o)}</li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            These overrides come from{' '}
            <code className="rounded bg-muted px-1 py-0.5">routing.perPhase</code>
            {' '}in Settings → Hybrid Routing. The current run will respect them; clearing
            them affects future runs only.
          </p>
          <div className="flex gap-2 pt-1">
            <Button size="sm" variant="outline" onClick={clearAll} disabled={clearing}>
              {clearing ? 'Clearing…' : 'Clear all per-phase overrides'}
            </Button>
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0 px-2"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss for this session"
          title="Dismiss until the next fresh run"
        >
          <X className="h-4 w-4" />
        </Button>
      </CardContent>
    </Card>
  )
}
