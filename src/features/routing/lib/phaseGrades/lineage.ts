// Model identity: declared size, base id and lineage, and the measurement a
// newer or older member of a measured lineage inherits.
import { MEASURED_GRADES } from './measured'
import { outranks } from './scale'
import type { Grade, MeasurementSource, Phase } from './scale'

// ────────────────────────────────────────────────────────────────────
// Predicted grades
// ────────────────────────────────────────────────────────────────────

/**
 * The parameter count an id declares, in billions, or null.
 *
 * Reads `-8b`, `-120b`, `-1.8b`. Takes the LARGEST match so a
 * mixture-of-experts id reads as its total rather than its active count:
 * `qwen3-30b-a3b` is a 30B model, and reading it as 3B would file a capable
 * model under the small-model rules.
 */
export function declaredSizeB(text: string): number | null {
  const found = [...text.matchAll(/[-_ /](\d+(?:\.\d)?)b(?![a-z0-9])/gi)].map((m) =>
    parseFloat(m[1]),
  )
  return found.length ? Math.max(...found) : null
}

/**
 * Strip the parts of an id that name a DELIVERY channel rather than a model.
 *
 * `~vendor/model` is an alias, `:free` is the same weights on a shared
 * zero-cost tier, `:batch` is the same weights on an async endpoint at half
 * price. None of the three changes what the model writes, so all three inherit
 * whatever is known about the plain id — a measured D reappearing as an
 * untested `:free` twin is exactly the gap this closes. What DOES differ
 * between them, retention and rate limits, is already carried as caveats.
 */
export function baseModelId(id: string): string {
  return id.replace(/^~/, '').replace(/:(free|batch)$/, '')
}

/**
 * Grades inferred from a pattern rather than measured on a run.
 *
 * The tables above are deliberately small because a letter in them has to be
 * earned. That honesty had a cost the catalogue made obvious: ~400 models,
 * almost none graded, and a reader with no way to narrow the list. Predictions
 * make it navigable without pretending to be measurements — they render
 * differently, they never claim an A, and the "tested by the maintainer"
 * filter still counts only real runs.
 *
 * Consulted LAST, so any measurement or family calibration overrides one.
 *
 * ─── What may be predicted from, and what may not ────────────────────
 *
 * Three patterns are concrete enough to act on:
 *
 *   1. PURPOSE. A model built to apply diffs, classify safety, drive a GUI or
 *      answer from web search is not a prose writer. That is read off the
 *      product category, not off a judgement about quality.
 *   2. SIZE, where the id declares it, and the vendor's own small tier.
 *      Anchored on measurements already in the table: both small models put
 *      through the Grounding bake-off failed it the same way, returning
 *      well-formed output that had corrected nothing.
 *   3. GENERATION. A model some releases behind its vendor's current line is
 *      behind it on the axis this pipeline loads.
 *
 * What is NOT predicted: a quality letter for a model or vendor with no track
 * record to reason from. Several vendors here are exactly that, and they stay
 * untested rather than guessed at. A prediction is an inference from something
 * known; anything else is a letter with nothing behind it, which is what this
 * scheme was rewritten to stop producing.
 *
 * Predictions never award an A. A means "better than the reference, or as good
 * for less money", and only running a model against it can establish that. B
 * is the ceiling for a prediction, and a test enforces it.
 */
// ────────────────────────────────────────────────────────────────────
// Lineage: one measurement, every version and channel of the same tier
// ────────────────────────────────────────────────────────────────────

/**
 * Vendors whose models also appear WITHOUT a vendor prefix.
 *
 * The Gemini rows in the grade table are bare (`gemini-pro-latest`) because
 * they were measured on a Google key, while the catalogue calls the same model
 * `google/gemini-pro-latest`. The subscription CLIs are the same story from
 * the other direction: Claude Code names its models `claude-opus-5` and
 * `sonnet`. Without this, a model measured through one route stays untested
 * through the other — which is not a fact about the model, only about how it
 * was reached.
 */
const BARE_ID_VENDORS: Array<{ match: RegExp; vendor: string }> = [
  { match: /^gemini/, vendor: 'google' },
  { match: /^(claude|opus|sonnet|haiku|fable)/, vendor: 'anthropic' },
  { match: /^(gpt|o[134])/, vendor: 'openai' },
  { match: /^grok/, vendor: 'x-ai' },
]

/** Words that describe a release, not a model. */
const LINEAGE_NOISE = new Set([
  'latest',
  'preview',
  'exp',
  'experimental',
  'instruct',
  'it',
  'chat',
  'customtools',
  'contributor',
])

/** A declared parameter count as one id token: `8b`, `120b`, `1.5b`. */
const SIZE_TOKEN = /^\d+(?:\.\d+)?b$/i

/**
 * The product line and tier an id belongs to, with the version taken out.
 *
 * `claude-sonnet-4.8`, `anthropic/claude-sonnet-5:batch` and the CLI's bare
 * `sonnet` all reduce to `anthropic/claude-sonnet`. `gemini-3.7-flash` and
 * `gemini-3.6-flash` both reduce to `google/gemini-flash`, and neither
 * collides with `google/gemini-flash-lite` or `google/gemini-pro`.
 *
 * Tier is kept and version is dropped, because tier is what the measurements
 * actually distinguish: Flash and Pro graded four steps apart on the same
 * phase, while consecutive versions of one tier have never been observed to.
 * Merging too little is safe — the model simply falls through to the pattern
 * rules — so anything unrecognised returns null rather than being forced.
 */
