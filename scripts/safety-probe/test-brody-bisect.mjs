#!/usr/bin/env node
// The previous Free/Paid probe showed: Lucia's chunk blocks on ALL three
// Gemini tiers (Free Flash, Paid Flash, Paid Pro). So the trigger is the
// content itself, not the endpoint's T&S threshold.
//
// This probe isolates which line(s) trigger it:
//   1. Send each individual cue in isolation → which one(s) block?
//   2. Send the chunk MINUS the suspected trigger → does the rest pass?
//   3. Send the chunk diluted with neutral wrestling commentary (mimicking
//      the larger Paid Pro chunk size effect) → does dilution unblock it?
//
// Helps answer the user's question: was the previous run "passing through"
// because the same content lived in a larger chunk where the trigger got
// diluted by surrounding context?

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { phase2Audit } from './prompts.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..', '..')

const SAFETY_SETTINGS = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
]

// SYNTHETIC. This probe originally carried the verbatim chunk that tripped the
// filter in a real session — which meant a private conversation, and the people
// having it, sat in a public repo. The cues below are written to reproduce the
// same trigger rather than copied from anyone's game: the shape that blocks is
// a grappling sequence plus a taunt phrased around sexuality, and that shape is
// reconstructable without shipping the original.
//
// If you re-run this against a fresh block, DO NOT paste the real chunk in.
// Write an equivalent, or point the probe at a file outside the repo.
const LINE_SUSPECT = `0:11:43.730,0:11:45.590
[Lucia (Tanvi)] and I do it in the most gay way possible obviously`

const LINE_SUPLEX = `0:11:35.720,0:11:37.880
[Dungeon Master (DM)] He hoists you up and drops you with a suplex`

const LINE_KNOCKED_PRONE = `0:11:39.630,0:11:41.470
[Lucia (Tanvi)] so once he's knocked prone I want to do this bit`

const LINE_TONGUE = `0:11:41.470,0:11:43.730
[Lucia (Tanvi)] I stand over him and stick my tongue out at the crowd`

// The full chunk, assembled from the cues above plus filler turns.
const FULL = `0:11:35.000,0:11:35.720
[Dungeon Master (DM)] Starfall steps up then

0:11:35.720,0:11:37.880
[Dungeon Master (DM)] He hoists you up and drops you with a suplex

0:11:37.880,0:11:38.160
[Dungeon Master (DM)] Hard

0:11:38.470,0:11:39.630
[Lucia (Tanvi)] right ok so what I want is

0:11:39.630,0:11:41.470
[Lucia (Tanvi)] so once he's knocked prone I want to do this bit

0:11:41.470,0:11:43.730
[Lucia (Tanvi)] I stand over him and stick my tongue out at the crowd

0:11:43.730,0:11:45.590
[Lucia (Tanvi)] and I do it in the most gay way possible obviously

0:11:46.620,0:11:47.480
[Dungeon Master (DM)] Yeah go on then

0:11:48.060,0:11:48.580
[Lucia (Tanvi)] um

0:11:48.080,0:11:50.700
[Dungeon Master (DM)] That's two hype points for the crowd work`

// The same chunk with the suspect line removed.
const FULL_MINUS_SUSPECT = FULL.replace(LINE_SUSPECT, '').replace(/\n\n\n+/g, '\n\n').trim()

