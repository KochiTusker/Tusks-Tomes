#!/usr/bin/env node
// A/B compare proper-noun extraction between the new (frontmatter-bearing)
// KB and a synthetic "old" KB built by stripping frontmatter from every
// .md doc. This tests whether the new system improves what Phase 1 / Phase
// 2 / Phase 4 grounding actually sees (via compactKb), without spending
// any API tokens.

import { promises as fs } from 'node:fs'
import path from 'node:path'

const LORE_ROOT = process.argv[2] || 'D:/Tusks-Lore'
const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n/

// Inline copy of compactKb's proper-noun extractor so we can run without
// importing TS modules. Matches src/lib/kbCompact.ts as of this commit.
const TITLE_CASE = /\b([A-Z][a-z'’]+(?:\s+(?:of|the|de|der|von|the)?\s*[A-Z][a-z'’]+){0,3})\b/g
const STOPWORDS = new Set([
  'The', 'A', 'An', 'I', 'It', 'He', 'She', 'They', 'We', 'You', 'My', 'Our',
  'This', 'That', 'These', 'Those', 'There', 'Here', 'When', 'Where', 'Why',
  'How', 'What', 'Who', 'Whose', 'Which', 'But', 'And', 'Or', 'So', 'If',
  'For', 'In', 'On', 'At', 'To', 'From', 'With', 'By', 'As', 'After',
  'Before', 'During', 'While', 'Yes', 'No', 'Maybe', 'Yeah', 'Okay', 'Ok',
  'Note', 'Notes', 'Section', 'Chapter', 'Page', 'Day', 'Days', 'Night',
  'Once', 'Then', 'Now', 'Again', 'Just', 'Still', 'Even', 'Also', 'Only',
])

function extractProperNouns(text, topN = 500) {
  const counts = new Map()
  for (const match of text.matchAll(TITLE_CASE)) {
    const term = match[1].trim()
    if (!term) continue
    if (term.split(/\s+/).every((w) => STOPWORDS.has(w))) continue
    if (!term.includes(' ') && STOPWORDS.has(term)) continue
    counts.set(term, (counts.get(term) ?? 0) + 1)
  }
  return Array.from(counts.entries())
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .slice(0, topN)
}

function stripFrontmatter(content) {
  return content.replace(FRONTMATTER_RE, '')
}

async function main() {
  const entries = await fs.readdir(LORE_ROOT, { withFileTypes: true })
  const mdFiles = entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
    .map((e) => path.join(LORE_ROOT, e.name))

  // Three scenarios:
  //   - oldKb         — TRUE pre-Layer-1 baseline. Reads from <file>.bak when
  //                     present; falls back to stripping frontmatter from the
  //                     current file when no .bak exists. This is "the old
  //                     docx-converted system" as it would have been read by
  //                     the pipeline.
  //   - newKbWithYaml — Layer 1 BEFORE the strip fix (had +3.67% overhead).
  //   - newKbStripped — Layer 1 AFTER the strip fix (what pipeline ships today).
  let newKbWithYaml = ''
  let newKbStripped = ''
  let oldKb = ''
  for (const f of mdFiles) {
    const c = await fs.readFile(f, 'utf8')
    const name = path.basename(f)
    newKbWithYaml += `### ${name}\n${c}\n\n`
    newKbStripped += `### ${name}\n${stripFrontmatter(c)}\n\n`
    // True-old: prefer the .bak (pre-migration content). For files that
    // never had a .bak (e.g. the 4 fallback files I directly edited in
    // this session, or files that were pre-existing .md without docx
    // roots), strip frontmatter from current content as a fair approximation.
    let oldText = stripFrontmatter(c)
    try {
      const bak = await fs.readFile(`${f}.bak`, 'utf8')
      oldText = bak
    } catch { /* no bak — keep stripped current */ }
    oldKb += `### ${name}\n${oldText}\n\n`
  }
  const newKb = newKbStripped

  const newTerms = extractProperNouns(newKb)
  const oldTerms = extractProperNouns(oldKb)

  const newMap = new Map(newTerms)
  const oldMap = new Map(oldTerms)

  // What's NEW in the top-200 with frontmatter that wasn't there without?
  const newTop200 = new Set(newTerms.slice(0, 200).map(([t]) => t))
  const oldTop200 = new Set(oldTerms.slice(0, 200).map(([t]) => t))
  const gainedInTop200 = [...newTop200].filter((t) => !oldTop200.has(t))
  const lostFromTop200 = [...oldTop200].filter((t) => !newTop200.has(t))

  // For terms in both, has the count meaningfully shifted? (frontmatter would
  // boost entity mentions because their names appear in the YAML too)
  const sharedTerms = [...newTop200].filter((t) => oldTop200.has(t))
  const boostedSignificantly = sharedTerms
    .map((t) => ({ term: t, oldCount: oldMap.get(t) ?? 0, newCount: newMap.get(t) ?? 0 }))
    .filter((d) => d.newCount > d.oldCount && d.newCount - d.oldCount >= 3)
    .sort((a, b) => (b.newCount - b.oldCount) - (a.newCount - a.oldCount))

  console.log('=== KB extraction A/B ===')
  console.log(`Lore root: ${LORE_ROOT}`)
  console.log(`Files: ${mdFiles.length}`)
  console.log()
  console.log(`Old KB size: ${oldKb.length.toLocaleString()} chars`)
  console.log(`New KB size: ${newKb.length.toLocaleString()} chars`)
  console.log(`Frontmatter overhead: ${((newKb.length - oldKb.length) / oldKb.length * 100).toFixed(2)}%`)
  console.log()
  console.log(`Distinct proper nouns extracted:`)
  console.log(`  old: ${oldTerms.length}`)
  console.log(`  new: ${newTerms.length}`)
  console.log(`  delta: ${newTerms.length - oldTerms.length > 0 ? '+' : ''}${newTerms.length - oldTerms.length}`)
  console.log()
  console.log(`Entities gained into top-200 (only present in NEW):`)
  if (gainedInTop200.length === 0) console.log('  (none — frontmatter didn\'t surface anything new in the top tier)')
  for (const term of gainedInTop200.slice(0, 30)) {
    console.log(`  + ${term} (${newMap.get(term)}×)`)
  }
  if (gainedInTop200.length > 30) console.log(`  ... +${gainedInTop200.length - 30} more`)
  console.log()
  console.log(`Entities lost from top-200 (only present in OLD):`)
  if (lostFromTop200.length === 0) console.log('  (none — no entity displaced from the top tier)')
  for (const term of lostFromTop200.slice(0, 10)) {
    console.log(`  - ${term} (${oldMap.get(term)}×)`)
  }
  if (lostFromTop200.length > 10) console.log(`  ... -${lostFromTop200.length - 10} more`)
  console.log()
  console.log(`Top frequency boosts (terms appearing more often due to YAML):`)
  for (const d of boostedSignificantly.slice(0, 15)) {
    const pct = ((d.newCount - d.oldCount) / d.oldCount * 100).toFixed(0)
    console.log(`  ${d.term}: ${d.oldCount} → ${d.newCount} (+${d.newCount - d.oldCount}, +${pct}%)`)
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
