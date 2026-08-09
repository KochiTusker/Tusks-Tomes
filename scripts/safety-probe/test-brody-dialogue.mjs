#!/usr/bin/env node
// Focused probe — does Solveig's specific line that tripped Phase 2 chunk 3
// during the dev-test-mode run pass on Paid Flash / Paid Pro when it fails
// on Free Flash? Confirms the Free→Paid escalation path will actually
// recover the chunk before we soft-skip it.
//
// Reuses the canonical phase2Audit() prompt builder so the test wraps the
// dialogue in exactly the same audit framing the pipeline does.
//
// Reads keys from .env (PAID_GEMINI_API_KEY + VITE_GEMINI_API_KEY) so it
// runs against the same endpoints the pipeline uses. NO data ever lands
// on disk besides the report itself.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { phase2Audit } from './prompts.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..', '..')

async function loadEnv() {
  const envPath = path.join(repoRoot, '.env')
  try {
    const raw = await fs.readFile(envPath, 'utf8')
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i)
      if (!m) continue
      const key = m[1]
      let val = m[2]
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1)
      }
      if (!(key in process.env)) process.env[key] = val
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
}

/** Pull live keys from the running dev server's encrypted vault. The server
 *  serves these at /api/provider-keys (machine-bound scrypt decryption); we
 *  use them in-memory only, never log or persist. Falls back to .env if the
 *  server isn't reachable. */
