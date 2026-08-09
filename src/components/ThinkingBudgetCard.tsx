// Phase A — Gemini thinking-budget toggle.
//
// Surfaces a single opt-in setting: when enabled, Phase 1 grounding calls
// are sent to Gemini with `thinkingBudget: 0`, disabling internal reasoning
// for the mechanical name-substitution work. Expected saving: ~10-15% on
// Phase 1 Gemini calls. Chronicle quality is unaffected — Phase 3 is
// hardcoded to keep thinking on regardless of this toggle.
//
// Default: OFF (existing behaviour preserved). User opts in to save cost.
// Persisted to {configDir}/settings.json via the existing settings router.

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Brain, Loader2 } from 'lucide-react'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

type PerPhaseThinking = { phase1?: boolean; phase2?: boolean; phase4?: boolean; phase6?: boolean }
type Settings = {
  updaterRemote: string
  disableThinkingOnGrounding: boolean
  perPhaseThinking?: PerPhaseThinking
}

export function ThinkingBudgetCard() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/settings')
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        setSettings((await res.json()) as Settings)
      } catch (err) {
        console.warn('[ThinkingBudgetCard] failed to load settings:', err)
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
      <Card>
        <CardContent className="py-6">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading settings…
          </div>
        </CardContent>
      </Card>
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
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Brain className="h-5 w-5" />
          Gemini thinking budget (per-phase quality dial)
        </CardTitle>
        <CardDescription>
          Per-phase "thinking" toggles. ON = slower + sharper output (~3× output tokens, ~3× output cost).
          OFF = faster + cheaper. Phase 3 (Chronicle) is hardcoded ON — voice protection. Default for
          other phases = SDK default (model decides).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <label className="flex cursor-pointer items-start gap-3 rounded-md border bg-card p-3 hover:bg-muted/30">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 shrink-0"
            checked={enabled}
            disabled={saving}
            onChange={(e) => void toggle(e.target.checked)}
          />
          <div className="space-y-1 text-sm">
            <div className="font-medium">Phase 1 (grounding) — disable thinking</div>
            <div className="text-xs text-muted-foreground">
              ~10-15% cheaper on grounding. Mechanical name-substitution doesn't need reasoning.
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
            <div className="font-medium">Phase 4 (extras) — enable thinking</div>
            <div className="text-xs text-muted-foreground">
              Sharper quote / jest / gore selection. Costs ~3× extras output tokens but extras are small
              (~5% of transcript) so absolute cost rise is small. Worth trying when quotes feel noisy.
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
            <div className="font-medium">Phase 6 (condense) — enable thinking</div>
            <div className="text-xs text-muted-foreground">
              Hits the ~25%/2000-word condense target more reliably on Flash-tier models. The closest
              middle ground to running Phase 6 on Pro at a fraction of the cost.
            </div>
          </div>
        </label>
        {saving && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            Saving…
          </div>
        )}
      </CardContent>
    </Card>
  )
}
