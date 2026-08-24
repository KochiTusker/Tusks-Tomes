// Shared shape handling for Phase 4's "Memorable Quotes".
//
// A quote entry comes back from the model in one of two shapes:
//   - single line — one line that lands on its own.
//   - exchange    — an ordered back-and-forth between two or more speakers
//                   that only lands as a unit (setup → retort → reaction).
//
// The exchange shape exists because the sharpest table moments are usually a
// volley: read alone each line looks unremarkable, but the chain is the joke.
// Extracting only the individual lines throws away the thing that made the
// moment memorable, so the prompt offers both shapes and everything
// downstream normalises through here.
//
// `speaker` / `line` stay populated on EVERY entry — for an exchange they
// carry the participant list and a flattened rendering. That keeps state
// persisted by older builds valid, and means any consumer that only knows
// the flat shape degrades to readable text rather than blanks.

import type { Quote, QuoteKind, QuoteTurn } from '@/types'

const KINDS: readonly QuoteKind[] = ['funny', 'stupid', 'dark']

/** Hard ceiling on turns kept from one exchange. The prompt asks for 2–8;
 *  this only fires when a model dumps a whole scene, and keeps a runaway
 *  response from bloating the persisted run state. */
export const MAX_EXCHANGE_TURNS = 12

/** Unrecognised / missing kinds fall back to 'funny' — the same default the
 *  renderers apply to legacy entries written before `kind` existed. */
export function normalizeQuoteKind(raw: unknown): QuoteKind {
  return KINDS.includes(raw as QuoteKind) ? (raw as QuoteKind) : 'funny'
}

function normalizeTurns(raw: unknown): QuoteTurn[] {
  if (!Array.isArray(raw)) return []
  const turns: QuoteTurn[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const rec = entry as Record<string, unknown>
    const speaker = typeof rec.speaker === 'string' ? rec.speaker.trim() : ''
    const line = typeof rec.line === 'string' ? rec.line.trim() : ''
    if (!speaker || !line) continue
    turns.push({ speaker, line })
    if (turns.length === MAX_EXCHANGE_TURNS) break
  }
  return turns
}

/** Participant list for an exchange: unique speakers in order of first
 *  appearance, e.g. `Pernille, Anouk & Kiona`. */
export function exchangeSpeakers(turns: QuoteTurn[]): string {
  const seen: string[] = []
  for (const t of turns) if (!seen.includes(t.speaker)) seen.push(t.speaker)
  if (seen.length <= 1) return seen[0] ?? ''
  return `${seen.slice(0, -1).join(', ')} & ${seen[seen.length - 1]}`
}

/** Single-string rendering of an exchange, used for the flat `line` field. */
export function flattenExchange(turns: QuoteTurn[]): string {
  return turns.map((t) => `${t.speaker}: "${t.line}"`).join(' / ')
}

/** Tolerant parse of one model-supplied quote entry. Returns null when the
 *  entry carries no usable text. */
export function normalizeQuote(raw: unknown): Quote | null {
  if (!raw || typeof raw !== 'object') return null
  const rec = raw as Record<string, unknown>
  const kind = normalizeQuoteKind(rec.kind)
  const contextRaw = typeof rec.context === 'string' ? rec.context.trim() : ''
  const context = contextRaw ? { context: contextRaw } : {}

  const turns = normalizeTurns(rec.exchange)
  if (turns.length >= 2) {
    return {
      speaker: exchangeSpeakers(turns),
      line: flattenExchange(turns),
      kind,
      exchange: turns,
      ...context,
    }
  }

  // A one-turn "exchange" is not an exchange — fold it back to the flat
  // shape rather than dropping it or rendering a degenerate list.
  const speaker = turns[0]?.speaker ?? (typeof rec.speaker === 'string' ? rec.speaker.trim() : '')
  const line = turns[0]?.line ?? (typeof rec.line === 'string' ? rec.line.trim() : '')
  if (!speaker || !line) return null
  return { speaker, line, kind, ...context }
}

export function normalizeQuotes(raw: unknown): Quote[] {
  if (!Array.isArray(raw)) return []
  return raw.map(normalizeQuote).filter((q): q is Quote => q !== null)
}

/** Primary dedup key — matches the pre-exchange key format. */
export function quoteKey(q: Quote): string {
  return `${q.speaker}::${q.line.trim()}`
}

/** Every key an entry occupies: its own, plus one per turn for an exchange.
 *  The per-turn keys are what stop a line that already appears inside an
 *  exchange from being re-added as a standalone quote (and vice versa) when
 *  a later chunk — or a fusion retry — re-emits it. */
export function quoteKeys(q: Quote): string[] {
  const keys = [quoteKey(q)]
  for (const t of q.exchange ?? []) keys.push(`${t.speaker}::${t.line.trim()}`)
  return keys
}

/** Append only the entries that don't overlap what's already accumulated. */
export function appendNovelQuotes(existing: Quote[], incoming: Quote[]): Quote[] {
  const seen = new Set(existing.flatMap(quoteKeys))
  const out = [...existing]
  for (const q of incoming) {
    const keys = quoteKeys(q)
    if (keys.some((k) => seen.has(k))) continue
    for (const k of keys) seen.add(k)
    out.push(q)
  }
  return out
}

/** Flat text form — clipboard copy and the Reforge before/after diff. */
export function quoteToPlainText(q: Quote): string {
  const body = q.exchange?.length ? q.line : `${q.speaker}: "${q.line}"`
  return q.context ? `(${q.context}) ${body}` : body
}
