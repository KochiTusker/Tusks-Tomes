// GET /api/openrouter/models — the model catalogue the picker renders from.
//
// Kept server-side rather than fetched from the browser for three reasons:
// the on-disk cache lives in the config dir; the ~400-row payload is worth
// trimming before it crosses to the client; and the data-policy lookup needs
// a second upstream call that would otherwise double the browser's work.
//
// No key is required — OpenRouter serves both of these endpoints anonymously.
// That is unusual and useful: the picker can show real prices and capability
// flags before the user has pasted anything.

import express, { type Router } from 'express'
import { getCatalogue } from '../lib/openrouterCatalogue.js'
import { slog } from '../lib/slog.js'

const PROVIDERS_URL = 'https://openrouter.ai/api/frontend/v1/all-providers'
const PROVIDER_TTL_MS = 24 * 60 * 60 * 1000

/** What an upstream does with a prompt once it has it. */
export interface ProviderPolicy {
  name: string
  /** May train on prompts. */
  trains: boolean
  /** Stores prompts beyond the request. */
  retains: boolean
  /** Days retained, when the provider states a figure. */
  retentionDays: number | null
}

let policyCache: { fetchedAt: number; policies: ProviderPolicy[] } | null = null

/** Parse the provider directory. Exported for tests — this is third-party
 *  shape we do not control, and a silent parse failure here would present
 *  every provider as privacy-clean, which is the worst possible default. */
export function normalisePolicies(raw: unknown): ProviderPolicy[] {
  const rows = (raw as { data?: unknown })?.data
  if (!Array.isArray(rows)) return []
  const out: ProviderPolicy[] = []
  for (const row of rows as Array<Record<string, unknown>>) {
    const name = typeof row?.displayName === 'string' ? row.displayName : null
    if (!name) continue
    const dp = (row.dataPolicy ?? {}) as Record<string, unknown>
    out.push({
      name,
      // Absent means unknown, and unknown must not read as safe.
      trains: dp.training === true,
      retains: dp.retainsPrompts === true,
      retentionDays: typeof dp.retentionDays === 'number' ? dp.retentionDays : null,
    })
  }
  return out
}

async function getPolicies(): Promise<ProviderPolicy[]> {
  if (policyCache && Date.now() - policyCache.fetchedAt < PROVIDER_TTL_MS) {
    return policyCache.policies
  }
  try {
    const res = await fetch(PROVIDERS_URL, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const policies = normalisePolicies(await res.json())
    if (policies.length > 0) {
      policyCache = { fetchedAt: Date.now(), policies }
      return policies
    }
    throw new Error('provider directory parsed to zero rows')
  } catch (err) {
    if (policyCache) return policyCache.policies
    // An empty list means the UI shows "policy unknown" rather than claiming
    // a provider is safe. Degrading to silence is correct here.
    slog('openrouter.policies.failed', { error: (err as Error)?.message ?? String(err) })
    return []
  }
}

export function openrouterModelsRouter(): Router {
  const router = express.Router()

  router.get('/models', async (req, res) => {
    try {
      const force = req.query.refresh === '1'
      const [catalogue, policies] = await Promise.all([getCatalogue({ force }), getPolicies()])
      res.json({
        fetchedAt: catalogue.fetchedAt,
        models: catalogue.models,
        providerPolicies: policies,
      })
    } catch (err) {
      const message = (err as Error)?.message ?? String(err)
      slog('openrouter.catalogue.failed', { error: message })
      // 200-with-error mirrors how routing.ts and profiles.ts report soft
      // failures, so the picker can show a message instead of blanking out.
      res.status(200).json({ ok: false, error: message, models: [], providerPolicies: [] })
    }
  })

  return router
}
