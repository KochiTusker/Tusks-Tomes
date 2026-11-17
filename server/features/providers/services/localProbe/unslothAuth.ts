// Unsloth Studio authentication, invoked directly from server-side detection
// and probe code paths so it doesn't go through the proxy hop. The token
// fetch and cache are shared with the local-LLM proxy (platform/oauth2Token).

import { loadKeys } from '../crypto/keyStore.js'
import { createOAuth2TokenSource } from '../../../../platform/oauth2Token.js'

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

// Cap auth at 5 s: a stuck Unsloth shouldn't be able to wedge the probe
// runner. The probe surface has a longer per-call timeout for inference itself.
const oauthTokens = createOAuth2TokenSource({ timeoutMs: 5000 })

export async function authHeaders(config: UnslothConfig): Promise<Record<string, string>> {
  if (config.bearerToken && config.bearerToken.trim()) {
    return { Authorization: `Bearer ${config.bearerToken.trim()}` }
  }
  if (config.username && config.password) {
    const jwt = await oauthTokens.get(config.baseUrl, config.username, config.password)
    if (jwt) return { Authorization: `Bearer ${jwt}` }
    const basic = Buffer.from(`${config.username}:${config.password}`).toString('base64')
    return { Authorization: `Basic ${basic}` }
  }
  return {}
}

export function invalidateTokenCache(): void {
  oauthTokens.clear()
}
