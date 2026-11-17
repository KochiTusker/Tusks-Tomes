// A client for one server-held JSON document: fetched once, cached in memory,
// shared by every consumer, and announced to subscribers whenever it changes.
//
// The Chronicle tab, the Settings cards and the pipeline all read the same
// document, so they share one fetch and hear about each other's saves instead
// of bouncing through localStorage.

export interface DocClientOptions<T> {
  /** The document's route, for example `/api/glossary`. */
  path: string
  /** Shape whatever the server sent into the document the app works with. */
  normalise?: (raw: T) => T
}

export interface DocClient<T> {
  /** The cached document, fetching it on first use. Concurrent first calls share one request. */
  get(): Promise<T>
  /** The cached document, or null before the first fetch finishes. */
  peek(): T | null
  /** Replace the cache and notify subscribers, for a write made elsewhere. */
  emit(doc: T): void
  /** Save the whole document with PUT to `path`; the server's answer becomes the cache. */
  put(doc: T): Promise<T>
  subscribe(fn: (doc: T) => void): () => void
}

/** The failure text of a write: method, path, status, then the first 400 characters of the body. */
export async function writeFailure(method: string, path: string, res: Response): Promise<Error> {
  const body = await res.text().catch(() => '')
  return new Error(`${method} ${path} failed: HTTP ${res.status}. ${body.slice(0, 400)}`)
}

export function createDocClient<T>({ path, normalise }: DocClientOptions<T>): DocClient<T> {
  let cache: T | null = null
  let inflight: Promise<T> | null = null
  const listeners = new Set<(doc: T) => void>()

  function emit(doc: T): void {
    cache = doc
    for (const l of listeners) l(doc)
  }

  return {
    async get() {
      if (cache) return cache
      if (inflight) return inflight
      inflight = (async () => {
        try {
          const res = await fetch(path)
          if (!res.ok) throw new Error(`GET ${path} failed: HTTP ${res.status}`)
          const raw = (await res.json()) as T
          const doc = normalise ? normalise(raw) : raw
          emit(doc)
          return doc
        } finally {
          inflight = null
        }
      })()
      return inflight
    },
    peek: () => cache,
    emit,
    async put(doc) {
      const res = await fetch(path, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(doc),
      })
      if (!res.ok) throw await writeFailure('PUT', path, res)
      const saved = (await res.json()) as T
      emit(saved)
      return saved
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}
