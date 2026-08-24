// API surface for the Obsidian Vault lore-source add-on.
//
//   GET  /api/obsidian/status   — config + vault diagnostics + cached-index time
//   POST /api/obsidian/config   — set { vaultPath, enabled, modeB } (validated)
//   POST /api/obsidian/reindex  — rebuild the derived index (cached in cacheDir)
//   GET  /api/obsidian/preview  — first N mapped entities, for the Settings UI
//
// The vault is treated STRICTLY READ-ONLY. The derived AliasIndex is written
// to the app's cacheDir (keyed by a hash of the vault path), NEVER into the
// vault. Mounted only when the add-on is loaded (see registry.ts).

import express, { type Router } from 'express'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { cacheDir, writeJson, readJson } from '../appData.js'
import {
  obsidianConfigPath,
  readObsidianConfig,
  type ObsidianVaultConfig,
} from '../lore/source/resolver.js'
import { buildObsidianAliasIndex, ENTITY_INDEX_RELPATH } from '../lore/obsidian/vaultAdapter.js'
import {
  readVaultReadiness,
  graphifyStatus,
  runGraphifyBuild,
  writeVaultClaudeMd,
} from '../lore/obsidian/vaultTools.js'
import { buildVaultClaudeMd, readVaultClaudeMd } from '../lore/obsidian/vaultClaudeMd.js'
import { convertDocsToMarkdown, findConvertibleDocs } from '../lore/obsidian/vaultConvert.js'
import { isAddonLoaded } from '../addons/loader.js'
import { pickFolder } from '../lib/folderDialog.js'
import type { AliasIndex } from '../lore/aliasTypes.js'

type CachedIndex = { vaultPath: string; builtAt: string; index: AliasIndex }

function cachedIndexPath(vaultPath: string): string {
  const hash = createHash('sha1').update(vaultPath).digest('hex').slice(0, 12)
  return path.join(cacheDir(), 'obsidian-vault', `${hash}.index.json`)
}

