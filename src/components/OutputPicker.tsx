// Output picker — sits between the DM-questions step and the actual run.
// User picks which of {Chronicle, Extras, Condensed} this run should
// produce. Selection persists across runs via localStorage so a returning
// user resumes their preferred shape.
//
// Phase dependency note: Condensed (Phase 6) requires Chronicle (Phase 3)
// because Phase 6's prompt consumes the chronicle text. The picker
// enforces this by auto-flipping Chronicle on whenever Condensed is
// turned on. No direct-condense path today.

import { useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { BookOpen, FileText, Play, Sparkles } from 'lucide-react'
import type { OutputSelection } from '@/types'
import { CondenseSlider } from './CondenseSlider'

type Props = {
  /** Initial selection — typically the value persisted in localStorage
   *  (caller wires this via useLocalStorage). */
  initial: OutputSelection
  /** Fired when the user clicks "Run with selection". The caller is
   *  responsible for persisting + dispatching the pipeline. */
  onConfirm: (selection: OutputSelection) => void
  /** Fired when the user clicks "Back" so they can change DM answers. */
  onBack?: () => void
  /** Approximate chunk count from the grounded transcript so we can show
   *  a rough cost-hint per phase. Optional. */
  estimatedChunks?: number
  /** Best-available word-count estimate of the (not-yet-generated)
   *  chronicle, used as the basis for the Condense Slider's live
   *  preview. Phase 6 recomputes the actual target at runtime using
   *  the real chronicle word count, so this is only for UI feedback. */
  chronicleWordCountEstimate?: number
}

export function OutputPicker({ initial, onConfirm, onBack, estimatedChunks, chronicleWordCountEstimate }: Props) {
  const [chronicle, setChronicle] = useState(initial.chronicle)
  const [extras, setExtras] = useState(initial.extras)
  const [condensed, setCondensed] = useState(initial.condensed)
  const [condensePercentage, setCondensePercentage] = useState(initial.condensePercentage)

  const noneSelected = !chronicle && !extras && !condensed

  // Clicking Condensed when Chronicle is off auto-flips Chronicle on. We
  // do this in the onChange handler rather than disabling the checkbox so
  // the user gets the affordance without an extra click.
  function onCondensedToggle(next: boolean) {
    setCondensed(next)
    if (next && !chronicle) setChronicle(true)
  }
  // Clicking Chronicle off auto-flips Condensed off (since Condensed needs
  // Chronicle). Matches the same one-click affordance.
  function onChronicleToggle(next: boolean) {
    setChronicle(next)
    if (!next && condensed) setCondensed(false)
  }

  function onRun() {
    if (noneSelected) return
    onConfirm({ chronicle, extras, condensed, condensePercentage })
  }

  // Phase plan preview — describes exactly which phases will fire so the
  // user can sanity-check the cost before clicking Run. Phase 5 (Polish)
  // is shown as "(local-LLM only; cloud providers skip)" rather than
  // hidden — it's part of the architecture so users on a local backend
  // know to expect it. Cloud users see the same label so they can match
  // it against the "Phase 5 skipped" line they'll later see in logs.
  const phasesThatWillRun: string[] = []
  if (chronicle) phasesThatWillRun.push('Phase 3 (Chronicle)', 'Phase 5 (Polish — local-LLM only; cloud providers skip)')
  if (extras) phasesThatWillRun.push('Phase 4 (Extras)')
  if (condensed) phasesThatWillRun.push('Phase 6 (Condense)')

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="h-5 w-5" />
          Pick outputs for this run
        </CardTitle>
        <CardDescription>
          Phase 1 + 2 are complete. Choose which downstream outputs you want — skipped
          phases never call the model, so this is where you save API tokens. You can
          always generate the remaining outputs later from the chronicle card.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <label className="flex cursor-pointer items-start gap-3 rounded border p-3 hover:bg-muted/40">
          <input
            type="checkbox"
            checked={chronicle}
            onChange={(e) => onChronicleToggle(e.target.checked)}
            className="mt-1 h-4 w-4"
            aria-label="Generate chronicle"
          />
          <span className="flex flex-1 flex-col">
            <span className="flex items-center gap-2 font-medium">
              <BookOpen className="h-4 w-4" /> Chronicle
            </span>
            <span className="text-xs text-muted-foreground">
              Narrative prose of the session. Runs Phase 3 (and Phase 5 Polish if your active provider is a local LLM; cloud providers skip Phase 5 by design).
              Most expensive output — skip if you only want quotes/jests/gore.
            </span>
          </span>
        </label>

        <label className="flex cursor-pointer items-start gap-3 rounded border p-3 hover:bg-muted/40">
          <input
            type="checkbox"
            checked={extras}
            onChange={(e) => setExtras(e.target.checked)}
            className="mt-1 h-4 w-4"
            aria-label="Generate extras"
          />
          <span className="flex flex-1 flex-col">
            <span className="flex items-center gap-2 font-medium">
              <Sparkles className="h-4 w-4" /> Extras (quotes, jests, gore)
            </span>
            <span className="text-xs text-muted-foreground">
              Curated lists of memorable lines, comedic bits, and combat moments.
              Independent of Chronicle — you can take extras without a chronicle
              for the fastest token-light run.
            </span>
          </span>
        </label>

        <label className="flex cursor-pointer items-start gap-3 rounded border p-3 hover:bg-muted/40">
          <input
            type="checkbox"
            checked={condensed}
            onChange={(e) => onCondensedToggle(e.target.checked)}
            className="mt-1 h-4 w-4"
            aria-label="Generate condensed chronicle"
          />
          <span className="flex flex-1 flex-col">
            <span className="flex items-center gap-2 font-medium">
              <FileText className="h-4 w-4" /> Condensed chronicle
            </span>
            <span className="text-xs text-muted-foreground">
              Tighter narrative + 10–15 catch-up bullets. <strong>Requires Chronicle</strong> —
              the condense prompt consumes the chronicle text. Picking this auto-enables
              Chronicle.
            </span>
            {condensed && (
              <CondenseSlider
                value={condensePercentage}
                onChange={setCondensePercentage}
                estimatedChronicleWords={chronicleWordCountEstimate ?? 0}
              />
            )}
          </span>
        </label>

        {!noneSelected && phasesThatWillRun.length > 0 && (
          <div className="rounded border border-blue-500/30 bg-blue-50 p-3 text-xs dark:bg-blue-950/30">
            <p className="font-medium">This run will execute:</p>
            <ul className="mt-1 list-disc pl-4 text-muted-foreground">
              {phasesThatWillRun.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
            {estimatedChunks && estimatedChunks > 0 ? (
              <p className="mt-2 text-muted-foreground">
                Approximate work: ~{estimatedChunks} chunks per phase, so roughly{' '}
                {estimatedChunks * phasesThatWillRun.length} model calls total.
              </p>
            ) : null}
          </div>
        )}

        {noneSelected && (
          <div className="rounded border border-amber-500/40 bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
            Select at least one output. With nothing checked, no phases run and
            you'd have to start over from Phase 1 to get any output.
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
          {onBack && (
            <Button variant="ghost" onClick={onBack}>
              Back
            </Button>
          )}
          <Button onClick={onRun} disabled={noneSelected} className="ml-auto">
            <Play className="mr-1 h-4 w-4" />
            Run with selection
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
