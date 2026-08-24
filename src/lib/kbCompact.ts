// Compact representation of the Knowledge Base for local LLMs with small
// context windows.
//
// The full KB for a campaign can run 100k+ tokens — well beyond an 8GB-VRAM
// model's loaded context. Even with chunked transcripts, sending the full KB
// per chunk (as we do for cloud) crashes Qwen / Llama / Gemma 7B-class models
// instantly. Until proper RAG (milestone #3) lands, we extract a glossary of
// canonical proper nouns + brief context lines that captures most of the
// value at ~1/20 the token cost.
//
// The extraction is heuristic and intentionally conservative — better to ship
// a faithful subset than to invent terms. Hand-curated lists in
// `src/data/corrections.ts` and `src/data/dndDictionary.ts` are also surfaced
// since those are the cleanest signal we have.

const TITLE_CASE = /\b([A-Z][a-z'’]+(?:\s+(?:of|the|de|der|von|the)?\s*[A-Z][a-z'’]+){0,3})\b/g

// Words that look like proper nouns at the start of a sentence but aren't.
const STOPWORDS = new Set([
  'The', 'A', 'An', 'I', 'It', 'He', 'She', 'They', 'We', 'You', 'My', 'Our',
  'This', 'That', 'These', 'Those', 'There', 'Here', 'When', 'Where', 'Why',
  'How', 'What', 'Who', 'Whose', 'Which', 'But', 'And', 'Or', 'So', 'If',
  'For', 'In', 'On', 'At', 'To', 'From', 'With', 'By', 'As', 'After',
  'Before', 'During', 'While', 'Yes', 'No', 'Maybe', 'Yeah', 'Okay', 'Ok',
  'Note', 'Notes', 'Section', 'Chapter', 'Page', 'Day', 'Days', 'Night',
  'Once', 'Then', 'Now', 'Again', 'Just', 'Still', 'Even', 'Also', 'Only',
])

export type CompactKbResult = {
  /** Compact glossary string ready to paste into a prompt. */
  text: string
  /** How many distinct proper-noun terms made it in. */
  termCount: number
  /** Original char count of the full KB (for diagnostics). */
  originalChars: number
  /** Compact output's char count (for diagnostics). */
  compactChars: number
}

/**
 * Extract canonical names and one-line context snippets from the full KB.
 * Targets ~10–20 KB of output regardless of input size.
 */
/**
 * Choose the KB shape per pipeline phase.
 *
 *   Phase 1 (Ground)   → compact glossary. Grounding is a names-and-terms
 *                        task per prompts.ts; the full prose KB ships
 *                        ~10× more bytes than the task needs.
 *   Phase 2 (Audit)    → compact. Audit reads the grounded chunk +
 *                        names; doesn't need narrative lore depth.
 *   Phase 3 (Chronicle)→ full prose. The chronicle writer benefits from
 *                        the narrative tone of the KB documents.
 *   Phase 4 (Extras)   → compact. Jests/gore/quotes are dialogue-driven,
 *                        not lore-deep.
 *   Phase 6 (Condense) → full prose. Mirrors Phase 3 — the condenser
 *                        is recapping the chronicle's narrative.
 *
 * Applies uniformly to cloud and local providers (local already used
 * compactKb everywhere — cloud now joins it for Phase 1, 2, 4). The
 * `result.text` is suitable for direct splice into a prompt's KB
 * section; the per-phase reduction is the headline savings.
 */
export type KbPhase = 'phase1_ground' | 'phase2_audit' | 'phase3_chronicle' | 'phase4_extras' | 'phase6_condense'

export function kbForPhase(phase: KbPhase, fullKb: string): { text: string; format: 'compact' | 'full' } {
  switch (phase) {
    case 'phase1_ground':
    case 'phase2_audit':
    case 'phase4_extras':
      return { text: compactKb(fullKb).text, format: 'compact' }
    case 'phase3_chronicle':
    case 'phase6_condense':
      return { text: fullKb || '(no Knowledge Base provided)', format: 'full' }
  }
}

export function compactKb(fullKb: string): CompactKbResult {
  const originalChars = fullKb.length
  if (!fullKb.trim()) {
    return { text: '(no Knowledge Base provided)', termCount: 0, originalChars, compactChars: 0 }
  }

  // 1. Pull all Title-Case phrases. Count frequency to identify load-bearing
  //    terms (a name mentioned 8 times matters more than one mentioned once).
  const counts = new Map<string, number>()
  for (const match of fullKb.matchAll(TITLE_CASE)) {
    const term = match[1].trim()
    if (!term) continue
    // Skip pure stopwords / single-word stopwords appearing alone.
    if (term.split(/\s+/).every((w) => STOPWORDS.has(w))) continue
    // Skip if the very first word is a stopword AND it's a single-word match.
    if (!term.includes(' ') && STOPWORDS.has(term)) continue
    counts.set(term, (counts.get(term) ?? 0) + 1)
  }

  // 2. Sort by frequency desc, then alphabetically for ties.
  const ranked = Array.from(counts.entries()).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1]
    return a[0].localeCompare(b[0])
  })

  // 3. Take the top 200 by frequency. For each, find the first sentence
  //    in the KB that contains it — this gives downstream the canonical
  //    spelling AND a 1-line context for what the term refers to.
  const topTerms = ranked.slice(0, 200)
  const sentenceFor = new Map<string, string>()
  // Split KB into sentences. Cheap heuristic — period/newline/semicolon.
  const sentences = fullKb.split(/(?<=[.!?])\s+|\n+/g).map((s) => s.trim()).filter(Boolean)
  for (const [term] of topTerms) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`\\b${escaped}\\b`)
    for (const s of sentences) {
      if (re.test(s) && s.length < 280) {
        sentenceFor.set(term, s)
        break
      }
    }
  }

  // 4. Compose: header, then one line per term — name + brief context.
  const lines: string[] = []
  lines.push('# CANONICAL NAMES & TERMS (use these spellings exactly)')
  lines.push('')
  for (const [term, freq] of topTerms) {
    const ctx = sentenceFor.get(term)
    if (ctx && ctx !== term) {
      // Truncate context to one line.
      const short = ctx.length > 200 ? ctx.slice(0, 197) + '…' : ctx
      lines.push(`- **${term}** (${freq}×) — ${short}`)
    } else {
      lines.push(`- **${term}** (${freq}×)`)
    }
  }

  const text = lines.join('\n')
  return {
    text,
    termCount: topTerms.length,
    originalChars,
    compactChars: text.length,
  }
}
