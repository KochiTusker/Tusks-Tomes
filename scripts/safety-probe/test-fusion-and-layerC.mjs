#!/usr/bin/env node
// Empirically validate Layer B (chunk fusion) and Layer C (Paid Flash
// 15KB chunks) for the Solveig trigger.
//
// Builds a realistic 3-chunk Phase 2 audit scenario from the dev-test-mode
// transcript (24KB truncated), where chunk 3 is the Solveig-trigger chunk.
// Probes:
//   a) Original Free Flash 8KB chunk 3 (baseline — should block)
//   b) Layer C: same content but Paid Flash 15KB chunk size (chunk 3
//      naturally includes more surrounding context)
//   c) Layer B: fusion — chunk 2 + chunk 3 joined, sent as one prompt
//      (proves the fusion recovery path)

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { phase2Audit } from './prompts.mjs'
import { FIXTURE_E2E } from './fixtures-e2e.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..', '..')

const SAFETY_SETTINGS = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
]

async function loadLiveKeys() {
  const port = process.env.PORT || 5173
  const res = await fetch(`http://127.0.0.1:${port}/api/provider-keys`, {
    signal: AbortSignal.timeout(2000),
  })
  if (!res.ok) throw new Error('Could not fetch live keys')
  const json = await res.json()
  return {
    paid: json.gemini,
    free: json.geminiFallback,
  }
}

function classifyOutcome(json) {
  const pfReason = json?.promptFeedback?.blockReason
  if (typeof pfReason === 'string') return { outcome: 'blocked_prompt', reason: pfReason }
  const cand = json?.candidates?.[0]
  const fr = cand?.finishReason
  if (typeof fr === 'string' && fr !== 'STOP' && fr !== 'MAX_TOKENS') {
    return { outcome: 'blocked_candidate', reason: fr }
  }
  const text = cand?.content?.parts?.[0]?.text
  if (typeof text === 'string' && text.length > 0) return { outcome: 'pass', textChars: text.length }
  return { outcome: 'empty' }
}

async function probe({ apiKey, modelId, userPrompt }) {
  const body = {
    contents: [{ parts: [{ text: userPrompt }] }],
    safetySettings: SAFETY_SETTINGS,
    generationConfig: { maxOutputTokens: 1024, temperature: 0 },
  }
  const t0 = Date.now()
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  )
  const lat = Date.now() - t0
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { outcome: `http_${res.status}`, latency: lat, error: text.slice(0, 200) }
  }
  const json = await res.json().catch(() => null)
  if (!json) return { outcome: 'parse_error', latency: lat }
  return { ...classifyOutcome(json), latency: lat, promptChars: userPrompt.length }
}

// Mimics src/lib/chunker.ts chunkText() — slices at maxChars, then backs up
// to the nearest paragraph/line boundary in the last 30% so chunks end
// cleanly. Good enough for this probe.
function chunkAtBoundary(text, maxChars) {
  const chunks = []
  let pos = 0
  while (pos < text.length) {
    let end = Math.min(pos + maxChars, text.length)
    if (end < text.length) {
      const lookback = end - Math.floor(maxChars * 0.3)
      const newlineAt = text.lastIndexOf('\n\n', end)
      if (newlineAt > lookback) end = newlineAt
      else {
        const singleNl = text.lastIndexOf('\n', end)
        if (singleNl > lookback) end = singleNl
      }
    }
    chunks.push(text.slice(pos, end).trim())
    pos = end
  }
  return chunks
}

