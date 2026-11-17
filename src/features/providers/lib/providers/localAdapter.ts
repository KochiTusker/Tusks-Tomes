// LLMProvider adapter for the existing local-LLM routing (Ollama / LM Studio /
// Unsloth Studio). Wraps the free-function `generateLocal` from `./local.ts`
// in the unified LLMProvider shape so the pipeline can dispatch uniformly.
//
// This is a temporary bridge until Step 13 lands the full per-instance
// LocalProvider with capability probing and per-phase routing.

import { MAX_OUTPUT_TOKENS } from '../constants'
import { stripReasoningBlocks } from '../reasoning'
import { defaultBaseUrl, generateLocal } from './local'
import { getProviderSettings } from './settings'
import type {
  GenerateOptions,
  GenerateRequest,
  GenerateResponse,
  LLMProvider,
  ProviderName,
} from './llm'

export class LocalProviderAdapter implements LLMProvider {
  readonly name: ProviderName = 'local'

  async generate(req: GenerateRequest, opts: GenerateOptions = {}): Promise<GenerateResponse> {
    const settings = getProviderSettings()
    const baseUrl = settings.baseUrl || defaultBaseUrl(settings.providerId)
    const composedPrompt = [req.systemPrompt, req.cacheablePrefix, req.userPrompt]
      .filter((s) => s && s.length > 0)
      .join('\n\n')

    try {
      const text = await generateLocal({
        provider: settings.providerId,
        baseUrl,
        model: req.model,
        prompt: composedPrompt,
        signal: opts.signal,
        maxOutputTokens: req.maxOutputTokens || MAX_OUTPUT_TOKENS,
        auth: settings.auth,
      })
      if (!text.trim()) {
        throw new Error(
          [
            `Local model "${req.model}" returned an empty response.`,
            '',
            '--- Diagnostic context ---',
            `Provider:      ${settings.providerId}`,
            `Base URL:      ${baseUrl}`,
            `Prompt length: ${composedPrompt.length.toLocaleString()} chars`,
            '',
            'Possible causes: model not loaded, context window too small for',
            'the prompt, or the model failed to produce output. Check your',
            'local server logs for details.',
          ].join('\n')
        )
      }
      return {
        text: stripReasoningBlocks(text),
        usage: { inputTokens: 0, outputTokens: 0 },
      }
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') throw err
      if (!opts.contextLabel) throw err
      const base = err instanceof Error ? err : new Error(String(err))
      const wrapped = new Error(`[${opts.contextLabel}]\n${base.message}`)
      ;(wrapped as Error & { cause?: unknown }).cause = base
      throw wrapped
    }
  }

  async listModels(): Promise<string[]> {
    return []
  }
}
