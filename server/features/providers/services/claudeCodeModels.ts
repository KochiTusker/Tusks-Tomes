// Which models the Claude Code CLI can be asked for.
//
// The CLI has no command that lists models, so this used to be a hardcoded
// list — and it fell behind every Claude release while the OpenRouter route,
// which reads a live catalogue, kept up. The OpenRouter catalogue carries every
// current Anthropic model as `anthropic/claude-opus-5.5`, and the CLI's
// `--model` flag takes the same model as `claude-opus-5-5`. Deriving one from
// the other means a new Claude model reaches the Claude Code picker as soon as
// OpenRouter lists it, with no code change here.
//
// Whether the user's plan actually includes a given model is not something
// either list can say; the CLI reports that at call time.

import type { OpenRouterCatalogue } from './openrouterCatalogue.js'

/** Aliases first: the CLI resolves them to its current model in each tier, so
 *  they move forward on a CLI upgrade without anyone editing a list. */
export const CLAUDE_CODE_ALIASES = ['sonnet', 'opus', 'haiku'] as const

/** What the picker offers before any catalogue has been fetched. */
export const CLAUDE_CODE_BASELINE = [
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-opus-4-8',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
]

/** `anthropic/claude-opus-5.5` → `claude-opus-5-5`. Returns null for anything
 *  that is not a plain Anthropic chat model the CLI would accept: variants
 *  (`:batch`, `:free`), routers (`~anthropic/…`), and the Claude 3 family,
 *  which current CLI versions no longer serve. */
export function cliIdFromOpenRouter(openrouterId: string): string | null {
  const m = /^anthropic\/(claude-[a-z0-9.-]+)$/.exec(openrouterId)
  if (!m) return null
  const id = m[1].replace(/\./g, '-')
  if (id.startsWith('claude-3')) return null
  return id
}

/** Aliases, then every Anthropic model the catalogue lists (in its own order,
 *  which is newest first), then any baseline id the catalogue did not cover. */
export function claudeCodeModelsFrom(catalogue: OpenRouterCatalogue | null): string[] {
  const derived = (catalogue?.models ?? [])
    .map((m) => cliIdFromOpenRouter(m.id))
    .filter((id): id is string => id !== null)
  return [...new Set<string>([...CLAUDE_CODE_ALIASES, ...derived, ...CLAUDE_CODE_BASELINE])]
}
