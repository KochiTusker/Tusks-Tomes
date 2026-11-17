// Every model a phase could run on, from every provider, in one shape.
//
// The routing editor used to ask the same question twice: a "Model Profiles"
// grid set the active provider's per-phase default, and a second grid below it
// set per-phase overrides. Both answered "which model runs Chronicle", in
// different words, with different model lists — and only one of them could
// reach OpenRouter. Users had to know which grid won.
//
// This collapses the sources into one list so a single control can own the
// decision. Nothing here decides layout; it decides what the choices ARE and
// what is known about each one.

import type { CloudKeyOption, AvailabilityCache } from '@/features/providers'
import {
  availableModelsFor,
  handlesMatureContent,
  type OpenRouterModelInfo,
  buildLiveRateResolver,
  type LiveRateResolver,
  liveRateFor,
} from '@/features/providers'
import {
  type Grade,
  type MeasurementSource,
  type Phase,
  isIndirectGrade,
  judgePhase,
  lineageMeasurement,
  phaseCost,
} from './phaseGrades'
import { type DeveloperPick, pickFor, pickRank, vendorLabel, vendorOf } from './developerPicks'

/**
 * How a model is reached and billed. This is the TOP-LEVEL grouping, and it is
 * deliberately not the model's vendor.
 *
 * The two come apart in ways that matter: Gemini reached through your own
 * Google key and the same Gemini reached through OpenRouter are different
 * prices, different reliability, and in measurement different quality — but
 * they share a vendor. Grouping by vendor put them in the same folder and hid
 * the distinction that actually decides which to pick.
 */
export type Connection = 'gemini' | 'openrouter' | 'claudeCode' | 'codex' | 'local'

export const CONNECTION_LABEL: Record<Connection, string> = {
  gemini: 'Gemini API key',
  openrouter: 'OpenRouter',
  claudeCode: 'Claude Code subscription',
  codex: 'Codex subscription',
  local: 'Local runner',
}

/** How each connection bills, in one line. Shown under the group header,
 *  because "on your plan" and "per token" is the first thing that changes
 *  what someone picks. */
export const CONNECTION_BILLING: Record<Connection, string> = {
  gemini: 'Per token, on your Google key.',
  openrouter: 'Per token, on your OpenRouter key. Same rates the vendors charge.',
  claudeCode: 'Included in your Claude subscription — no per-token cost, but it draws on your usage window.',
  codex: 'Included in your ChatGPT subscription — no per-token cost, but it draws on your usage window.',
  local: 'Runs on your own hardware. No API cost at all.',
}

export interface PhaseOption {
  /** Stable identity for React keys and selection comparison. */
  key: string
  modelId: string
  provider: CloudKeyOption['provider'] | 'local'
  /** Human label for the provider, shown beside the model. */
  providerLabel: string
  /** Top-level grouping: how this model is reached and paid for. */
  connection: Connection
  /** Second-level grouping, used only inside OpenRouter, whose catalogue is
   *  the only one large enough to need it. */
  vendor: string
  grade: Grade
  /** What the grade was actually based on, in the maintainer's words, when
   *  there is a recorded measurement. A bare letter says a model lost without
   *  saying to what — "C- against GLM 5.2's B- on extras" is the difference
   *  between a score and a reason. Undefined for untested and family-inferred
   *  grades, which have no first-hand note to show. */
  gradeNote?: string
  /** True when the letter is not a measurement of this model — read off a
   *  pattern, or taken from a run on a sibling of the same tier. Carried
   *  through so the picker can mark it: a grade that looks the same as a
   *  measured one but is not would be worse than showing nothing. */
  indirect?: boolean
  /** Which of the two it is, so the picker can say so rather than guess.
   *  Absent when the grade is a direct measurement or there is none. */
  gradeSource?: MeasurementSource['method']
  /** Projected spend for THIS phase across a reference session. Null when the
   *  model bills against a subscription rather than per token, which is a
   *  different thing from costing zero. */
  cost: number | null
  /** Non-empty when the model structurally cannot run this phase. */
  blockedReason?: string
  pick?: DeveloperPick
  pickRank: number
  /** True when the model has a recorded grade on ANY phase — the "tested"
   *  filter. A model graded on one phase and unmeasured on another is still
   *  a known quantity in a way an untouched catalogue entry is not. */
  tested: boolean
  /** Measured writing up graphic violence and crude dialogue without
   *  sanitising it. Absence means unmeasured, NOT "refuses" — a catalogue
   *  moderation flag did not predict refusal in testing. */
  mature: boolean
  /** Only set for local models. */
  baseUrl?: string
}

/** A model has been "tested" if the grade table has an entry for it anywhere. */
export function isTested(modelId: string, measured: Record<string, unknown>): boolean {
  const prefix = `${modelId}::`
  for (const key of Object.keys(measured)) if (key.startsWith(prefix)) return true
  return false
}

