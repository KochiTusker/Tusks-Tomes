// One phase, one row, one decision.
//
// The old editor split this across two grids — a profile default and an
// override — which meant the answer to "what runs Chronicle" lived in two
// places and the user had to know which won. Here the row states the model in
// effect, says where that came from, and opens one picker to change it.
//
// Each row also carries what the phase IS and what it costs, because the two
// facts that actually drive the decision are "how hard is this phase" and "how
// much does it cost here" — and both vary enormously between phases.

import { ChevronDown, RotateCcw } from 'lucide-react'
import { PHASE_LABELS, type Grade, type Phase } from '@/lib/phaseGrades'
import type { PhaseOption } from '@/lib/phaseOptions'

/** What each phase does, in the terms someone choosing a model needs. */
export const PHASE_BRIEF: Record<Phase, { what: string; wants: string }> = {
  phase1: {
    what: 'Corrects transcription errors against your lore. Near 1:1 in and out.',
    wants: 'Accuracy and obedience, not flair. The most calls of any phase, so price shows up here.',
  },
  phase2: {
    what: 'Reads raw and corrected side by side and asks the DM only what it must.',
    wants: 'Cheap and terse — it emits almost nothing. No model has been graded on this phase yet.',
  },
  phase3: {
    what: 'Writes the narrative chronicle. Exhaustive, in the table’s own voice.',
    wants: 'Prose judgement, and tolerance for mature content. Usually most of the bill.',
  },
  phase4: {
    what: 'Pulls the quotes, jests and gore worth keeping.',
    wants: 'A sense of humour and an ear for an exchange. Cheap — output is tiny.',
  },
  phase6: {
    what: 'Condenses the finished chronicle into a recap.',
    wants: 'Same prose judgement as Chronicle, over a shorter output.',
  },
}

const GRADE_STYLE: Record<Grade, string> = {
  A: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  B: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  C: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  D: 'bg-red-500/15 text-red-600 dark:text-red-400',
  F: 'bg-red-500/20 text-red-700 dark:text-red-400',
  untested: 'bg-muted text-muted-foreground',
}

function money(usd: number | null | undefined): string {
  if (usd === null || usd === undefined) return 'on your plan'
  if (usd === 0) return 'free'
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  if (usd < 1) return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(2)}`
}

export function PhaseRoutingRow(props: {
  phase: Phase
  /** The model actually in effect, whether inherited or overridden. */
  effectiveModelId: string
  effectiveProviderLabel: string
  /** Known facts about the effective model, when it is one we can identify. */
  effective?: Pick<PhaseOption, 'grade' | 'cost'>
  /** True when this phase carries an explicit override rather than inheriting. */
  overridden: boolean
  open: boolean
  onToggle: () => void
  onReset: () => void
  children?: React.ReactNode
}) {
  const brief = PHASE_BRIEF[props.phase]
  const grade = props.effective?.grade ?? 'untested'

  return (
    <div className="rounded-md border border-border">
      <div className="flex flex-col gap-2 p-3 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{PHASE_LABELS[props.phase]}</span>
            {props.overridden ? (
              <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-400">
                Overridden
              </span>
            ) : (
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                Inherited
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">{brief.what}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            <span className="font-medium">Wants:</span> {brief.wants}
          </p>
        </div>

        <div className="flex shrink-0 flex-col items-stretch gap-1 sm:w-[22rem]">
          <button
            type="button"
            onClick={props.onToggle}
            className="flex items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-left text-sm hover:bg-muted"
          >
            <span className="truncate font-mono text-xs">{props.effectiveModelId}</span>
            <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
              {props.effectiveProviderLabel}
            </span>
            <span className={`shrink-0 rounded px-1 py-0.5 font-mono text-[10px] ${GRADE_STYLE[grade]}`}>
              {grade === 'untested' ? '—' : grade}
            </span>
            <ChevronDown className="ml-auto h-4 w-4 shrink-0 text-muted-foreground" />
          </button>
          <div className="flex items-center justify-between px-1">
            <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
              {money(props.effective?.cost)} this phase
            </span>
            {props.overridden && (
              <button
                type="button"
                onClick={props.onReset}
                className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
              >
                <RotateCcw className="h-3 w-3" />
                Reset
              </button>
            )}
          </div>
        </div>
      </div>
      {props.open && <div className="border-t border-border p-3">{props.children}</div>}
    </div>
  )
}
