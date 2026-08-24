// Choosing a model for one phase, out of everything configured.
//
// This replaced two overlapping grids. The old editor asked "which model runs
// Chronicle" twice — once as the active provider's profile default, once as a
// per-phase override — with different model lists, and only one of them could
// reach OpenRouter. A user had to know which grid won.
//
// Three ideas do the work here:
//
//   A model is good AT A PHASE, not in general. The same model graded top of
//   the field on one phase and near the bottom on another, so every grade,
//   cost and recommendation is per-phase and the phase is the first input.
//
//   Cost is per-phase too. Chronicle emits output at ~0.9x its input while
//   Audit emits ~0.02x, and reasoning bills as output — so ranking candidates
//   by headline token price puts them in close to the wrong order.
//
//   Most of the catalogue is unmeasured. Rather than hide that, the tested
//   models lead and everything else sits under its CONNECTION — the key or
//   subscription it is reached through. Connection rather than vendor,
//   because the same Gemini model on a Google key and on OpenRouter differ in
//   price, reliability and measured quality, and grouping by vendor filed
//   them together and hid exactly that.

import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Search, Sparkles, X } from 'lucide-react'
import { GRADE_MEANING, PHASE_LABELS, type Grade, type Phase } from '@/lib/phaseGrades'
import {
  CONNECTION_BILLING,
  CONNECTION_LABEL,
  type Connection,
  type PhaseOption,
  type SortKey,
  comparePhaseOptions,
  filterPhaseOptions,
  groupByConnection,
  groupOpenRouterByVendor,
  recommendedFor,
} from '@/lib/phaseOptions'
import { type DeveloperPick, hasPicks, vendorLabel } from '@/lib/developerPicks'

const SORT_LABELS: Record<SortKey, string> = {
  picks: "Developer's picks",
  performance: 'Performance',
  cost: 'Cost for this phase',
}

const GRADE_ORDER: Record<Grade, number> = { A: 0, B: 1, C: 2, D: 3, F: 5, untested: 4 }

const GRADE_STYLE: Record<Grade, string> = {
  A: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  B: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  C: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  D: 'bg-red-500/15 text-red-600 dark:text-red-400',
  F: 'bg-red-500/20 text-red-700 dark:text-red-400 font-semibold',
  untested: 'bg-muted text-muted-foreground',
}

const TAG_LABEL: Record<DeveloperPick['tag'], string> = {
  balanced: 'Balanced',
  value: 'Best value',
  quality: 'Best quality',
  fastest: 'Fastest',
  cheapest: 'Cheapest',
}

