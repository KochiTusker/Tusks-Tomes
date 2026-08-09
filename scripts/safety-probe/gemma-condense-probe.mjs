#!/usr/bin/env node
// Round 2: test Gemma 4 on a free-form prose task (Phase 6 condense)
// where it doesn't need to follow structured-output rules. Compare with
// Gemini 2.5 Flash + Gemini 3.x preview models we're not using yet.

const CHRONICLE = `The pre-game chatter was a familiar cacophony. Solveig steered the table back to order while Gustav made his political opinions known. The Dungeon Master's voice boomed across the arena: "Welcome to the main event! Tonight, we are throwing out the rule books. We are setting the tree on fire! Prepare yourselves for a colossal, textbook-shattering tag team collision!"

The Underminer and Rock Blesnar emerged first, representing the CCW machine. Six hundred pounds of pure unmitigated hostility. The crowd booed as the champions climbed into the ring.

Then Stardust and Pentagon emerged from pyrotechnics. Solveig, as Stardust, played to the kids in the front row. Giulia, as Pentagon, launched himself into a backflip, sparks flying around him on cue.

The match began with Solveig attempting a low-risk jab on the Underminer. He rolled poorly. The Underminer blocked and immediately launched into a suplex — but rolled a one. Solveig reversed, hoisting the Underminer up and slamming him down onto the mat. He performed a mocking gesture, sticking his tongue out at the crowd in the most provocative way possible. The crowd roared. Two hype points. He needed five to attempt a pin.

Feeling the momentum, Stardust went for another suplex. He rolled a two. The Underminer reversed and sent him tumbling. The Underminer turned his back on the downed Stardust, playing to the booing crowd, cupping a hand to his ear to drink in their hatred. Pentagon, watching from the corner, asked the DM if he could tag in.`

const CONDENSE_PROMPT = `You are condensing a D&D session chronicle into tighter prose. Target ~25% of the original word count.

Rules:
- Third-person past tense, fantasy-novel voice
- Keep story events, NPC interactions, party decisions, dramatic moments
- Cut filler, table chatter, dice mechanics, rules questions
- No headings, no bullet lists
- Preserve any profanity verbatim — do not censor or soften

Chronicle to condense:

${CHRONICLE}`

async function probe({ apiKey, modelId, label }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(apiKey)}`
  const body = {
    contents: [{ parts: [{ text: CONDENSE_PROMPT }] }],
    generationConfig: { maxOutputTokens: 2048, temperature: 0.3 },
  }
  const t0 = Date.now()
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const lat = Date.now() - t0
    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      return { label, modelId, status: res.status, latencyMs: lat, error: errBody.slice(0, 400) }
    }
    const json = await res.json()
    const cand = json?.candidates?.[0]
    const text = cand?.content?.parts?.[0]?.text ?? ''
    const usage = json?.usageMetadata ?? {}
    return {
      label,
      modelId,
      status: res.status,
      latencyMs: lat,
      finishReason: cand?.finishReason,
      blockReason: json?.promptFeedback?.blockReason,
      inputTokens: usage.promptTokenCount,
      outputTokens: usage.candidatesTokenCount,
      outputChars: text.length,
      outputPreview: text,
    }
  } catch (e) {
    return { label, modelId, error: String(e), latencyMs: Date.now() - t0 }
  }
}

async function loadKeys() {
  const res = await fetch('http://127.0.0.1:5173/api/provider-keys')
  if (!res.ok) throw new Error('Could not fetch keys')
  const json = await res.json()
  return { paid: json.gemini, free: json.geminiFallback }
}

async function main() {
  const keys = await loadKeys()
  const trials = [
    { apiKey: keys.paid, modelId: 'gemma-4-26b-a4b-it',          label: 'Gemma 4 26B-MoE' },
    { apiKey: keys.paid, modelId: 'gemma-4-31b-it',              label: 'Gemma 4 31B-dense' },
    { apiKey: keys.paid, modelId: 'gemini-2.5-flash',            label: 'Gemini 2.5 Flash (baseline)' },
    { apiKey: keys.paid, modelId: 'gemini-2.5-flash-lite',       label: 'Gemini 2.5 Flash-Lite (current Phase 6)' },
    { apiKey: keys.paid, modelId: 'gemini-3.5-flash',            label: 'Gemini 3.5 Flash (NEW)' },
    { apiKey: keys.paid, modelId: 'gemini-3.1-flash-lite',       label: 'Gemini 3.1 Flash-Lite (NEW)' },
    { apiKey: keys.paid, modelId: 'gemini-3-pro-preview',        label: 'Gemini 3 Pro Preview (NEW)' },
    { apiKey: keys.paid, modelId: 'gemini-2.5-pro',              label: 'Gemini 2.5 Pro (baseline)' },
  ]

  const results = []
  for (const t of trials) {
    if (!t.apiKey) continue
    console.log(`\n--- ${t.label} (${t.modelId})`)
    const r = await probe(t)
    results.push(r)
    if (r.error) console.log(`  ✗ ERROR: ${r.error.slice(0, 200)}`)
    else if (r.blockReason) console.log(`  ✗ BLOCKED: ${r.blockReason}`)
    else {
      console.log(`  ✓ ${r.status} · ${r.latencyMs}ms · ${r.inputTokens}in/${r.outputTokens}out · finish=${r.finishReason}`)
      console.log(`  Output (${r.outputChars} chars):`)
      console.log(`  ${r.outputPreview.split('\n').slice(0, 10).map(l => '    ' + l.slice(0, 150)).join('\n')}`)
      if (r.outputPreview.split('\n').length > 10) console.log(`    [... ${r.outputPreview.split('\n').length - 10} more lines]`)
    }
    await new Promise((r) => setTimeout(r, 500))
  }

  const fs = await import('node:fs/promises')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const out = `.diagnose/gemma-condense-probe-${stamp}.json`
  await fs.writeFile(out, JSON.stringify({ timestamp: new Date().toISOString(), results }, null, 2))
  console.log(`\n--- Saved: ${out}`)

  console.log('\n=== SUMMARY (condense quality vs cost) ===')
  for (const r of results) {
    const ok = r.status === 200 && !r.blockReason && !r.error
    if (!ok) { console.log(`✗ ${r.label}`); continue }
    const outputWords = (r.outputPreview ?? '').split(/\s+/).filter(Boolean).length
    const echoedRules = /Rules:|Target ~25%|condensing.*chronicle/i.test(r.outputPreview ?? '')
    console.log(`${echoedRules ? '⚠ ' : '✓ '} ${r.label.padEnd(45)} ${String(r.outputTokens).padStart(4)}out · ${String(r.latencyMs).padStart(5)}ms · ${String(outputWords).padStart(4)} words · ${echoedRules ? 'ECHOED PROMPT' : 'prose'}`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