function providerLabelFor(o: CloudKeyOption): string {
  return o.short
}

/**
 * Build the full option list for one phase.
 *
 * Cloud models come from the same `availableModelsFor` the dropdowns used, so
 * probe-certified lists still win over advertised ones. OpenRouter models come
 * from its public catalogue, which needs no key to enumerate.
 */
export function buildPhaseOptions(args: {
  phase: Phase
  cloudKeyOptions: CloudKeyOption[]
  availability: AvailabilityCache
  openRouterModels: OpenRouterModelInfo[]
  localProbes?: Array<{ modelId: string; backend: string; baseUrl: string; eligible: Record<string, boolean> }>
  measuredGrades: Record<string, unknown>
}): PhaseOption[] {
  const { phase, cloudKeyOptions, availability, openRouterModels, measuredGrades } = args
  const out: PhaseOption[] = []
  // One resolver per build: native Gemini entries price from the same
  // catalogue the OpenRouter entries do, so the picker never shows two
  // different ideas of what a model costs.
  const liveRates = buildLiveRateResolver(openRouterModels)

  for (const opt of cloudKeyOptions) {
    if (opt.provider === 'openrouter') continue // handled from the catalogue below
    for (const m of availableModelsFor(opt, availability)) {
      out.push({
        key: `cloud:${opt.id}:${m.id}`,
        modelId: m.id,
        provider: opt.provider,
        providerLabel: providerLabelFor(opt),
        connection: opt.provider as Connection,
        vendor: opt.provider === 'gemini' ? 'google' : opt.provider,
        ...(() => {
          const g = gradeForBareModel(m.id, phase, measuredGrades)
          return {
            grade: g.grade,
            gradeNote: g.note,
            indirect: g.indirect,
            gradeSource: g.gradeSource,
          }
        })(),
        // Subscription CLIs bill against a plan, not per token. Null rather
        // than 0: "included in your plan" and "free" are different claims,
        // and only one of them is true.
        cost:
          opt.provider === 'claudeCode' || opt.provider === 'codex'
            ? null
            : costForNativeModel(opt, m.id, phase, liveRates),
        pick: pickFor(phase, m.id),
        pickRank: pickRank(phase, m.id),
        tested: isTested(m.id, measuredGrades),
        mature: handlesMatureContent(m.id),
      })
    }
  }

  for (const m of openRouterModels) {
    const verdict = judgePhase(m, phase)
    out.push({
      key: `cloud:openrouter:${m.id}`,
      modelId: m.id,
      provider: 'openrouter',
      providerLabel: 'OpenRouter',
      connection: 'openrouter',
      vendor: vendorOf(m.id),
      grade: verdict.grade,
      gradeNote: verdict.source?.note,
      indirect: isIndirectGrade(verdict),
      gradeSource: verdict.source?.method,
      cost: phaseCost(m, phase),
      blockedReason: verdict.blockers[0],
      pick: pickFor(phase, m.id),
      pickRank: pickRank(phase, m.id),
      tested: isTested(m.id, measuredGrades),
      mature: handlesMatureContent(m.id),
    })
  }

  for (const p of args.localProbes ?? []) {
    if (!p.eligible[phase === 'phase6' ? 'phase3' : phase]) continue
    out.push({
      key: `local:${p.baseUrl}:${p.modelId}`,
      modelId: p.modelId,
      provider: 'local',
      providerLabel: p.backend,
      connection: 'local',
      vendor: 'local',
      grade: 'untested',
      cost: 0, // genuinely zero — it runs on the user's own hardware
      pickRank: Number.MAX_SAFE_INTEGER,
      tested: false,
      // A local model's behaviour is whatever the user loaded; the app has
      // measured nothing about it.
      mature: false,
      baseUrl: p.baseUrl,
    })
  }

  return out
}

/**
 * Phase cost for a provider-native model (Gemini), which has no catalogue
 * record. Reuses the catalogue path's own arithmetic by handing it the same
 * shape, so the two never drift into pricing a phase differently.
 */
function costForNativeModel(
  opt: CloudKeyOption,
  modelId: string,
  phase: Phase,
  resolver: LiveRateResolver | null,
): number {
  const rate = liveRateFor(resolver, opt.provider, opt.geminiTier, modelId)
  return phaseCost(
    {
      id: modelId,
      inputPerM: rate.input,
      outputPerM: rate.output,
      cachedInputPerM: rate.cachedInput,
      // Gemini reasons by default and cannot be switched off on the prose
      // phases, which is most of what the estimate turns on.
      reasoning: { mandatory: false, defaultEnabled: true },
    } as unknown as OpenRouterModelInfo,
    phase,
  )
}

