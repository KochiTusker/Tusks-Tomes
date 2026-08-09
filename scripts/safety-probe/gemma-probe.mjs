#!/usr/bin/env node
// Probe whether Gemma 4 models work via the Gemini API on both Free + Paid
// keys, what they cost (response header inspection), and how their
// extraction quality compares with gemini-2.5-flash on a realistic
// Phase 4 (jests/gore/quotes) prompt.
//
// Findings inform the pricing table + routing options.

const FIXTURE = `[Ursula (Perpetua)] Right, I'm going to charge the ogre. I roll a... twelve.
[DM (DM)] You leap forward and your hammer connects with a sickening crunch — the ogre's jaw shatters in a spray of yellow teeth.
[Zainab (Adaeze)] My god. Ursula, that was beautiful.
[Ursula (Perpetua)] That's for stealing my sandwich.
[Hiroko (Xiomara)] I cast firebolt on the second ogre. Natural twenty!
[DM (DM)] The firebolt explodes against the ogre's chest and you watch as it staggers backwards, its leather armour catching fire.
[Bhavna (Priya)] Wait, can the leather armour give the ogre disadvantage?
[Ursula (Perpetua)] He's literally on fire, Bhavna. He's having a worse day than getting disadvantage.
[DM (DM)] The ogre's screams echo through the cavern as it falls to its knees.
[Zainab (Adaeze)] I want to loot the body.
[Hiroko (Xiomara)] It's still on fire.
[Zainab (Adaeze)] I have gloves.`

const EXTRAS_PROMPT = `Extract three lists from the following D&D transcript chunk. Output ONLY valid JSON in this exact shape:
{
  "quotes": [{"speaker": "...", "line": "...", "kind": "funny|stupid|dark"}],
  "jests": [{"description": "what made it funny"}],
  "gore": [{"description": "what was violent or graphic"}]
}

Rules:
- Only include items that stand on their own (the punchline lands without setup)
- Max 3 of each kind
- Preserve original wording in quotes exactly

Transcript:
${FIXTURE}`

async function probe({ apiKey, modelId, label }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(apiKey)}`
  const body = {
    contents: [{ parts: [{ text: EXTRAS_PROMPT }] }],
    generationConfig: { maxOutputTokens: 2048, temperature: 0 },
  }
  const t0 = Date.now()
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const lat = Date.now() - t0
    const headers = {}
    for (const [k, v] of res.headers.entries()) {
      if (/quota|ratelimit|billing|usage/i.test(k)) headers[k] = v
    }
    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      return { label, modelId, status: res.status, latencyMs: lat, error: errBody.slice(0, 400), headers }
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
      totalTokens: usage.totalTokenCount,
      outputChars: text.length,
      outputPreview: text.slice(0, 600),
      headers,
    }
  } catch (e) {
    return { label, modelId, error: String(e), latencyMs: Date.now() - t0 }
  }
}

async function loadKeys() {
  const res = await fetch('http://127.0.0.1:5173/api/provider-keys')
  if (!res.ok) throw new Error('Could not fetch keys (is dev server running?)')
  const json = await res.json()
  return { paid: json.gemini, free: json.geminiFallback }
}

async function main() {
  const keys = await loadKeys()
  const trials = [
    { apiKey: keys.free, modelId: 'gemma-4-26b-a4b-it', label: 'Free · Gemma 4 26B-MoE' },
    { apiKey: keys.free, modelId: 'gemma-4-31b-it', label: 'Free · Gemma 4 31B-dense' },
    { apiKey: keys.paid, modelId: 'gemma-4-26b-a4b-it', label: 'Paid · Gemma 4 26B-MoE' },
    { apiKey: keys.paid, modelId: 'gemma-4-31b-it', label: 'Paid · Gemma 4 31B-dense' },
    { apiKey: keys.free, modelId: 'gemini-2.5-flash', label: 'Free · Gemini 2.5 Flash (baseline)' },
    { apiKey: keys.paid, modelId: 'gemini-2.5-flash', label: 'Paid · Gemini 2.5 Flash (baseline)' },
  ]

  const results = []
  for (const t of trials) {
    if (!t.apiKey) {
      console.log(`SKIP ${t.label} — no key configured`)
      continue
    }
    console.log(`\n--- ${t.label} (${t.modelId})`)
    const r = await probe(t)
    results.push(r)
    if (r.error) {
      console.log(`  ✗ ERROR: ${r.error.slice(0, 200)}`)
    } else if (r.blockReason) {
      console.log(`  ✗ BLOCKED: ${r.blockReason}`)
    } else {
      console.log(`  ✓ ${r.status} · ${r.latencyMs}ms · ${r.inputTokens}in/${r.outputTokens}out · finish=${r.finishReason}`)
      console.log(`  Output (${r.outputChars} chars):`)
      console.log(`  ${r.outputPreview.split('\n').map(l => '    ' + l).join('\n')}`)
    }
    await new Promise((r) => setTimeout(r, 500))
  }

  // Save to disk
  const fs = await import('node:fs/promises')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const out = `.diagnose/gemma-probe-${stamp}.json`
  await fs.mkdir('.diagnose', { recursive: true })
  await fs.writeFile(out, JSON.stringify({ timestamp: new Date().toISOString(), results }, null, 2))
  console.log(`\n--- Saved: ${out}`)

  // Print a summary table
  console.log('\n=== SUMMARY ===')
  for (const r of results) {
    const ok = r.status === 200 && !r.blockReason && !r.error
    const flag = ok ? '✓' : '✗'
    console.log(`${flag} ${r.label}`)
    console.log(`    in=${r.inputTokens ?? '?'} out=${r.outputTokens ?? '?'} ms=${r.latencyMs}`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
