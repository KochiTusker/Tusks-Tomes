// Tiny end-to-end smoke test. Verifies:
//   1. Cloud providers with configured keys respond to a 1-token call.
//   2. Whisper sidecar is importable (faster-whisper).
//   3. Local LLM detection works (best-effort — fine if nothing's running).
//
// Reads keys from process.env (legacy mode) or hits /api/provider-keys if a
// dev server is running on localhost:5173.

import { performance } from 'node:perf_hooks'

const BASE = process.env.SMOKE_BASE_URL ?? 'http://localhost:5173'

async function fetchJson(url, init = {}) {
  const res = await fetch(url, init)
  const text = await res.text()
  try {
    return { ok: res.ok, status: res.status, body: text ? JSON.parse(text) : null }
  } catch {
    return { ok: res.ok, status: res.status, body: text }
  }
}

async function probeBoot() {
  try {
    const res = await fetchJson(`${BASE}/api/health`)
    return res.ok
  } catch {
    return false
  }
}

async function getKeys() {
  if (!(await probeBoot())) {
    console.log('[smoke] server not reachable, using process.env for keys')
    return {
      gemini: process.env.PAID_GEMINI_API_KEY ?? process.env.VITE_GEMINI_API_KEY,
      claude: process.env.ANTHROPIC_API_KEY,
      openai: process.env.OPENAI_API_KEY,
    }
  }
  const res = await fetchJson(`${BASE}/api/provider-keys`)
  if (!res.ok) {
    console.log('[smoke] /api/provider-keys returned HTTP', res.status)
    return {}
  }
  return res.body
}

