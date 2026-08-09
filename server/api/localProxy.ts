// Local LLM proxy + launcher.
//
// The browser can't talk directly to localhost:11434 (Ollama) or localhost:1234
// (LM Studio) because of CORS — different port = different origin. Express
// proxies through to the local runner since it's same-origin with the page.
//
// Security:
//   - We only forward to localhost / RFC1918 / loopback addresses.
//   - All state-changing routes use POST and are gated by the same-origin
//     middleware mounted on /api/* in server/index.ts.
//   - The router is only mounted when the `local-llm-addon` is loaded —
//     users who haven't opted into local LLMs never expose this surface.

import express, { type Router } from 'express'
import { spawn } from 'node:child_process'
import { validateLocalBaseUrl } from '../lib/validators.js'
import { loopbackOnly } from '../lib/loopbackGate.js'

type LocalProvider = 'ollama' | 'lmstudio' | 'unsloth'

function pathForList(provider: LocalProvider): string {
  return provider === 'ollama' ? '/api/tags' : '/v1/models'
}

function pathForGenerate(provider: LocalProvider): string {
  return provider === 'ollama' ? '/api/generate' : '/v1/chat/completions'
}

function defaultPortForProvider(provider: LocalProvider): number {
  switch (provider) {
    case 'ollama':
      return 11434
    case 'lmstudio':
      return 1234
    case 'unsloth':
      return 8888
  }
}

type LaunchSpec = {
  command: string
  args: string[]
  env?: Record<string, string>
  /** URL the user should visit in their browser after launch (e.g. login). */
  openUrl?: string
  /** Human-readable name for messages. */
  displayName: string
}

function launchSpecFor(provider: LocalProvider): LaunchSpec {
  switch (provider) {
    case 'ollama':
      return {
        command: 'ollama',
        args: ['serve'],
        env: {
          // Bake in the perf flags we recommend in the UI. Ollama reads
          // these once at `ollama serve` startup; there's no runtime API.
          OLLAMA_FLASH_ATTENTION: '1',
          OLLAMA_KV_CACHE_TYPE: 'q4_0',
        },
        displayName: 'Ollama',
      }
    case 'lmstudio':
      return {
        command: 'lms',
        args: ['server', 'start'],
        displayName: 'LM Studio',
      }
    case 'unsloth':
      return {
        command: 'unsloth',
        args: ['studio', '-H', '0.0.0.0', '-p', '8888'],
        openUrl: 'http://localhost:8888',
        displayName: 'Unsloth Studio',
      }
  }
}

/** Probe whether the runner is already responding on its default port. */
async function isRunnerLive(provider: LocalProvider): Promise<boolean> {
  const port = defaultPortForProvider(provider)
  const url = `http://localhost:${port}${pathForList(provider)}`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) })
    return res.status > 0
  } catch {
    return false
  }
}

type LocalAuth = { username?: string; password?: string; bearerToken?: string }

const tokenCache = new Map<string, { token: string; fetchedAt: number }>()
const TOKEN_TTL_MS = 30 * 60 * 1000