async function main() {
  const live = await loadLiveKeys()
  if (!live.paid) {
    console.error('No paid key available. Aborting.')
    process.exit(1)
  }

  // Use the bundled synthetic 24KB transcript fixture — no dev-machine path
  // dependency, runs out-of-the-box on any clone. FIXTURE_E2E is hand-written
  // D&D content (combat, dialogue, dark themes) calibrated to match real
  // session style; identical chunk-count behaviour to a real 24KB SBV slice.
  const truncated = FIXTURE_E2E.join('\n').slice(0, 24_000)

  // Sliced at the two real chunk sizes:
  //   Free Flash 8KB → ~3 chunks
  //   Paid Flash 15KB → ~2 chunks
  const freeFlashChunks = chunkAtBoundary(truncated, 8_000)
  const paidFlashChunks = chunkAtBoundary(truncated, 15_000)

  // Find which chunk index in each splitting contains the trigger line.
  const triggerLine = 'in the most gay way possible'
  const triggerIdxFreeFlash = freeFlashChunks.findIndex((c) => c.includes(triggerLine))
  const triggerIdxPaidFlash = paidFlashChunks.findIndex((c) => c.includes(triggerLine))

  console.log('=== Layer B + Layer C empirical validation ===\n')
  console.log(`Truncated transcript size: ${truncated.length} chars`)
  console.log(`Free Flash chunking (8KB): ${freeFlashChunks.length} chunks — trigger in chunk ${triggerIdxFreeFlash + 1}`)
  console.log(`Paid Flash chunking (15KB): ${paidFlashChunks.length} chunks — trigger in chunk ${triggerIdxPaidFlash + 1}`)
  console.log('')

  const trials = [
    {
      label: 'A) Baseline: Free Flash, trigger-chunk only (8KB)',
      chunk: freeFlashChunks[triggerIdxFreeFlash],
      modelId: 'gemini-2.5-flash',
      apiKey: live.free,
      meta: 'simulates current Smart Budget behavior pre-fix',
    },
    {
      label: 'B) Layer B fusion: chunk[i-1] + chunk[i] on Paid Flash',
      chunk: (freeFlashChunks[triggerIdxFreeFlash - 1] || '') + '\n\n' + freeFlashChunks[triggerIdxFreeFlash],
      modelId: 'gemini-2.5-flash',
      apiKey: live.paid,
      meta: 'simulates Layer B fusion recovery — joined chunks, paid key',
    },
    {
      label: 'C) Layer C: Paid Flash 15KB chunking (natural)',
      chunk: paidFlashChunks[triggerIdxPaidFlash],
      modelId: 'gemini-2.5-flash',
      apiKey: live.paid,
      meta: 'simulates Smart Budget preset change to Paid Flash — bigger native chunks',
    },
    {
      label: 'D) Combined: fusion on Paid Flash 15KB (defense in depth)',
      chunk: (paidFlashChunks[triggerIdxPaidFlash - 1] || '') + '\n\n' + paidFlashChunks[triggerIdxPaidFlash],
      modelId: 'gemini-2.5-flash',
      apiKey: live.paid,
      meta: 'if Layer C still blocks, Layer B fuses on the larger native chunks',
    },
  ]

  const results = []
  for (let i = 0; i < trials.length; i++) {
    const t = trials[i]
    const userPrompt = phase2Audit({ rawChunk: t.chunk, groundedChunk: t.chunk, index: 2, total: 3 })
    console.log(`Running: ${t.label}`)
    console.log(`  Chunk: ${t.chunk.length} chars · Prompt: ${userPrompt.length} chars · ${t.meta}`)
    const r = await probe({ apiKey: t.apiKey, modelId: t.modelId, userPrompt })
    const reason = r.reason ? ` (${r.reason})` : ''
    const lat = r.latency ? ` [${r.latency}ms]` : ''
    console.log(`  → ${r.outcome}${reason}${lat}\n`)
    results.push({ ...t, ...r, chunk: undefined })  // strip chunk text from output
    await new Promise((r2) => setTimeout(r2, 1000))
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const out = path.join(repoRoot, '.diagnose', `fusion-layerC-${stamp}.json`)
  await fs.mkdir(path.dirname(out), { recursive: true })
  await fs.writeFile(out, JSON.stringify({ timestamp: new Date().toISOString(), trials: results }, null, 2), 'utf8')
  console.log(`Report: ${path.relative(repoRoot, out)}\n`)

  console.log('=== Verdict ===')
  const [a, b, c, d] = results
  if (a.outcome.startsWith('blocked')) console.log(`✓ Baseline reproduced — Free Flash chunk ${triggerIdxFreeFlash + 1}/${freeFlashChunks.length} blocks as expected.`)
  else console.log(`~ Baseline did NOT block (filter behavior may have shifted since last run).`)

  if (b.outcome === 'pass') console.log('✓ LAYER B (fusion) RECOVERS the blocked chunk. Fusion fallback works.')
  else console.log(`✗ Layer B did NOT recover (${b.outcome}). Fusion alone insufficient.`)

  if (c.outcome === 'pass') console.log('✓ LAYER C (Paid Flash 15KB) PREVENTS the block. Bigger native chunks suffice.')
  else console.log(`~ Layer C alone did NOT pass (${c.outcome}). Need fusion as defense-in-depth.`)

  if (d.outcome === 'pass') console.log('✓ Combined (B+C) passes — full defense in depth confirmed.')

  if (c.outcome === 'pass' && b.outcome === 'pass') {
    console.log('\nFinal: BOTH layers independently sufficient. Layer C prevents most cases; Layer B catches any survivors.')
  }
}

main().catch((err) => {
  console.error('Probe failed:', err)
  process.exit(1)
})
