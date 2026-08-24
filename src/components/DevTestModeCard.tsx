// Dev-mode-gated card for the pipeline test-mode toggle.
//
// Surfaces a single opt-in setting: truncate every transcript at a clean
// line-boundary before Phase 1 so dev-led pipeline runs cost a fraction
// of a real session while still exercising every phase (1 → 2 → 3 → 4 → 6).
//
// Visibility: this card is rendered ONLY when the parent component
// (App.tsx) passes devModeUnlocked=true. The unlock is the 5-tap on
// the coat-of-arms logo (session-local React state). A non-dev user
// never sees this card, even if they hand-edit `devTestMode.enabled`
// in settings.json — the pipeline reads the setting regardless, but
// the surface is the safety rail.

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { FlaskConical, Loader2 } from 'lucide-react'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

type Settings = {
  devTestMode: { enabled: boolean; maxChars: number }
}

export function DevTestModeCard() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [saving, setSaving] = useState(false)
  const [maxCharsDraft, setMaxCharsDraft] = useState('')

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/settings')
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const body = (await res.json()) as Settings
        setSettings(body)
        setMaxCharsDraft(String(body.devTestMode.maxChars))
      } catch (err) {
        console.warn('[DevTestModeCard] failed to load settings:', err)
      }
    })()
  }, [])

  async function patch(next: Partial<Settings['devTestMode']>) {
    if (!settings) return
    setSaving(true)
    const merged = { ...settings.devTestMode, ...next }
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ devTestMode: merged }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = (await res.json()) as Settings
      setSettings(body)
      setMaxCharsDraft(String(body.devTestMode.maxChars))
    } catch (err) {
      toast.error(`Failed to update dev test mode: ${(err as Error).message}`)
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
            Loading dev test mode…
          </div>
        </CardContent>
      </Card>
    )
  }

  const { enabled, maxChars } = settings.devTestMode

  // Rough chunk-count preview using the static chunk-size table assumptions.
  // Free Flash Phase 1 chunks at 8KB, Paid Pro Phase 3 at 60KB. Show both
  // so the user knows what their truncation will cost in chunks per phase.
  const freeFlashChunks = Math.max(1, Math.ceil(maxChars / 8000))
  const paidProChunks = Math.max(1, Math.ceil(maxChars / 60000))

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FlaskConical className="h-5 w-5" />
          Dev test mode (truncate transcripts)
          <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-300">
            dev-only
          </span>
        </CardTitle>
        <CardDescription>
          When ON, every transcript sent to the pipeline gets truncated at a clean line break
          before Phase 1 starts. Every phase still runs end-to-end, so you can verify the whole
          pipeline works without paying for a full multi-hundred-KB session run.
          This card only appears while dev mode is unlocked
          (5 taps on the coat-of-arms logo).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <label className="flex cursor-pointer items-start gap-3 rounded-md border bg-card p-3 hover:bg-muted/30">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 shrink-0"
            checked={enabled}
            disabled={saving}
            onChange={(e) => void patch({ enabled: e.target.checked })}
          />
          <div className="space-y-1 text-sm">
            <div className="font-medium">
              Truncate transcripts before pipeline runs
            </div>
            <div className="text-xs text-muted-foreground">
              Affects every <code className="rounded bg-muted px-1">Begin the Chronicle</code> run while
              this is ON. Default <strong>OFF</strong>. A banner appears on the Chronicle tab during
              each run so you can never accidentally process a truncated transcript thinking it was
              the whole thing.
            </div>
          </div>
        </label>

        <div className="space-y-2">
          <label className="text-sm font-medium">Max transcript chars</label>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1000}
              max={200000}
              step={1000}
              value={maxCharsDraft}
              disabled={saving || !enabled}
              onChange={(e) => setMaxCharsDraft(e.target.value)}
              onBlur={() => {
                const n = parseInt(maxCharsDraft, 10)
                if (Number.isFinite(n) && n !== maxChars) void patch({ maxChars: n })
                else setMaxCharsDraft(String(maxChars))
              }}
              className="h-9 w-32 rounded-md border border-input bg-background px-3 text-sm shadow-sm disabled:opacity-50"
            />
            <span className="text-xs text-muted-foreground">
              ≈ {freeFlashChunks} chunk{freeFlashChunks === 1 ? '' : 's'} on Free Flash (8KB chunks)
              · ≈ {paidProChunks} chunk{paidProChunks === 1 ? '' : 's'} on Paid Pro (60KB chunks)
            </span>
          </div>
          <div className="text-xs text-muted-foreground">
            Range: 1,000 – 200,000 chars. Default 24,000 (~3 Free Flash chunks · ~1 Paid Pro chunk).
            Truncation cuts at the nearest newline so utterances stay whole.
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
