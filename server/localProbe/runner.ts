// Probe runner. Sends the two fixture batteries to the chosen local model
// and computes a ProbeResult. Lives on the server so we don't need browser
// CORS workarounds; the model endpoints are localhost from the server's POV
// just as from the browser's.

import { performance } from 'node:perf_hooks'
import {
  GROUNDING_FIXTURE,
  JSON_FIXTURES,
  type GroundingFixture,
  type JsonFixture,
} from './fixtures.js'
import {
  backendForBaseUrl,
  type Backend,
  type ProbeResult,
} from '../api/localLLM.js'
import { authHeaders as unslothAuthHeaders, readUnslothConfig } from './unslothAuth.js'
import { validateLocalBaseUrl } from '../lib/validators.js'

/** True iff the request's URL.host exactly matches the stored Unsloth
 *  baseUrl.host. Used to gate attachment of the user's stored Unsloth
 *  credentials — a port-only heuristic (8888) is not sufficient because
 *  a hostile baseUrl on the same port would harvest the bearer. */
function isStoredUnslothHost(requestBaseUrl: string, storedBaseUrl: string): boolean {
  try {
    const a = new URL(requestBaseUrl).host.toLowerCase()
    const b = new URL(storedBaseUrl).host.toLowerCase()
    return a === b
  } catch {
    return false
  }
}

const STRUCTURED_PASS = 0.8
const GROUNDING_PHASE1_PASS = 0.7

// Per-call timeout. Probe prompts are short — a model that can't respond
// within 60 s is too slow for the pipeline anyway. Prevents a stuck
// Unsloth / Ollama server from wedging the probe runner.
const CALL_TIMEOUT_MS = 60_000

function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const filtered = signals.filter((s): s is AbortSignal => !!s)
  if (filtered.length === 0) return new AbortController().signal
  if (filtered.length === 1) return filtered[0]
  const controller = new AbortController()
  for (const sig of filtered) {
    if (sig.aborted) {
      controller.abort(sig.reason)
      break
    }
    sig.addEventListener('abort', () => controller.abort(sig.reason), { once: true })
  }
  return controller.signal
}

async function callLocal(args: {
  baseUrl: string
  modelId: string
  prompt: string
  maxOutputTokens: number
  signal?: AbortSignal
}): Promise<{ text: string; elapsedMs: number; outputApproxTokens: number }> {
  const { baseUrl: rawBaseUrl, modelId, prompt, maxOutputTokens, signal } = args
  // Re-validate at the lowest layer too. The route handler should have
  // already done this, but a future internal caller (different route,
  // background job, etc.) might forget — fail closed here so a missed
  // route-level validation can't reach `fetch()` with an arbitrary URL.
  const baseUrl = await validateLocalBaseUrl(rawBaseUrl)
  const backend = backendForBaseUrl(baseUrl)
  let url: string
  let body: unknown
  if (backend === 'ollama') {
    url = `${baseUrl}/api/generate`
    body = {
      model: modelId,
      prompt,
      stream: false,
      options: { num_predict: maxOutputTokens },
    }
  } else {
    url = `${baseUrl}/v1/chat/completions`
    body = {
      model: modelId,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxOutputTokens,
      stream: false,
    }
  }
  const started = performance.now()
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (backend === 'unsloth') {
    // Only attach the stored Unsloth credentials when the request's
    // host exactly matches the user's stored Unsloth baseUrl. The
    // port-8888 heuristic above is a path/body-shape decision; this
    // host-equality check is the security gate that prevents an
    // attacker-supplied baseUrl on :8888 from exfiltrating the bearer.
    const cfg = await readUnslothConfig()
    if (cfg && isStoredUnslothHost(baseUrl, cfg.baseUrl)) {
      Object.assign(headers, await unslothAuthHeaders(cfg))
    }
  }
  const timeoutSignal = AbortSignal.timeout(CALL_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: combineSignals(signal, timeoutSignal),
    })
  } catch (err) {
    // Surface a recognisable message so the runner counts this as a failed
    // fixture instead of bubbling a bare "DOMException: TimeoutError".
    if ((err as Error).name === 'TimeoutError' || (err as Error).name === 'AbortError') {
      throw new Error(`local request timed out after ${CALL_TIMEOUT_MS / 1000}s (${backend} ${modelId})`)
    }
    throw err
  }
  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    throw new Error(`local HTTP ${res.status}: ${errBody.slice(0, 400)}`)
  }
  let text = ''
  if (backend === 'ollama') {
    const json = (await res.json()) as { response?: string; error?: string }
    if (json.error) throw new Error(json.error)
    text = json.response ?? ''
  } else {
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    text = json.choices?.[0]?.message?.content ?? ''
  }
  const elapsedMs = performance.now() - started
  // Rough token estimate: chars/4. Used only for tokensPerSecond display.
  const outputApproxTokens = Math.max(1, Math.round(text.length / 4))
  return { text, elapsedMs, outputApproxTokens }
}