async function dirReadable(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory()
  } catch {
    return false
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/** Build the derived index and persist it to cacheDir (never the vault). */
async function reindex(vaultPath: string): Promise<CachedIndex> {
  const built = await buildObsidianAliasIndex(vaultPath)
  const payload: CachedIndex = {
    vaultPath,
    builtAt: new Date().toISOString(),
    index: built.index,
  }
  await writeJson(cachedIndexPath(vaultPath), payload)
  return payload
}

export function obsidianRouter(): Router {
  const router = express.Router()
  router.use(express.json({ limit: '256kb' }))

  router.get('/status', async (_req, res) => {
    try {
      const cfg = await readObsidianConfig()
      const vaultExists = cfg.vaultPath ? await dirReadable(cfg.vaultPath) : false
      const entityIndexExists = vaultExists
        ? await fileExists(path.join(cfg.vaultPath, ENTITY_INDEX_RELPATH))
        : false
      // Whether a CLAUDE.md vault-navigation guide already lives at the root —
      // drives the generator button's "regenerate vs create" copy and the
      // don't-clobber confirm in the Tome-of-Lore summary card.
      const claudeMdPresent = vaultExists
        ? await fileExists(path.join(cfg.vaultPath, 'CLAUDE.md'))
        : false
      let cached: CachedIndex | null = null
      if (cfg.vaultPath) {
        cached = await readJson<CachedIndex | null>(cachedIndexPath(cfg.vaultPath), null)
      }
      res.json({
        enabled: cfg.enabled,
        vaultPath: cfg.vaultPath,
        modeB: cfg.modeB,
        useClaudeMdContext: cfg.useClaudeMdContext,
        vaultExists,
        entityIndexExists,
        claudeMdPresent,
        entityCount: cached ? Object.keys(cached.index.byEntity).length : null,
        indexCachedAt: cached?.builtAt ?? null,
      })
    } catch (err) {
      console.error('[api/obsidian/status] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  router.post('/config', async (req, res) => {
    try {
      const body = (req.body ?? {}) as Partial<ObsidianVaultConfig>
      const vaultPath = typeof body.vaultPath === 'string' ? body.vaultPath.trim() : ''
      const enabled = body.enabled === true
      const modeB = body.modeB === true
      const useClaudeMdContext = body.useClaudeMdContext === true

      // When enabling, the path must be an absolute, readable directory.
      // (Read-only: no write-probe — we never write into the vault.)
      if (enabled) {
        if (!vaultPath || !path.isAbsolute(vaultPath)) {
          return res.status(400).json({ error: 'vaultPath must be an absolute path.' })
        }
        if (!(await dirReadable(vaultPath))) {
          return res.status(400).json({ error: `Not a readable directory: ${vaultPath}` })
        }
      }
      const cfg: ObsidianVaultConfig = { enabled, vaultPath, modeB, useClaudeMdContext }
      await writeJson(obsidianConfigPath(), cfg)

      // Best-effort: warm the derived-index cache when enabling a valid vault.
      let entityCount: number | null = null
      if (enabled && vaultPath) {
        try {
          const built = await reindex(vaultPath)
          entityCount = Object.keys(built.index.byEntity).length
        } catch (err) {
          console.warn('[api/obsidian/config] reindex skipped:', (err as Error).message)
        }
      }
      res.json({ ok: true, ...cfg, entityCount })
    } catch (err) {
      console.error('[api/obsidian/config] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // --- Document conversion (SANCTIONED VAULT WRITE) -----------------------
  //
  // Grounding only reads .md. A vault seeded from Word/PDF campaign notes is
  // therefore invisible to it, which is the single most common reason a new
  // user sees no grounding benefit. These two routes let the setup wizard
  // offer "make .md copies of these", explicitly and with the file list shown.
  //
  // The write rules live in vaultConvert.ts: never overwrite, never touch the
  // original, containment-checked, atomic. The read-only invariant on the
  // grounding modules (readonly-guard.test.ts) is unaffected — that guard
  // covers vaultAdapter/vaultKb/vaultClaudeMd, none of which are used here.

  /** Read-only scan: which documents could be converted, and which already have
   *  a sibling .md (and so would be skipped). */
  router.get('/convertible', async (_req, res) => {
    try {
      const cfg = await readObsidianConfig()
      if (!cfg.vaultPath || !(await dirReadable(cfg.vaultPath))) {
        return res.status(400).json({ error: 'No readable vault configured.' })
      }
      res.json({ docs: await findConvertibleDocs(cfg.vaultPath) })
    } catch (err) {
      console.error('[api/obsidian/convertible] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  /** Convert the named documents. `paths` is required and must be explicit —
   *  there is deliberately no "convert everything you find" mode, so a bug in
   *  the client can never trigger a vault-wide write the user didn't see. */
  router.post('/convert', async (req, res) => {
    try {
      const cfg = await readObsidianConfig()
      if (!cfg.vaultPath || !(await dirReadable(cfg.vaultPath))) {
        return res.status(400).json({ error: 'No readable vault configured.' })
      }
      const raw = (req.body ?? {}) as { paths?: unknown }
      if (!Array.isArray(raw.paths) || raw.paths.some((p) => typeof p !== 'string')) {
        return res.status(400).json({ error: 'Body must be { paths: string[] }.' })
      }
      const paths = (raw.paths as string[]).map((p) => p.trim()).filter(Boolean)
      if (paths.length === 0) return res.status(400).json({ error: 'No paths supplied.' })

      const results = await convertDocsToMarkdown(cfg.vaultPath, paths)
      const converted = results.filter((r) => r.status === 'converted').length
      // Newly-readable notes only reach grounding after a reindex.
      if (converted > 0) {
        try {
          await reindex(cfg.vaultPath)
        } catch (err) {
          console.warn('[api/obsidian/convert] reindex skipped:', (err as Error).message)
        }
      }
      res.json({ results, converted })
    } catch (err) {
      console.error('[api/obsidian/convert] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  router.post('/reindex', async (_req, res) => {
    try {
      const cfg = await readObsidianConfig()
      if (!cfg.vaultPath || !(await dirReadable(cfg.vaultPath))) {
        return res.status(400).json({ error: 'No readable vault configured.' })
      }
      const built = await reindex(cfg.vaultPath)
      res.json({
        ok: true,
        builtAt: built.builtAt,
        entityCount: Object.keys(built.index.byEntity).length,
        byType: built.index.byType,
      })
    } catch (err) {
      console.error('[api/obsidian/reindex] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // Native OS folder dialog — pops on the local desktop, returns the chosen
  // absolute path. Headless/remote setups get reason:'unavailable' → the UI
  // falls back to the text field.
  router.post('/pick-folder', async (_req, res) => {
    try {
      const result = await pickFolder()
      res.json(result)
    } catch (err) {
      console.error('[api/obsidian/pick-folder] failed:', err)
      res.status(500).json({ ok: false, reason: 'error', detail: (err as Error).message })
    }
  })

  // Read-only readiness: recommended-plugin presence (from the vault's
  // .obsidian/community-plugins.json), entity-index + graphify status.
  router.get('/readiness', async (_req, res) => {
    try {
      const cfg = await readObsidianConfig()
      if (!cfg.vaultPath || !(await dirReadable(cfg.vaultPath))) {
        return res.status(400).json({ error: 'No readable vault configured.' })
      }
      const [readiness, graphify] = await Promise.all([
        readVaultReadiness(cfg.vaultPath),
        graphifyStatus(cfg.vaultPath),
      ])
      res.json({ ...readiness, graphify })
    } catch (err) {
      console.error('[api/obsidian/readiness] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // Explicit, opt-in graphify build. WRITES graphify-out/ INTO the vault
  // (the user's chosen behaviour) — the one vault write, never on the
  // grounding path.
  router.post('/graphify-build', async (_req, res) => {
    try {
      const cfg = await readObsidianConfig()
      if (!cfg.vaultPath || !(await dirReadable(cfg.vaultPath))) {
        return res.status(400).json({ error: 'No readable vault configured.' })
      }
      const status = await graphifyStatus(cfg.vaultPath)
      if (!status.cliAvailable) {
        return res
          .status(400)
          .json({ error: 'graphify CLI not found on PATH. Install it with `pip install graphifyy`.' })
      }
      const result = await runGraphifyBuild(cfg.vaultPath)
      res.status(result.ok ? 200 : 500).json(result)
    } catch (err) {
      console.error('[api/obsidian/graphify-build] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // Generate a CLAUDE.md vault-navigation guide and WRITE it into the vault
  // root. The second sanctioned vault write (alongside graphify-build): opt-in,
  // and only offered when BOTH the Obsidian and Claude Code add-ons are in use
  // — so a vault paired with Claude Code gets an AI-navigation map. Honours a
  // don't-clobber confirm: returns 409 if a CLAUDE.md already exists unless the
  // caller passes { overwrite: true }.
  router.post('/generate-claude-md', async (req, res) => {
    try {
      // Defense in depth on top of the client gate: only meaningful when the
      // user is actually using Claude Code. The client hides the button
      // otherwise; the server refuses the write to match.
      if (!isAddonLoaded('claude-code-addon')) {
        return res.status(400).json({
          error:
            'The Claude Code add-on is not enabled. Enable it (Settings → Add-ons) to generate a vault navigation guide for Claude Code.',
        })
      }
      const cfg = await readObsidianConfig()
      if (!cfg.vaultPath || !(await dirReadable(cfg.vaultPath))) {
        return res.status(400).json({ error: 'No readable vault configured.' })
      }
      const overwrite = (req.body ?? {})?.overwrite === true
      const existing = await readVaultClaudeMd(cfg.vaultPath)
      if (existing.present && !overwrite) {
        return res.status(409).json({
          error: 'A CLAUDE.md already exists in this vault. Confirm to replace it.',
          exists: true,
          existingPreview: existing.summary,
          modifiedAt: existing.modifiedAt,
        })
      }
      const content = await buildVaultClaudeMd(cfg.vaultPath)
      const result = await writeVaultClaudeMd(cfg.vaultPath, content)
      res.json({ ok: true, ...result, replaced: existing.present })
    } catch (err) {
      console.error('[api/obsidian/generate-claude-md] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  router.get('/preview', async (req, res) => {
    try {
      const cfg = await readObsidianConfig()
      if (!cfg.vaultPath || !(await dirReadable(cfg.vaultPath))) {
        return res.status(400).json({ error: 'No readable vault configured.' })
      }
      const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 200)
      const built = await buildObsidianAliasIndex(cfg.vaultPath)
      const entities = Object.values(built.index.byEntity)
        .slice(0, limit)
        .map((e) => ({ name: e.name, type: e.type, aliases: e.aliases }))
      res.json({
        source: built.source,
        total: Object.keys(built.index.byEntity).length,
        entities,
      })
    } catch (err) {
      console.error('[api/obsidian/preview] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  return router
}