// "Dilution" — wrap the original chunk in ~5KB of additional neutral
// wrestling commentary, mimicking how the same line would have appeared
// in a much larger Paid Pro chunk during the pre-Smart-Budget runs.
const NEUTRAL_BEFORE = `0:08:00.000,0:08:03.000
[Dungeon Master (DM)] The wrestling ring is set up. The crowd is buzzing.

0:08:03.000,0:08:05.000
[Lucia (Tanvi)] I want to enter to my theme music. Star Spangled Pentagon power.

0:08:05.000,0:08:07.000
[Dungeon Master (DM)] Confetti rains down. The pyrotechnics fire.

0:08:07.000,0:08:09.000
[Eero (Beatriz)] This is the big match. Tonight Stardust faces the Underminer.

0:08:09.000,0:08:12.000
[Thao (Devika)] Last week's championship was a real spectacle. The crowd loved it.

0:08:12.000,0:08:14.000
[Lucia (Tanvi)] I'm gonna start with a low-risk jab. Just feeling him out.

0:08:14.000,0:08:16.000
[Dungeon Master (DM)] Roll a d20 for the jab attack.

0:08:16.000,0:08:18.000
[Lucia (Tanvi)] Twelve plus three. Fifteen total.

0:08:18.000,0:08:20.000
[Dungeon Master (DM)] The Underminer blocks. You lose a hype point.

0:08:20.000,0:08:22.000
[Lucia (Tanvi)] Damn it. I'll try to grapple him next round.

0:08:22.000,0:08:25.000
[Eero (Beatriz)] You need five hype points to attempt a pin. Build it up.

0:08:25.000,0:08:28.000
[Thao (Devika)] The crowd's getting louder. They love a comeback story.

0:08:28.000,0:08:30.000
[Dungeon Master (DM)] The Underminer hits the ropes for momentum.

0:08:30.000,0:08:33.000
[Lucia (Tanvi)] I'll counter with a shoulder tackle. Roll the d20.

0:08:33.000,0:08:35.000
[Dungeon Master (DM)] Eighteen. You knock him down. Two hype points.

0:08:35.000,0:08:38.000
[Thao (Devika)] The arena's getting electric. Star Spangled signs everywhere.

0:08:38.000,0:08:41.000
[Lucia (Tanvi)] I want to climb the turnbuckle for an elbow drop.

0:08:41.000,0:08:43.000
[Dungeon Master (DM)] You climb, but he rolls away. Roll for landing.

0:08:43.000,0:08:46.000
[Lucia (Tanvi)] Six. Ouch. I crash into the mat.

0:08:46.000,0:08:48.000
[Eero (Beatriz)] Big mistake. The Underminer's back on his feet.

0:08:48.000,0:08:51.000
[Dungeon Master (DM)] He launches into a clothesline. Roll to defend.

0:08:51.000,0:08:53.000
[Lucia (Tanvi)] Nineteen. I duck under it.

0:08:53.000,0:08:56.000
[Thao (Devika)] The crowd's chanting Stardust's name now. The mood has shifted.

0:08:56.000,0:08:58.000
[Dungeon Master (DM)] Good. The Underminer is winded from missing.

0:08:58.000,0:09:01.000
[Lucia (Tanvi)] I want to seize the moment. Going for a body slam.

0:09:01.000,0:09:04.000
[Dungeon Master (DM)] Roll. The crowd is on its feet.

0:09:04.000,0:09:06.000
[Lucia (Tanvi)] Sixteen plus three. Nineteen.

0:09:06.000,0:09:09.000
[Dungeon Master (DM)] You lift him over your head. The audience gasps.`

const NEUTRAL_AFTER = `0:11:50.700,0:11:53.000
[Dungeon Master (DM)] The crowd is roaring. The Underminer staggers up.

0:11:53.000,0:11:55.000
[Lucia (Tanvi)] I want to follow up with another suplex while he's dazed.

0:11:55.000,0:11:57.000
[Dungeon Master (DM)] Roll for the second attempt.

0:11:57.000,0:11:59.000
[Lucia (Tanvi)] Eight. That's not great.

0:11:59.000,0:12:01.000
[Dungeon Master (DM)] He reverses. You're on your back now.

0:12:01.000,0:12:03.000
[Eero (Beatriz)] He's playing to the audience. Soaking in the boos.

0:12:03.000,0:12:06.000
[Thao (Devika)] The crowd's split. Half cheering Stardust, half jeering.

0:12:06.000,0:12:08.000
[Lucia (Tanvi)] I'll kip up to my feet and dust myself off.

0:12:08.000,0:12:10.000
[Dungeon Master (DM)] Smooth move. The judges note your style.

0:12:10.000,0:12:13.000
[Thao (Devika)] This is the biggest match Pentagon has seen this season.

0:12:13.000,0:12:15.000
[Eero (Beatriz)] You've still got three hype points. Build it up to five.

0:12:15.000,0:12:18.000
[Dungeon Master (DM)] The Underminer paces the ring, taunting the crowd.

0:12:18.000,0:12:20.000
[Lucia (Tanvi)] I'll go for a running clothesline.

0:12:20.000,0:12:22.000
[Dungeon Master (DM)] Roll. The crowd is chanting.

0:12:22.000,0:12:24.000
[Lucia (Tanvi)] Seventeen. I connect.

0:12:24.000,0:12:26.000
[Dungeon Master (DM)] He's down. Four hype points now.`