function stripCodeFence(s: string): string {
  return s
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim()
}

function tryParseJson(raw: string): unknown | null {
  const stripped = stripCodeFence(raw)
  try {
    return JSON.parse(stripped)
  } catch {
    // Try extracting the first {…} block.
    const m = stripped.match(/\{[\s\S]*\}/)
    if (!m) return null
    try {
      return JSON.parse(m[0])
    } catch {
      return null
    }
  }
}

function schemaShape(expected: Record<string, string | number>): Record<string, 'string' | 'number'> {
  const out: Record<string, 'string' | 'number'> = {}
  for (const [key, value] of Object.entries(expected)) {
    out[key] = typeof value === 'number' ? 'number' : 'string'
  }
  return out
}

function matchesSchema(parsed: unknown, expected: Record<string, string | number>): boolean {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
  const shape = schemaShape(expected)
  const obj = parsed as Record<string, unknown>
  for (const [key, ty] of Object.entries(shape)) {
    if (!(key in obj)) return false
    const v = obj[key]
    if (ty === 'number' && typeof v !== 'number') return false
    if (ty === 'string' && typeof v !== 'string') return false
  }
  // Reject if there are extraneous prose-like properties beyond the schema.
  // (Model wrapping the result in additional keys still parses, but the
  // schema-only check is the relevant signal — we don't penalise extras.)
  return true
}

type StructuredScore = {
  score: number
  totalTokensOut: number
  totalElapsedMs: number
}

async function runStructuredJsonBattery(args: {
  baseUrl: string
  modelId: string
  signal?: AbortSignal
}): Promise<StructuredScore> {
  let passed = 0
  let totalTokensOut = 0
  let totalElapsedMs = 0
  for (const fixture of JSON_FIXTURES) {
    try {
      const { text, elapsedMs, outputApproxTokens } = await callLocal({
        baseUrl: args.baseUrl,
        modelId: args.modelId,
        prompt: fixture.prompt,
        maxOutputTokens: 256,
        signal: args.signal,
      })
      totalElapsedMs += elapsedMs
      totalTokensOut += outputApproxTokens
      const parsed = tryParseJson(text)
      if (matchesSchema(parsed, fixture.expected)) {
        passed += 1
      }
    } catch (err) {
      // A network / model error is a failed fixture; keep going so partial
      // scoring is still meaningful.
      console.warn(`[probe] structured fixture ${fixture.id} errored: ${(err as Error).message}`)
    }
  }
  return {
    score: passed / JSON_FIXTURES.length,
    totalTokensOut,
    totalElapsedMs,
  }
}

function buildGroundingPrompt(fixture: GroundingFixture): string {
  return [
    'You are correcting a transcript snippet. The glossary below lists the only canonical names that can be substituted into the text.',
    'Apply the substitutions ONLY where surrounding context clearly indicates a person/place/deity. Do not change anything else. Do not invent new names. Preserve all other words exactly.',
    '',
    `# GLOSSARY (canonical names)`,
    fixture.glossary.map((n) => `- ${n}`).join('\n'),
    '',
    '# RAW TRANSCRIPT',
    fixture.raw,
    '',
    '# OUTPUT',
    'Return only the corrected transcript text. No explanation.',
  ].join('\n')
}

