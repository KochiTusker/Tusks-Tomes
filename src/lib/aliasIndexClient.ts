// Browser-side fetcher for the lore alias index. Caches per-run so
// runPhase1 doesn't re-fetch on every chunk. Returns null on any error
// (no lore configured, server down, parse error) — the pipeline falls
// back to its existing behaviour without the index.

import type { AliasIndex, EntityRecord } from '../../server/lore/aliasIndex'

let cached: { at: number; index: AliasIndex | null } | null = null
const CACHE_TTL_MS = 5 * 60_000 // 5 min — index rebuilds on lore changes via debounced fs watcher

export async function getAliasIndex(opts?: { force?: boolean }): Promise<AliasIndex | null> {
  if (!opts?.force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.index
  }
  try {
    const res = await fetch('/api/lore/index')
    if (!res.ok) {
      cached = { at: Date.now(), index: null }
      return null
    }
    const json = await res.json()
    const index: AliasIndex | null = json?.status === 'ok' ? json.index : null
    cached = { at: Date.now(), index }
    return index
  } catch {
    cached = { at: Date.now(), index: null }
    return null
  }
}

/** Convenience — pull the EntityRecord list flat for downstream iteration. */
export function entitiesFromIndex(index: AliasIndex | null): EntityRecord[] {
  if (!index) return []
  return Object.values(index.byEntity)
}

export type { AliasIndex, EntityRecord }
