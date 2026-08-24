// Migrating stored config off the retired direct Anthropic and OpenAI keys.
//
// Those two providers were dropped in favour of OpenRouter, which reaches the
// same models with one key. Gemini stays on its own direct key: it is measurably
// cheaper direct than through OpenRouter, and the only decoder collapse seen in
// testing happened on the OpenRouter route.
//
// The subscription CLIs are NOT affected. `claudeCode` and `codex` bill against
// a subscription rather than an API key, cost nothing per token, and grade well
// on the mechanical phases — they are the reason the hybrid presets exist. It
// would be easy to confuse `claude` with `claudeCode` while reading this; they
// are different things and only the first is going away.
//
// Anything already on disk keeps working. A routing document naming a retired
// provider is rewritten to the OpenRouter equivalent on read, so a user who
// had Claude on the chronicle phase finds the same model still there, reached
// by a different key. Nothing silently changes model.

/** The two providers that no longer have their own key slot. */
export const RETIRED_PROVIDERS = ['claude', 'openai'] as const
export type RetiredProvider = (typeof RETIRED_PROVIDERS)[number]

export function isRetiredProvider(value: unknown): value is RetiredProvider {
  return typeof value === 'string' && (RETIRED_PROVIDERS as readonly string[]).includes(value)
}

/**
 * Map a direct-API model id onto its OpenRouter namespace.
 *
 * OpenRouter passes both vendors' pricing straight through, so this is the
 * same model at the same rate reached by a different key — not a downgrade
 * dressed up as a migration.
 *
 * An id that is already namespaced is returned untouched, so running this
 * twice is safe.
 */
export function toOpenRouterModelId(provider: RetiredProvider, modelId: string): string {
  const id = modelId.trim()
  if (!id) return id
  if (id.includes('/')) return id

  if (provider === 'claude') {
    // Direct ids use dashes where OpenRouter uses dots for the point release:
    // claude-sonnet-4-5 -> anthropic/claude-sonnet-4.5. Dated suffixes
    // (…-20251001) are dropped; OpenRouter resolves the undated alias.
    const base = id.replace(/-\d{8}$/, '')
    const dotted = base.replace(/^(claude-[a-z]+)-(\d+)-(\d+)$/, '$1-$2.$3')
    return `anthropic/${dotted}`
  }
  return `openai/${id}`
}

/** A per-phase routing entry, in the shape routing.json stores. */
interface PhaseEntry {
  target?: string
  cloudProvider?: string
  modelId?: string
  geminiTier?: string
}

/**
 * Rewrite one phase entry off a retired provider. Returns the entry unchanged
 * when it names something still supported.
 */
export function migratePhaseEntry<T extends PhaseEntry>(entry: T): T {
  if (!isRetiredProvider(entry.cloudProvider)) return entry
  return {
    ...entry,
    cloudProvider: 'openrouter',
    modelId: entry.modelId ? toOpenRouterModelId(entry.cloudProvider, entry.modelId) : entry.modelId,
  }
}

/** What a migration changed, so the UI can tell the user rather than
 *  rewriting their routing behind their back. */
export interface MigrationNotice {
  phase: string
  from: RetiredProvider
  fromModel?: string
  toModel?: string
}

/**
 * Migrate a whole routing document. Returns the new document plus a list of
 * what moved — an empty list means nothing needed migrating.
 */
export function migrateRouting<
  T extends { lastSelectedProvider?: unknown; perPhase?: Record<string, PhaseEntry> | undefined },
>(doc: T): { doc: T; notices: MigrationNotice[] } {
  const notices: MigrationNotice[] = []
  const perPhase = doc.perPhase
  let nextPerPhase = perPhase

  if (perPhase) {
    nextPerPhase = {}
    for (const [phase, entry] of Object.entries(perPhase)) {
      if (isRetiredProvider(entry?.cloudProvider)) {
        const migrated = migratePhaseEntry(entry)
        notices.push({
          phase,
          from: entry.cloudProvider,
          fromModel: entry.modelId,
          toModel: migrated.modelId,
        })
        nextPerPhase[phase] = migrated
      } else {
        nextPerPhase[phase] = entry
      }
    }
  }

  const last = doc.lastSelectedProvider
  return {
    doc: {
      ...doc,
      // A retired provider cannot remain the remembered selection, or the
      // next run would resolve to a provider with no key slot.
      lastSelectedProvider: isRetiredProvider(last) ? 'openrouter' : last,
      ...(nextPerPhase ? { perPhase: nextPerPhase } : {}),
    },
    notices,
  }
}