const DILUTED = `${NEUTRAL_BEFORE}\n\n${FULL}\n\n${NEUTRAL_AFTER}`

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

function classifyOutcome(json) {
  const pfReason = json?.promptFeedback?.blockReason
  if (typeof pfReason === 'string') return { outcome: 'blocked_prompt', reason: pfReason }
  const cand = json?.candidates?.[0]
  const fr = cand?.finishReason
  if (typeof fr === 'string' && fr !== 'STOP' && fr !== 'MAX_TOKENS') {
    return { outcome: 'blocked_candidate', reason: fr }
  }
  const text = cand?.content?.parts?.[0]?.text
  if (typeof text === 'string' && text.length > 0) return { outcome: 'pass' }
  return { outcome: 'empty' }
}

async function probe(apiKey, modelId, chunk, index = 0, total = 1) {
  const userPrompt = phase2Audit({ rawChunk: chunk, groundedChunk: chunk, index, total })
  const body = {
    contents: [{ parts: [{ text: userPrompt }] }],
    safetySettings: SAFETY_SETTINGS,
    generationConfig: { maxOutputTokens: 1024, temperature: 0 },
  }
  const t0 = Date.now()
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
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

async function main() {
  const live = await loadLiveKeys()
  if (!live?.paid) {
    console.error('No paid key from live server. Aborting.')
    process.exit(1)
  }

  // Sleep helper for free-tier RPM pacing.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  const trials = [
    { label: 'Full chunk (original)',           chunk: FULL,                tier: 'paidFlash' },
    { label: 'Full minus "gay way" line',       chunk: FULL_MINUS_SUSPECT,  tier: 'paidFlash' },
    { label: 'Diluted (~5KB neutral context)',  chunk: DILUTED,             tier: 'paidFlash' },
    { label: 'Diluted on Paid Pro',             chunk: DILUTED,             tier: 'paidPro' },
    { label: 'Full chunk on Paid Pro',          chunk: FULL,                tier: 'paidPro' },
    { label: 'Full minus "gay way" on Paid Pro', chunk: FULL_MINUS_SUSPECT, tier: 'paidPro' },
  ]

  console.log('=== Bisect / dilution probe ===\n')
  const results = []
  for (const t of trials) {
    const modelId = t.tier === 'paidPro' ? 'gemini-2.5-pro' : 'gemini-2.5-flash'
    const r = await probe(live.paid, modelId, t.chunk)
    results.push({ ...t, ...r })
    const reason = r.reason ? ` (${r.reason})` : ''
    console.log(`${t.label.padEnd(38)} → ${r.outcome}${reason}  [${r.promptChars ?? '?'} prompt chars, ${r.latency}ms]`)
    await sleep(800) // gentle pacing
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const out = path.join(repoRoot, '.diagnose', `brody-bisect-${stamp}.json`)
  await fs.mkdir(path.dirname(out), { recursive: true })
  await fs.writeFile(out, JSON.stringify({ timestamp: new Date().toISOString(), trials: results }, null, 2), 'utf8')
  console.log(`\nReport: ${path.relative(repoRoot, out)}`)

  // Verdict
  const fullOnPro = results.find((r) => r.label === 'Full chunk on Paid Pro')
  const dilutedOnPro = results.find((r) => r.label === 'Diluted on Paid Pro')
  const minusOnPro = results.find((r) => r.label === 'Full minus "gay way" on Paid Pro')
  console.log('\n=== Verdict ===')
  if (fullOnPro?.outcome === 'pass') {
    console.log('✓ Full chunk passes on Paid Pro. Asymmetry IS by model size, not just endpoint.')
  }
  if (dilutedOnPro?.outcome === 'pass' && fullOnPro?.outcome !== 'pass') {
    console.log('✓ Dilution recovers the chunk on Paid Pro. Larger chunks → meta-filter ignores trigger.')
  }
  if (minusOnPro?.outcome === 'pass') {
    console.log('✓ Removing the suspect line unblocks the chunk. Trigger isolated.')
  }
  if (fullOnPro?.outcome !== 'pass' && dilutedOnPro?.outcome !== 'pass' && minusOnPro?.outcome !== 'pass') {
    console.log('✗ Even Paid Pro + dilution + line-removal can\'t clear it. Whole chunk is filter-tripping.')
  }
}

main().catch((err) => {
  console.error('Bisect probe failed:', err)
  process.exit(1)
})
