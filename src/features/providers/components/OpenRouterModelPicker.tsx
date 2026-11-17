// OpenRouter model picker.
//
// OpenRouter publishes its whole catalogue without auth, so — uniquely among
// the providers here — the app can show what a model costs, how much context
// it has, whether it can emit JSON, whether it filters prompts, and what its
// host does with a transcript, all before a single call is made.
//
// Grades are the important part, and they are narrower than they look. See
// src/features/routing/lib/phaseGrades.ts: a letter appears only where a model has actually
// been compared against the reference on that phase. Everything else shows a
// dash. An earlier version of this card graded on capability fields alone,
// which meant anything without a structural blocker came out green — including
// models that produce poor output. That was misleading in exactly the way a
// badge should not be, so the grades now refuse to guess.

import { useEffect, useMemo, useState } from 'react'
import { Loader2, RefreshCw, Search, ShieldAlert, ShieldCheck, TriangleAlert } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/platform/ui/card'
import { Input } from '@/platform/ui/input'
import { Button } from '@/platform/ui/button'
import { CATALOGUE_REFRESHED_EVENT } from '@/platform/lib/appEvents'
import { InfoHint } from '@/platform/ui/info-hint'
import {
  formatRate,
  formatTokens,
  MATURE_CONTENT_MEASURED_OK,
  getOpenRouterCatalogue,
  isTextPipelineModel,
  type CatalogueResult,
  type OpenRouterModelInfo,
} from '@/features/providers/lib/openrouterModelsClient'
import { isUnrecommended, SMALL_MODEL_CEILING_B } from '@/features/providers/lib/modelVisibility'
import { useShowAllModels } from '@/features/providers/lib/useShowAllModels'
import {
  GEMINI_PRO_REFERENCE,
  GRADE_MEANING,
  MEASURED_MODEL_IDS,
  PHASE_LABELS,
  PHASE_ORDER,
  REFERENCE_SESSION,
  isIndirectGrade,
  judgeAllPhases,
  measuredPhaseCount,
  overallVerdict,
  PREDICTIONS_DATED,
  referenceSessionCost,
  type Grade,
  type MeasurementSource,
  type OverallVerdict,
  type Phase,
} from '@/features/routing'

type SortKey = 'price' | 'context' | 'name'

