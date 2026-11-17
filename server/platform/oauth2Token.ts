/**
 * A cache of OAuth2 password-flow bearer tokens for a local runner's `/token`
 * endpoint. Each source owns its own cache, so the proxy and the probe runner
 * invalidate independently; the one thing that differs between them, whether
 * the token request is time-limited, is an option.
 */

const TOKEN_TTL_MS = 30 * 60 * 1000

export interface OAuth2TokenSource {
  /** The cached or freshly fetched token, or null when the endpoint refuses or is unreachable. */
  get(baseUrl: string, username: string, password: string): Promise<string | null>
  /** Drop one user's token, e.g. after a 401 proves it stale. */
  forget(baseUrl: string, username: string): void
  clear(): void
}

export function createOAuth2TokenSource(opts: { timeoutMs?: number } = {}): OAuth2TokenSource {
  const cache = new Map<string, { token: string; fetchedAt: number }>()
  const keyOf = (baseUrl: string, username: string) => `${baseUrl}::${username}`

  return {
    async get(baseUrl, username, password) {
      const key = keyOf(baseUrl, username)
      const cached = cache.get(key)
      if (cached && Date.now() - cached.fetchedAt < TOKEN_TTL_MS) return cached.token
      try {
        const params = new URLSearchParams({ username, password })
        const res = await fetch(`${baseUrl}/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: params.toString(),
          ...(opts.timeoutMs !== undefined ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
        })
        if (!res.ok) return null
        const data = (await res.json()) as { access_token?: string }
        if (!data.access_token) return null
        cache.set(key, { token: data.access_token, fetchedAt: Date.now() })
        return data.access_token
      } catch {
        return null
      }
    },
    forget(baseUrl, username) {
      cache.delete(keyOf(baseUrl, username))
    },
    clear() {
      cache.clear()
    },
  }
}
