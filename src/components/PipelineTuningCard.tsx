// Pipeline tuning — one card for every optional quality/cost adjustment.
//
// Replaces three separate full-width cards (alias hints, quote reassembly,
// vault retrieval) that each spent ~150px explaining themselves in prose.
// Same three settings, same defaults, same endpoint — the change is purely
// presentational: one scannable line each, with the rationale, measurements
// and caveats folded behind an ⓘ.
//
// Each row also carries an "impact" chip showing the measured effect, so a
// new user can tell at a glance which switches matter without reading a
// word of the detail.

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Loader2, SlidersHorizontal, AlertTriangle } from 'lucide-react'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { InfoHint } from '@/components/ui/info-hint'

type TuningSettings = {
  phase1AliasHints: boolean
  reassembleQuotes: boolean
  retrieveVaultKb: boolean
}

type RowDef = {
  key: keyof TuningSettings
  title: string
  /** One line, plain language. Everything else goes in the hint. */
  blurb: string
  /** Measured effect, shown as a chip. Keep it short and factual. */
  impact: string
  impactTone: 'good' | 'neutral'
  hintLabel: string
  hint: React.ReactNode
  /** Rendered in amber under the row when the setting is ON. */
  caveat?: React.ReactNode
}

const ROWS: RowDef[] = [
  {
    key: 'retrieveVaultKb',
    title: 'Send only relevant lore to Condense',
    blurb: 'Condense receives just the notes your chronicle mentions, instead of your whole vault.',
    impact: '−92% lore sent',
    impactTone: 'good',
    hintLabel: 'About lore retrieval',
    hint: (
      <>
        <p className="mb-2">
          Condense is the only step that receives your entire lore vault — every note, on every
          run, to shorten a chronicle that is already written.
        </p>
        <p className="mb-2">
          Measured on a 2.13&nbsp;MB vault: <strong>2,228,864 → 176,196 characters</strong>, with
          all 17 referenced entities still present.
        </p>
        <p className="mb-2">
          Selection works on any vault layout — it matches note titles and frontmatter aliases,
          never folder names.
        </p>
        <p className="text-emerald-700 dark:text-emerald-400">
          This cannot silently lose lore: any note named in your chronicle is always included. A
          bad match can only send a few extra notes, never drop one.
        </p>
      </>
    ),
  },
  {
    key: 'reassembleQuotes',
    title: 'Reassemble fragmented quotes',
    blurb: 'Lets the Extras phase rejoin split speech into complete sentences before quoting it.',
    impact: 'quotes 70% → 93% complete',
    impactTone: 'good',
    hintLabel: 'About quote reassembly',
    hint: (
      <>
        <p className="mb-2">
          Transcription cuts each speaker into roughly two-second slices, so one spoken sentence is
          usually split across several lines with no punctuation. Quoting verbatim then lifts a
          single slice — which is how you get <em>“took more than that”</em> when the “I” was on
          the line above.
        </p>
        <p className="mb-2">
          With this on, the phase may rejoin a speaker’s consecutive fragments and restore
          punctuation, producing <em>“I took more than that.”</em>
        </p>
        <p>
          Measured across two chunks, five runs each, blind-judged: grammatically complete quotes
          rose <strong>70% → 93%</strong> and truncated quotes fell <strong>25% → 5%</strong>, with
          quote volume unchanged. Costs nothing extra — it is only a prompt change.
        </p>
      </>
    ),
    caveat: (
      <>
        Verbatim fidelity drops slightly: about <strong>one quote in six</strong> gets a light edit
        — usually a stutter dropped (<em>“stunning a strike”</em> → <em>“stunning strike”</em>),
        occasionally a word substituted. Leave this off if exact word-for-word accuracy matters more
        than readable sentences.
      </>
    ),
  },
  {
    key: 'phase1AliasHints',
    title: 'Use lore aliases to catch misheard names',
    blurb: 'Grounding gets phonetic hints from your lore index, for names transcription mangles.',
    impact: 'no extra cost',
    impactTone: 'neutral',
    hintLabel: 'About alias hints',
    hint: (
      <>
        <p className="mb-2">
          Grounding consumes your lore alias index to catch phonetic mishearings that exact
          matching misses — for example a name transcribed as <em>“more than vain”</em> is
          annotated as a suggestion for <em>“Morvan Vayne”</em>, which the model accepts or rejects
          from context.
        </p>
        <p className="mb-2">
          <strong>Zero extra cost</strong> — the hint just sits in the prompt.
        </p>
        <p>
          The matcher is tuned conservatively, so it will not catch every mishearing. For names it
          repeatedly gets wrong, a Glossary entry in the Tome of Lore tab is the reliable fix — that
          runs before any AI and is exact.
        </p>
      </>
    ),
  },
]

export function PipelineTuningCard() {
  const [settings, setSettings] = useState<TuningSettings | null>(null)
  const [saving, setSaving] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/settings')
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const body = (await res.json()) as Partial<TuningSettings>
        setSettings({
          phase1AliasHints: body.phase1AliasHints === true,
          reassembleQuotes: body.reassembleQuotes === true,
          retrieveVaultKb: body.retrieveVaultKb === true,
        })
      } catch (err) {
        console.warn('[PipelineTuningCard] failed to load settings:', err)
      }
    })()
  }, [])

  async function toggle(key: keyof TuningSettings, next: boolean) {
    if (!settings) return
    setSaving(key)
    const prev = settings
    setSettings({ ...settings, [key]: next })
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: next }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    } catch (err) {
      setSettings(prev)
      toast.error(`Couldn't save that setting: ${(err as Error).message}`)
    } finally {
      setSaving(null)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <SlidersHorizontal className="h-5 w-5" />
          Pipeline tuning
        </CardTitle>
        <CardDescription>
          Optional adjustments to output quality and cost. Every one defaults to <strong>off</strong>
          {' '}— your runs behave exactly as they do today until you change something here.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!settings ? (
          <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading settings…
          </div>
        ) : (
          <div className="divide-y divide-border/60 rounded-md border">
            {ROWS.map((row) => {
              const on = settings[row.key]
              return (
                <div key={row.key} className="p-3">
                  <label className="flex cursor-pointer items-start gap-3">
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 shrink-0"
                      checked={on}
                      disabled={saving === row.key}
                      onChange={(e) => void toggle(row.key, e.target.checked)}
                    />
                    <span className="min-w-0 flex-1 space-y-0.5">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">{row.title}</span>
                        <span
                          className={
                            row.impactTone === 'good'
                              ? 'rounded-full bg-emerald-600/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-400'
                              : 'rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground'
                          }
                        >
                          {row.impact}
                        </span>
                        <InfoHint label={row.hintLabel}>{row.hint}</InfoHint>
                        {saving === row.key && (
                          <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                        )}
                      </span>
                      <span className="block text-xs text-muted-foreground">{row.blurb}</span>
                    </span>
                  </label>
                  {row.caveat && on && (
                    <div className="mt-2 ml-7 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-500" />
                      <span className="text-muted-foreground">{row.caveat}</span>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
