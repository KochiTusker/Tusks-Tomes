import type { LocalAuth, ProviderId } from './types'

// Default endpoints. The user can override via the Settings UI for remote
// boxes (e.g. an Ollama instance on another machine on the LAN).
export const OLLAMA_DEFAULT_BASE = 'http://localhost:11434'
export const LMSTUDIO_DEFAULT_BASE = 'http://localhost:1234'
export const UNSLOTH_DEFAULT_BASE = 'http://localhost:8888'

/**
 * Underlying API protocol per provider. Some providers share a protocol —
 * Unsloth Studio and LM Studio are both OpenAI-compatible — so the network
 * code paths collapse here, but each gets its own provider ID for setup
 * UX, default URL, and launch behaviour.
 */
export function apiProtocol(provider: ProviderId): 'ollama-native' | 'openai-compatible' {
  return provider === 'ollama' ? 'ollama-native' : 'openai-compatible'
}

const PROXY_GENERATE = '/api/local/generate'
const PROXY_LAUNCH = '/api/local/launch'

export function defaultBaseUrl(provider: ProviderId): string {
  switch (provider) {
    case 'ollama':
      return OLLAMA_DEFAULT_BASE
    case 'lmstudio':
      return LMSTUDIO_DEFAULT_BASE
    case 'unsloth':
      return UNSLOTH_DEFAULT_BASE
    default:
      return ''
  }
}

/**
 * Run a single generation against a local LLM via the server proxy. No
 * retry/backoff — local servers don't rate-limit, so a failure is generally
 * a real problem (model not loaded, OOM, server crashed). Bubble it up.
 */
export async function generateLocal(args: {
  provider: ProviderId
  baseUrl: string
  model: string
  prompt: string
  signal?: AbortSignal
  maxOutputTokens: number
  auth?: LocalAuth
}): Promise<string> {
  const { provider, baseUrl, model, prompt, signal, maxOutputTokens, auth } = args

  const body =
    apiProtocol(provider) === 'ollama-native'
      ? {
          model,
          prompt,
          stream: false,
          options: { num_predict: maxOutputTokens },
        }
      : {
          model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: maxOutputTokens,
          stream: false,
        }

  const res = await fetch(PROXY_GENERATE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, baseUrl, body, auth }),
    signal,
  })

  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    // Detect llama.cpp / Unsloth context-overflow specifically — it's the
    // single most common local-LLM failure mode and the default error is
    // buried in nested JSON. Surface an actionable message instead.
    const overflow = errBody.match(
      /request \((\d+) tokens\) exceeds the available context size \((\d+) tokens\)/i
    )
    if (overflow) {
      const requested = Number(overflow[1])
      const available = Number(overflow[2])
      throw new Error(
        [
          `Context overflow: prompt is ${requested.toLocaleString()} tokens but your model is loaded with only ${available.toLocaleString()} tokens of context.`,
          '',
          '--- How to fix ---',
          `1. Reload your model in ${provider === 'unsloth' ? 'Unsloth Studio' : provider} with a larger context window:`,
          `   - In the model load options, set "context size" / "n_ctx" to at least ${Math.max(16384, requested + 2000).toLocaleString()}.`,
          `   - For an 8 GB GPU, 16,384 is a good default. 32,768 if VRAM allows.`,
          '2. Or shrink your Knowledge Base — fewer / smaller lore documents.',
          '3. Or pick a model with a larger native context window (Llama 3.1 / Qwen 2.5 / Gemma 3 all support 128k natively when loaded with sufficient n_ctx).',
        ].join('\n')
      )
    }
    throw new Error(
      `${provider} HTTP ${res.status}: ${errBody.slice(0, 600)}`
    )
  }

  if (apiProtocol(provider) === 'ollama-native') {
    const json = (await res.json()) as { response?: string; error?: string }
    if (json.error) throw new Error(`Ollama error: ${json.error}`)
    return json.response ?? ''
  }

  // OpenAI-compatible (LM Studio, Unsloth Studio, vLLM, llama.cpp, etc.)
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>
    error?: unknown
  }
  if (json.error) {
    throw new Error(`${provider} error: ${JSON.stringify(json.error).slice(0, 400)}`)
  }
  return json.choices?.[0]?.message?.content ?? ''
}

export type LaunchResult = {
  /** True when the runner is up after our call (whether we spawned it or it was already running). */
  ok: boolean
  /** Whether we actually spawned a new process (vs. detecting an existing instance). */
  spawned: boolean
  /** Human-readable status — surfaced in toast / Settings panel. */
  message: string
  /** URL the user should visit in the browser, if the runner has a web UI worth opening. */
  openUrl?: string
}

/**
 * Ask the server to launch the local runner (Ollama / LM Studio / Unsloth)
 * if it isn't already running. The server validates the provider, picks
 * the right command + env, and spawns it detached so it survives our app's
 * lifecycle.
 */
export async function launchLocalRunner(provider: ProviderId): Promise<LaunchResult> {
  const res = await fetch(PROXY_LAUNCH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider }),
  })
  const text = await res.text()
  let parsed: Partial<LaunchResult> = {}
  try {
    parsed = JSON.parse(text)
  } catch {
    /* fall through */
  }
  if (!res.ok) {
    return {
      ok: false,
      spawned: false,
      message: parsed.message ?? `Launch failed (HTTP ${res.status}): ${text.slice(0, 400)}`,
    }
  }
  return {
    ok: parsed.ok ?? false,
    spawned: parsed.spawned ?? false,
    message: parsed.message ?? 'Launch returned no message',
    openUrl: parsed.openUrl,
  }
}
