import { useCallback, useEffect, useState } from 'react'
import type { KBDocument } from '@/types'

// Single in-memory cache shared across all consumers of useLoreDocuments.
// The KB tab, the Chronicle tab, and the Caption Repair tab all read from
// the same Tusks-Lore folder, so a single fetch on app boot is enough —
// per-tab refetches would just hammer the disk-walk + .docx parser.

/** Which lore source produced the current documents. `obsidian-vault` means
 *  the read-only Obsidian Vault add-on is the active source and the Tusks-Lore
 *  folder is on standby — the UI uses this to swap to a read-only vault view
 *  and surface the active source clearly. */
export type LoreSource = 'tusks-lore' | 'obsidian-vault'

export type LoreDocumentsState = {
  status: 'idle' | 'loading' | 'ready' | 'missing' | 'error'
  documents: KBDocument[]
  loreRoot: string | null
  /** Active lore source for the current documents. Defaults to 'tusks-lore'
   *  (the Obsidian add-on tags its responses with 'obsidian-vault'). */
  source: LoreSource
  /** Diagnostics surfaced by /api/lore/status when the folder isn't found. */
  notes: string[]
  error: string | null
}

const LORE_REFRESH_EVENT = 'sbts:lore-documents-updated'

let cache: LoreDocumentsState = {
  status: 'idle',
  documents: [],
  loreRoot: null,
  source: 'tusks-lore',
  notes: [],
  error: null,
}
let inflight: Promise<void> | null = null
let bootstrapped = false

type ServerResponse = {
  found?: boolean
  loreRoot?: string
  source?: LoreSource
  notes?: string[]
  documents?: Array<{
    id: string
    name: string
    relPath: string
    type: KBDocument['type']
    text: string
    sizeBytes: number
    modifiedAt: string
  }>
  error?: string
}

function emitUpdate(next: LoreDocumentsState) {
  cache = next
  window.dispatchEvent(
    new CustomEvent<LoreDocumentsState>(LORE_REFRESH_EVENT, { detail: next }),
  )
}

export async function refreshLoreDocuments(): Promise<LoreDocumentsState> {
  if (inflight) {
    await inflight
    return cache
  }
  inflight = (async () => {
    emitUpdate({ ...cache, status: 'loading', error: null })
    try {
      const res = await fetch('/api/lore/documents')
      const body = (await res.json()) as ServerResponse
      if (!res.ok) {
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      if (!body.found) {
        emitUpdate({
          status: 'missing',
          documents: [],
          loreRoot: null,
          source: body.source ?? 'tusks-lore',
          notes: body.notes ?? [],
          error: null,
        })
        return
      }
      const documents: KBDocument[] = (body.documents ?? []).map((d) => ({
        id: d.id,
        name: d.name,
        type: d.type,
        text: d.text,
        sizeBytes: d.sizeBytes,
        addedAt: d.modifiedAt,
        relPath: d.relPath,
      }))
      emitUpdate({
        status: 'ready',
        documents,
        loreRoot: body.loreRoot ?? null,
        source: body.source ?? 'tusks-lore',
        notes: [],
        error: null,
      })
    } catch (err) {
      emitUpdate({
        ...cache,
        status: 'error',
        error: (err as Error).message,
      })
    }
  })()
  try {
    await inflight
  } finally {
    inflight = null
  }
  return cache
}

/** Read-only view of the lore documents cache. Auto-fetches on first mount
 *  in the application; subsequent components share the cache. */
export function useLoreDocuments(): LoreDocumentsState & {
  refresh: () => Promise<void>
} {
  const [state, setState] = useState<LoreDocumentsState>(cache)

  useEffect(() => {
    const handler = (e: Event) => {
      setState((e as CustomEvent<LoreDocumentsState>).detail)
    }
    window.addEventListener(LORE_REFRESH_EVENT, handler)

    if (!bootstrapped) {
      bootstrapped = true
      void refreshLoreDocuments()
    } else {
      // Late mounter — sync with whatever's in the cache right now.
      setState(cache)
    }

    return () => window.removeEventListener(LORE_REFRESH_EVENT, handler)
  }, [])

  const refresh = useCallback(async () => {
    await refreshLoreDocuments()
  }, [])

  return { ...state, refresh }
}