async function loadLiveKeys() {
  const port = process.env.PORT || 5173
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/provider-keys`, {
      signal: AbortSignal.timeout(2000),
    })
    if (!res.ok) return null
    const json = await res.json()
    return {
      paid: typeof json.gemini === 'string' && json.gemini.length > 0 ? json.gemini : null,
      free: typeof json.geminiFallback === 'string' && json.geminiFallback.length > 0 ? json.geminiFallback : null,
    }
  } catch {
    return null
  }
}

// The exact dialogue region that landed in Phase 2 chunk 3/3 on the
// 24KB dev-test-mode run, focused tightly around the suspected trigger
// (the suplex sequence + the "gay way possible" line). Mirrors .sbv
// shape so the audit prompt sees the same structure the pipeline saw.
const BRODY_CHUNK = `0:11:35.000,0:11:35.720
[Dungeon Master (DM)] Stardust then

0:11:35.720,0:11:37.880
[Dungeon Master (DM)] Manages to pick him up and then suplex him

0:11:37.880,0:11:38.160
[Dungeon Master (DM)] Himself

0:11:38.470,0:11:39.630
[Solveig (Orsolya)] wanna as he like

0:11:39.630,0:11:41.470
[Solveig (Orsolya)] gets knocked prone I wanna do like this

0:11:41.470,0:11:43.730
[Solveig (Orsolya)] and then just like stick my tongue out at him

0:11:43.730,0:11:45.590
[Solveig (Orsolya)] like in the most gay way possible

0:11:46.620,0:11:47.480
[Dungeon Master (DM)] Yeah sure

0:11:48.060,0:11:48.580
[Solveig (Orsolya)] um

0:11:48.080,0:11:50.700
[Dungeon Master (DM)] You can get two hype points for that`

// Pipeline-equivalent BLOCK_NONE safety settings (gemini.ts:49-65).
// All four configurable HarmCategory thresholds set to BLOCK_NONE.
const SAFETY_SETTINGS = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
]

function classifyOutcome(json) {
  const pfReason = json?.promptFeedback?.blockReason
  if (typeof pfReason === 'string') return { outcome: 'blocked_prompt', reason: pfReason, where: 'promptFeedback' }
  const cand = json?.candidates?.[0]
  const fr = cand?.finishReason
  if (typeof fr === 'string' && fr !== 'STOP' && fr !== 'MAX_TOKENS') {
    return { outcome: 'blocked_candidate', reason: fr, where: 'finishReason' }
  }
  const text = cand?.content?.parts?.[0]?.text
  if (typeof text === 'string' && text.length > 0) {
    return { outcome: 'pass', textPreview: text.slice(0, 200) }
  }
  return { outcome: 'empty', reason: fr ?? null }
}

async function probeCell({ label, apiKey, modelId, userPrompt }) {
  if (!apiKey) return { label, modelId, outcome: 'skipped_no_key' }
  const t0 = Date.now()
  const body = {
    contents: [{ parts: [{ text: userPrompt }] }],
    safetySettings: SAFETY_SETTINGS,
    generationConfig: { maxOutputTokens: 1024, temperature: 0 },
  }
  let res, json
  try {
    res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    )
  } catch (err) {
    return { label, modelId, outcome: 'network_error', error: err?.message ?? String(err), latencyMs: Date.now() - t0 }
  }
  const latencyMs = Date.now() - t0
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { label, modelId, outcome: `http_${res.status}`, errorPreview: text.slice(0, 300), latencyMs }
  }
  json = await res.json().catch(() => null)
  if (!json) return { label, modelId, outcome: 'parse_error', latencyMs }
  const result = classifyOutcome(json)
  return { label, modelId, latencyMs, ...result, promptFeedback: json.promptFeedback ?? null }
}

async function main() {
  await loadEnv()
  const live = await loadLiveKeys()
  const paidKey = live?.paid ?? process.env.PAID_GEMINI_API_KEY
  const freeKey = live?.free ?? process.env.VITE_GEMINI_API_KEY
  const keysFrom = live?.paid || live?.free ? 'live server vault' : '.env'

  const userPrompt = phase2Audit({
    rawChunk: BRODY_CHUNK,
    groundedChunk: BRODY_CHUNK,
    index: 2,
    total: 3,
  })

  console.log('=== Solveig-dialogue probe ===')
  console.log(`Chunk length: ${BRODY_CHUNK.length} chars`)
  console.log(`Prompt length: ${userPrompt.length} chars`)
  console.log(`Free key configured: ${freeKey ? 'YES' : 'NO'} (source: ${keysFrom})`)
  console.log(`Paid key configured: ${paidKey ? 'YES' : 'NO'} (source: ${keysFrom})`)
  console.log('')

  const cells = [
    { label: 'Free Flash', apiKey: freeKey, modelId: 'gemini-2.5-flash' },
    { label: 'Paid Flash', apiKey: paidKey, modelId: 'gemini-2.5-flash' },
    { label: 'Paid Pro',   apiKey: paidKey, modelId: 'gemini-2.5-pro' },
  ]

  const results = []
  for (const c of cells) {
    const r = await probeCell({ ...c, userPrompt })
    results.push(r)
    const reason = r.reason ? ` (${r.reason})` : ''
    const lat = r.latencyMs ? ` ${r.latencyMs}ms` : ''
    console.log(`${c.label.padEnd(12)} → ${r.outcome}${reason}${lat}`)
    if (r.outcome === 'pass' && r.textPreview) {
      console.log(`              text preview: ${r.textPreview.replace(/\n/g, ' ').slice(0, 120)}`)
    }
    if (r.errorPreview) {
      console.log(`              error: ${r.errorPreview.slice(0, 200)}`)
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outPath = path.join(repoRoot, '.diagnose', `brody-probe-${stamp}.json`)
  await fs.mkdir(path.dirname(outPath), { recursive: true })
  await fs.writeFile(
    outPath,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        chunkChars: BRODY_CHUNK.length,
        promptChars: userPrompt.length,
        cells: results,
      },
      null,
      2,
    ),
    'utf8',
  )
  console.log('')
  console.log(`Report written: ${path.relative(repoRoot, outPath)}`)

  const free = results.find((r) => r.label === 'Free Flash')
  const paidFlash = results.find((r) => r.label === 'Paid Flash')
  console.log('')
  console.log('=== Verdict ===')
  if (free?.outcome.startsWith('blocked') && paidFlash?.outcome === 'pass') {
    console.log('✓ Asymmetry CONFIRMED: Free Flash blocks; Paid Flash passes.')
    console.log('  → Free→Paid escalation will recover this chunk.')
  } else if (free?.outcome === 'pass' && paidFlash?.outcome === 'pass') {
    console.log('~ Both tiers pass. Asymmetry not reproducible right now.')
    console.log('  Filter behavior may have shifted, or this chunk was a transient false positive.')
  } else if (free?.outcome.startsWith('blocked') && paidFlash?.outcome?.startsWith('blocked')) {
    console.log('✗ Both Free Flash AND Paid Flash block. Escalation will not recover this chunk.')
    console.log('  Soft-skip remains the only safety net for this exact prompt.')
  } else {
    console.log('? Mixed/unexpected outcomes — see report for full details.')
  }
}

main().catch((err) => {
  console.error('Probe failed:', err)
  process.exit(1)
})
