// Lore-source resolver — decides whether grounding reads from the Tusks-Lore
// folder (default) or a read-only Obsidian vault.
//
// Config lives at {configDir}/obsidian-vault.json:
//   { "enabled": boolean, "vaultPath": string, "modeB": boolean }
//
// When `enabled` is true and `vaultPath` resolves to a readable directory, the
// two lore endpoints (/api/lore/documents and /api/lore/index) serve
// Obsidian-derived data instead of Tusks-Lore. The vault is treated strictly
// read-only — nothing is ever written into vaultPath.
//
// This is the minimal seam needed for the bake-off's faithful Playwright run.
// The full add-on (marker file, Settings UI, cached derived index) builds on
// top of this resolver.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { configDir, readJson } from '../../appData.js'

export const OBSIDIAN_CONFIG_FILENAME = 'obsidian-vault.json'

export type ObsidianVaultConfig = {
  enabled: boolean
  vaultPath: string
  modeB: boolean
  /** When true (opt-in, default OFF), the vault's CLAUDE.md navigation guide is
   *  injected as a bounded context block into grounding. Changes grounding
   *  output, so it ships off per the "risky features default OFF" rule. */
  useClaudeMdContext: boolean
}

export function obsidianConfigPath(): string {
  return path.join(configDir(), OBSIDIAN_CONFIG_FILENAME)
}

/** Add-on marker file — its presence means the add-on is installed. The
 *  resolver requires it so a stale config can't override lore after the
 *  add-on is uninstalled. */
const DEFAULT_CONFIG: ObsidianVaultConfig = {
  enabled: false,
  vaultPath: '',
  modeB: false,
  useClaudeMdContext: false,
}

export async function readObsidianConfig(): Promise<ObsidianVaultConfig> {
  let cfg: ObsidianVaultConfig
  try {
    // A malformed config must never take down grounding — fall back to the
    // default (Obsidian disabled → Tusks-Lore) on any read/parse error.
    cfg = await readJson<ObsidianVaultConfig>(obsidianConfigPath(), DEFAULT_CONFIG)
  } catch (err) {
    console.warn('[obsidian] config unreadable, falling back to Tusks-Lore:', (err as Error).message)
    return { ...DEFAULT_CONFIG }
  }
  return {
    enabled: cfg.enabled === true,
    vaultPath: typeof cfg.vaultPath === 'string' ? cfg.vaultPath : '',
    modeB: cfg.modeB === true,
    useClaudeMdContext: cfg.useClaudeMdContext === true,
  }
}

export type ActiveObsidianSource = { vaultPath: string; modeB: boolean; useClaudeMdContext: boolean }

/** Returns the active Obsidian source when config is enabled and the vault
 *  path is a readable directory; otherwise null (→ caller falls back to
 *  Tusks-Lore). The old install-marker check is gone — the real gate was
 *  always `enabled && vaultPath && isDirectory`, and still is. */
export async function resolveObsidianSource(): Promise<ActiveObsidianSource | null> {
  const cfg = await readObsidianConfig()
  if (!cfg.enabled || !cfg.vaultPath) return null
  try {
    const stat = await fs.stat(cfg.vaultPath)
    if (!stat.isDirectory()) return null
  } catch {
    return null
  }
  return { vaultPath: cfg.vaultPath, modeB: cfg.modeB, useClaudeMdContext: cfg.useClaudeMdContext }
}
