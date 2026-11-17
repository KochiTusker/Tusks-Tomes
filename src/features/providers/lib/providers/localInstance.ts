// Per-instance local provider (ROADMAP Step 13). Unlike LocalProviderAdapter
// in `localAdapter.ts` — which uses the legacy single-provider settings —
// this class is configured with an explicit `{ baseUrl, modelId }` so the
// hybrid routing layer (Step 15) can target a specific local model
// independent of the user's "active provider" selection.

import { MAX_OUTPUT_TOKENS } from '../constants'
import { stripReasoningBlocks } from '../reasoning'
import type {
  GenerateOptions,
  GenerateRequest,
  GenerateResponse,
  LLMProvider,
  ProviderName,
} from './llm'

type Backend = 'ollama' | 'lmstudio' | 'llamacpp' | 'unknown'

function detectBackend(baseUrl: string): Backend {
  const lower = baseUrl.toLowerCase()
  if (lower.includes(':11434')) return 'ollama'
  if (lower.includes(':1234')) return 'lmstudio'
  if (lower.includes(':8080')) return 'llamacpp'
  return 'unknown'
}

type GenerateBodyOllama = {
  model: string
  prompt: string
  stream: false
  options: { num_predict: number }
}

type GenerateBodyOpenAI = {
  model: string
  messages: Array<{ role: 'system' | 'user'; content: string }>
  max_tokens: number
  stream: false
}

type ProxyArgs = {
  provider: 'ollama' | 'lmstudio' | 'unsloth'
  baseUrl: string
  body: GenerateBodyOllama | GenerateBodyOpenAI
}

const PROXY_PATH = '/api/local/generate'

export class LocalInstanceProvider implements LLMProvider {
  readonly name: ProviderName = 'local'
  readonly baseUrl: string
  readonly modelId: string
  readonly backend: Backend

  constructor(args: { baseUrl: string; modelId: string }) {
    this.baseUrl = args.baseUrl
    this.modelId = args.modelId
    this.backend = detectBackend(args.baseUrl)
  }

  async generate(req: GenerateRequest, opts: GenerateOptions = {}): Promise<GenerateResponse> {
    const composed = [req.systemPrompt, req.cacheablePrefix, req.userPrompt]
      .filter((s) => s && s.length > 0)
      .join('\n\n')
    // We reuse the existing same-origin proxy at /api/local/generate so we
    // don't have to worry about CORS from the page origin to localhost.
    const proxyProvider: ProxyArgs['provider'] =
      this.backend === 'ollama' ? 'ollama' : this.backend === 'llamacpp' ? 'unsloth' : 'lmstudio'
    const body: GenerateBodyOllama | GenerateBodyOpenAI =
      proxyProvider === 'ollama'
        ? {
            model: this.modelId,
            prompt: composed,
            stream: false,
            options: { num_predict: req.maxOutputTokens || MAX_OUTPUT_TOKENS },
          }
        : {
            model: this.modelId,
            messages: [{ role: 'user', content: composed }],
            max_tokens: req.maxOutputTokens || MAX_OUTPUT_TOKENS,
            stream: false,
          }

    const res = await fetch(PROXY_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: proxyProvider,
        baseUrl: this.baseUrl,
        body,
      }),
      signal: opts.signal,
    })
    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      throw new Error(`Local model HTTP ${res.status}: ${errBody.slice(0, 600)}`)
    }

    let text = ''
    if (proxyProvider === 'ollama') {
      const json = (await res.json()) as { response?: string; error?: string }
      if (json.error) throw new Error(`Ollama error: ${json.error}`)
      text = json.response ?? ''
    } else {
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>
      }
      text = json.choices?.[0]?.message?.content ?? ''
    }
    return {
      text: stripReasoningBlocks(text),
      usage: { inputTokens: 0, outputTokens: 0 },
    }
  }

  async listModels(): Promise<string[]> {
    return [this.modelId]
  }
}
