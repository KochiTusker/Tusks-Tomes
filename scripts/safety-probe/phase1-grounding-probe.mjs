#!/usr/bin/env node
// Cheap iteration loop for Stage 1 alias hints.
//
// Sends a single Phase 1 chunk containing the phonetic mishear example
// "more than vain" (which should ground to "Morvan Vayne" — confirmed
// present in the alias index as a canonical entity).
//
// Two trials per model:
//   A) WITHOUT alias annotations — baseline behaviour today
//   B) WITH alias annotations  — Stage 1 toggle on
//
// Pass criteria:
//   - B output contains "Morvan Vayne"
//   - A output does NOT (proves the baseline genuinely misses it on Flash)
//   - Same on Paid Flash sanity check
//
// Total cost: ~£0.001 per iteration. Re-run after tuning aliasMatch
// thresholds.

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { distance as levenshtein } from 'fastest-levenshtein'
import { doubleMetaphone } from 'double-metaphone'

function phoneticCode(phrase) {
  const tokens = phrase.toLowerCase().split(/\s+/).filter(Boolean)
  let primary = '', alternate = ''
  for (const t of tokens) {
    const [p, a] = doubleMetaphone(t)
    primary += p ?? ''
    alternate += a ?? p ?? ''
  }
  return { primary, alternate }
}