/**
 * Grade lookup for a provider-native id (Gemini, Claude Code, Codex), which
 * has no catalogue record to judge structurally.
 *
 * Falls back to a measurement of the same tier reached another way. The same
 * Sonnet is "claude-sonnet-5" through the subscription CLI and
 * "anthropic/claude-sonnet-5" through OpenRouter, and a grade earned on one
 * route is a fact about the model rather than about the route — so it applies
 * to both, marked as inherited rather than measured here.
 */
function gradeForBareModel(
  modelId: string,
  phase: Phase,
  measured: Record<string, unknown>,
): {
  grade: Grade
  note?: string
  indirect: boolean
  gradeSource?: MeasurementSource['method']
} {
  const hit = measured[`${modelId}::${phase}`] as
    | { grade?: Grade; source?: { note?: string; method?: MeasurementSource['method'] } }
    | undefined
  if (hit?.grade) {
    return { grade: hit.grade, note: hit.source?.note, indirect: false, gradeSource: hit.source?.method }
  }

  const sibling = lineageMeasurement(modelId, phase)
  if (sibling) {
    return {
      grade: sibling.grade,
      note: `Measured on ${sibling.fromId}, not on this one. ${sibling.source.note ?? ''}`.trim(),
      indirect: true,
      gradeSource: 'sibling-measurement',
    }
  }
  return { grade: 'untested', indirect: false }
}

// ────────────────────────────────────────────────────────────────────
// Ordering and grouping
//
// Lives here rather than inside the picker component so it can be tested
// directly. The ordering rules are where the judgement is, and a judgement
// that can only be checked by rendering a component tends not to get checked.
// ────────────────────────────────────────────────────────────────────

export type SortKey = 'picks' | 'performance' | 'value' | 'cost'

const GRADE_RANK: Record<Grade, number> = { A: 0, B: 1, C: 2, D: 3, untested: 4, F: 5 }

/** Quality as a number, for the value sort. Mirrors GRADE_RANK inverted, with
 *  untested deliberately absent: an unknown has no value to compute. */
const GRADE_POINTS: Record<Grade, number> = { A: 4, B: 3, C: 2, D: 1, F: 0, untested: 0 }

/**
 * Quality per dollar, recomputed from the live catalogue.
 *
 * This is what the grade letter used to try to say on its own, and could not:
 * a cheap model that matches an expensive one is a genuinely different
 * proposition from an expensive one that matches it, but folding that into the
 * letter meant a price judgement taken at measurement time outlived the price
 * it was based on. Here the letter stays fixed and the ranking moves when the
 * catalogue does.
 *
 * Unpriced options — the subscription CLIs — have no per-token cost to divide
 * by. They are ordered on grade alone and placed after priced options, for the
 * same reason compareByCost does: a plan has a cost, it is just not charged
 * per call, and pretending it is zero would put them top of a value sort on an
 * accounting artefact.
 */
export function compareByValue(a: PhaseOption, b: PhaseOption): number {
  const rank = (o: PhaseOption): number | null => {
    if (o.cost === null) return null
    const points = GRADE_POINTS[o.grade]
    if (o.grade === 'untested' || points === 0) return 0
    // A free model divides by zero; treat it as the top of the scale rather
    // than as infinity, so the ordering stays total.
    return o.cost <= 0 ? Number.MAX_SAFE_INTEGER : points / o.cost
  }
  const ra = rank(a)
  const rb = rank(b)
  if (ra === null && rb === null) return GRADE_RANK[a.grade] - GRADE_RANK[b.grade]
  if (ra === null) return 1
  if (rb === null) return -1
  return rb - ra || GRADE_RANK[a.grade] - GRADE_RANK[b.grade]
}

/**
 * Cost ordering, with one deliberate asymmetry.
 *
 * A subscription model has no per-token price. Treating that as zero would
 * sort it above a genuinely free local model and below everything else, which
 * asserts something the app does not know — a plan has a cost, it is just not
 * charged per call. Unpriced options therefore sort AFTER priced ones rather
 * than at either extreme.
 */
export function compareByCost(a: PhaseOption, b: PhaseOption): number {
  if (a.cost === null && b.cost === null) return 0
  if (a.cost === null) return 1
  if (b.cost === null) return -1
  return a.cost - b.cost
}

export function comparePhaseOptions(sort: SortKey): (a: PhaseOption, b: PhaseOption) => number {
  if (sort === 'cost') return compareByCost
  if (sort === 'value') return compareByValue
  if (sort === 'performance') {
    return (a, b) => GRADE_RANK[a.grade] - GRADE_RANK[b.grade] || compareByCost(a, b)
  }
  // Picks lead, then grade, then price. A pick is an ordered opinion, so its
  // position wins over the grade it happens to carry.
  return (a, b) =>
    a.pickRank - b.pickRank || GRADE_RANK[a.grade] - GRADE_RANK[b.grade] || compareByCost(a, b)
}

