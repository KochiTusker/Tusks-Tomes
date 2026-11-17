// One way to call a JSON endpoint on the app's own server.
//
// What differs between callers is how a failure reads, so that is the option:
// each mode below reproduces one existing message format exactly, and a caller
// picks the one whose wording its users already see.
//
//   status     "GET /api/x failed: HTTP 500"
//   text       "GET /api/x failed: HTTP 500. <first bodySlice chars of the body>"
//   json       the server's own `{ "error": "..." }`, else "HTTP 500"
//   http       "HTTP 500"
//   http-text  "HTTP 500: <first bodySlice chars of the body>"
//
// `status` and `text` start with `<method> <path>` unless `errorPrefix` names
// something else (for example "detect" or "unsloth-config save").

export type ApiErrorMode = 'status' | 'text' | 'json' | 'http' | 'http-text'

export interface ApiJsonOptions {
  /** Defaults to GET. */
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  /** Sent as JSON. Leave out for a request with no body. */
  body?: unknown
  errorMode: ApiErrorMode
  /** How much of the response body an error message keeps (`text`, `http-text`). */
  bodySlice?: number
  /** Replaces `<method> <path>` at the start of a `status` / `text` message. */
  errorPrefix?: string
  /** `none` for an endpoint whose answer is not read. Default `json`. */
  parse?: 'json' | 'none'
}

async function failure(res: Response, method: string, path: string, o: ApiJsonOptions): Promise<Error> {
  const label = o.errorPrefix ?? `${method} ${path}`
  switch (o.errorMode) {
    case 'status':
      return new Error(`${label} failed: HTTP ${res.status}`)
    case 'text': {
      const body = await res.text().catch(() => '')
      return new Error(`${label} failed: HTTP ${res.status}. ${body.slice(0, o.bodySlice ?? 400)}`)
    }
    case 'json': {
      let message = `HTTP ${res.status}`
      try {
        const body = (await res.json()) as { error?: string }
        if (body.error) message = body.error
      } catch {
        /* the body was not JSON; keep the status */
      }
      return new Error(message)
    }
    case 'http':
      return new Error(`HTTP ${res.status}`)
    case 'http-text': {
      const body = await res.text().catch(() => '')
      return new Error(`HTTP ${res.status}: ${body.slice(0, o.bodySlice ?? 400)}`)
    }
  }
}

export async function apiJson<T>(path: string, options: ApiJsonOptions): Promise<T> {
  const method = options.method ?? 'GET'
  const res =
    method === 'GET' && options.body === undefined
      ? await fetch(path)
      : await fetch(
          path,
          options.body === undefined
            ? { method }
            : {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(options.body),
              },
        )
  if (!res.ok) throw await failure(res, method, path, options)
  if (options.parse === 'none') return undefined as T
  return (await res.json()) as T
}