export function OpenRouterModelPicker() {
  // Collapsed by default: this is a reference table, not a control — nothing
  // here writes routing. Phase models are picked in the per-phase rows above;
  // this exists for browsing the catalogue's prices, grades and policies.
  // The catalogue is only fetched once the disclosure is first opened, so
  // users who never open it never pay for the request.
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<CatalogueResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortKey>('price')
  const [showFree, setShowFree] = useState(false)
  // Shared with the per-phase routing dropdowns — see useShowAllModels. The
  // browser used to hide these behind a tick that governed only this table,
  // which meant a model could be filtered out of the reference view and still
  // sit in the dropdown where it actually gets chosen.
  const [showWeak, setShowWeak] = useShowAllModels()
  // Off by default: it narrows the list to what has been MEASURED carrying
  // mature content, which is far fewer models than can actually do it. On by
  // default it would read as "everything else refuses", which is not known.
  const [matureOnly, setMatureOnly] = useState(false)
  // Off by default: the catalogue is the point of this card, and opening it
  // pre-filtered to 19 rows would hide the ~400 it exists to show. On demand
  // it answers a different question — "what has the maintainer actually run?"
  const [testedOnly, setTestedOnly] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => {
    if (!open || data !== null) return
    let alive = true
    getOpenRouterCatalogue().then((r) => {
      if (!alive) return
      setData(r)
      setLoading(false)
    })
    return () => {
      alive = false
    }
  }, [open, data])

  // Re-read when the catalogue is refreshed elsewhere. A forced fetch has
  // already updated the client's memo, so the plain call returns it.
  useEffect(() => {
    if (data === null) return
    const onRefreshed = () => {
      void getOpenRouterCatalogue().then((r) => setData(r))
    }
    window.addEventListener(CATALOGUE_REFRESHED_EVENT, onRefreshed)
    return () => window.removeEventListener(CATALOGUE_REFRESHED_EVENT, onRefreshed)
  }, [data])

  const refresh = async () => {
    setRefreshing(true)
    setData(await getOpenRouterCatalogue({ force: true }))
    setRefreshing(false)
  }

  const rows = useMemo(() => {
    if (!data) return []
    const q = query.trim().toLowerCase()
    // Image, speech, video and embedding endpoints cannot run a phase, so they
    // are excluded rather than offered and left to fail at run time.
    let list = data.models.filter(isTextPipelineModel)
    if (!showFree) list = list.filter((m) => !m.isFree)
    if (matureOnly) list = list.filter((m) => MATURE_CONTENT_MEASURED_OK.has(m.id))
    // Individually measured only — see MEASURED_MODEL_IDS for why this is not
    // `grade !== 'untested'`. Applied before showWeak so a measured D still
    // shows: the question this answers is "what was tested", not "what won".
    if (testedOnly) list = list.filter((m) => MEASURED_MODEL_IDS.has(m.id))
    // Hide anything measured worse than the reference on every phase it was
    // assessed on, plus untested models whose own id declares a single-digit
    // parameter count. An untested model that declares nothing stays visible —
    // an unknown is not a low score, and hiding those would quietly bury most
    // of the catalogue behind a checkbox nobody ticks.
    if (!showWeak && !testedOnly) list = list.filter((m) => !isUnrecommended(m))
    if (q) {
      list = list.filter(
        (m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q),
      )
    }
    const sorted = [...list]
    if (sort === 'price') {
      sorted.sort((a, b) => a.inputPerM + a.outputPerM - (b.inputPerM + b.outputPerM))
    }
    if (sort === 'context') sorted.sort((a, b) => b.contextLength - a.contextLength)
    if (sort === 'name') sorted.sort((a, b) => a.id.localeCompare(b.id))
    return sorted.slice(0, 60)
  }, [data, query, sort, showFree, showWeak, matureOnly, testedOnly])

  const body = loading ? (
    <div className="space-y-2 p-4" aria-label="Loading the catalogue">
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading the catalogue…
      </p>
      {[0, 1, 2].map((i) => (
        <div key={i} className="animate-pulse rounded-md border border-border/50 p-3">
          <div className="h-3 w-1/3 rounded bg-muted" />
          <div className="mt-2 h-2.5 w-2/3 rounded bg-muted/70" />
        </div>
      ))}
    </div>
  ) : (
    <Card className="border-0 shadow-none">
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2">
          <span>The catalogue</span>
          <Button variant="ghost" size="sm" onClick={refresh} disabled={refreshing}>
            {refreshing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            <span className="ml-1">Refresh</span>
          </Button>
        </CardTitle>
        <CardDescription>
          {data?.error ? (
            <span className="text-amber-500">
              Could not reach OpenRouter ({data.error}). Showing nothing rather than stale guesses.
            </span>
          ) : (
            <>
              {data?.models.length ?? 0} models, priced live.{' '}
              {data?.fetchedAt ? `Fetched ${new Date(data.fetchedAt).toLocaleString()}.` : ''} Cost
              is for one {REFERENCE_SESSION.label}.
            </>
          )}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-3">
        <GradeKey />

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] flex-1">
            <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by name, e.g. deepseek"
              className="pl-8"
            />
          </div>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="price">Cheapest first</option>
            <option value="context">Largest context first</option>
            <option value="name">Name</option>
          </select>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={showFree}
              onChange={(e) => setShowFree(e.target.checked)}
            />
            Show free models
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={showWeak}
              onChange={(e) => setShowWeak(e.target.checked)}
            />
            Show lower-performing and small models
          </label>
          <label
            className="flex items-center gap-2 text-sm"
            title="Narrows to models measured writing up graphic violence and crude dialogue without sanitising it."
          >
            <input
              type="checkbox"
              checked={matureOnly}
              onChange={(e) => setMatureOnly(e.target.checked)}
            />
            Handles mature content
            <span className="text-xs text-muted-foreground">
              ({MATURE_CONTENT_MEASURED_OK.size})
            </span>
          </label>
          <label
            className="flex items-center gap-2 text-sm"
            title="Narrows to models the maintainer has actually run and graded on at least one phase."
          >
            <input
              type="checkbox"
              checked={testedOnly}
              onChange={(e) => setTestedOnly(e.target.checked)}
            />
            Tested by the maintainer
            <span className="text-xs text-muted-foreground">({MEASURED_MODEL_IDS.size})</span>
          </label>
        </div>

        {matureOnly && (
          <p className="rounded-md border border-border bg-muted/40 p-2 text-xs text-muted-foreground">
            These are the models <strong>measured</strong> carrying a session's
            worth of graphic violence and crude dialogue without softening it.
            The rest are unmeasured, not known to refuse — a moderation flag in
            the catalogue did not predict refusal in testing.{' '}
            <strong>Your own Gemini key is also fine:</strong> the pipeline sends
            BLOCK_NONE on every prose chunk, and a deliberately graphic passage
            came back intact through it — with the safety settings, without them,
            and through OpenRouter.
          </p>
        )}

        {testedOnly && (
          <p className="rounded-md border border-border bg-muted/40 p-2 text-xs text-muted-foreground">
            The {MEASURED_MODEL_IDS.size} models with a first-hand grade on at
            least one phase — bake-offs and operator reports, never leaderboards.
            Models graded <strong>by family</strong> rather than individually are
            excluded, because an inference from a sibling is not a test.{' '}
            <strong>Low grades are shown too:</strong> a measured D is a result
            worth seeing, so this list ignores the lower-performing filter.
            Expand a row to read what each grade was based on.
          </p>
        )}

        {showWeak && (
          <p className="rounded-md border border-border bg-muted/40 p-2 text-xs text-muted-foreground">
            Now also showing models measured below the reference on every phase
            they were tried on, and untested models whose own id declares fewer than{' '}
            {SMALL_MODEL_CEILING_B}B parameters. This tick is shared
            with the per-phase routing rows above, so these models are now
            offered there too. Models that simply declare no size were never
            hidden — not measured is not the same as not good.
          </p>
        )}

        {showFree && <FreeModelWarning />}

        <div className="divide-y divide-border rounded-md border border-border">
          {rows.map((m) => (
            <ModelRow
              key={m.id}
              model={m}
              expanded={expanded === m.id}
              onToggle={() => setExpanded(expanded === m.id ? null : m.id)}
            />
          ))}
          {rows.length === 0 && (
            <div className="p-4 text-sm text-muted-foreground">No models match that filter.</div>
          )}
        </div>
      </CardContent>
    </Card>
  )

  return (
    <details
      id="openrouter-catalogue"
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      className="rounded-md border border-border bg-card/40"
    >
      <summary className="flex cursor-pointer items-center gap-2 p-4 font-display text-sm uppercase tracking-wider [&::-webkit-details-marker]:hidden">
        <Search className="h-4 w-4" />
        Browse OpenRouter models
        <span className="text-xs font-normal normal-case text-muted-foreground">
          — Prices, grades and policies for the whole catalogue. Reference only:
          pick phase models in the routing rows above.
        </span>
      </summary>
      {open && body}
    </details>
  )
}

