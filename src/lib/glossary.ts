// React-side client for /api/glossary. Caches the document in memory so
// pipeline runs and the editor don't both hit the server, and notifies
// subscribers when the cache changes (after a save or external refresh).

import type { ContextualHint, SafeReplacement } from '@/data/corrections'

export type GlossaryDocument = {
  version: 1
  safeReplacements: SafeReplacement[]
  contextualHints: ContextualHint[]
}

const EMPTY: GlossaryDocument = {
  version: 1,
  safeReplacements: [],
  contextualHints: [],
}

let cache: GlossaryDocument | null = null
let inflight: Promise<GlossaryDocument> | null = null
const listeners = new Set<(doc: GlossaryDocument) => void>()

function emit(doc: GlossaryDocument): void {
  cache = doc
  for (const l of listeners) l(doc)
}

export async function getGlossary(): Promise<GlossaryDocument> {
  if (cache) return cache
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const res = await fetch('/api/glossary')
      if (!res.ok) throw new Error(`GET /api/glossary failed: HTTP ${res.status}`)
      const doc = (await res.json()) as GlossaryDocument
      const normalized: GlossaryDocument = {
        version: 1,
        safeReplacements: doc.safeReplacements ?? [],
        contextualHints: doc.contextualHints ?? [],
      }
      emit(normalized)
      return normalized
    } finally {
      inflight = null
    }
  })()
  return inflight
}

export async function putGlossary(doc: GlossaryDocument): Promise<GlossaryDocument> {
  const res = await fetch('/api/glossary', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(doc),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`PUT /api/glossary failed: HTTP ${res.status}. ${body.slice(0, 400)}`)
  }
  const saved = (await res.json()) as GlossaryDocument
  emit(saved)
  return saved
}

/** Synchronously read the currently cached glossary. Returns empty until {@link getGlossary} resolves. */
export function peekGlossary(): GlossaryDocument {
  return cache ?? EMPTY
}

export function subscribeGlossary(fn: (doc: GlossaryDocument) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