type GroundingScore = {
  score: number
  totalTokensOut: number
  totalElapsedMs: number
}

function applicationsInText(needle: string, hay: string): number {
  if (!needle) return 0
  const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
  return (hay.match(re) ?? []).length
}

function inventedCount(corrected: string, fixture: GroundingFixture): number {
  // For every "right" name that wasn't a "wrong" target either, count any
  // occurrences as inventions when the same word doesn't appear in the
  // original raw text.
  let invented = 0
  for (const name of fixture.glossary) {
    const inRaw = applicationsInText(name, fixture.raw)
    const inOut = applicationsInText(name, corrected)
    if (inOut > inRaw) {
      const expectedFromMishearing = fixture.mishearings
        .filter((m) => m.right === name)
        .reduce((acc, m) => acc + applicationsInText(m.wrong, fixture.raw), 0)
      // Anything beyond raw + expected mishearing fixes is invented.
      const allowable = inRaw + expectedFromMishearing
      if (inOut > allowable) invented += inOut - allowable
    }
  }
  return invented
}

function correctedCount(corrected: string, fixture: GroundingFixture): number {
  // Each mishearing's "wrong" form is unique in the raw. If it's gone from
  // the corrected output AND the "right" form appears (at least as many
  // times as the wrong form did in raw), count one corrected entry.
  let count = 0
  for (const { wrong, right } of fixture.mishearings) {
    const stillWrong = applicationsInText(wrong, corrected)
    const wrongInRaw = applicationsInText(wrong, fixture.raw)
    const rightInRaw = applicationsInText(right, fixture.raw)
    const rightInOut = applicationsInText(right, corrected)
    const replaced = wrongInRaw - stillWrong > 0
    const rightAppeared = rightInOut > rightInRaw
    if (replaced && rightAppeared) count += 1
  }
  return count
}

async function runGroundingBattery(args: {
  baseUrl: string
  modelId: string
  signal?: AbortSignal
}): Promise<GroundingScore> {
  try {
    const { text, elapsedMs, outputApproxTokens } = await callLocal({
      baseUrl: args.baseUrl,
      modelId: args.modelId,
      prompt: buildGroundingPrompt(GROUNDING_FIXTURE),
      maxOutputTokens: 1024,
      signal: args.signal,
    })
    const corrected = stripCodeFence(text)
    const corrects = correctedCount(corrected, GROUNDING_FIXTURE)
    const invents = inventedCount(corrected, GROUNDING_FIXTURE)
    const raw = Math.max(0, corrects / GROUNDING_FIXTURE.mishearings.length - 0.2 * invents)
    const score = Math.min(1, raw)
    return {
      score,
      totalTokensOut: outputApproxTokens,
      totalElapsedMs: elapsedMs,
    }
  } catch (err) {
    console.warn(`[probe] grounding fixture errored: ${(err as Error).message}`)
    return { score: 0, totalTokensOut: 0, totalElapsedMs: 0 }
  }
}

export async function runProbe(args: {
  baseUrl: string
  modelId: string
  signal?: AbortSignal
}): Promise<ProbeResult> {
  const structured = await runStructuredJsonBattery(args)
  const grounding = await runGroundingBattery({ ...args })

  const elapsedSec = Math.max(0.001, (structured.totalElapsedMs + grounding.totalElapsedMs) / 1000)
  const tokensPerSecond = (structured.totalTokensOut + grounding.totalTokensOut) / elapsedSec

  const backend: Backend | 'unknown' = backendForBaseUrl(args.baseUrl)
  const result: ProbeResult = {
    modelId: args.modelId,
    baseUrl: args.baseUrl,
    backend,
    runAt: new Date().toISOString(),
    structuredJsonScore: structured.score,
    groundingScore: grounding.score,
    tokensPerSecond,
    eligible: {
      phase1: grounding.score >= GROUNDING_PHASE1_PASS,
      phase2: structured.score >= STRUCTURED_PASS,
      // Phase 3 (narrative chronicle) is held back from local at this tier
      // per the roadmap until a richer probe validates prose quality.
      phase3: false,
      phase4: structured.score >= STRUCTURED_PASS,
    },
  }
  return result
}
