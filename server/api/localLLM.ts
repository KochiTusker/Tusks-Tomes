// Local LLM detection (Step 13) + capability probe persistence (Step 14).
//
// Detection probes three default backends (Ollama, LM Studio, llama.cpp /
// Unsloth via OpenAI-compatible) on their default ports. Probe results
// live in {cacheDir}/capability.json and survive restarts.

import express, { type Router } from 'express'
import { capabilityFile, readJson, writeJson } from '../appData.js'
import { clearKey, loadKeys, setKey } from '../crypto/keyStore.js'
import { validateLocalBaseUrl } from '../lib/validators.js'
import { loopbackOnly } from '../lib/loopbackGate.js'
import {
  authHeaders as unslothAuthHeaders,
  invalidateTokenCache as invalidateUnslothToken,
  readUnslothConfig,
  type UnslothConfig,
} from '../localProbe/unslothAuth.js'

export type Backend = 'ollama' | 'lmstudio' | 'llamacpp' | 'unsloth'

type BackendDef = {
  name: Backend
  baseUrl: string
  modelsPath: string
  generatePath: string
  /** Some backends gate model listing behind auth — pull from keystore at probe time. */
  authProvider?: () => Promise<{ baseUrl: string; headers: Record<string, string> } | null>
}

async function unslothAuthProvider(): Promise<
  { baseUrl: string; headers: Record<string, string> } | null
> {
  const cfg = await readUnslothConfig()
  if (!cfg) return null
  // Defence in depth: re-validate the stored baseUrl before attaching
  // any credential header. PUT /unsloth-config also validates on write,
  // but a future internal caller (a migration, a manual edit of the
  // keystore file) could land an unvalidated value here. Refuse to
  // attach bearer / basic auth to a public-IP target — that would be
  // a one-line SSRF + credential-exfil gadget otherwise.
  try {
    const normalised = await validateLocalBaseUrl(cfg.baseUrl)
    const headers = await unslothAuthHeaders(cfg)
    return { baseUrl: normalised, headers }
  } catch (err) {
    console.warn(
      `[unsloth] stored baseUrl failed re-validation (${(err as Error).message}). ` +
        `Refusing to attach credentials. Update the URL in Settings.`,
    )
    return null
  }
}

const BACKENDS: BackendDef[] = [
  {
    name: 'ollama',
    baseUrl: 'http://localhost:11434',
    modelsPath: '/api/tags',
    generatePath: '/api/generate',
  },
  {
    name: 'lmstudio',
    baseUrl: 'http://localhost:1234',
    modelsPath: '/v1/models',
    generatePath: '/v1/chat/completions',
  },
  {
    name: 'llamacpp',
    baseUrl: 'http://localhost:8080',
    modelsPath: '/v1/models',
    generatePath: '/v1/chat/completions',
  },
  {
    // Unsloth Studio defaults to port 8888 and usually requires OAuth2
    // password auth. The baseUrl override comes from the stored config so
    // users can point at a non-default host.
    name: 'unsloth',
    baseUrl: 'http://localhost:8888',
    modelsPath: '/v1/models',
    generatePath: '/v1/chat/completions',
    authProvider: unslothAuthProvider,
  },
]

export type LocalBackendInfo = {
  name: Backend
  baseUrl: string
  reachable: boolean
  models: string[]
  error?: string
}

async function detectBackend(def: BackendDef): Promise<LocalBackendInfo> {
  // Resolve baseUrl + headers via the optional authProvider (Unsloth pulls
  // baseUrl from its stored config so the user can override the default port).
  let baseUrl = def.baseUrl
  let headers: Record<string, string> = {}
  if (def.authProvider) {
    const resolved = await def.authProvider()
    if (resolved) {
      baseUrl = resolved.baseUrl
      headers = resolved.headers
    } else if (def.name === 'unsloth') {
      // No stored config — don't bother probing localhost:8888 with no auth.
      // Surface "configure auth" so the UI can prompt rather than show "offline".
      return {
        name: def.name,
        baseUrl: def.baseUrl,
        reachable: false,
        models: [],
        error: 'auth not configured',
      }
    }
  }
  const info: LocalBackendInfo = {
    name: def.name,
    baseUrl,
    reachable: false,
    models: [],
  }
  try {
    const res = await fetch(`${baseUrl}${def.modelsPath}`, {
      signal: AbortSignal.timeout(2500),
      headers,
    })
    if (!res.ok) {
      info.error = `HTTP ${res.status}`
      if (res.status === 401 && def.name === 'unsloth') {
        invalidateUnslothToken()
        info.error = 'Unsloth auth rejected (HTTP 401) — re-enter credentials.'
      }
      return info
    }
    info.reachable = true
    const body = (await res.json()) as unknown
    if (def.name === 'ollama') {
      const ollama = body as { models?: Array<{ name?: string; details?: { parameter_size?: string } }> }
      info.models = (ollama.models ?? []).map((m) => m.name ?? '').filter(Boolean)
    } else {
      const openai = body as { data?: Array<{ id?: string }> }
      info.models = (openai.data ?? []).map((m) => m.id ?? '').filter(Boolean)
    }
    info.models.sort()
  } catch (err) {
    info.error = (err as Error).message
  }
  return info
}

