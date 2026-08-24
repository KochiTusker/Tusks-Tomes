// API surface for the shared Tusks-Lore sibling folder.
//
//   GET    /api/lore/status         — auto-detect + sessions count
//   POST   /api/lore/create         — create the sibling folder + marker
//   POST   /api/lore/save-chronicle — render a chronicle as .docx and
//                                     drop it under Tusks-Lore/Sessions/
//   GET    /api/lore/documents      — list + parse all .md/.txt/.pdf/.docx
//                                     under the lore root (incl. Sessions/),
//                                     used as the KB source for grounding
//   POST   /api/lore/documents      — multipart upload OR JSON migration,
//                                     writes the file under <loreRoot>/
//   DELETE /api/lore/documents      — delete a file by relPath (within root)

import express, { type Router } from 'express'
import multer from 'multer'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { randomBytes } from 'node:crypto'
import {
  createLoreFolder,
  defaultLorePath,
  detectLore,
  LORE_MARKER_FILENAME,
  type LoreStatus,
} from '../lore/detection.js'
import {
  renderChronicleDocx,
  type ChronicleDocxArgs,
} from '../lore/docxRenderer.js'
import {
  SUPPORTED_DOC_EXTS,
  invalidateDocCache,
  listLoreDocuments,
  normalizeMigrationName,
  safeResolveInside,
  walkFiles,
} from '../lore/documents.js'
import { docxBufferToMarkdown } from '../lore/docxToMarkdown.js'
import { sanitizeSegment } from '../lib/validators.js'
import { autoApplyFrontmatter } from '../lore/entityExtraction.js'
import {
  forceRebuild,
  getCachedAliasIndex,
  getCurrentLoreRoot,
} from '../lore/aliasIndexManager.js'
import { resolveObsidianSource } from '../lore/source/resolver.js'
import { buildObsidianAliasIndex } from '../lore/obsidian/vaultAdapter.js'
import { listObsidianDocuments } from '../lore/obsidian/vaultKb.js'
import { readVaultClaudeMd } from '../lore/obsidian/vaultClaudeMd.js'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

async function writeBufferAtomic(absPath: string, buf: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(absPath), { recursive: true })
  const tmp = `${absPath}.${randomBytes(6).toString('hex')}.tmp`
  await fs.writeFile(tmp, buf)
  await fs.rename(tmp, absPath)
}

async function fileExists(absPath: string): Promise<boolean> {
  try {
    await fs.stat(absPath)
    return true
  } catch {
    return false
  }
}

type DetectedLore = LoreStatus & { loreRoot: string }

/** Detect the lore folder for a write/delete route; send a 404 and return
 *  null if it's missing. GET /documents skips this — it answers 200 with
 *  `found: false` so the UI can surface the detection notes. The returned
 *  status is narrowed to guarantee `loreRoot` is defined for callers. */
async function requireLoreStatus(res: express.Response): Promise<DetectedLore | null> {
  const status = await detectLore()
  if (!status.found || !status.loreRoot) {
    res.status(404).json({
      error:
        'Tusk\'s Lore folder not detected. Create one from Settings or set TUSKS_LORE_DIR in .env.',
    })
    return null
  }
  return status as DetectedLore
}

const docUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
})

