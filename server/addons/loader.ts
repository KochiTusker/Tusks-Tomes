import type { Express } from 'express'
import { addonsFile, readJson, writeJson } from '../appData.js'
import { ADDON_REGISTRY } from './registry.js'
import { slog } from '../lib/slog.js'

const LOADED_ADDONS = new Set<string>()

/** Disk schema for {configDir}/addons.json. Default for an unseen name is
 *  configEnabled: true — installing an add-on implies the user wants it on,
 *  and pre-existing add-ons stay enabled across an upgrade that introduces
 *  the toggle. */
export type AddonsConfig = Record<string, { configEnabled?: boolean }>

/** v1.1.0 — record of whether the most recent read of addons.json
 *  detected schema corruption. The startup-banner endpoint reads this so
 *  the UI can surface a clear warning rather than silently degrading. */
let lastReadWasCorrupted = false
let lastCorruptionReason = ''

export function getAddonsConfigCorruption(): { corrupted: boolean; reason: string } {
  return { corrupted: lastReadWasCorrupted, reason: lastCorruptionReason }
}

/** Validate a parsed JSON blob against the AddonsConfig schema. Returns
 *  null if the shape is wrong — the caller can then trigger the
 *  conservative-disabled fallback. */
export function validateAddonsConfig(parsed: unknown): AddonsConfig | null {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  for (const [name, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof name !== 'string' || !name) return null
    if (entry === null || entry === undefined) continue
    if (typeof entry !== 'object' || Array.isArray(entry)) return null
    const rec = entry as Record<string, unknown>
    if (rec.configEnabled !== undefined && typeof rec.configEnabled !== 'boolean') return null
  }
  return parsed as AddonsConfig
}

export async function readAddonsConfig(): Promise<AddonsConfig> {
  // v1.1.0 — validate the parsed shape against the AddonsConfig schema.
  // Pre-fix: on malformed JSON, the catch handler returned {} and EVERY
  // add-on was treated as enabled (the unseen-name default). That meant
  // a corrupted addons.json could silently re-enable add-ons whose
  // prerequisites were missing, triggering cryptic pipeline crashes.
  // Now: malformed input flips the conservative-disabled fallback +
  // exposes the corruption via getAddonsConfigCorruption() so the UI
  // can render a clear startup warning.
  lastReadWasCorrupted = false
  lastCorruptionReason = ''
  let parsed: unknown
  try {
    parsed = await readJson<unknown>(addonsFile(), {})
  } catch (err) {
    lastReadWasCorrupted = true
    lastCorruptionReason = `addons.json could not be parsed as JSON: ${(err as Error).message}`
    console.warn('[addons]', lastCorruptionReason)
    slog('server', { event: 'addons_config_corrupted', reason: lastCorruptionReason })
    return {}
  }
  const validated = validateAddonsConfig(parsed)
  if (validated === null) {
    lastReadWasCorrupted = true
    lastCorruptionReason = 'addons.json shape does not match AddonsConfig schema'
    console.warn('[addons]', lastCorruptionReason)
    slog('server', { event: 'addons_config_corrupted', reason: lastCorruptionReason })
    return {}
  }
  return validated
}

export async function writeAddonsConfig(config: AddonsConfig): Promise<void> {
  await writeJson(addonsFile(), config)
}

/** True iff the user hasn't explicitly disabled this add-on. Unseen names
 *  count as enabled — matches the install→active flow. */
export function isAddonConfigEnabled(name: string, config: AddonsConfig): boolean {
  const entry = config[name]
  return entry?.configEnabled !== false
}

/** True iff the named add-on's routes were mounted in the current process.
 *  Distinct from "enabled" (= prerequisites installed) and "configEnabled"
 *  (= user hasn't disabled it): all three must align for a clean state,
 *  but they diverge between install/toggle and the next restart. */
export function isAddonLoaded(name: string): boolean {
  return LOADED_ADDONS.has(name)
}

/** Checks each registered add-on and mounts its routes if ready AND not
 *  toggled off by the user. Call once during server startup, after core
 *  routes are registered and before the Vite / static-file middleware.
 *
 *  v1.1.0 — if `readAddonsConfig` detected schema corruption, fall back
 *  to the conservative "all disabled" path. The default is the safer
 *  choice than the previous "all enabled" fallback because mounting an
 *  add-on whose prerequisites are missing or stale produces cryptic
 *  pipeline errors at run time. The user can re-enable explicitly via
 *  Settings → Add-ons once they've inspected the corrupted file. */
export async function loadAddons(app: Express): Promise<string[]> {
  LOADED_ADDONS.clear()
  const config = await readAddonsConfig().catch((err) => {
    // Defensive — readAddonsConfig already handles its own errors but
    // we still wrap to make sure a future surprise doesn't crash startup.
    console.warn('[addons] readAddonsConfig threw unexpectedly:', err)
    lastReadWasCorrupted = true
    lastCorruptionReason = `unexpected readAddonsConfig throw: ${(err as Error).message}`
    return {} as AddonsConfig
  })
  if (lastReadWasCorrupted) {
    console.warn('[addons] addons.json is corrupted — skipping ALL add-ons until the file is fixed or removed')
    slog('server', { event: 'addons_load_skipped_all', reason: lastCorruptionReason })
    return []
  }
  for (const addon of ADDON_REGISTRY) {
    try {
      // Builtins always mount: they have no prerequisites to check and no
      // install lifecycle, so neither isReady() nor the addons.json toggle
      // applies. Whether the underlying capability is USABLE (CLI on PATH,
      // runner reachable) is a per-request detection question, not a mount
      // question. A stale configEnabled:false from the add-on era is
      // deliberately ignored rather than migrated.
      if (addon.kind === 'builtin') {
        addon.registerRoutes(app)
        LOADED_ADDONS.add(addon.name)
        slog('server', { event: 'addon_loaded', name: addon.name, builtin: true })
        continue
      }
      if (!isAddonConfigEnabled(addon.name, config)) {
        console.log(`[addons] "${addon.displayName}" skipped (toggled off)`)
        slog('server', { event: 'addon_skipped', name: addon.name, reason: 'toggled_off' })
        continue
      }
      if (await addon.isReady()) {
        addon.registerRoutes(app)
        LOADED_ADDONS.add(addon.name)
        console.log(`[addons] "${addon.displayName}" loaded`)
        slog('server', { event: 'addon_loaded', name: addon.name })
      } else {
        slog('server', { event: 'addon_not_ready', name: addon.name })
      }
    } catch (err) {
      console.error(`[addons] failed to load "${addon.name}":`, err)
      slog('server', { event: 'addon_load_error', name: addon.name, error: (err as Error).message })
    }
  }
  return [...LOADED_ADDONS]
}
