// CRUD endpoints for the encrypted provider keystore + a per-provider test
// endpoint that runs a trivial generation through the SDK to validate the
// key. Never returns the raw key in any response.

import express, { type Router } from 'express'
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import {
  clearKey,
  loadKeys,
  setKey,
  summarize,
  type ProviderKey,
} from '../crypto/keyStore.js'
import {
  invalidateSlot,
  probeGeminiKey,
  readAvailabilityCache,
  updateSlotAvailability,
} from './modelProbe.js'
import { isAddonLoaded } from '../addons/loader.js'
import { claudeCodeStatus } from './claudeCode.js'
import { codexStatus } from './codex.js'

// Each user-facing "provider" slot maps to one encrypted keystore slot.
// `geminiFree` is the user-visible label for what the keystore (and the
// legacy "auto" fallback path) calls `geminiFallback`; we keep the keystore
// name stable so existing encrypted bundles continue to decrypt cleanly.
type ProviderName = 'gemini' | 'geminiFree' | 'openrouter'

const PROVIDER_TO_KEY: Record<ProviderName, ProviderKey> = {
  gemini: 'gemini',
  geminiFree: 'geminiFallback',
  openrouter: 'openrouter',
}

function isProviderName(value: unknown): value is ProviderName {
  return (
    value === 'gemini' ||
    value === 'geminiFree' ||
    value === 'claude' ||
    value === 'openai' ||
    value === 'openrouter'
  )
}

/** Per-provider key-test timeout. The Test buttons in Settings used to hang
 *  indefinitely on slow networks because the SDK calls had no timeout —
 *  users saw a frozen UI with no feedback. 10s covers normal network
 *  variance and is short enough that "did I lose connectivity?" becomes
 *  the obvious diagnosis instead of "is the app broken?". */
const KEY_TEST_TIMEOUT_MS = 10_000

/** Wrap an SDK call with an AbortController so a network hang surfaces as
 *  an actionable "API test timed out" error instead of a frozen UI. The
 *  SDKs (anthropic + openai) accept the signal directly; native fetch
 *  (Gemini) does too. */
async function withTimeout<T>(
  ms: number,
  label: string,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    return await fn(ctrl.signal)
  } catch (err) {
    if (ctrl.signal.aborted) {
      throw new Error(
        `${label} timed out after ${ms / 1000}s. Check your internet connection or whether the API endpoint is reachable from this network. Original: ${(err as Error).message}`,
      )
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

async function testGemini(apiKey: string): Promise<void> {
  return withTimeout(KEY_TEST_TIMEOUT_MS, 'Gemini key test', async (signal) => {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(
        apiKey
      )}&pageSize=1`,
      { signal },
    )
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Gemini key invalid (HTTP ${res.status}). ${body.slice(0, 300)}`)
    }
  })
}

async function testClaude(apiKey: string): Promise<void> {
  return withTimeout(KEY_TEST_TIMEOUT_MS, 'Claude key test', async (signal) => {
    const client = new Anthropic({ apiKey })
    await client.messages.create(
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 8,
        messages: [{ role: 'user', content: 'ping' }],
      },
      { signal },
    )
  })
}

async function testOpenAI(apiKey: string): Promise<void> {
  return withTimeout(KEY_TEST_TIMEOUT_MS, 'OpenAI key test', async (signal) => {
    const client = new OpenAI({ apiKey })
    await client.models.list({ signal })
  })
}

/**
 * Validate an OpenRouter key against /api/v1/key.
 *
 * That endpoint is cheaper than listing models and returns the two facts we
 * actually need: whether the key works, and `is_free_tier` — which decides
 * whether free-variant models are capped at 50 or 1000 requests per day. The
 * `rate_limit` object in the same payload is deprecated upstream; ignore it.
 */
export async function testOpenRouter(apiKey: string): Promise<OpenRouterKeyStatus> {
  return withTimeout(KEY_TEST_TIMEOUT_MS, 'OpenRouter key test', async (signal) => {
    const res = await fetch('https://openrouter.ai/api/v1/key', {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal,
    })
    if (!res.ok) {
      throw new Error(
        res.status === 401
          ? 'OpenRouter rejected the key (401). Check it was copied whole, including the sk-or- prefix.'
          : `OpenRouter key check failed: HTTP ${res.status}`,
      )
    }
    const body = (await res.json()) as { data?: Record<string, unknown> }
    const d = body?.data ?? {}
    return {
      isFreeTier: d.is_free_tier === true,
      limitRemaining: typeof d.limit_remaining === 'number' ? d.limit_remaining : null,
      usage: typeof d.usage === 'number' ? d.usage : null,
    }
  })
}

/** What /api/v1/key tells us about a key, beyond "it works". */
export type OpenRouterKeyStatus = {
  /** True when the account has never purchased credits. Free-variant models
   *  are then capped at 50 requests/day rather than 1000. */
  isFreeTier: boolean
  /** Credits left on the key, or null when the key has no cap. */
  limitRemaining: number | null
  usage: number | null
}

