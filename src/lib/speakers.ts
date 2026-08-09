// React-side client for /api/speakers. Mirrors `src/lib/glossary.ts` —
// an in-memory cache with subscribe(), so the editor and the upload
// pipeline stay in sync without bouncing through localStorage.

export type Speaker = {
  discordUserId: string
  discordDisplayName?: string
  playerName: string
  characterName: string
}

export type SpeakersDocument = {
  version: 1
  speakers: Speaker[]
}

const EMPTY: SpeakersDocument = {
  version: 1,
  speakers: [],
}

let cache: SpeakersDocument | null = null
let inflight: Promise<SpeakersDocument> | null = null
const listeners = new Set<(doc: SpeakersDocument) => void>()

function emit(doc: SpeakersDocument): void {
  cache = doc
  for (const l of listeners) l(doc)
}

export async function getSpeakers(): Promise<SpeakersDocument> {
  if (cache) return cache
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const res = await fetch('/api/speakers')
      if (!res.ok) throw new Error(`GET /api/speakers failed: HTTP ${res.status}`)
      const doc = (await res.json()) as SpeakersDocument
      const normalized: SpeakersDocument = {
        version: 1,
        speakers: doc.speakers ?? [],
      }
      emit(normalized)
      return normalized
    } finally {
      inflight = null
    }
  })()
  return inflight
}

export async function putSpeakers(doc: SpeakersDocument): Promise<SpeakersDocument> {
  const res = await fetch('/api/speakers', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(doc),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`PUT /api/speakers failed: HTTP ${res.status}. ${body.slice(0, 400)}`)
  }
  const saved = (await res.json()) as SpeakersDocument
  emit(saved)
  return saved
}

export function peekSpeakers(): SpeakersDocument {
  return cache ?? EMPTY
}

export function subscribeSpeakers(fn: (doc: SpeakersDocument) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
