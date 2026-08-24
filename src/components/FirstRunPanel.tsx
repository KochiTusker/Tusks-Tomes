// The first-run state. Deliberately a panel, not a modal: a modal gets
// dismissed, and then the user is back at an empty textarea with nothing to
// say what went wrong. This replaces the run form until a cloud key exists,
// so the app's first screen states what it does and offers exactly one
// primary action.
//
// Renders null the moment any cloud key is configured — the run form is
// the real surface; this is only the answer to "I just installed it, now
// what?".

import { useEffect, useState } from 'react'
import { Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { getProvidersSummary, subscribeProviders } from '@/lib/providerSettings'
import { listConfiguredCloudKeyOptions } from '@/lib/cloudKeys'
import { emitOpenSetupWizard, emitSwitchTab } from '@/lib/appEvents'

/** true = no cloud key configured; false = at least one; null = not yet known. */
export function useNoCloudKeys(): boolean | null {
  const [noKeys, setNoKeys] = useState<boolean | null>(null)
  useEffect(() => {
    let cancelled = false
    function load() {
      getProvidersSummary()
        .then((s) => {
          if (!cancelled) setNoKeys(listConfiguredCloudKeyOptions(s).length === 0)
        })
        .catch(() => {
          // Can't tell — keep the normal form rather than blocking a
          // configured user behind a setup screen because a fetch failed.
          if (!cancelled) setNoKeys(false)
        })
    }
    load()
    const unsub = subscribeProviders(load)
    return () => {
      cancelled = true
      unsub()
    }
  }, [])
  return noKeys
}

export function FirstRunPanel() {
  return (
    <Card>
      <CardContent className="flex flex-col items-start gap-4 py-10">
        <div className="space-y-2">
          <h2 className="font-display text-xl tracking-wide">
            Turn a session recording into a chronicle worth reading.
          </h2>
          <p className="max-w-xl text-sm text-muted-foreground">
            Tusk's Tomes takes a transcript of your game session, fixes the names it mishears,
            asks the DM the questions it can't answer itself, and writes the tale. To start, it
            needs one connection to a model that will do the writing.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => emitOpenSetupWizard()}>
            <Sparkles className="mr-2 h-4 w-4" />
            Set up Tusk's Tomes
          </Button>
          <button
            type="button"
            className="text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            onClick={() => emitSwitchTab('settings')}
          >
            or add an API key yourself in Settings
          </button>
        </div>
      </CardContent>
    </Card>
  )
}