export type EligibilitySet = {
  phase1: boolean
  phase2: boolean
  phase3: boolean
  phase4: boolean
}

export type ProbeResult = {
  modelId: string
  baseUrl: string
  backend: Backend | 'unknown'
  runAt: string
  structuredJsonScore: number
  groundingScore: number
  tokensPerSecond: number
  eligible: EligibilitySet
}

type CapabilityDocument = {
  version: 1
  results: ProbeResult[]
}

async function loadCapability(): Promise<CapabilityDocument> {
  return (
    (await readJson<CapabilityDocument | null>(capabilityFile(), null)) ?? {
      version: 1,
      results: [],
    }
  )
}

async function saveCapability(doc: CapabilityDocument): Promise<void> {
  await writeJson(capabilityFile(), doc)
}

export async function upsertProbeResult(result: ProbeResult): Promise<CapabilityDocument> {
  const doc = await loadCapability()
  const others = doc.results.filter(
    (r) => !(r.baseUrl === result.baseUrl && r.modelId === result.modelId)
  )
  others.push(result)
  doc.results = others
  await saveCapability(doc)
  return doc
}

export async function listProbeResults(): Promise<ProbeResult[]> {
  const doc = await loadCapability()
  return doc.results
}

// Port-based heuristic for "what API does this local runner speak?" —
// used to pick a request path / body shape, NOT to authorise credential
// attachment. The credential check happens separately in the probe
// runner via host-equality against the stored Unsloth baseUrl, so a
// hostile baseUrl that merely runs on :8888 cannot harvest the user's
// stored bearer.
//
// Substring scans on `baseUrl.toLowerCase()` previously matched a
// public host with the right port baked in (e.g. http://attacker:8888/);
// the parsed URL.port check below is exact.
export function backendForBaseUrl(baseUrl: string): Backend | 'unknown' {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    return 'unknown'
  }
  switch (url.port) {
    case '11434':
      return 'ollama'
    case '1234':
      return 'lmstudio'
    case '8080':
      return 'llamacpp'
    case '8888':
      return 'unsloth'
    default:
      return 'unknown'
  }
}

export function backendGeneratePath(backend: Backend | 'unknown'): string {
  if (backend === 'ollama') return '/api/generate'
  return '/v1/chat/completions'
}

export function localLLMRouter(): Router {
  const router = express.Router()

  router.get('/detect', async (_req, res) => {
    try {
      const results = await Promise.all(BACKENDS.map(detectBackend))
      res.json({ backends: results })
    } catch (err) {
      console.error('[api/local-llm/detect] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  router.get('/probes', async (_req, res) => {
    try {
      const results = await listProbeResults()
      res.json({ results })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // Unsloth-specific auth config. The credential bundle lives in the
  // encrypted keystore under the 'unsloth' slot as JSON; this surface only
  // exposes whether one is configured + writes/clears it. The actual
  // credentials never leave the server in any response.
  //
  // loopback-only: all three verbs read/write credential state. LAN
  // visitors must not be able to set or clear keystore entries that
  // bear plaintext credentials. The SPA on the host hits 127.0.0.1
  // same-origin and passes the gate.
  router.get('/unsloth-config', loopbackOnly(), async (_req, res) => {
    try {
      const cfg = await readUnslothConfig()
      if (!cfg) return res.json({ configured: false })
      res.json({
        configured: true,
        baseUrl: cfg.baseUrl,
        hasUsername: !!cfg.username,
        hasPassword: !!cfg.password,
        hasBearerToken: !!cfg.bearerToken,
      })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  router.put('/unsloth-config', loopbackOnly(), async (req, res) => {
    try {
      const body = req.body as Partial<UnslothConfig>
      if (typeof body.baseUrl !== 'string' || !body.baseUrl.trim()) {
        return res.status(400).json({ error: 'baseUrl is required' })
      }
      // Validate the baseUrl at the storage boundary too — not just on
      // the proxy / probe paths. Otherwise a write-then-read-then-fetch
      // chain (PUT /unsloth-config → next /detect call) silently sends
      // the bearer to whatever URL was just written. validateLocalBaseUrl
      // throws on public IPs / userinfo bypass / non-http schemes.
      let normalisedBaseUrl: string
      try {
        normalisedBaseUrl = await validateLocalBaseUrl(body.baseUrl.trim())
      } catch (err) {
        return res.status(400).json({ error: (err as Error).message })
      }
      const next: UnslothConfig = {
        baseUrl: normalisedBaseUrl,
        username: typeof body.username === 'string' && body.username.trim() ? body.username.trim() : undefined,
        password: typeof body.password === 'string' && body.password ? body.password : undefined,
        bearerToken:
          typeof body.bearerToken === 'string' && body.bearerToken.trim() ? body.bearerToken.trim() : undefined,
      }
      await setKey('unsloth', JSON.stringify(next))
      invalidateUnslothToken()
      res.json({ configured: true, baseUrl: next.baseUrl })
    } catch (err) {
      console.error('[api/local-llm/unsloth-config PUT] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  router.delete('/unsloth-config', loopbackOnly(), async (_req, res) => {
    try {
      await clearKey('unsloth')
      invalidateUnslothToken()
      res.json({ configured: false })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  return router
}