async function pingGemini(key) {
  if (!key) return 'skipped (no key)'
  const t = performance.now()
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(
    key
  )}&pageSize=1`
  const res = await fetch(url)
  if (!res.ok) return `failed (HTTP ${res.status})`
  return `ok in ${Math.round(performance.now() - t)}ms`
}

async function pingClaude(key) {
  if (!key) return 'skipped (no key)'
  const t = performance.now()
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8,
      messages: [{ role: 'user', content: 'ping' }],
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    return `failed (HTTP ${res.status}: ${body.slice(0, 120)})`
  }
  return `ok in ${Math.round(performance.now() - t)}ms`
}

async function pingOpenAI(key) {
  if (!key) return 'skipped (no key)'
  const t = performance.now()
  const res = await fetch('https://api.openai.com/v1/models', {
    headers: { authorization: `Bearer ${key}` },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    return `failed (HTTP ${res.status}: ${body.slice(0, 120)})`
  }
  return `ok in ${Math.round(performance.now() - t)}ms`
}

async function pingWhisper() {
  if (!(await probeBoot())) return 'skipped (server offline)'
  // Audio is an opt-in add-on. /api/whisper/status only exists when the
  // add-on's routes are mounted, so we check /api/addons first.
  const list = await fetchJson(`${BASE}/api/addons`)
  if (!list.ok) return `failed (HTTP ${list.status} from /api/addons)`
  const audio = (list.body?.addons ?? []).find((a) => a.name === 'audio-addon')
  if (!audio || !audio.enabled) return 'not installed'
  if (!audio.loaded) return 'installed, restart required'
  const res = await fetchJson(`${BASE}/api/whisper/status`)
  if (res.ok && res.body?.ready) return 'ready'
  return `not ready (${res.body?.error ?? 'unknown'})`
}

async function pingLocalLLM() {
  if (!(await probeBoot())) return 'skipped (server offline)'
  const res = await fetchJson(`${BASE}/api/local-llm/detect`)
  if (!res.ok) return `failed (HTTP ${res.status})`
  const reachable = (res.body?.backends ?? []).filter((b) => b.reachable)
  if (reachable.length === 0) return 'no local backends running'
  return `${reachable.length} reachable: ${reachable.map((b) => b.name).join(', ')}`
}

/** Free→Paid failover readiness check. Prints which preconditions are in
 *  place (or missing) for the auto-tier swap path. The audit identified
 *  this as the single most important thing to verify before relying on
 *  the failover — a missing precondition silently breaks the swap and the
 *  user only finds out mid-run.
 *
 *  ARMED = both keys configured, fingerprints differ, both probes succeed,
 *  Paid has at least one paid-only model (proves it's actually billing).
 */
async function failoverReadiness(keys) {
  const lines = []
  const paidKey = keys?.gemini
  const freeKey = keys?.geminiFallback
  const haveBoth = !!(paidKey && freeKey)
  if (!haveBoth) {
    lines.push(
      `Failover readiness: NOT ARMED — missing ${!paidKey ? 'Paid' : ''}${!paidKey && !freeKey ? ' + ' : ''}${!freeKey ? 'Free' : ''} key.`,
    )
    return lines.join('\n')
  }
  // Fingerprint distinctness — using the same hash strategy as
  // server/api/modelProbe.ts (SHA-256, 6-char prefix).
  const { createHash } = await import('node:crypto')
  const paidFp = createHash('sha256').update(paidKey).digest('hex').slice(0, 6)
  const freeFp = createHash('sha256').update(freeKey).digest('hex').slice(0, 6)
  if (paidFp === freeFp) {
    lines.push(
      `Failover readiness: NOT ARMED — Paid and Free slots hold the SAME key (fingerprint ${paidFp}).`,
    )
    return lines.join('\n')
  }
  // Probe both keys via models.list (cheap; proves the key is valid).
  async function probe(key) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`
    try {
      const res = await fetch(url)
      if (!res.ok) return { ok: false, status: res.status }
      const body = await res.json()
      return { ok: true, models: (body.models ?? []).map((m) => m.name?.replace(/^models\//, '')) }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  }
  const [paidProbe, freeProbe] = await Promise.all([probe(paidKey), probe(freeKey)])
  if (!paidProbe.ok || !freeProbe.ok) {
    lines.push(
      `Failover readiness: NOT ARMED — Paid probe ${paidProbe.ok ? 'OK' : `failed (HTTP ${paidProbe.status})`}, ` +
        `Free probe ${freeProbe.ok ? 'OK' : `failed (HTTP ${freeProbe.status})`}.`,
    )
    return lines.join('\n')
  }
  // Sanity-check: Paid should be able to reach a Pro model that Free can't.
  // We don't actually generateContent here (that costs $) — checking the
  // advertised list is enough.
  const proModel = (paidProbe.models ?? []).find((m) => /gemini-2\.5-pro/i.test(m))
  const paidHasPro = !!proModel
  if (!paidHasPro) {
    lines.push(
      `Failover readiness: ARMED with caveat — Paid key (fingerprint ${paidFp}) does NOT advertise gemini-2.5-pro. ` +
        `Verify billing is enabled on the Paid project at https://aistudio.google.com/apikey.`,
    )
  } else {
    lines.push(
      `Failover readiness: ARMED — Paid (fingerprint ${paidFp}) has Pro access; Free (fingerprint ${freeFp}) for fallback. ` +
        `Auto-tier swap path is fully wired.`,
    )
  }
  return lines.join('\n')
}

const keys = await getKeys()
const results = {
  Gemini: await pingGemini(keys?.gemini),
  Claude: await pingClaude(keys?.claude),
  OpenAI: await pingOpenAI(keys?.openai),
  Whisper: await pingWhisper(),
  'Local LLMs': await pingLocalLLM(),
}

console.log('\n=== Smoke test results ===')
for (const [name, status] of Object.entries(results)) {
  console.log(`${name.padEnd(12)} : ${status}`)
}

console.log('\n=== Free → Paid failover ===')
console.log(await failoverReadiness(keys))

// Final summary block — separates "what's configured + working" from
// "what failed or isn't set up" so a user running smoke-test on a fresh
// install instantly sees which providers they still need to address.
// Without this, "Whisper: not installed" and "Claude: failed: 401" look
// the same severity but mean very different things.
console.log('\n=== Summary ===')
const summaryOk = []
const summaryFailed = []
const summaryNotConfigured = []
for (const [name, status] of Object.entries(results)) {
  const s = String(status)
  // Order matters: "failed" matches need to win against any later more-
  // generic matchers. "ready" / "skipped" / "no local backends running" /
  // "installed, restart required" are healthy states — treat them as
  // "Not configured" so they don't trip the exit-1 hard-failure gate.
  // Preship-2026-05-28: the old code bucketed "ready" into Failed, which
  // produced a scary "Failed: Whisper (ready)" line plus exit code 1 on
  // a perfectly healthy install.
  if (s.startsWith('failed')) summaryFailed.push(`${name} (${s.slice(0, 80)})`)
  else if (s.startsWith('ok')) summaryOk.push(name)
  else if (s.startsWith('ready')) summaryOk.push(name)
  else if (
    s.startsWith('not configured') ||
    s.startsWith('not installed') ||
    s.startsWith('skipped') ||
    s.startsWith('no local backends running') ||
    s.startsWith('installed, restart required')
  )
    summaryNotConfigured.push(name)
  else summaryFailed.push(`${name} (${s.slice(0, 80)})`)
}
console.log(`OK            : ${summaryOk.length ? summaryOk.join(', ') : '(none)'}`)
console.log(`Failed        : ${summaryFailed.length ? summaryFailed.join(', ') : '(none)'}`)
console.log(`Not configured: ${summaryNotConfigured.length ? summaryNotConfigured.join(', ') : '(none)'}`)
if (summaryFailed.length) {
  console.log(
    '\nNext step: re-check the failed providers in Settings → API Keys (open http://127.0.0.1:5173/).',
  )
  console.log(
    'If a key looks correct but the test still fails, copy the failure message and search the README troubleshooting section.',
  )
}
if (!summaryOk.length && !summaryFailed.length) {
  console.log(
    '\nNo providers configured yet. Open http://127.0.0.1:5173/ → Settings → API Keys and paste at least one key.',
  )
}

const hardFailure = summaryFailed.length > 0
process.exit(hardFailure ? 1 : 0)