function GradeKey() {
  return (
    <div className="rounded-md border border-border bg-muted/30 p-3 text-xs">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="font-medium">Grades are quality only — price is the column beside them</span>
        <InfoHint label="How these are decided">
          <p className="mb-2">
            A letter says how well a model does that phase, and nothing about what it costs. Those
            two answers disagree sharply for some models: <span className="font-mono">{GEMINI_PRO_REFERENCE}</span>{' '}
            is the strongest output measured on most phases and roughly six times the price of
            Flash for one session. A single letter carrying both would have to call that middling,
            which is the opposite of what the measurements say. Sort by{' '}
            <em>quality per dollar</em> in the routing picker to put the two back together.
          </p>
          <p className="mb-2">
            A letter appears only where a model has actually been run on that phase, where a
            structural check proves it cannot run at all, or — shown dashed — where a pattern or a
            sibling version supports a prediction. Anything else shows a dash.
          </p>
          <p className="mb-2">
            That is stricter than it sounds, and deliberately so. No vendor benchmarks the thing
            this pipeline asks for — reproducing a long passage faithfully — and the benchmarks
            people usually cite are poor proxies for it. Instruction-following scores are saturated
            and measure short answers. Arena rankings are worse than useless here: their own
            style-control analysis shows answer length is by far the strongest predictor of a win,
            so they reward writing more, when these phases need a model that writes exactly as much
            as its input and adds nothing.
          </p>
          <p>
            A grade inferred from those numbers would look authoritative and mean very little, so
            an unmeasured model is left blank instead.
          </p>
        </InfoHint>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
        {(['A', 'B', 'C', 'D', 'F', 'untested'] as Grade[]).map((g) => (
          <span key={g} className="flex items-center gap-1">
            <span className={`rounded border px-1 text-[10px] font-medium ${GRADE_TONE[g]}`}>
              {g === 'untested' ? '—' : g}
            </span>
            {GRADE_MEANING[g]}
          </span>
        ))}
      </div>
      <p className="mt-2 border-t border-border pt-2">
        <span className="mr-1 rounded border border-dashed border-border bg-muted px-1 text-[10px] font-medium text-muted-foreground">
          B?
        </span>
        A dashed chip was not measured on <em>this</em> model, and it is one of
        two things. A <strong>prediction</strong> is read off the model's
        purpose or its declared size, with no run behind it anywhere; a
        prediction never awards an A, because only a real comparison can show
        something beating the reference. An <strong>inherited</strong> grade did
        come from a real run, on another version or channel of the same tier,
        so it keeps whatever letter that run earned. Both exist so that a
        400-model catalogue can be narrowed at all; running every model would
        cost more than the tool saves. Expand a row to read which one it is and
        what it was based on, and tick <em>Tested by the maintainer</em> to see
        only models that have genuinely been run here. Reviewed{' '}
        {PREDICTIONS_DATED}.
      </p>
    </div>
  )
}

