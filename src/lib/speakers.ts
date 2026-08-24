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

/**
 * Resolve a saved speaker row for one session participant.
 *
 * Matches on ID first, then on Discord display name. Craig-derived
 * speaker IDs used to be Craig's per-recording track index, so mappings
 * saved before that changed are keyed by a number that no longer
 * identifies anyone; the display-name fallback keeps them applying.
 *
 * Mirror of `findSpeakerFor` in server/lib/speakerIdentity.ts — the two
 * trees don't import from each other. Keep the two in step; the
 * behaviour is pinned by tests on both sides.
 */
export function findSpeakerFor<T extends { discordUserId: string; discordDisplayName?: string }>(
  speakers: readonly T[],
  userId: string,
  displayName: string | undefined,
): T | undefined {
  const byId = speakers.find((s) => s.discordUserId === userId)
  if (byId) return byId
  const needle = displayName?.trim().toLowerCase()
  if (!needle) return undefined
  return speakers.find((s) => s.discordDisplayName?.trim().toLowerCase() === needle)
}

export function subscribeSpeakers(fn: (doc: SpeakersDocument) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
