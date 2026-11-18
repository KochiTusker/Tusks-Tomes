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
import {
  CATALOGUE_TTL_MS,
  RefreshBackoff,
  catalogueStatus,
  getCatalogue,
  readCachedCatalogue,
} from '../services/openrouterCatalogue.js'
import { readAutoUpdateModelList } from '../../../platform/modelListSetting.js'
import { openrouterPoliciesFile, readJson, writeJson } from '../../../platform/appData.js'
import { slog } from '../../../platform/slog.js'
import type { ProviderPolicy } from '../../../../shared/contracts/openrouterModels.js'

const PROVIDERS_URL = 'https://openrouter.ai/api/frontend/v1/all-providers'
const PROVIDER_TTL_MS = CATALOGUE_TTL_MS

export type { ProviderPolicy }

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

/** Re-check a saved row field by field: the file sits in a user-writable
 *  folder, and a malformed row must drop out rather than read as a clean
 *  policy. */
function savedPolicy(row: unknown): ProviderPolicy | null {
  const r = row as Record<string, unknown> | null
  if (typeof r?.name !== 'string' || typeof r.trains !== 'boolean' || typeof r.retains !== 'boolean') return null
  const days = r.retentionDays
  if (days !== null && typeof days !== 'number') return null
  return { name: r.name, trains: r.trains, retains: r.retains, retentionDays: days }
}

/** The policies saved by the last successful fetch, read once per process so
 *  a restart with automatic updates off (or offline) still has them. Every
 *  caller awaits the same read: the app and the model-list strip both ask at
 *  startup, and the second must not see an empty cache mid-read. */
let savedLoad: Promise<void> | null = null
function loadSavedPolicies(): Promise<void> {
  savedLoad ??= (async () => {
    // A missing or unreadable file means no saved copy, never a failed request.
    const saved = await readJson<{ fetchedAt?: unknown; policies?: unknown } | null>(
      openrouterPoliciesFile(),
      null,
    ).catch(() => null)
    const at = saved?.fetchedAt
    // A date in the future (a clock change or a hand edit) would otherwise
    // count as fresh until the clock caught up, so it is treated as no copy.
    if (typeof at !== 'number' || at > Date.now() || !Array.isArray(saved?.policies)) return
    const policies = saved.policies.map(savedPolicy).filter((p): p is ProviderPolicy => p !== null)
    // A refresh that finished during the read is newer, so it wins.
    if (policies.length > 0 && !policyCache) policyCache = { fetchedAt: at, policies }
  })()
  return savedLoad
}

const policyBackoff = new RefreshBackoff()
let policyInFlight: Promise<ProviderPolicy[]> | null = null

/** Resolves once a policy refresh already under way has settled. Tests only. */
export async function settlePolicyRefresh(): Promise<void> {
  await policyInFlight?.catch(() => undefined)
}

function refreshPolicies(): Promise<ProviderPolicy[]> {
  if (policyInFlight) return policyInFlight
  const run = (async () => {
    try {
      const res = await fetch(PROVIDERS_URL, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const policies = normalisePolicies(await res.json())
      if (policies.length === 0) throw new Error('provider directory parsed to zero rows')
      policyCache = { fetchedAt: Date.now(), policies }
      policyBackoff.succeeded()
      // A failed save costs only the copy for the next restart, so it is logged
      // rather than failing a fetch that worked.
      await writeJson(openrouterPoliciesFile(), policyCache).catch((err) =>
        slog('openrouter.policies.save_failed', { error: (err as Error)?.message ?? String(err) }),
      )
      return policies
    } catch (err) {
      policyBackoff.failed((err as Error)?.message ?? String(err))
      throw err
    }
  })()
  policyInFlight = run
  const clear = () => {
    if (policyInFlight === run) policyInFlight = null
  }
  run.then(clear, clear)
  return run
}

/**
 * Provider data policies, saved beside the model list. Same rules as the
 * catalogue: an explicit refresh always asks; with automatic updates off
 * nothing is requested and the saved copy is used; a stale copy is served
 * while it refreshes in the background; and a failure keeps the last copy and
 * backs off. An empty result means the UI shows "policy unknown" rather than
 * claiming a provider is safe — degrading to silence is correct here.
 */
async function getPolicies(opts: { force: boolean; autoUpdate: boolean }): Promise<ProviderPolicy[]> {
  await loadSavedPolicies()
  const fresh = policyCache && Date.now() - policyCache.fetchedAt < PROVIDER_TTL_MS
  if (!opts.force) {
    if (fresh) return policyCache!.policies
    if (!opts.autoUpdate || !policyBackoff.allows()) return policyCache?.policies ?? []
    if (policyCache) {
      refreshPolicies().catch((err) =>
        slog('openrouter.policies.failed', { error: (err as Error)?.message ?? String(err) }),
      )
      return policyCache.policies
    }
  }
  try {
    return await refreshPolicies()
  } catch (err) {
    if (policyCache) return policyCache.policies
    slog('openrouter.policies.failed', { error: (err as Error)?.message ?? String(err) })
    return []
  }
}

export function openrouterModelsRouter(): Router {
  const router = express.Router()

  router.get('/models', async (req, res) => {
    try {
      const force = req.query.refresh === '1'
      const autoUpdate = await readAutoUpdateModelList()
      const [catalogue, policies] = await Promise.all([
        getCatalogue({ force, autoUpdate }),
        getPolicies({ force, autoUpdate }),
      ])
      res.json({
        fetchedAt: catalogue.fetchedAt,
        models: catalogue.models,
        providerPolicies: policies,
        status: catalogueStatus(await readCachedCatalogue().catch(() => null), autoUpdate),
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
