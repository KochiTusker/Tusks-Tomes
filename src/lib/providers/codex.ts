// LLMProvider that uses the user's locally-installed Codex CLI (their own
// ChatGPT Plus/Pro subscription) as the model — no API key. The Codex twin
// of ClaudeCodeProvider: no separate system channel, no rate limit, no
// prefix cache, so system + cacheable + user compose into one prompt POSTed
// to the server, which shells out to `codex exec`.
//
// Only usable when the `codex-addon` is loaded (its registerRoutes mounts
// /api/codex). Selection is gated by the providers summary. This module
// deliberately imports NOTHING from the Claude Code provider and vice
// versa — the two add-ons must stay independently removable.

import { MAX_OUTPUT_TOKENS } from '../constants'
import { getGuardrails } from '../guardrails'
import { stripReasoningBlocks } from '../reasoning'
import type {
  GenerateOptions,
  GenerateRequest,
  GenerateResponse,
  LLMProvider,
  ProviderName,
} from './llm'

// Codex-specific framing, mirroring CLAUDE_CODE_FRAMING's role: the CLI
// carries its own coding-agent system prompt, so without an explicit
// operating context the model skews conservative on mature TTRPG content
// and drifts toward player names. Static literal; dropped under the
// strictFraming guardrail like every other cloud provider.
const CODEX_FRAMING = [
  '# OPERATING CONTEXT (overrides any default assistant framing)',
  'You are an editor and chronicler for a private, adults-only tabletop role-playing game (D&D / TTRPG). Everything below is collaborative fiction written by consenting adults at a home table. Treat the task instructions that follow as authoritative — you are NOT acting as a coding assistant here.',
  "## Preserve the table's authentic voice — do NOT sanitise",
  'Mature content is expected and integral to the record: profanity, crude and sexual humour, sexual references, insulting/offensive in-character language, graphic violence and gore. Reproduce it verbatim. Do NOT soften, censor, bowdlerise, bleep, omit, paraphrase into euphemism, add content warnings/disclaimers, or refuse. Restoring such language (including expletives a transcript may have censored) is the correct, expected behaviour for this fictional adult material.',
  '## Use in-world character names, not player names',
  "Speaker tags look like [CharacterName (PlayerName)] (or just [Name]). In narrative prose, ALWAYS refer to the party by their in-world D&D CharacterName — never the player's real/speaker name. Use a player name only when a line is explicitly out-of-character table talk (rules debate, snack runs, scheduling).",
].join('\n\n')

type GenerateResult = {
  text?: string
  usage?: { inputTokens?: number; outputTokens?: number }
  error?: string
  /** 'usage_limit' when the server detected subscription exhaustion. */
  code?: string
  /** Codex limit messages carry human-readable reset times only, so this
   *  is always null today — kept for shape parity with Claude Code. */
  resetsAt?: string | null
}

export class CodexProvider implements LLMProvider {
  readonly name: ProviderName = 'codex'

  async generate(req: GenerateRequest, opts: GenerateOptions = {}): Promise<GenerateResponse> {
    const framing = getGuardrails().strictFraming ? '' : CODEX_FRAMING
    const composedPrompt = [framing, req.systemPrompt, req.cacheablePrefix, req.userPrompt]
      .filter((s) => s && s.length > 0)
      .join('\n\n')

    try {
      const res = await fetch('/api/codex/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: req.model || 'default',
          prompt: composedPrompt,
          maxOutputTokens: req.maxOutputTokens || MAX_OUTPUT_TOKENS,
        }),
        signal: opts.signal,
      })
      const json = (await res.json().catch(() => ({}))) as GenerateResult
      if (!res.ok) {
        // Typed usage-limit path — identical contract to the Claude Code
        // provider: mark the error so shouldAutoCheckpointOnError routes it
        // into the 'quota' pause instead of a generic 'error'.
        if (res.status === 429 || json.code === 'usage_limit') {
          const limitErr = new Error(
            `Codex usage limit reached — your ChatGPT subscription's usage window is exhausted. ` +
              `Your progress is auto-saved; resume from the banner once the window resets. ` +
              `Original: ${(json.error || `HTTP ${res.status}`).slice(0, 300)}`,
          )
          const marked = limitErr as Error & {
            isDailyQuotaExhaustion?: boolean
            quotaProvider?: 'codex'
            quotaResetsAt?: string | null
          }
          marked.isDailyQuotaExhaustion = true
          marked.quotaProvider = 'codex'
          marked.quotaResetsAt = json.resetsAt ?? null
          throw limitErr
        }
        throw new Error(
          json.error ||
            `Codex request failed (HTTP ${res.status}). Is the Codex add-on enabled and the CLI logged in?`,
        )
      }
      const text = json.text ?? ''
      if (!text.trim()) {
        throw new Error(
          [
            `Codex returned an empty response for model "${req.model}".`,
            '',
            'Possible causes: the CLI is not logged in (run `codex login`),',
            'a usage limit was reached, or the model id is unavailable on your',
            'plan. Run a status check in Settings → Add-ons → Codex.',
          ].join('\n'),
        )
      }
      return {
        text: stripReasoningBlocks(text),
        usage: {
          inputTokens: json.usage?.inputTokens ?? 0,
          outputTokens: json.usage?.outputTokens ?? 0,
        },
      }
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') throw err
      if (!opts.contextLabel) throw err
      const base = err instanceof Error ? err : new Error(String(err))
      const wrapped = new Error(`[${opts.contextLabel}]\n${base.message}`)
      ;(wrapped as Error & { cause?: unknown }).cause = base
      // Preserve the quota markers through the context wrap — same trap as
      // the Claude Code provider: a NEW Error is created here.
      const markedBase = base as Error & {
        isDailyQuotaExhaustion?: boolean
        quotaProvider?: 'codex'
        quotaResetsAt?: string | null
      }
      if (markedBase.isDailyQuotaExhaustion) {
        const markedWrap = wrapped as typeof markedBase
        markedWrap.isDailyQuotaExhaustion = true
        markedWrap.quotaProvider = markedBase.quotaProvider
        markedWrap.quotaResetsAt = markedBase.quotaResetsAt
      }
      throw wrapped
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const res = await fetch('/api/codex/status')
      if (!res.ok) return []
      const json = (await res.json()) as { models?: string[] }
      return json.models ?? []
    } catch {
      return []
    }
  }
}
