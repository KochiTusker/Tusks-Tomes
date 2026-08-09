// Singleton wrapper around aliasIndex.ts that:
//   - Loads the persisted index at boot (or rebuilds if missing).
//   - Subscribes to invalidateDocCache so a single doc write triggers a
//     debounced rebuild (~500ms) — bursts of edits collapse into one build.
//   - Exposes a cached in-memory snapshot for /api/lore/index to read.
//
// Decoupled from the HTTP router via the onDocCacheInvalidated hook in
// documents.ts, so adding new lore mutation paths doesn't require touching
// this file.

import path from 'node:path'
import {
  type AliasIndex,
  readAliasIndex,
  rebuildAliasIndex,
} from './aliasIndex.js'
import { onDocCacheInvalidated } from './documents.js'

const REBUILD_DEBOUNCE_MS = 500

let cachedIndex: AliasIndex | null = null
let loreRoot: string | null = null
let rebuildTimer: NodeJS.Timeout | null = null
let pendingRebuild: Promise<AliasIndex> | null = null
let unsubscribe: (() => void) | null = null

/** Initialize the alias-index manager. Idempotent — safe to call multiple
 *  times (e.g. when the lore root changes via re-detection). */
export async function initAliasIndexManager(currentLoreRoot: string | null): Promise<void> {
  if (unsubscribe) {
    unsubscribe()
    unsubscribe = null
  }
  loreRoot = currentLoreRoot
  cachedIndex = null
  if (!loreRoot) return
  try {
    // Try the persisted file first — boot path stays cheap when nothing
    // changed since the last shutdown.
    cachedIndex = await readAliasIndex(loreRoot)
    if (!cachedIndex) {
      cachedIndex = await rebuildAliasIndex(loreRoot)
    }
  } catch (err) {
    console.warn('[aliasIndexManager] initial load failed:', err)
    cachedIndex = null
  }
  unsubscribe = onDocCacheInvalidated((absPath) => {
    // Only rebuild when the invalidation falls inside the lore root —
    // we don't want unrelated cache mutations to trigger a full rescan.
    if (loreRoot && absPath.startsWith(loreRoot)) {
      scheduleRebuild()
    }
  })
}

function scheduleRebuild(): void {
  if (!loreRoot) return
  if (rebuildTimer) clearTimeout(rebuildTimer)
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null
    if (!loreRoot) return
    if (pendingRebuild) return
    pendingRebuild = rebuildAliasIndex(loreRoot)
      .then((next) => {
        cachedIndex = next
        return next
      })
      .catch((err) => {
        console.warn('[aliasIndexManager] rebuild failed:', err)
        return cachedIndex ?? buildEmptyIndex()
      })
      .finally(() => {
        pendingRebuild = null
      })
  }, REBUILD_DEBOUNCE_MS)
}

/** Force an immediate rebuild and update the cached snapshot. Used by the
 *  POST /api/lore/index/rebuild endpoint and by tests. */
export async function forceRebuild(): Promise<AliasIndex> {
  if (!loreRoot) return buildEmptyIndex()
  if (rebuildTimer) {
    clearTimeout(rebuildTimer)
    rebuildTimer = null
  }
  if (pendingRebuild) return pendingRebuild
  pendingRebuild = rebuildAliasIndex(loreRoot)
    .then((next) => {
      cachedIndex = next
      return next
    })
    .finally(() => {
      pendingRebuild = null
    })
  return pendingRebuild
}

export function getCachedAliasIndex(): AliasIndex | null {
  return cachedIndex
}

export function getCurrentLoreRoot(): string | null {
  return loreRoot
}

function buildEmptyIndex(): AliasIndex {
  return {
    schema: 1,
    builtAt: new Date().toISOString(),
    byEntity: {},
    aliases: {},
    byType: {
      character: [],
      country: [],
      deity: [],
      faction: [],
      patron: [],
      location: [],
      other: [],
    },
    filesWithFrontmatter: [],
    filesWithoutFrontmatter: [],
  }
}

/** Helper for tests / scripts that want the lore-root-relative path to the
 *  cached index file. */
export function aliasIndexFilePath(root: string): string {
  return path.join(root, '.tusks-lore.index.json')
}
