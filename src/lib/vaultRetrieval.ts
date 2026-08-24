// Vault-agnostic KB retrieval.
//
// The problem: Phase 6 (condense) is handed the ENTIRE lore vault on every
// call — 2.13 MB / ~557k tokens on the reference vault, of which a measured
// 6% is referenced by the text being processed. The rest is paid for and
// ignored. Sending less is easy; sending less WITHOUT silently dropping the
// lore a chunk actually needed is the hard part, and it has to work on a
// vault whose folder names we have never seen.
//
// Everything here keys off two structure-free signals:
//
//   1. The alias index (server/lore/aliasIndex) — note titles, frontmatter
//      aliases, and a frontmatter `type`. None of these depend on how the
//      user organises folders. A flat vault, `Campaign/NPCs/`, or a
//      tag-driven vault all produce the same index shape.
//   2. Inbound reference counts computed from the documents themselves —
//      how many OTHER notes mention this note's title. A campaign's core
//      notes are the ones everything else points at, whatever they're
//      called. No Obsidian link graph required.
//
// An optional RetrievalProfile (produced by the Claude Code mapping pass,
// user-editable in the GUI) refines this with folder roles. It is strictly
// ADVISORY: see the invariant below.
//
// ─── SAFETY INVARIANT ─────────────────────────────────────────────────
// Any note whose title or alias literally appears in the text is ALWAYS
// retrieved, regardless of profile, role, budget, or score. A bad profile
// or a too-small budget can therefore only cost tokens by including extra
// notes — it can never remove grounding the model needed. Every drop path
// below is guarded by `literal === false`.
// ──────────────────────────────────────────────────────────────────────

import type { AliasIndex } from './aliasIndexClient'
import type { KBDocument } from '@/types'

/** Role a folder plays, as classified by the optional mapping pass. */
export type FolderRole =
  /** In-world canon: NPCs, locations, factions, deities, plot threads. */
  | 'canon'
  /** Per-session write-ups. Only the most recent is kept for continuity. */
  | 'session-log'
  /** Craft advice, inspiration, third-party material. Not in-world. */
  | 'reference'
  /** Superseded or retired. Never included unless literally referenced. */
  | 'exclude'

export type RetrievalProfile = {
  /** Top-level folder (or path prefix) → role. Advisory only. */
  roles?: Record<string, FolderRole>
  /** Note paths always included regardless of matching (campaign frame). */
  coreNotes?: string[]
}

export type RetrievalOptions = {
  /** Alias index. When null, retrieval degrades to title matching over the
   *  documents themselves — still correct, just less alias-aware. */
  index: AliasIndex | null
  /** Optional folder-role profile. Absent = Tier 0 (pure Tier-0 signals). */
  profile?: RetrievalProfile | null
  /** Notes selected for the previous chunk, carried forward so a character
   *  introduced in chunk N is still grounded in chunk N+1 when they are
   *  referred to only as "he". Keyed by document id. */
  previousSelection?: ReadonlySet<string>
  /** Soft ceiling on total retrieved characters. Literal matches are never
   *  dropped to satisfy it, so the result may exceed this. Default 250k. */
  maxChars?: number
  /** How many most-referenced notes to treat as always-on core when the
   *  profile supplies no coreNotes. Default 6. */
  coreCount?: number
}

export type RetrievalResult = {
  docs: KBDocument[]
  /** Document ids selected — feed back as `previousSelection` next chunk. */
  selection: Set<string>
  /** Canonical entity names matched literally in the text. */
  matchedEntities: string[]
  stats: {
    totalDocs: number
    selectedDocs: number
    totalChars: number
    selectedChars: number
    /** Selected because their title/alias appeared in the text. */
    literalMatches: number
    /** Selected as always-on core. */
    coreDocs: number
    /** Carried over from the previous chunk. */
    carriedDocs: number
    /** Dropped to respect maxChars (never literal matches). */
    droppedForBudget: number
  }
}

/** Strip a note path down to its title: `05 - Lore/Deities/Aveline.md` →
 *  `Aveline`. Works for any separator and any depth. */
export function noteTitle(pathOrName: string): string {
  return pathOrName.split(/[\\/]/).pop()!.replace(/\.md$/i, '').trim()
}

/** Top-level folder of a note path, or '' when the note sits at the root.
 *  Only ever used to look up an advisory role — never to include/exclude
 *  on its own. */
function topFolder(relPath: string): string {
  const parts = relPath.split(/[\\/]/)
  return parts.length > 1 ? parts[0] : ''
}

/** Terms are matched on word boundaries so `Merr` does not fire inside
 *  `Kazakhstan`, and short terms are skipped entirely — a 3-character title
 *  matches too much prose to be a useful signal. */
const MIN_TERM_LEN = 4

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function mentions(haystackLower: string, term: string): boolean {
  if (term.length < MIN_TERM_LEN) return false
  const re = new RegExp(`(?:^|[^a-z0-9])${escapeRe(term.toLowerCase())}(?:[^a-z0-9]|$)`)
  return re.test(haystackLower)
}

/**
 * Count, for each document, how many OTHER documents mention its title.
 * The campaign's load-bearing notes are the ones everything else points at.
 * This is derived from content alone, so it holds for any vault layout.
 *
 * O(docs²) on titles only (not bodies) — a few hundred notes is trivial,
 * and callers memoise via `precomputedCore`.
 */
export function computeCoreNotes(docs: KBDocument[], count: number): Set<string> {
  const titles = docs.map((d) => ({ id: d.id, title: noteTitle(d.relPath || d.name || '') }))
  const scored = titles.map(({ id, title }) => {
    if (title.length < MIN_TERM_LEN) return { id, score: 0 }
    let score = 0
    for (const d of docs) {
      if (d.id === id) continue
      if (mentions((d.text || '').toLowerCase(), title)) score++
    }
    return { id, score }
  })
  return new Set(
    scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, count)
      .map((s) => s.id),
  )
}

