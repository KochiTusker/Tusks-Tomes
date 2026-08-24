// Per-phase Gemini "thinking" toggles. Rendered inside the Customise
// phases disclosure — reasoning is a property of a phase, so it lives
// beside the model that runs the phase, not in a separate tuning card
// the user has to correlate by hand.
//
// Phase 3 (Chronicle) is hardcoded ON — voice protection. Defaults
// everywhere else preserve existing behaviour; each switch is opt-in.
// Saves immediately to {configDir}/settings.json (unlike the routing
// rows above, which stage until Save) — the caption says so.

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Brain, Loader2 } from 'lucide-react'

type PerPhaseThinking = { phase1?: boolean; phase2?: boolean; phase4?: boolean; phase6?: boolean }
type Settings = {
  updaterRemote: string
  disableThinkingOnGrounding: boolean
  perPhaseThinking?: PerPhaseThinking
}

export function PhaseThinking() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/settings')
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        setSettings((await res.json()) as Settings)
      } catch (err) {
        console.warn('[PhaseThinking] failed to load settings:', err)
      }
    })()
  }, [])

  async function toggle(next: boolean) {
    if (!settings) return
    setSaving(true)
    const optimistic: Settings = { ...settings, disableThinkingOnGrounding: next }
    setSettings(optimistic)
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disableThinkingOnGrounding: next }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = (await res.json()) as Settings
      setSettings(body)
      toast.success(
        next
          ? 'Gemini reasoning disabled on grounding. Phase 1 should now run ~10-15% cheaper.'
          : 'Grounding reverted to default — Gemini reasoning re-enabled on Phase 1.',
      )
    } catch (err) {
      // Roll back optimistic update on error.
      setSettings(settings)
      toast.error(`Failed to update setting: ${(err as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  if (!settings) {
    return (
      <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading reasoning settings…
      </div>
    )
  }

  const enabled = settings.disableThinkingOnGrounding
  const ppt: PerPhaseThinking = settings.perPhaseThinking ?? {}

  async function togglePerPhase(phase: keyof PerPhaseThinking, on: boolean) {
    if (!settings) return
    setSaving(true)
    const nextPpt = { ...ppt, [phase]: on }
    const optimistic: Settings = { ...settings, perPhaseThinking: nextPpt }
    setSettings(optimistic)
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ perPhaseThinking: nextPpt }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = (await res.json()) as Settings
      setSettings(body)
      toast.success(`${phase.toUpperCase()} thinking ${on ? 'ON' : 'OFF'}.`)
    } catch (err) {
      setSettings(settings)
      toast.error(`Failed to update: ${(err as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-3 rounded-md border border-border/70 bg-card/30 p-3">
      <div>
        <div className="flex items-center gap-2 text-sm font-medium">
          <Brain className="h-4 w-4" />
          Model reasoning, per phase
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Gemini phases only. Reasoning on = slower, sharper, ~3× the output cost; off = faster and
          cheaper. The Chronicle phase always keeps reasoning on. These save immediately.
        </p>
      </div>
      <div className="space-y-2">
        <label className="flex cursor-pointer items-start gap-3 rounded-md border bg-card p-3 hover:bg-muted/30">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 shrink-0"
            checked={enabled}
            disabled={saving}
            onChange={(e) => void toggle(e.target.checked)}
          />
          <div className="space-y-1 text-sm">
            <div className="font-medium">Cheaper grounding, same names</div>
            <div className="text-xs text-muted-foreground">
              Phase 1 · turns reasoning off. ~10–15% cheaper — mechanical name-substitution
              doesn't need it.
            </div>
          </div>
        </label>
        <label className="flex cursor-pointer items-start gap-3 rounded-md border bg-card p-3 hover:bg-muted/30">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 shrink-0"
            checked={ppt.phase4 === true}
            disabled={saving}
            onChange={(e) => void togglePerPhase('phase4', e.target.checked)}
          />
          <div className="space-y-1 text-sm">
            <div className="font-medium">Sharper quotes, jests and gore</div>
            <div className="text-xs text-muted-foreground">
              Phase 4 · turns reasoning on. ~3× the extras output cost, but extras are small, so
              pennies in practice. Worth trying when the quotes feel noisy.
            </div>
          </div>
        </label>
        <label className="flex cursor-pointer items-start gap-3 rounded-md border bg-card p-3 hover:bg-muted/30">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 shrink-0"
            checked={ppt.phase6 === true}
            disabled={saving}
            onChange={(e) => void togglePerPhase('phase6', e.target.checked)}
          />
          <div className="space-y-1 text-sm">
            <div className="font-medium">Condense hits its target length</div>
            <div className="text-xs text-muted-foreground">
              Phase 6 · turns reasoning on. Flash-tier models land the condense target far more
              reliably — most of Pro's discipline at a fraction of its price.
            </div>
          </div>
        </label>
        {saving && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            Saving…
          </div>
        )}
      </div>
    </div>
  )
}