/** Filters applied before grouping. Kept separate so a filter that empties a
 *  group still leaves the group visible with a count of zero. */
export function filterPhaseOptions(
  options: PhaseOption[],
  opts: { query?: string; testedOnly?: boolean; matureOnly?: boolean },
): PhaseOption[] {
  const q = (opts.query ?? '').trim().toLowerCase()
  return options.filter((o) => {
    if (opts.testedOnly && !o.tested) return false
    if (opts.matureOnly && !o.mature) return false
    if (!q) return true
    return o.modelId.toLowerCase().includes(q) || o.providerLabel.toLowerCase().includes(q)
  })
}

/** Display order for connections. Subscriptions and the user's own keys come
 *  before the large catalogue, because they are the short lists someone
 *  scanning for "what do I already have" is looking for. */
const CONNECTION_ORDER: Connection[] = ['gemini', 'claudeCode', 'codex', 'local', 'openrouter']

export function groupByConnection(
  options: PhaseOption[],
  sort: SortKey,
): Array<[Connection, PhaseOption[]]> {
  const cmp = comparePhaseOptions(sort)
  const groups = new Map<Connection, PhaseOption[]>()
  for (const o of options) {
    const list = groups.get(o.connection)
    if (list) list.push(o)
    else groups.set(o.connection, [o])
  }
  for (const list of groups.values()) list.sort(cmp)
  return CONNECTION_ORDER.filter((c) => groups.has(c)).map((c) => [c, groups.get(c)!])
}

/** Vendor sub-folders, used only inside OpenRouter — the one catalogue large
 *  enough to need a second level. Vendors holding a recommendation float up. */
export function groupOpenRouterByVendor(
  options: PhaseOption[],
  sort: SortKey,
): Array<[string, PhaseOption[]]> {
  const cmp = comparePhaseOptions(sort)
  const groups = new Map<string, PhaseOption[]>()
  for (const o of options) {
    if (o.connection !== 'openrouter') continue
    const list = groups.get(o.vendor)
    if (list) list.push(o)
    else groups.set(o.vendor, [o])
  }
  for (const list of groups.values()) list.sort(cmp)
  return [...groups.entries()].sort(([va, la], [vb, lb]) => {
    const ra = la.some((o) => o.pick) ? 0 : 1
    const rb = lb.some((o) => o.pick) ? 0 : 1
    return ra - rb || vendorLabel(va).localeCompare(vendorLabel(vb))
  })
}

/** The short list the picker opens on: measured for this phase, or picked. */
export function recommendedFor(options: PhaseOption[], sort: SortKey): PhaseOption[] {
  return options
    .filter((o) => o.pick !== undefined || (o.grade !== 'untested' && o.grade !== 'F'))
    .sort(comparePhaseOptions(sort))
}

/**
 * How many recommendations the picker shows before it is asked for more.
 *
 * A predicted grade qualifies a model as recommended, and across the whole
 * OpenRouter catalogue that is hundreds of models. Listed in full, it is a
 * catalogue rather than a recommendation, and it sits above the connection
 * folders where a key's own models are. The head of the list is what the
 * sort order exists to produce; the rest stays one click away.
 */
export const RECOMMENDED_PREVIEW = 6

/** Below this many extra rows, a "show more" control costs more than the rows. */
const RECOMMENDED_SLACK = 2

export function recommendedPreview(
  recommended: PhaseOption[],
  showAll: boolean,
): { shown: PhaseOption[]; hidden: number } {
  if (showAll || recommended.length <= RECOMMENDED_PREVIEW + RECOMMENDED_SLACK) {
    return { shown: recommended, hidden: 0 }
  }
  return {
    shown: recommended.slice(0, RECOMMENDED_PREVIEW),
    hidden: recommended.length - RECOMMENDED_PREVIEW,
  }
}

/** Disclosure keys for the picker's folders, shared so the picker and the
 *  rule below cannot disagree about what a folder is called. */
export const connectionFolder = (c: Connection): string => `conn:${c}`
export const vendorFolder = (vendor: string): string => `vendor:${vendor}`

/**
 * The folders that start open: the ones holding the current selection.
 *
 * The recommendation list is cut to its head, so the selected model may not
 * be in it. A picker that opens without showing what is already chosen reads
 * as the choice having been lost, and the connection is where someone looking
 * for "the model on my key" goes next anyway.
 */
export function foldersHolding(options: PhaseOption[], selectedKey: string | null): Set<string> {
  const open = new Set<string>()
  const selected = selectedKey === null ? undefined : options.find((o) => o.key === selectedKey)
  if (!selected) return open
  open.add(connectionFolder(selected.connection))
  if (selected.connection === 'openrouter') open.add(vendorFolder(selected.vendor))
  return open
}