function FreeModelWarning() {
  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
      <div className="flex items-start gap-2">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
        <div className="space-y-1">
          <p className="font-medium text-amber-200">What free models cost instead of money</p>
          <p className="text-muted-foreground">
            Every free model on OpenRouter runs on a provider that keeps a copy of what you send,
            and around half are hosted by one that may train on it. A session transcript is your
            players&rsquo; conversation, and they are not in the room for that decision.
          </p>
          <p className="text-muted-foreground">
            They are also capped at 20 requests a minute and 50 a day until an account has bought
            credits at least once, after which the daily cap is 1,000. A three-hour session is about
            26 requests. When probed on 18 August 2026, 4 of 14 free models answered
            &ldquo;temporarily rate-limited&rdquo; and one timed out, so a run may simply stop
            partway. Runs are resumable, but it is a real interruption.
          </p>
        </div>
      </div>
    </div>
  )
}

function ModelRow({
  model,
  expanded,
  onToggle,
}: {
  model: OpenRouterModelInfo
  expanded: boolean
  onToggle: () => void
}) {
  const verdicts = useMemo(() => judgeAllPhases(model), [model])
  const overall = useMemo(() => overallVerdict(verdicts), [verdicts])
  const cost = useMemo(() => referenceSessionCost(model), [model])
  const graded = PHASE_ORDER.filter((p) => verdicts[p].grade !== 'untested')
  const blocked = PHASE_ORDER.filter((p) => verdicts[p].grade === 'F')
  const measuredHere = measuredPhaseCount(model.id)

  return (
    <div className="p-3">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-start justify-between gap-3 text-left"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm">{model.id}</span>
            {model.isFree && <Chip tone="amber">free</Chip>}
            {MATURE_CONTENT_MEASURED_OK.has(model.id) ? (
              <Chip tone="green">handles mature content</Chip>
            ) : (
              model.isModerated && <Chip tone="muted">has content filter</Chip>
            )}
            {!model.supportsStructuredOutputs && <Chip tone="muted">no JSON</Chip>}
            {model.leaksReasoning && <Chip tone="red">leaks reasoning</Chip>}
            {model.pricingTiers && model.pricingTiers.length > 0 && (
              <Chip tone="muted">tiered price</Chip>
            )}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="text-foreground">
              {model.isFree ? 'free' : `~$${cost.usd.toFixed(2)} / session`}
            </span>
            <span>
              in {formatRate(model.inputPerM)} · out {formatRate(model.outputPerM)} per M
            </span>
            <span>ctx {formatTokens(model.contextLength)}</span>
            <span>max out {formatTokens(model.maxCompletionTokens)}</span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            <OverallGradeChip overall={overall} />
            <span className="px-0.5 text-muted-foreground/40">|</span>
            {PHASE_ORDER.map((p) => (
              <PhaseGradeChip
                key={p}
                phase={p}
                grade={verdicts[p].grade}
                indirect={isIndirectGrade(verdicts[p])}
                source={verdicts[p].source?.method}
              />
            ))}
          </div>
        </div>
        <div className="shrink-0 text-right text-xs text-muted-foreground">
          {blocked.length > 0 ? (
            <span className="flex items-center gap-1 text-red-400">
              <TriangleAlert className="h-3.5 w-3.5" /> {blocked.length} blocked
            </span>
          ) : measuredHere > 0 ? (
            <span>
              {measuredHere} of {PHASE_ORDER.length} measured
            </span>
          ) : graded.length > 0 ? (
            <span className="opacity-70">predicted only</span>
          ) : (
            <span className="flex items-center gap-1">
              <ShieldCheck className="h-3.5 w-3.5 opacity-40" /> untested
            </span>
          )}
        </div>
      </button>

      {expanded && (
        <div className="mt-3 space-y-2 border-t border-border pt-3">
          {PHASE_ORDER.map((p) => {
            const v = verdicts[p]
            return (
              <div key={p} className="text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <PhaseGradeChip phase={p} grade={v.grade} />
                  <span className="font-medium">{PHASE_LABELS[p]}</span>
                  <span className="text-muted-foreground">{GRADE_MEANING[v.grade]}</span>
                </div>
                {v.source && (
                  <p className="ml-1 mt-0.5 text-muted-foreground">
                    {SOURCE_LABEL[v.source.method]},{' '} 
                    {v.source.date}
                    {v.source.note ? ` — ${v.source.note}` : ''}
                  </p>
                )}
                {v.blockers.length > 0 && (
                  <ul className="ml-1 mt-1 list-inside list-disc text-red-300">
                    {v.blockers.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                )}
                {v.caveats.length > 0 && (
                  <ul className="ml-1 mt-1 list-inside list-disc text-muted-foreground">
                    {v.caveats.map((c, i) => (
                      <li key={i}>
                        <span className="opacity-60">
                          {c.kind === 'observed'
                            ? 'seen: '
                            : c.kind === 'reported'
                              ? 'reported: '
                              : 'note: '}
                        </span>
                        {c.text}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )
          })}

          <div className="text-xs text-muted-foreground">
            <span className="font-medium">Per phase, one session: </span>
            {cost.perPhase
              .map((p) => `${PHASE_LABELS[p.phase]} $${p.usd.toFixed(3)} (${p.chunks} calls)`)
              .join(' · ')}
          </div>

          {model.pricingTiers && model.pricingTiers.length > 0 && (
            <div className="text-xs">
              <span className="font-medium">Price rises with prompt length: </span>
              <span className="text-muted-foreground">
                {model.pricingTiers
                  .map(
                    (t) =>
                      `above ${formatTokens(t.minPromptTokens)} tokens, in ${formatRate(t.inputPerM)} / out ${formatRate(t.outputPerM)}`,
                  )
                  .join('; ')}
                . Condense carries your whole lore corpus, so it is the phase most likely to cross a
                threshold.
              </span>
            </div>
          )}

          {model.reasoning?.mandatory && (
            <p className="text-xs text-muted-foreground">
              Always spends reasoning tokens and they cannot be switched off. They bill as output
              whether or not you see them, which makes a mechanical phase like Ground cost more than
              its output length suggests. Not the same thing as writing reasoning into the reply —
              that is flagged separately.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

/** How a grade was arrived at, in the reader's words rather than the type's. */
const SOURCE_LABEL: Record<MeasurementSource['method'], string> = {
  'bake-off': 'Measured in a bake-off',
  'operator-report': 'Hands-on testing',
  research: 'From published evidence',
  'sibling-measurement': 'Measured on another version of the same tier',
  prediction: 'Predicted from a pattern, not measured',
}

const GRADE_TONE: Record<Grade, string> = {
  A: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  B: 'bg-lime-500/15 text-lime-300 border-lime-500/30',
  C: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  D: 'bg-orange-500/15 text-orange-300 border-orange-500/30',
  F: 'bg-red-500/15 text-red-300 border-red-500/30',
  // Deliberately colourless. An untested model is neither a warning nor an
  // endorsement, and a colour would imply one.
  untested: 'bg-muted text-muted-foreground border-border',
}

/** The one letter a reader scanning 400 rows actually has time for. Sits
 *  first, ahead of the per-phase chips, because the per-phase detail only
 *  matters once this one says the model is worth a look. */
function OverallGradeChip({ overall }: { overall: OverallVerdict }) {
  const { grade, predicted, inherited, gradedPhases, blockedPhases } = overall
  const indirect = predicted || inherited
  const provenance = predicted
    ? `Some of it is predicted rather than measured — reviewed ${PREDICTIONS_DATED}.`
    : inherited
      ? 'Some of it was measured on another version of this model, not on this one.'
      : 'Every grade behind this was measured on this model.'
  const title =
    grade === 'untested'
      ? 'Nothing is known about this model on any phase.'
      : [
          `${GRADE_MEANING[grade]}`,
          `Averaged over the ${gradedPhases} phase${gradedPhases === 1 ? '' : 's'} that carry a grade.`,
          blockedPhases > 0
            ? `${blockedPhases} phase${blockedPhases === 1 ? '' : 's'} cannot run at all.`
            : '',
          provenance,
        ]
          .filter(Boolean)
          .join(' ')
  return (
    <span
      className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${GRADE_TONE[grade]} ${indirect ? 'border-dashed' : ''}`}
      title={title}
    >
      Overall {grade === 'untested' ? '—' : grade}
      {indirect && <span className="ml-0.5 opacity-70">?</span>}
    </span>
  )
}

/** A dashed border and a trailing ? mark a grade that was not measured on this
 *  model — a pattern-read prediction, or a run on a sibling of the same tier.
 *
 *  Both are deliberately non-colour: an indirect B and a measured B mean the
 *  same thing about the model and differ only in how much to trust it, so
 *  recolouring one would say something about quality that is not meant. The
 *  title tells the two apart, because only one of them is a guess. */
function PhaseGradeChip({
  phase,
  grade,
  indirect,
  source,
}: {
  phase: Phase
  grade: Grade
  indirect?: boolean
  source?: MeasurementSource['method']
}) {
  const provenance = !indirect
    ? ''
    : source === 'sibling-measurement'
      ? ' Measured on another version of this model, not on this one.'
      : ' Predicted from a pattern, not measured.'
  return (
    <span
      className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${GRADE_TONE[grade]} ${indirect ? 'border-dashed' : ''}`}
      title={`${GRADE_MEANING[grade]}${provenance}`}
    >
      {PHASE_LABELS[phase]} {grade === 'untested' ? '—' : grade}
      {indirect && <span className="ml-0.5 opacity-70">?</span>}
    </span>
  )
}

function Chip({
  tone,
  children,
}: {
  tone: 'amber' | 'red' | 'muted' | 'green'
  children: React.ReactNode
}) {
  const cls =
    tone === 'amber'
      ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
      : tone === 'red'
        ? 'bg-red-500/15 text-red-300 border-red-500/30'
        : tone === 'green'
          ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
          : 'bg-muted text-muted-foreground border-border'
  return (
    <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${cls}`}>{children}</span>
  )
}