export function providersRouter(): Router {
  const router = express.Router()

  router.get('/', async (_req, res) => {
    try {
      const summary = await summarize()
      // Claude Code has no encrypted key slot — auth is the user's own
      // CLI. Surface it as "configured" through the SAME summary the
      // selection UI gates on, so it appears in the provider picker with
      // zero changes to ActiveProviderCard / HybridRoutingEditor. Gate on
      // the add-on being loaded AND the CLI being present; a logged-out CLI
      // still surfaces (the run-time error then guides `claude login`).
      const configured: string[] = [...summary.configured]
      if (isAddonLoaded('claude-code-addon')) {
        try {
          const status = await claudeCodeStatus()
          if (status.installed) configured.push('claudeCode')
        } catch (err) {
          console.warn('[api/providers GET] claude-code status check failed:', err)
        }
      }
      // Codex mirrors the Claude Code virtual slot: same gating shape,
      // separate add-on, separate CLI. Independent try/catch so one CLI
      // probe failing can't hide the other provider.
      if (isAddonLoaded('codex-addon')) {
        try {
          const status = await codexStatus()
          if (status.installed) configured.push('codex')
        } catch (err) {
          console.warn('[api/providers GET] codex status check failed:', err)
        }
      }
      res.json({ ...summary, configured })
    } catch (err) {
      console.error('[api/providers GET] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  router.put('/:name', async (req, res) => {
    const name = req.params.name
    if (!isProviderName(name)) {
      return res.status(400).json({ error: `Unknown provider: ${name}` })
    }
    const body = req.body as { key?: unknown }
    if (typeof body.key !== 'string' || !body.key.trim()) {
      return res.status(400).json({ error: 'Missing key in request body.' })
    }
    try {
      const slot = PROVIDER_TO_KEY[name]
      await setKey(slot, body.key.trim())
      // The cached availability data was probed against the old key;
      // it does not describe the new key. Drop it so the next read
      // forces a re-probe.
      await invalidateSlot(slot)
      res.json(await summarize())
    } catch (err) {
      console.error('[api/providers PUT] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  router.delete('/:name', async (req, res) => {
    const name = req.params.name
    if (!isProviderName(name)) {
      return res.status(400).json({ error: `Unknown provider: ${name}` })
    }
    try {
      const slot = PROVIDER_TO_KEY[name]
      await clearKey(slot)
      await invalidateSlot(slot)
      res.json(await summarize())
    } catch (err) {
      console.error('[api/providers DELETE] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  router.post('/:name/test', async (req, res) => {
    const name = req.params.name
    if (!isProviderName(name)) {
      return res.status(400).json({ error: `Unknown provider: ${name}` })
    }
    try {
      const bundle = await loadKeys()
      const apiKey = bundle[PROVIDER_TO_KEY[name]]
      if (!apiKey) {
        return res.status(400).json({ ok: false, error: `${name} not configured` })
      }
      // Dispatch explicitly. This used to end in a bare `else` that sent
      // anything unrecognised to OpenAI, which would have quietly validated an
      // OpenRouter key against the wrong vendor and reported a confusing 401.
      if (name === 'gemini' || name === 'geminiFree') {
        await testGemini(apiKey)
      } else if (name === 'openrouter') {
        const status = await testOpenRouter(apiKey)
        return res.json({ ok: true, openrouter: status })
      } else {
        return res.status(400).json({ ok: false, error: `Unknown provider: ${String(name)}` })
      }
      res.json({ ok: true })
    } catch (err) {
      const message = (err as Error).message || String(err)
      res.status(200).json({ ok: false, error: message })
    }
  })

  // Deep probe — fetches the key's advertised model list AND actively calls
  // each curated candidate model with a 1-token request to confirm
  // accessibility. Result persists to model-availability.json keyed by
  // slot; the picker UI reads it via GET /availability. All four slots
  // are supported (Gemini Paid, Gemini Free, Claude, OpenAI) — the
  // dropdown wiring (HybridRoutingEditor / ModelProfileEditor) consumes
  // the same SlotAvailability shape uniformly.
  router.post('/:name/probe', async (req, res) => {
    const name = req.params.name
    if (!isProviderName(name)) {
      return res.status(400).json({ error: `Unknown provider: ${name}` })
    }
    try {
      const bundle = await loadKeys()
      const slot = PROVIDER_TO_KEY[name]
      const apiKey = bundle[slot]
      if (!apiKey) {
        return res.status(400).json({ ok: false, error: `${name} not configured` })
      }
      if (name !== 'gemini' && name !== 'geminiFree') {
        // Probing exists to find out which models a key can actually reach.
        // OpenRouter publishes that catalogue openly and key-lessly, so the
        // picker reads it directly and there is nothing here to probe.
        return res.status(400).json({
          error: 'Model probing applies to Gemini only. OpenRouter publishes its catalogue openly, so the model picker reads it directly.',
        })
      }
      const result = await probeGeminiKey(apiKey)
      await updateSlotAvailability(slot, result)
      res.json({ ok: true, availability: result })
    } catch (err) {
      const message = (err as Error).message || String(err)
      console.error('[api/providers POST /:name/probe] failed:', err)
      res.status(200).json({ ok: false, error: message })
    }
  })

  // Read the cached availability for every probed slot. Returns an object
  // keyed by ProviderKey ('gemini' / 'geminiFallback' / ...) with each
  // entry being the SlotAvailability shape. Slots that have never been
  // probed are absent.
  router.get('/availability', async (_req, res) => {
    try {
      const cache = await readAvailabilityCache()
      res.json(cache)
    } catch (err) {
      console.error('[api/providers GET /availability] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  return router
}
