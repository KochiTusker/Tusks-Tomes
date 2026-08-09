// Unsloth Studio authentication. Mirrors the legacy in-browser flow that
// lives in server/index.ts's local-LLM proxy (`fetchOAuth2Token` +
// `buildAuthHeaders`) but is invoked directly from server-side detection +
// probe code paths, so it doesn't go through the proxy hop.

import { loadKeys } from '../crypto/keyStore.js'

export type UnslothConfig = {
  baseUrl: string
  username?: string
  password?: string
  bearerToken?: string
}

export async function readUnslothConfig(): Promise<UnslothConfig | null> {
  const bundle = await loadKeys()
  const raw = bundle.unsloth
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<UnslothConfig>
    if (typeof parsed.baseUrl !== 'string' || !parsed.baseUrl) return null
    return {
      baseUrl: parsed.baseUrl,
      username: parsed.username,
      password: parsed.password,
      bearerToken: parsed.bearerToken,
    }
  } catch {
    return null
  }
}

const tokenCache = new Map<string, { token: string; fetchedAt: number }>()
const TOKEN_TTL_MS = 30 * 60 * 1000

async function fetchOAuth2Token(
  baseUrl: string,
  username: string,
  password: string
): Promise<string | null> {
  const key = `${baseUrl}::${username}`
  const cached = tokenCache.get(key)
  if (cached && Date.now() - cached.fetchedAt < TOKEN_TTL_MS) return cached.token
  try {
    const params = new URLSearchParams({ username, password })
    // Cap auth at 5 s — a stuck Unsloth shouldn't be able to wedge the
    // probe runner. The probe surface above already has a longer per-call
    // timeout for inference itself.
    const res = await fetch(`${baseUrl}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { access_token?: string }
    if (!data.access_token) return null
    tokenCache.set(key, { token: data.access_token, fetchedAt: Date.now() })
    return data.access_token
  } catch {
    return null
  }
}

export async function authHeaders(config: UnslothConfig): Promise<Record<string, string>> {
  if (config.bearerToken && config.bearerToken.trim()) {
    return { Authorization: `Bearer ${config.bearerToken.trim()}` }
  }
  if (config.username && config.password) {
    const jwt = await fetchOAuth2Token(config.baseUrl, config.username, config.password)
    if (jwt) return { Authorization: `Bearer ${jwt}` }
    const basic = Buffer.from(`${config.username}:${config.password}`).toString('base64')
    return { Authorization: `Basic ${basic}` }
  }
  return {}
}

export function invalidateTokenCache(): void {
  tokenCache.clear()
}