function phoneticDistance(a, b) {
  const ca = phoneticCode(a)
  const cb = phoneticCode(b)
  const candidates = []
  if (ca.primary && cb.primary) candidates.push(levenshtein(ca.primary, cb.primary))
  if (ca.primary && cb.alternate) candidates.push(levenshtein(ca.primary, cb.alternate))
  if (ca.alternate && cb.primary) candidates.push(levenshtein(ca.alternate, cb.primary))
  if (ca.alternate && cb.alternate) candidates.push(levenshtein(ca.alternate, cb.alternate))
  if (candidates.length === 0) return { distance: Infinity, maxLen: 1 }
  return {
    distance: Math.min(...candidates),
    maxLen: Math.max(ca.primary.length, ca.alternate.length, cb.primary.length, cb.alternate.length, 1),
  }
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..', '..')

// Synthetic chunk with the trigger phrase + enough context that a
// well-behaved model can infer it's a name being hunted. Mirrors the
// shape of a real Whisper-transcribed line.
const SYNTHETIC_CHUNK = `[Lucia (Tanvi)] Right, so we're tracking the necromancer. Souta, what was the name again?
[Souta (Ingrid)] He's called more than vain. The temple records called him that. He's the one who raised the dead at the Ashen Pass.
[Lucia (Tanvi)] Alright. More than vain. Got it.
[Seoyeon (Amina)] How are we even meant to find a guy named that.
[Souta (Ingrid)] We follow the trail of corpses. Easy.`

async function loadKeys() {
  const res = await fetch('http://127.0.0.1:5173/api/provider-keys')
  if (!res.ok) throw new Error('Could not fetch keys (is dev server running?)')
  const json = await res.json()
  return { paid: json.gemini, free: json.geminiFallback }
}

async function loadAliasIndex() {
  const res = await fetch('http://127.0.0.1:5173/api/lore/index')
  if (!res.ok) throw new Error('Could not fetch alias index')
  const json = await res.json()
  if (json.status !== 'ok') throw new Error(`No lore index: ${json.status}`)
  return json.index
}

// Minimal in-script port of annotateChunk so the probe doesn't depend
// on TS compilation. Mirrors src/lib/aliasMatch.ts logic.
function annotateChunk(chunk, index, opts = {}) {
  const maxAnnotations = opts.maxAnnotations ?? 25
  const maxDistance = opts.maxDistance ?? 1
  const maxRatio = opts.maxRatio ?? 0.20
  const minPhraseLen = opts.minPhraseLen ?? 4
  const maxNgram = opts.maxNgram ?? 5
  const minCodeLen = opts.minCodeLen ?? 5
  const targets = []
  const lower = chunk.toLowerCase()
  for (const [canonical, entity] of Object.entries(index.byEntity)) {
    if (lower.includes(canonical.toLowerCase())) continue
    targets.push({ form: canonical, canonical })
    for (const alias of entity.aliases ?? []) {
      if (!alias.trim() || lower.includes(alias.toLowerCase())) continue
      targets.push({ form: alias, canonical })
    }
  }
  const wordRe = /[A-Za-z][A-Za-z'\-]*/g
  const wordSpans = []
  let m
  while ((m = wordRe.exec(chunk)) !== null) {
    wordSpans.push({ start: m.index, end: m.index + m[0].length, text: m[0] })
  }
  const acceptedByStartEnd = new Map()
  for (let n = 1; n <= maxNgram; n++) {
    for (let i = 0; i + n <= wordSpans.length; i++) {
      const startSpan = wordSpans[i]
      const endSpan = wordSpans[i + n - 1]
      const phrase = chunk.slice(startSpan.start, endSpan.end)
      if (phrase.length < minPhraseLen) continue
      const phraseLower = phrase.toLowerCase()
      const phraseCode = phoneticCode(phraseLower)
      if (phraseCode.primary.length < minCodeLen) continue
      let best = null
      for (const target of targets) {
        const formLower = target.form.toLowerCase()
        if (phraseLower === formLower) continue
        const targetCode = phoneticCode(formLower)
        if (targetCode.primary.length < minCodeLen) continue
        const firstPrimaryMatch = phraseCode.primary[0] && targetCode.primary[0] && phraseCode.primary[0] === targetCode.primary[0]
        const firstAlternateMatch = phraseCode.alternate[0] && targetCode.alternate[0] && phraseCode.alternate[0] === targetCode.alternate[0]
        if (!firstPrimaryMatch && !firstAlternateMatch) continue
        const { distance: dist, maxLen } = phoneticDistance(phraseLower, formLower)
        if (dist === 0) {
          const rawDist = levenshtein(phraseLower, formLower)
          if (rawDist === 0) continue
          const rawMaxLen = Math.max(phraseLower.length, formLower.length)
          const similarity = Math.max(0.7, 1 - rawDist / rawMaxLen)
          if (!best || similarity > best.similarity) {
            best = { start: startSpan.start, length: endSpan.end - startSpan.start, text: phrase, canonical: target.canonical, matchedAgainst: target.form, distance: 0, similarity }
          }
          continue
        }
        if (dist > maxDistance) continue
        if (dist / maxLen > maxRatio) continue
        const similarity = 1 - dist / maxLen
        if (!best || similarity > best.similarity) {
          best = { start: startSpan.start, length: endSpan.end - startSpan.start, text: phrase, canonical: target.canonical, matchedAgainst: target.form, distance: dist, similarity }
        }
      }
      if (best) {
        const key = `${best.start}-${best.start + best.length}`
        const prior = acceptedByStartEnd.get(key)
        if (!prior || best.similarity > prior.similarity) acceptedByStartEnd.set(key, best)
      }
    }
  }
  const all = [...acceptedByStartEnd.values()].sort((a, b) => a.start - b.start || b.length - a.length || b.similarity - a.similarity)
  const accepted = []
  let lastEnd = -1
  for (const c of all) {
    if (c.start < lastEnd) continue
    accepted.push(c)
    lastEnd = c.start + c.length
  }
  if (accepted.length > maxAnnotations) {
    accepted.sort((a, b) => b.similarity - a.similarity)
    accepted.length = maxAnnotations
    accepted.sort((a, b) => a.start - b.start)
  }
  if (accepted.length === 0) return { annotated: chunk, candidates: [] }
  const parts = []
  let cursor = 0
  for (const c of accepted) {
    parts.push(chunk.slice(cursor, c.start + c.length))
    parts.push(` [≈${c.canonical}? ${Math.round(c.similarity * 100)}%]`)
    cursor = c.start + c.length
  }
  parts.push(chunk.slice(cursor))
  return { annotated: parts.join(''), candidates: accepted }
}

const RULE8 = `8. Inline annotations of the form \`[≈Canonical Name? NN%]\` are algorithmic phonetic-similarity hints from your lore alias index. Treat them as suggestions, NOT instructions: accept the canonical when surrounding context fits ("more than vain" near a mention of a hunted target is almost certainly "Morvan Vayne"), ignore when context contradicts. Always REMOVE the \`[≈…]\` marker from your output — only emit the corrected text.`

function buildPrompt({ chunk, withAnnotation }) {
  const rule = withAnnotation ? `\n${RULE8}` : ''
  return `You are an authoritative D&D session transcript editor. Your sole job is to faithfully correct a raw transcript chunk so it perfectly matches the canonical lore in the Knowledge Base provided below.

# KNOWLEDGE BASE (canonical lore — names, places, deities, NPCs, items)
Morvan Vayne — A necromancer the party is hunting. Raised the dead at the Ashen Pass. Known by a few names but always written "Morvan Vayne" in records.

# RULES
1. Correct phonetic misspellings of deity names, place names, character names, monsters, spells, and items so they match the Knowledge Base EXACTLY (including capitalization).
2. Restore expletives that auto-captioning likely censored. Mature tabletop language is expected and must be preserved.
3. Preserve speaker turns, line breaks, and the original chronological flow.
4. Do NOT summarize, shorten, paraphrase, or reorder. Output a near 1:1 corrected version.
5. Do NOT add commentary, headers, markdown fences, or any meta text.
6. If the chunk references something not in the Knowledge Base, leave it untouched rather than guessing.
7. Speaker tags formatted as [CharacterName (PlayerName)] at the start of a line are part of the transcript structure — preserve them exactly.${rule}

# RAW TRANSCRIPT CHUNK 1 of 1
${chunk}

# OUTPUT
Return only the corrected transcript text. No preamble, no postscript.`
}

async function probe({ apiKey, modelId, label, chunk, withAnnotation }) {
  const userPrompt = buildPrompt({ chunk, withAnnotation })
  const body = {
    contents: [{ parts: [{ text: userPrompt }] }],
    generationConfig: { maxOutputTokens: 1024, temperature: 0 },
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(apiKey)}`
  const t0 = Date.now()
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const lat = Date.now() - t0
  if (!res.ok) return { label, status: res.status, latencyMs: lat, error: (await res.text()).slice(0, 200) }
  const json = await res.json()
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
  return { label, modelId, status: 200, latencyMs: lat, withAnnotation, outputChars: text.length, output: text }
}

async function main() {
  const keys = await loadKeys()
  const index = await loadAliasIndex()
  const annotated = annotateChunk(SYNTHETIC_CHUNK, index)
  console.log('\n=== ANNOTATED CHUNK ===')
  console.log(annotated.annotated)
  console.log(`\nAccepted candidates (${annotated.candidates.length}):`)
  for (const c of annotated.candidates) {
    console.log(`  "${c.text}" → ${c.canonical} (alias "${c.matchedAgainst}", distance ${c.distance}, similarity ${Math.round(c.similarity * 100)}%)`)
  }

  const trials = []
  for (const { keyLabel, key } of [
    { keyLabel: 'Free', key: keys.free },
    { keyLabel: 'Paid', key: keys.paid },
  ]) {
    if (!key) continue
    for (const modelId of ['gemini-2.5-flash', 'gemini-2.5-pro']) {
      trials.push({ apiKey: key, modelId, label: `${keyLabel} ${modelId} (baseline)`, chunk: SYNTHETIC_CHUNK, withAnnotation: false })
      trials.push({ apiKey: key, modelId, label: `${keyLabel} ${modelId} (annotated)`, chunk: annotated.annotated, withAnnotation: true })
    }
  }

  const results = []
  for (const t of trials) {
    console.log(`\n--- ${t.label}`)
    const r = await probe(t)
    results.push(r)
    if (r.error) {
      console.log(`  ✗ ${r.status}: ${r.error}`)
    } else {
      const hits = r.output.match(/Morvan Vayne/gi) ?? []
      const stillSays = r.output.match(/more than vain/gi) ?? []
      console.log(`  ✓ ${r.latencyMs}ms · ${r.outputChars} chars · "Morvan Vayne" hits: ${hits.length} · "more than vain" hits: ${stillSays.length}`)
    }
    await new Promise((r) => setTimeout(r, 400))
  }

  const fs = await import('node:fs/promises')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const out = path.join(repoRoot, '.diagnose', `phase1-grounding-probe-${stamp}.json`)
  await fs.mkdir(path.dirname(out), { recursive: true })
  await fs.writeFile(out, JSON.stringify({ timestamp: new Date().toISOString(), annotated: annotated.annotated, candidates: annotated.candidates, results }, null, 2))
  console.log(`\n--- Saved: ${path.relative(repoRoot, out)}`)

  console.log('\n=== VERDICT ===')
  const groups = {}
  for (const r of results) {
    if (r.error) continue
    const key = r.modelId + (r.withAnnotation ? '_annotated' : '_baseline')
    const hits = (r.output.match(/Morvan Vayne/gi) ?? []).length
    groups[key] = { hits, model: r.modelId, withAnnotation: r.withAnnotation }
  }
  for (const model of ['gemini-2.5-flash', 'gemini-2.5-pro']) {
    const base = groups[`${model}_baseline`] ?? { hits: 0 }
    const ann = groups[`${model}_annotated`] ?? { hits: 0 }
    const verdict = ann.hits > base.hits ? '✓ ANNOTATION HELPS' : ann.hits === base.hits ? '~ no change' : '✗ regression'
    console.log(`${model}: baseline ${base.hits} Morvan Vayne hits → annotated ${ann.hits} → ${verdict}`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