async function fetchOAuth2Token(
  baseUrl: string,
  username: string,
  password: string,
): Promise<string | null> {
  const key = `${baseUrl}::${username}`
  const cached = tokenCache.get(key)
  if (cached && Date.now() - cached.fetchedAt < TOKEN_TTL_MS) {
    return cached.token
  }
  try {
    const params = new URLSearchParams({ username, password })
    const res = await fetch(`${baseUrl}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
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

async function buildAuthHeaders(
  auth: LocalAuth | undefined,
  baseUrl: string,
): Promise<Record<string, string>> {
  if (!auth) return {}
  if (auth.bearerToken && auth.bearerToken.trim()) {
    return { Authorization: `Bearer ${auth.bearerToken.trim()}` }
  }
  if (auth.username && auth.password) {
    const jwt = await fetchOAuth2Token(baseUrl, auth.username, auth.password)
    if (jwt) {
      return { Authorization: `Bearer ${jwt}` }
    }
    const basic = Buffer.from(`${auth.username}:${auth.password}`).toString('base64')
    return { Authorization: `Basic ${basic}` }
  }
  return {}
}

async function forwardJson(args: {
  baseUrl: string
  path: string
  method: 'GET' | 'POST'
  body?: unknown
  signal?: AbortSignal
  auth?: LocalAuth
}): Promise<{ status: number; bodyText: string }> {
  const target = `${args.baseUrl}${args.path}`
  const authHeaders = await buildAuthHeaders(args.auth, args.baseUrl)
  const headers: Record<string, string> = {
    ...(args.method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
    ...authHeaders,
  }
  let res = await fetch(target, {
    method: args.method,
    headers,
    body: args.body !== undefined ? JSON.stringify(args.body) : undefined,
    signal: args.signal,
  })

  if (
    res.status === 401 &&
    args.auth?.username &&
    args.auth?.password &&
    !args.auth?.bearerToken
  ) {
    tokenCache.delete(`${args.baseUrl}::${args.auth.username}`)
    const retryHeaders = await buildAuthHeaders(args.auth, args.baseUrl)
    res = await fetch(target, {
      method: args.method,
      headers: {
        ...(args.method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
        ...retryHeaders,
      },
      body: args.body !== undefined ? JSON.stringify(args.body) : undefined,
      signal: args.signal,
    })
  }

  const bodyText = await res.text()
  return { status: res.status, bodyText }
}

/**
 * Mount under /api/local. Exposes list-models / generate / launch — the
 * same surface previously inlined in server/index.ts. Only mounted by the
 * local-llm-addon's registerRoutes(); not part of the default install.
 */
export function localProxyRouter(): Router {
  const router = express.Router()

  router.post('/list-models', async (req, res) => {
    const { provider, baseUrl, auth } = req.body as {
      provider?: LocalProvider
      baseUrl?: string
      auth?: LocalAuth
    }
    if (provider !== 'ollama' && provider !== 'lmstudio' && provider !== 'unsloth') {
      return res.status(400).json({ error: 'provider must be "ollama", "lmstudio", or "unsloth"' })
    }
    // Validate as a SEPARATE try/catch so a bad baseUrl returns 400
    // (client input error), not 500 (server error). Mirrors the shape
    // of server/api/probe.ts:21-28.
    let validated: string
    try {
      validated = await validateLocalBaseUrl(baseUrl)
    } catch (err) {
      return res.status(400).json({ error: (err as Error).message })
    }
    try {
      const r = await forwardJson({
        baseUrl: validated,
        path: pathForList(provider),
        method: 'GET',
        auth,
      })
      res.status(r.status).type('application/json').send(r.bodyText)
    } catch (err) {
      console.error('[local/list-models] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  router.post('/generate', async (req, res) => {
    const { provider, baseUrl, body, auth } = req.body as {
      provider?: LocalProvider
      baseUrl?: string
      body?: unknown
      auth?: LocalAuth
    }
    if (provider !== 'ollama' && provider !== 'lmstudio' && provider !== 'unsloth') {
      return res.status(400).json({ error: 'provider must be "ollama", "lmstudio", or "unsloth"' })
    }
    let validated: string
    try {
      validated = await validateLocalBaseUrl(baseUrl)
    } catch (err) {
      return res.status(400).json({ error: (err as Error).message })
    }
    try {
      const r = await forwardJson({
        baseUrl: validated,
        path: pathForGenerate(provider),
        method: 'POST',
        body,
        auth,
      })
      res.status(r.status).type('application/json').send(r.bodyText)
    } catch (err) {
      console.error('[local/generate] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  /**
   * Launch a local LLM runner if it isn't already up. Detached spawn so the
   * runner survives our app's lifecycle.
   *
   * loopback-only: this spawns a child process on the HOST machine.
   * Cross-device tablet visitors over LAN must not be able to trigger
   * process creation on the host. The SPA on the host's own browser hits
   * 127.0.0.1 same-origin and passes the gate; LAN visitors get 403.
   */
  router.post('/launch', loopbackOnly(), async (req, res) => {
    const { provider } = req.body as { provider?: LocalProvider }
    if (provider !== 'ollama' && provider !== 'lmstudio' && provider !== 'unsloth') {
      return res.status(400).json({ error: 'provider must be "ollama", "lmstudio", or "unsloth"' })
    }

    const spec = launchSpecFor(provider)

    if (await isRunnerLive(provider)) {
      return res.json({
        ok: true,
        spawned: false,
        message: `${spec.displayName} is already running.`,
        openUrl: spec.openUrl,
      })
    }

    try {
      // shell:true is required on Windows so spawn walks PATHEXT and
      // resolves the `.cmd` shims that Ollama / LM Studio / Unsloth
      // install (e.g. ollama.cmd, lms.cmd, unsloth.cmd). Without it,
      // Node's spawn cannot find a bare-name `ollama` invocation on
      // Win32 and the launch route silently fails with ENOENT.
      //
      // This is SAFE here ONLY because spec.command and spec.args are
      // hardcoded string literals per provider in launchSpecFor() at
      // lines 49-77. No req-derived or user-typed value flows into
      // either field. If you ever change launchSpecFor to accept any
      // value from `req` (or any other untrusted source), you MUST
      // switch to shell:false AND resolve the extension manually,
      // AND update server/api/localProxy.test.ts which pins the
      // shell:true invariant as a regression test.
      // AUDIT: shell:true safe — literal inputs (see launchSpecFor)
      const child = spawn(spec.command, spec.args, {
        shell: true,
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, ...(spec.env ?? {}) },
      })
      child.unref()

      let earlyError: string | null = null
      child.once('error', (err) => {
        earlyError = err.message
      })
      await new Promise((r) => setTimeout(r, 250))
      if (earlyError) {
        return res.status(500).json({
          ok: false,
          spawned: false,
          message: `Couldn't launch ${spec.displayName}: ${earlyError}. Make sure the "${spec.command}" command is on your PATH.`,
        })
      }

      res.json({
        ok: true,
        spawned: true,
        message: `Launching ${spec.displayName}…`,
        openUrl: spec.openUrl,
      })
    } catch (err) {
      console.error('[local/launch] failed:', err)
      res.status(500).json({
        ok: false,
        spawned: false,
        message: `Couldn't launch ${spec.displayName}: ${(err as Error).message}`,
      })
    }
  })

  return router
}
