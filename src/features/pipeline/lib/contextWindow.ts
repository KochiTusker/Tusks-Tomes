// The context window of the model a phase is routed to.
//
// Chronicle (Phase 3) and Condense (Phase 6) carry the lore in their prompts,
// and narrow it by retrieval when the whole of it cannot fit the model's
// window (shouldRetrieveVaultKb in modelLimits.ts). That decision needs the
// window. The OpenRouter catalogue publishes one for every model it lists, and
// it lists the models the Gemini, Claude Code and Codex routes call as well,
// so one cached lookup serves all of them.
//
// A figure is returned only when it can be tied to the model being called, or
// (for a Claude Code alias, which the CLI resolves) bounded from below by every
// model it could be. Anything else is null, which the retrieval rule reads as
// "unknown" and leaves the user's own setting in charge. A guessed window would
// be worse than none: too small and it narrows lore that fits, too large and it
// hides the overflow it exists to catch.

import type { CloudProvider } from '@/features/providers'
import {
  getOpenRouterCatalogue,
  type OpenRouterModelInfo,
  parseCatalogueGemini,
  parseNativeGemini,
} from '@/features/providers'

/** The CLI resolves these to its current model in each tier. */
const CLAUDE_CODE_ALIASES = new Set(['sonnet', 'opus', 'haiku'])

/** A plain Anthropic chat entry: no `:variant`, no `~router/` prefix. */
const ANTHROPIC_ENTRY = /^anthropic\/(claude-[a-z0-9.-]+)$/

/** parseCatalogueGemini wants a rate; only the id parsing matters here. */
const NO_RATE = { input: 0, output: 0 }

function windowOf(entry: OpenRouterModelInfo | undefined): number | null {
  const n = entry?.contextLength
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null
}

/** Native Gemini id → catalogue entry, by the same rules liveRates.ts prices
 *  with: a pinned id matches its own family and version only (its -preview
 *  accepted when the plain id is absent); a -latest alias takes the newest. */
function geminiEntry(
  models: readonly OpenRouterModelInfo[],
  model: string,
): OpenRouterModelInfo | undefined {
  const wanted = parseNativeGemini(model)
  if (!wanted) return undefined
  const inFamily = models
    .map((m) => ({ m, c: parseCatalogueGemini(m.id, NO_RATE) }))
    .filter((x): x is { m: OpenRouterModelInfo; c: NonNullable<typeof x.c> } => x.c?.family === wanted.family)
  const pool =
    wanted.version === 'latest' ? inFamily : inFamily.filter((x) => x.c.version === wanted.version)
  pool.sort((a, b) => b.c.version - a.c.version || Number(a.c.preview) - Number(b.c.preview))
  return pool[0]?.m
}

/** Claude Code id → window. A pinned id such as `claude-opus-5-5` is
 *  `anthropic/claude-opus-5.5` in the catalogue. An alias is resolved by the
 *  CLI, not by anything visible here, so it takes the SMALLEST window in its
 *  tier: narrowing lore that would have fit costs a little recall, while an
 *  overstated window is the failure this lookup exists to prevent. */
function claudeCodeWindow(models: readonly OpenRouterModelInfo[], model: string): number | null {
  const plain = models.filter((m) => {
    const id = ANTHROPIC_ENTRY.exec(m.id)?.[1]
    return id !== undefined && !id.startsWith('claude-3')
  })
  if (CLAUDE_CODE_ALIASES.has(model)) {
    const windows = plain
      .filter((m) => m.id.startsWith(`anthropic/claude-${model}-`))
      .map(windowOf)
      .filter((n): n is number => n !== null)
    return windows.length > 0 ? Math.min(...windows) : null
  }
  return windowOf(plain.find((m) => m.id.slice('anthropic/'.length).replace(/\./g, '-') === model))
}

/** The window of `model` on `provider`, from an already-fetched catalogue. */
export function contextWindowFromCatalogue(
  models: readonly OpenRouterModelInfo[],
  provider: CloudProvider | undefined,
  model: string,
): number | null {
  if (!model || models.length === 0) return null
  switch (provider) {
    case 'openrouter':
      return windowOf(models.find((m) => m.id === model))
    case 'gemini':
      return windowOf(geminiEntry(models, model))
    case 'claudeCode':
      return claudeCodeWindow(models, model)
    case 'codex':
      return windowOf(models.find((m) => m.id === `openai/${model}`))
    default:
      return null
  }
}

/** How long a phase waits for the catalogue before treating the window as
 *  unknown. The lookup sits in front of the first chunk, so it must never be
 *  what a run is waiting on. */
export const CONTEXT_LOOKUP_TIMEOUT_MS = 3_000

/** The window of `model` on `provider`, or null when it cannot be known in
 *  time. Never throws: the catalogue client fails soft to an empty list. */
export async function contextWindowFor(
  provider: CloudProvider | undefined,
  model: string,
  timeoutMs = CONTEXT_LOOKUP_TIMEOUT_MS,
): Promise<number | null> {
  if (!provider || !model) return null
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs)
  })
  try {
    const lookup = getOpenRouterCatalogue().then(({ models }) =>
      contextWindowFromCatalogue(models, provider, model),
    )
    return await Promise.race([lookup, timedOut])
  } finally {
    clearTimeout(timer)
  }
}