/** Pick the highest-numbered session note — "Session 28" beats "Session 7".
 *  Falls back to lexicographic order when no number is present. */
function latestSessionNote(docs: KBDocument[]): string | null {
  if (!docs.length) return null
  const rank = (d: KBDocument) => {
    const nums = (d.relPath || d.name || '').match(/\d+/g)
    return nums ? Math.max(...nums.map(Number)) : -1
  }
  return [...docs].sort((a, b) => {
    const r = rank(b) - rank(a)
    return r !== 0 ? r : (b.relPath || '').localeCompare(a.relPath || '')
  })[0].id
}

/**
 * Select the subset of `docs` needed to ground `text`.
 *
 * Tier 0 (no profile) is the default and needs no configuration: literal
 * title/alias matches + always-on core + previous-chunk carry-over.
 * A profile only adds the ability to demote reference material and to keep
 * just the newest session log — it can never remove a literal match.
 */
export function retrieveForText(
  text: string,
  docs: KBDocument[],
  opts: RetrievalOptions,
): RetrievalResult {
  const {
    index,
    profile,
    previousSelection,
    maxChars = 250_000,
    coreCount = 6,
  } = opts

  const lower = text.toLowerCase()
  const byId = new Map(docs.map((d) => [d.id, d]))
  const pathOf = (d: KBDocument) => d.relPath || d.name || ''

  // --- 1. Literal matches -------------------------------------------------
  // Build title → doc and alias → doc. The alias index maps a canonical name
  // to the file that defines it, which is how an alias like "The Pale Ledger"
  // pulls in Aveline.md even though that string never appears in the title.
  const literal = new Set<string>()
  const matchedEntities: string[] = []

  const docByPath = new Map<string, KBDocument>()
  for (const d of docs) docByPath.set(pathOf(d).replace(/\\/g, '/'), d)

  if (index) {
    for (const entity of Object.values(index.byEntity ?? {})) {
      const terms = [entity.name, ...(entity.aliases ?? [])].filter(Boolean)
      if (!terms.some((t) => mentions(lower, t))) continue
      matchedEntities.push(entity.name)
      const target = docByPath.get((entity.file ?? '').replace(/\\/g, '/'))
      if (target) literal.add(target.id)
    }
  }
  // Title matching runs whether or not an index exists — it is the fallback
  // when the add-on is off, and it catches notes the index has no entity for.
  for (const d of docs) {
    const title = noteTitle(pathOf(d))
    if (mentions(lower, title)) literal.add(d.id)
  }

  // --- 2. Roles (advisory) ------------------------------------------------
  const roleOf = (d: KBDocument): FolderRole | undefined =>
    profile?.roles?.[topFolder(pathOf(d))]

  const sessionDocs = docs.filter((d) => roleOf(d) === 'session-log')
  const keepSessionId = latestSessionNote(sessionDocs)

  // --- 3. Always-on core --------------------------------------------------
  const core = new Set<string>()
  if (profile?.coreNotes?.length) {
    const wanted = new Set(profile.coreNotes.map((p) => p.replace(/\\/g, '/')))
    for (const d of docs) if (wanted.has(pathOf(d).replace(/\\/g, '/'))) core.add(d.id)
  } else {
    // Tier 0: derive core from inbound references, excluding anything the
    // profile marks as not-canon so advice notes can't become "core".
    const eligible = docs.filter((d) => {
      const r = roleOf(d)
      return r !== 'reference' && r !== 'exclude' && r !== 'session-log'
    })
    for (const id of computeCoreNotes(eligible, coreCount)) core.add(id)
  }

  // --- 4. Assemble --------------------------------------------------------
  const carried = new Set<string>()
  for (const id of previousSelection ?? []) if (byId.has(id) && !literal.has(id)) carried.add(id)

  const selected = new Set<string>(literal)
  const addIfAllowed = (id: string) => {
    const d = byId.get(id)
    if (!d) return
    const r = roleOf(d)
    // Non-literal inclusion respects roles; literal matches bypassed this
    // entirely by being added above.
    if (r === 'exclude' || r === 'reference') return
    if (r === 'session-log' && id !== keepSessionId) return
    selected.add(id)
  }
  for (const id of core) addIfAllowed(id)
  for (const id of carried) addIfAllowed(id)
  if (keepSessionId) addIfAllowed(keepSessionId)

  // --- 5. Budget ----------------------------------------------------------
  // Drop non-literal notes, largest first, until under budget. Literal
  // matches are untouchable — see the safety invariant.
  const sizeOf = (id: string) => (byId.get(id)?.text || '').length
  let totalSelected = 0
  for (const id of selected) totalSelected += sizeOf(id)

  let droppedForBudget = 0
  if (totalSelected > maxChars) {
    const droppable = [...selected]
      .filter((id) => !literal.has(id))
      .sort((a, b) => sizeOf(b) - sizeOf(a))
    for (const id of droppable) {
      if (totalSelected <= maxChars) break
      selected.delete(id)
      totalSelected -= sizeOf(id)
      droppedForBudget++
    }
  }

  const outDocs = docs.filter((d) => selected.has(d.id))
  return {
    docs: outDocs,
    selection: selected,
    matchedEntities,
    stats: {
      totalDocs: docs.length,
      selectedDocs: outDocs.length,
      totalChars: docs.reduce((a, d) => a + (d.text || '').length, 0),
      selectedChars: outDocs.reduce((a, d) => a + (d.text || '').length, 0),
      literalMatches: literal.size,
      coreDocs: core.size,
      carriedDocs: carried.size,
      droppedForBudget,
    },
  }
}