export function modelLineage(id: string): string | null {
  const base = baseModelId(id)
  const slash = base.indexOf('/')
  let vendor = slash > 0 ? base.slice(0, slash) : ''
  let rest = slash > 0 ? base.slice(slash + 1) : base
  if (!vendor) {
    vendor = BARE_ID_VENDORS.find((v) => v.match.test(rest))?.vendor ?? ''
    if (!vendor) return null
    // The CLI's one-word aliases name a tier directly.
    if (/^(opus|sonnet|haiku|fable)$/.test(rest)) rest = `claude-${rest}`
  }
  // Trailing date stamps: -2024-11-20, -0813, -2507.
  rest = rest.replace(/-\d{4,8}(-\d{2}-\d{2})?$/, '')
  const tokens = rest
    .split('-')
    // A token that starts with a digit is a version or a size. A version is
    // dropped, because tier is what the measurements distinguish. A declared
    // size is kept, because for a line named by size the size IS the tier: a
    // 20B and a 120B of the same line sit as far apart as Flash and Pro.
    .filter((t) => t && (!/^\d/.test(t) || SIZE_TOKEN.test(t)) && !LINEAGE_NOISE.has(t))
    // `qwen3.5` and `qwen3` are the same line; `m2` and `m3` the same tier.
    .map((t) => (SIZE_TOKEN.test(t) ? t.toLowerCase() : t.replace(/[\d.]+$/, '')))
    .filter(Boolean)
  return tokens.length ? `${vendor}/${tokens.join('-')}` : null
}

/**
 * The version an id declares, for deciding which sibling to inherit from.
 *
 * `latest` sorts above every number, because that is what it means.
 */
export function lineageVersion(id: string): number {
  const base = baseModelId(id)
  if (/-latest$/.test(base)) return Number.POSITIVE_INFINITY
  // A declared size and a trailing date stamp are not versions: gpt-oss-120b
  // is not release 120 of anything, and ministral-8b-2512 is neither release
  // 8 nor release 2512. Strip both before reading the first number left.
  const stripped = base
    .replace(/-\d{4,8}(-\d{2}-\d{2})?$/, '')
    .replace(/[-_ /]\d+(?:\.\d+)?b(?![a-z0-9])/gi, '')
  const m = stripped.match(/(\d+(?:\.\d+)?)/)
  return m ? parseFloat(m[1]) : 0
}

interface LineageHit {
  grade: Grade
  source: MeasurementSource
  fromId: string
  version: number
}

/**
 * Every measurement, indexed by lineage and phase, newest version winning.
 *
 * Built once at module load from MEASURED_GRADES, so testing one more model
 * improves the predictions for its whole tier without another table to edit.
 * That is the point: the grade table is meant to grow one careful run at a
 * time, and each run should buy as much as it honestly can.
 */
const LINEAGE_INDEX: Map<string, Map<Phase, LineageHit>> = (() => {
  const index = new Map<string, Map<Phase, LineageHit>>()
  for (const [key, entry] of Object.entries(MEASURED_GRADES)) {
    const sep = key.lastIndexOf('::')
    const id = key.slice(0, sep)
    const phase = key.slice(sep + 2) as Phase
    const lineage = modelLineage(id)
    if (!lineage) continue
    const version = lineageVersion(id)
    let byPhase = index.get(lineage)
    if (!byPhase) index.set(lineage, (byPhase = new Map()))
    const existing = byPhase.get(phase)
    // Newest version wins. Two measurements of one version — the same alias
    // reached over two routes, say — are settled by the stronger evidence,
    // not by which table row happened to be read first.
    if (
      !existing ||
      version > existing.version ||
      (version === existing.version && outranks(entry.source, existing.source))
    ) {
      byPhase.set(phase, { grade: entry.grade, source: entry.source, fromId: id, version })
    }
  }
  return index
})()

/**
 * How far behind its tier a model may fall and still inherit.
 *
 * A newer model inherits an older measurement of its tier freely: a tier does
 * not usually get worse. Carrying a measurement BACKWARD is the direction that
 * misleads — Claude 3 Haiku is not what Haiku 4.5 measured, and letting it
 * borrow that grade would be the most flattering possible reading of the
 * oldest model in the catalogue.
 *
 * The comparison is against the newest NUMBERED measurement in the tier, not
 * against the particular one being inherited. A `-latest` alias has no version
 * to compare — it means "whichever is current" — so measuring one has to stay
 * useful to the numbered releases around it. Judging the model once, against
 * the tier as a whole, lets that work while still excluding a model that is
 * genuinely generations behind.
 *
 * Half a major version of slack: a 4.8 still inherits from a 5, and a 3.6 from
 * a 3.5, but a 2.5 does not inherit from a tier whose newest measurement is a
 * 3.5. Crude, since vendors number releases differently, but it only ever bites
 * backward — a model NEWER than every measurement in its tier always inherits.
 */
const LINEAGE_BACKWARD_SLACK = 0.5

/** The newest numbered measurement in each lineage, for the guard above. */
const LINEAGE_NEWEST_NUMBERED: Map<string, number> = (() => {
  const out = new Map<string, number>()
  for (const [lineage, byPhase] of LINEAGE_INDEX) {
    let newest = 0
    for (const hit of byPhase.values()) {
      if (Number.isFinite(hit.version)) newest = Math.max(newest, hit.version)
    }
    out.set(lineage, newest)
  }
  return out
})()

/**
 * A measurement of a sibling version or channel of the same tier, if one
 * applies and this model is recent enough to claim it.
 */
export function lineageMeasurement(id: string, phase: Phase): LineageHit | null {
  const lineage = modelLineage(id)
  if (!lineage) return null
  const hit = LINEAGE_INDEX.get(lineage)?.get(phase)
  if (!hit || hit.fromId === baseModelId(id)) return null
  const newest = LINEAGE_NEWEST_NUMBERED.get(lineage) ?? 0
  if (lineageVersion(id) < newest - LINEAGE_BACKWARD_SLACK) return null
  return hit
}