function money(usd: number | null): string {
  if (usd === null) return 'on your plan'
  if (usd === 0) return 'free'
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  if (usd < 1) return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(2)}`
}

export function PhaseModelPicker(props: {
  phase: Phase
  options: PhaseOption[]
  /** Currently selected option key, or null when the phase uses the default. */
  value: string | null
  onSelect: (option: PhaseOption) => void
  onCancel: () => void
}) {
  const { phase, options } = props
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortKey>(hasPicks(phase) ? 'picks' : 'performance')
  const [testedOnly, setTestedOnly] = useState(false)
  const [matureOnly, setMatureOnly] = useState(false)
  const [openVendors, setOpenVendors] = useState<Set<string>>(new Set())
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    searchRef.current?.focus()
  }, [])

  // Searching is a whole-catalogue action: someone typing a model name wants
  // it found, not told it sits behind a control they have not pressed.
  const searching = query.trim().length > 0

  const filtered = useMemo(
    () => filterPhaseOptions(options, { query, testedOnly, matureOnly }),
    [options, query, testedOnly, matureOnly],
  )

  const sortFn = useMemo(() => comparePhaseOptions(sort), [sort])

  const recommended = useMemo(() => recommendedFor(filtered, sort), [filtered, sort])

  /**
   * Connections first, vendors only inside OpenRouter.
   *
   * Grouping by model vendor put "Gemini on your Google key" and "Gemini
   * through OpenRouter" in the same folder. They are different prices,
   * different reliability, and measured differently — so the connection is
   * the distinction worth showing first, and the one people actually think in
   * ("is that on my subscription or my card?").
   */
  const byConnection = useMemo(() => groupByConnection(filtered, sort), [filtered, sort])

  const openRouterByVendor = useMemo(
    () => groupOpenRouterByVendor(filtered, sort),
    [filtered, sort],
  )

  const testedCount = useMemo(() => options.filter((o) => o.tested).length, [options])
  const matureCount = useMemo(() => options.filter((o) => o.mature).length, [options])

  const toggleVendor = (v: string) =>
    setOpenVendors((prev) => {
      const next = new Set(prev)
      if (next.has(v)) next.delete(v)
      else next.add(v)
      return next
    })

  return (
    <div className="flex max-h-[30rem] flex-col gap-2.5 rounded-md border border-border bg-background p-3 shadow-lg">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${options.length} models across every provider…`}
            className="w-full rounded border border-border bg-background py-1.5 pl-7 pr-2 text-sm"
          />
        </div>
        <button
          type="button"
          onClick={props.onCancel}
          className="rounded p-1.5 text-muted-foreground hover:bg-muted"
          aria-label="Close model picker"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-muted-foreground">Sort</span>
        {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setSort(k)}
            disabled={k === 'picks' && !hasPicks(phase)}
            className={`rounded px-2 py-0.5 text-xs transition-colors disabled:opacity-40 ${
              sort === k ? 'bg-primary text-primary-foreground' : 'bg-muted hover:bg-muted/70'
            }`}
          >
            {SORT_LABELS[k]}
          </button>
        ))}
        <label className="ml-2 flex cursor-pointer items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            checked={testedOnly}
            onChange={(e) => setTestedOnly(e.target.checked)}
            className="h-3 w-3"
          />
          Tested only
          <span className="text-muted-foreground">({testedCount})</span>
        </label>
        <label
          className="flex cursor-pointer items-center gap-1.5 text-xs"
          title="Measured writing up graphic violence and crude dialogue without softening it."
        >
          <input
            type="checkbox"
            checked={matureOnly}
            onChange={(e) => setMatureOnly(e.target.checked)}
            className="h-3 w-3"
          />
          Handles mature content
          <span className="text-muted-foreground">({matureCount})</span>
        </label>
      </div>

      <p className="text-xs text-muted-foreground">
        Cost shown is <strong>{PHASE_LABELS[phase]} alone</strong>, for a 3-hour session. “Tested”
        means graded on real session material — on this phase or another.
      </p>

      <div className="flex-1 overflow-y-auto pr-1">
        {searching ? (
          <Section title={`${filtered.length} matching`}>
            {[...filtered].sort(sortFn).map((o) => (
              <Row key={o.key} o={o} selected={o.key === props.value} onSelect={props.onSelect} />
            ))}
            {filtered.length === 0 && (
              <p className="px-2 py-3 text-sm text-muted-foreground">Nothing matches “{query}”.</p>
            )}
          </Section>
        ) : (
          <>
            <Section title={`Recommended for ${PHASE_LABELS[phase]}`}>
              {recommended.length === 0 ? (
                <p className="px-2 py-3 text-sm text-muted-foreground">
                  Nothing has been measured on {PHASE_LABELS[phase]} yet. Browse by provider below —
                  and treat what you find as untested rather than unsuitable.
                </p>
              ) : (
                recommended.map((o) => (
                  <Row key={o.key} o={o} selected={o.key === props.value} onSelect={props.onSelect} />
                ))
              )}
            </Section>

            <div className="mt-2 space-y-0.5">
              <p className="px-2 pb-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                By connection
              </p>
              {byConnection.map(([conn, list]) => {
                const open = openVendors.has(`conn:${conn}`)
                const best = list.reduce(
                  (acc, o) => Math.min(acc, GRADE_ORDER[o.grade]),
                  GRADE_ORDER.untested,
                )
                return (
                  <div key={conn}>
                    <button
                      type="button"
                      onClick={() => toggleVendor(`conn:${conn}`)}
                      className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-sm hover:bg-muted"
                    >
                      {open ? (
                        <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                      )}
                      <span className="font-medium">{CONNECTION_LABEL[conn]}</span>
                      <span className="text-xs text-muted-foreground">{list.length}</span>
                      {best <= GRADE_ORDER.B && (
                        <Sparkles
                          className="h-3 w-3 text-emerald-500"
                          aria-label="contains a tested model"
                        />
                      )}
                    </button>
                    {open && (
                      <div className="ml-4 border-l border-border pl-2">
                        <p className="px-2 py-1 text-[11px] text-muted-foreground">
                          {CONNECTION_BILLING[conn]}
                        </p>
                        {conn === 'openrouter' ? (
                          // The only catalogue big enough to need a second
                          // level. Everything else is short enough to list.
                          openRouterByVendor.map(([vendor, vlist]) => {
                            const vopen = openVendors.has(`vendor:${vendor}`)
                            return (
                              <div key={vendor}>
                                <button
                                  type="button"
                                  onClick={() => toggleVendor(`vendor:${vendor}`)}
                                  className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-sm hover:bg-muted"
                                >
                                  {vopen ? (
                                    <ChevronDown className="h-3 w-3 shrink-0" />
                                  ) : (
                                    <ChevronRight className="h-3 w-3 shrink-0" />
                                  )}
                                  <span>{vendorLabel(vendor)}</span>
                                  <span className="text-xs text-muted-foreground">
                                    {vlist.length}
                                  </span>
                                </button>
                                {vopen && (
                                  <div className="ml-3 border-l border-border pl-2">
                                    {vlist.map((o) => (
                                      <Row
                                        key={o.key}
                                        o={o}
                                        selected={o.key === props.value}
                                        onSelect={props.onSelect}
                                      />
                                    ))}
                                  </div>
                                )}
                              </div>
                            )
                          })
                        ) : (
                          list.map((o) => (
                            <Row
                              key={o.key}
                              o={o}
                              selected={o.key === props.value}
                              onSelect={props.onSelect}
                            />
                          ))
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function Section(props: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="px-2 pb-1 pt-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {props.title}
      </p>
      {props.children}
    </div>
  )
}

function Row(props: {
  o: PhaseOption
  selected: boolean
  onSelect: (o: PhaseOption) => void
}) {
  const { o } = props
  return (
    <button
      type="button"
      onClick={() => props.onSelect(o)}
      disabled={Boolean(o.blockedReason)}
      title={o.blockedReason}
      className={`flex w-full flex-col gap-0.5 rounded px-2 py-1.5 text-left transition-colors disabled:opacity-45 ${
        props.selected ? 'bg-primary/10 ring-1 ring-primary/40' : 'hover:bg-muted'
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="truncate font-mono text-xs">{o.modelId}</span>
        <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
          {o.providerLabel}
        </span>
        <span
          className={`shrink-0 rounded px-1 py-0.5 font-mono text-[10px] ${GRADE_STYLE[o.grade]}`}
          title={GRADE_MEANING[o.grade]}
        >
          {o.grade === 'untested' ? '—' : o.grade}
        </span>
        {o.mature && (
          <span
            className="shrink-0 rounded bg-emerald-500/10 px-1 py-0.5 text-[10px] text-emerald-700 dark:text-emerald-400"
            title="Measured carrying graphic violence and crude dialogue without sanitising it."
          >
            mature ok
          </span>
        )}
        {o.pick && (
          <span className="shrink-0 rounded bg-primary/15 px-1 py-0.5 text-[10px] text-primary">
            {TAG_LABEL[o.pick.tag]}
          </span>
        )}
        <span className="ml-auto shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
          {o.blockedReason ? 'cannot run' : money(o.cost)}
        </span>
      </div>
      {o.pick && <p className="pr-2 text-xs leading-snug text-muted-foreground">{o.pick.reason}</p>}
      {o.pick?.requires && (
        <p className="text-[11px] text-amber-600 dark:text-amber-400">Needs: {o.pick.requires}</p>
      )}
    </button>
  )
}