export function loreRouter(): Router {
  const router = express.Router()

  // Detection status + diagnostics. The UI polls this on Settings load
  // and after Create, so it always reflects the current folder state.
  router.get('/status', async (_req, res) => {
    try {
      const status = await detectLore()
      // Surface the would-be default path so the UI can preview where
      // "Create Tusk's Lore" will put the folder.
      res.json({ ...status, defaultPath: defaultLorePath() })
    } catch (err) {
      console.error('[api/lore/status] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // Create the sibling folder + marker + Sessions/. Idempotent — if the
  // folder already exists with a valid marker, this returns the same
  // status detectLore() would.
  router.post('/create', async (_req, res) => {
    try {
      const status = await createLoreFolder()
      res.json({ ok: true, ...status })
    } catch (err) {
      console.error('[api/lore/create] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // Render + save a chronicle .docx into <loreRoot>/Sessions/<campaign>/.
  router.post('/save-chronicle', async (req, res) => {
    try {
      const body = req.body as Partial<ChronicleDocxArgs> & { campaign?: string }
      const campaign = sanitizeSegment(body.campaign ?? '')
      if (!campaign) {
        return res.status(400).json({ error: 'campaign is required' })
      }
      const sessionNumber = Math.floor(Number(body.sessionNumber))
      if (!Number.isFinite(sessionNumber) || sessionNumber <= 0) {
        return res.status(400).json({ error: 'sessionNumber must be a positive integer' })
      }
      if (typeof body.chronicle !== 'string') {
        return res.status(400).json({ error: 'chronicle is required (string)' })
      }
      const mode: 'full' | 'condensed' = body.mode === 'condensed' ? 'condensed' : 'full'

      const status = await requireLoreStatus(res)
      if (!status?.sessionsDir) return

      const buf = await renderChronicleDocx({
        campaign: body.campaign ?? '',
        sessionNumber,
        chronicle: body.chronicle,
        extras: body.extras ?? null,
        condensed: body.condensed ?? null,
        mode,
      })

      const dateStr = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
      const sn = sessionNumber.toString().padStart(2, '0')
      const fileName = `Session-${sn}-${dateStr}-${mode}.docx`
      const targetDir = path.join(status.sessionsDir, campaign)
      const absPath = path.join(targetDir, fileName)
      await writeBufferAtomic(absPath, buf)

      const relative = path
        .relative(status.loreRoot!, absPath)
        .split(path.sep)
        .join('/')
      res.json({ ok: true, written: absPath, relativeToLore: relative, mode })
    } catch (err) {
      console.error('[api/lore/save-chronicle] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // List + parse every supported document under the lore root. The client's
  // useLoreDocuments hook calls this on app start (auto-load) and when the
  // user presses "Refresh from Tusks-Lore". Parse output is mtime-cached so
  // repeated refreshes are cheap unless files actually changed on disk.
  router.get('/documents', async (_req, res) => {
    try {
      // Read-only Obsidian vault override (bake-off / add-on path).
      const obsidian = await resolveObsidianSource()
      if (obsidian) {
        const documents = await listObsidianDocuments(obsidian.vaultPath, { modeB: obsidian.modeB })
        // Opt-in (default OFF): prepend the vault's CLAUDE.md as a bounded
        // navigation-guide context block so grounding/chronicle phases have the
        // vault's own description of its lore. CLAUDE.md is excluded from the
        // note walk, so this is the only way it reaches grounding — by explicit
        // choice. Bounded by readVaultClaudeMd (≤40 lines / 4 KB).
        if (obsidian.useClaudeMdContext) {
          const guide = await readVaultClaudeMd(obsidian.vaultPath)
          if (guide.present && guide.summary) {
            documents.unshift({
              id: '__vault-claude-md__',
              name: 'Vault Guide (CLAUDE.md)',
              relPath: 'CLAUDE.md',
              type: 'md',
              text: guide.summary,
              sizeBytes: Buffer.byteLength(guide.summary, 'utf8'),
              modifiedAt: guide.modifiedAt ?? new Date().toISOString(),
            })
          }
        }
        return res.json({
          found: true,
          loreRoot: obsidian.vaultPath,
          documents,
          source: 'obsidian-vault',
        })
      }
      const status = await detectLore()
      if (!status.found || !status.loreRoot) {
        return res.json({
          found: false,
          documents: [],
          notes: status.notes ?? [],
        })
      }
      const documents = await listLoreDocuments(status.loreRoot)
      res.json({ found: true, loreRoot: status.loreRoot, documents })
    } catch (err) {
      console.error('[api/lore/documents GET] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // Two upload shapes share this endpoint:
  //   - multipart/form-data with a "file" field → drag-and-drop in the UI
  //   - application/json with { name, text } → migration of localStorage
  //     KB docs (already extracted, write as .txt)
  router.post(
    '/documents',
    docUpload.single('file'),
    async (req, res) => {
      try {
        const status = await requireLoreStatus(res)
        if (!status) return

        let buffer: Buffer
        let name: string
        if (req.file) {
          buffer = req.file.buffer
          name = req.file.originalname
        } else if (req.body && typeof req.body.text === 'string' && typeof req.body.name === 'string') {
          // Migration path: text was already extracted from the original
          // file by the old localStorage KB. normalizeMigrationName forces
          // a .txt extension regardless of the original — see commit
          // 3b45cf8 / documents.test.ts for the regression case.
          buffer = Buffer.from(req.body.text, 'utf8')
          name = normalizeMigrationName(req.body.name)
        } else {
          return res.status(400).json({ error: 'Provide either a multipart "file" or JSON { name, text }.' })
        }

        const safeName = sanitizeSegment(name)
        if (!safeName) {
          return res.status(400).json({ error: 'File name resolved to empty after sanitization.' })
        }
        const ext = path.extname(safeName).toLowerCase()
        if (!SUPPORTED_DOC_EXTS.has(ext)) {
          return res.status(415).json({ error: `Unsupported file type: ${ext || '(none)'}` })
        }

        const absPath = path.join(status.loreRoot, safeName)
        const overwrite = String(req.query.overwrite ?? '') === '1'
        if (!overwrite && (await fileExists(absPath))) {
          return res.status(409).json({ error: `"${safeName}" already exists. Pass ?overwrite=1 to replace.` })
        }
        await writeBufferAtomic(absPath, buffer)
        invalidateDocCache(absPath)
        res.json({ ok: true, name: safeName, sizeBytes: buffer.length })
      } catch (err) {
        console.error('[api/lore/documents POST] failed:', err)
        res.status(500).json({ error: (err as Error).message })
      }
    },
  )

  // ─── Bulk .docx → .md conversion ─────────────────────────────────────────
  //
  // POST /api/lore/convert-docx
  //
  // Walks the lore root, finds every .docx that doesn't already have a
  // sibling .md, and writes a converted .md beside it. Excludes the
  // Sessions/ subdirectory — those are the app's own chronicle exports,
  // not user lore, and round-tripping them through markdown would lose
  // formatting in a way users don't expect.
  //
  // Never deletes anything. Re-running is safe: any .docx that already
  // has a sibling .md (whether from a previous convert run or hand-written
  // by the user) is skipped, so existing .md files are never overwritten.
  //
  // Returns a per-file report so the UI can show which files were
  // converted, skipped, or failed.
  router.post('/convert-docx', async (_req, res) => {
    try {
      const status = await requireLoreStatus(res)
      if (!status) return

      type Outcome =
        | {
            relPath: string
            status: 'converted'
            mdRelPath: string
            sizeBytes: number
            entitiesAutoIndexed?: number
            headingsPromoted?: boolean
          }
        | { relPath: string; status: 'skipped_existing_md'; mdRelPath: string }
        | { relPath: string; status: 'error'; error: string }
      const report: Outcome[] = []

      for await (const { absPath, relPath } of walkFiles(status.loreRoot, status.loreRoot)) {
        if (path.extname(absPath).toLowerCase() !== '.docx') continue
        // Exclude Sessions/ — those are the app's own .docx chronicle
        // exports. Converting them would lose docx-specific formatting
        // (headers, page breaks) and the user didn't ask for that.
        if (relPath.startsWith('Sessions/')) continue

        const mdAbs = absPath.replace(/\.docx$/i, '.md')
        const mdRelPath = relPath.replace(/\.docx$/i, '.md')
        if (await fileExists(mdAbs)) {
          report.push({ relPath, status: 'skipped_existing_md', mdRelPath })
          continue
        }
        try {
          const buf = await fs.readFile(absPath)
          const md = await docxBufferToMarkdown(buf)
          // Auto-apply YAML frontmatter so the converted .md is indexed
          // immediately. The user-facing requirement is "no web form" — this
          // is the path that delivers it: drop a .docx, get an indexed .md
          // back with no manual step. Frontmatter is stripped from the
          // AI-bound KB (see buildKbConcat in src/lib/pipeline.ts) so the
          // cost stays neutral vs the old direct-docx-to-prose flow.
          const augmented = autoApplyFrontmatter(md, path.basename(mdAbs))
          const body = Buffer.from(augmented.markdown, 'utf8')
          await writeBufferAtomic(mdAbs, body)
          invalidateDocCache(mdAbs)
          // The .docx itself isn't touched and still parses on next run.
          // The user opts into removal via /remove-docx below.
          report.push({
            relPath,
            status: 'converted',
            mdRelPath,
            sizeBytes: body.length,
            entitiesAutoIndexed: augmented.result.entities.length,
            headingsPromoted: augmented.result.promotedHeadings,
          })
        } catch (err) {
          report.push({ relPath, status: 'error', error: (err as Error).message })
        }
      }
      // Force a rebuild of the alias index after any conversions so the
      // /api/lore/index endpoint reflects the new entities immediately.
      if (report.some((r) => r.status === 'converted')) {
        try {
          await forceRebuild()
        } catch (err) {
          console.warn('[api/lore/convert-docx] post-convert index rebuild failed:', err)
        }
      }
      res.json({ ok: true, loreRoot: status.loreRoot, report })
    } catch (err) {
      console.error('[api/lore/convert-docx POST] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // ─── Opt-in removal of converted .docx originals ─────────────────────────
  //
  // POST /api/lore/remove-docx
  //   body: { relPaths: string[] }   // .docx files the user explicitly OK'd
  //
  // Safety rules (all enforced server-side; the UI hint is informational):
  //   1. Path must resolve inside the lore root (no traversal).
  //   2. File extension must be exactly `.docx` (case-insensitive).
  //   3. A sibling `.md` file with the same base name MUST exist. This is
  //      the load-bearing safety check: it guarantees the .docx's content
  //      is preserved as markdown somewhere on disk before we delete it.
  //   4. The file in Sessions/ subdirectory is rejected — same reasoning
  //      as convert-docx, those are chronicle exports not user lore.
  //   5. Uses fs.unlink on individual files. NEVER fs.rm({recursive,force}).
  //      The audit guard in scripts/audit-dangerous-fs-rm.test.mjs would
  //      catch a regression that introduced rm here.
  //
  // Returns a per-file report so the user sees exactly what was removed.
  router.post('/remove-docx', async (req, res) => {
    try {
      const status = await requireLoreStatus(res)
      if (!status) return

      const body = req.body as { relPaths?: unknown }
      if (!Array.isArray(body.relPaths)) {
        return res.status(400).json({ error: 'relPaths must be an array.' })
      }
      const inputs = body.relPaths.filter((p): p is string => typeof p === 'string')
      if (inputs.length === 0) {
        return res.status(400).json({ error: 'relPaths is empty.' })
      }

      type Outcome =
        | { relPath: string; status: 'removed' }
        | { relPath: string; status: 'skipped'; reason: string }
      const report: Outcome[] = []

      for (const relPath of inputs) {
        const abs = safeResolveInside(status.loreRoot, relPath)
        if (!abs) {
          report.push({ relPath, status: 'skipped', reason: 'path escapes lore root' })
          continue
        }
        if (path.extname(abs).toLowerCase() !== '.docx') {
          report.push({ relPath, status: 'skipped', reason: 'not a .docx file' })
          continue
        }
        const normalised = relPath.split(path.sep).join('/')
        if (normalised.startsWith('Sessions/')) {
          report.push({
            relPath,
            status: 'skipped',
            reason: 'Sessions/ chronicle exports are protected',
          })
          continue
        }
        const mdAbs = abs.replace(/\.docx$/i, '.md')
        if (!(await fileExists(mdAbs))) {
          report.push({
            relPath,
            status: 'skipped',
            reason: 'no sibling .md found; refusing to delete without a markdown copy',
          })
          continue
        }
        try {
          await fs.unlink(abs)
          invalidateDocCache(abs)
          report.push({ relPath, status: 'removed' })
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code
          if (code === 'ENOENT') {
            report.push({ relPath, status: 'skipped', reason: 'file already gone' })
          } else {
            report.push({ relPath, status: 'skipped', reason: (err as Error).message })
          }
        }
      }
      res.json({ ok: true, report })
    } catch (err) {
      console.error('[api/lore/remove-docx POST] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  router.delete('/documents', async (req, res) => {
    try {
      const status = await requireLoreStatus(res)
      if (!status) return
      const relPath = typeof req.query.relPath === 'string' ? req.query.relPath : ''
      if (!relPath) {
        return res.status(400).json({ error: 'relPath query param is required.' })
      }
      const abs = safeResolveInside(status.loreRoot, relPath)
      if (!abs) {
        return res.status(400).json({ error: 'relPath escapes the lore root.' })
      }
      if (path.basename(abs) === LORE_MARKER_FILENAME) {
        return res.status(400).json({ error: 'The lore marker file cannot be deleted via this endpoint.' })
      }
      await fs.unlink(abs)
      invalidateDocCache(abs)
      res.json({ ok: true })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        return res.status(404).json({ error: 'File not found.' })
      }
      console.error('[api/lore/documents DELETE] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // GET /api/lore/template — serves the canonical lore-doc template. Users
  // download this from the Tome of Lore UI, fill in their entities, and drop
  // the result into the lore folder. Self-documenting markdown — every
  // optional field is annotated with a comment that the YAML parser ignores.
  // Resolves the source template from the repo root (matches the docs router
  // pattern: works in both dev and the dist-server production build because
  // both server/ and dist-server/ sit one level below the repo root).
  router.get('/template', async (_req, res) => {
    try {
      const repoRoot = path.resolve(__dirname, '..', '..')
      const templatePath = path.join(repoRoot, 'server', 'lore', 'loreTemplate.md')
      const content = await fs.readFile(templatePath, 'utf8')
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
      res.setHeader('Content-Disposition', 'attachment; filename="lore-template.md"')
      res.send(content)
    } catch (err) {
      console.error('[api/lore/template] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // GET /api/lore/index — the cached alias-index snapshot. Returns 200 with
  // a small `{ status: 'no-lore' }` body when the lore root isn't detected
  // so the client doesn't have to special-case a 404.
  router.get('/index', async (_req, res) => {
    // Read-only Obsidian vault override — build the index fresh from the vault
    // (cached layer is a follow-up; the vault is never written to).
    const obsidian = await resolveObsidianSource()
    if (obsidian) {
      try {
        const built = await buildObsidianAliasIndex(obsidian.vaultPath)
        return res.json({
          status: 'ok',
          loreRoot: obsidian.vaultPath,
          index: built.index,
          source: 'obsidian-vault',
        })
      } catch (err) {
        console.error('[api/lore/index obsidian] failed:', err)
        return res.status(500).json({ error: (err as Error).message })
      }
    }
    const loreRoot = getCurrentLoreRoot()
    if (!loreRoot) {
      return res.json({ status: 'no-lore', index: null })
    }
    const index = getCachedAliasIndex()
    res.json({ status: 'ok', loreRoot, index })
  })

  // POST /api/lore/index/rebuild — force a fresh build of the alias index.
  // The UI calls this after the user applies the migration so the snapshot
  // reflects the new frontmatter immediately.
  router.post('/index/rebuild', async (_req, res) => {
    try {
      const index = await forceRebuild()
      res.json({ ok: true, index })
    } catch (err) {
      console.error('[api/lore/index/rebuild] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // GET /api/lore/migration/preview — dry-run the extract-aliases helper
  // and surface the proposed frontmatter per file. NEVER writes. The client
  // shows this as a diff in the "Lore Migration" card.
  router.get('/migration/preview', async (_req, res) => {
    const status = await requireLoreStatus(res)
    if (!status) return
    try {
      const report = await runExtractAliases(status.loreRoot, false)
      res.json({ ok: true, report })
    } catch (err) {
      console.error('[api/lore/migration/preview] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // POST /api/lore/migration/apply — write the frontmatter in place.
  // Each modified file gets a .bak sibling so the UI can offer per-file
  // revert. Triggers an alias-index rebuild on success.
  router.post('/migration/apply', async (_req, res) => {
    const status = await requireLoreStatus(res)
    if (!status) return
    try {
      const report = await runExtractAliases(status.loreRoot, true)
      await forceRebuild()
      res.json({ ok: true, report })
    } catch (err) {
      console.error('[api/lore/migration/apply] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // POST /api/lore/migration/revert — restore <file>.bak → <file>.
  // Body: { relPath: "Characters.md" }. The .bak file is removed after a
  // successful restore.
  router.post('/migration/revert', express.json(), async (req, res) => {
    const status = await requireLoreStatus(res)
    if (!status) return
    const relPath = typeof req.body?.relPath === 'string' ? req.body.relPath : ''
    if (!relPath) return res.status(400).json({ error: 'relPath required' })
    const abs = safeResolveInside(status.loreRoot, relPath)
    if (!abs) return res.status(400).json({ error: 'relPath escapes the lore root' })
    const backup = `${abs}.bak`
    try {
      await fs.access(backup)
    } catch {
      return res.status(404).json({ error: 'No backup found for this file' })
    }
    try {
      const original = await fs.readFile(backup, 'utf8')
      await fs.writeFile(abs, original, 'utf8')
      await fs.unlink(backup).catch(() => {})
      invalidateDocCache(abs)
      await forceRebuild()
      res.json({ ok: true, relPath })
    } catch (err) {
      console.error('[api/lore/migration/revert] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  return router
}

/** Invoke the extract-aliases.mjs script as a subprocess and return the
 *  parsed migration report. Spawning keeps the script's edit logic in one
 *  place (it's also useful as a CLI) instead of duplicating it in the
 *  router. The subprocess is short-lived and stays within the lore root. */
async function runExtractAliases(
  loreRoot: string,
  apply: boolean,
): Promise<unknown> {
  // server/api/lore.ts is one of `server/api/` or `dist-server/api/` at
  // runtime. The script lives at <repoRoot>/scripts/lore/extract-aliases.mjs.
  // Walk up to the repo root regardless.
  const repoRoot = path.resolve(__dirname, '..', '..')
  const scriptPath = path.join(repoRoot, 'scripts', 'lore', 'extract-aliases.mjs')
  const args = [scriptPath, loreRoot]
  if (apply) args.push('--apply')
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderrBuf = ''
    child.stderr.on('data', (b) => {
      stderrBuf += b.toString('utf8')
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`extract-aliases exited ${code}: ${stderrBuf}`))
    })
  })
  const reportPath = path.join(loreRoot, '.tusks-lore-migration.json')
  const raw = await fs.readFile(reportPath, 'utf8')
  return JSON.parse(raw)
}
