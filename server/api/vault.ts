// Pairing + push integration with the sister project Tusk's Vault
// (https://github.com/KochiTusker/tusks-vault).
//
// Detection strategy (first match wins):
//
//   1. Explicit override:        $TUSKS_VAULT_DIR
//   2. Sibling directory:        <repoRoot>/../tusks-vault
//                                <repoRoot>/../Tusks-Vault
//                                <repoRoot>/../tusks_vault
//
// We consider a directory "a Tusk's Vault install" if it has a Lore/
// subdirectory (Vault's documented drop-folder) AND a package.json whose
// `name` field matches `tusks-vault` (case-insensitive). The second
// check is cheap and makes "just any folder named tusks-vault" not
// trigger false positives.
//
// Once paired, the UI can call POST /api/vault/export-chronicle to push
// a saved chronicle's markdown into the Vault's Lore folder under a
// `Tomes/<campaign>/` sub-tree. Vault then surfaces the chronicle on
// its Knowledge tab and indexes it for retrieval.

import express, { type Router } from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promises as fs } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { sanitizeSegment } from '../lib/validators.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..')

const SIBLING_CANDIDATES = ['tusks-vault', 'Tusks-Vault', 'tusks_vault']

export type VaultPairStatus = {
  paired: boolean
  /** Absolute path to the Vault repo root, when paired. */
  vaultRoot?: string
  /** Absolute path to the Vault's Lore directory, when paired. */
  loreDir?: string
  /** True if we successfully wrote a probe file to loreDir. */
  loreDirWritable?: boolean
  /** How we found the Vault — useful for telling the user why a custom
   *  TUSKS_VAULT_DIR was preferred over the sibling lookup. */
  source: 'env' | 'sibling' | 'none'
  /** Path we tried but rejected, with the reason. Only populated when
   *  paired === false and we want to give the user a useful hint. */
  notes?: string[]
}

async function isVaultInstall(dir: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dir)
    if (!stat.isDirectory()) return false
  } catch {
    return false
  }
  // Lore/ is the documented drop folder per Vault's README.
  try {
    const loreStat = await fs.stat(path.join(dir, 'Lore'))
    if (!loreStat.isDirectory()) return false
  } catch {
    // Vault might be freshly cloned and Lore/ not yet created. Treat
    // the package.json name match as sufficient evidence below — we'll
    // create Lore/ on first export.
  }
  try {
    const pkgRaw = await fs.readFile(path.join(dir, 'package.json'), 'utf8')
    const pkg = JSON.parse(pkgRaw) as { name?: unknown }
    if (typeof pkg.name === 'string' && pkg.name.toLowerCase() === 'tusks-vault') {
      return true
    }
  } catch {
    // No package.json or unreadable — not a Vault install.
  }
  return false
}

async function ensureWritable(dir: string): Promise<boolean> {
  await fs.mkdir(dir, { recursive: true }).catch(() => undefined)
  const probe = path.join(dir, `.tusks-tomes-probe-${randomBytes(4).toString('hex')}`)
  try {
    await fs.writeFile(probe, 'ok', 'utf8')
    await fs.unlink(probe).catch(() => undefined)
    return true
  } catch {
    return false
  }
}

export async function detectVault(): Promise<VaultPairStatus> {
  const notes: string[] = []

  // 1. Env-var override.
  const envDir = process.env.TUSKS_VAULT_DIR?.trim()
  if (envDir) {
    const abs = path.isAbsolute(envDir) ? envDir : path.resolve(REPO_ROOT, envDir)
    if (await isVaultInstall(abs)) {
      const loreDir = path.join(abs, 'Lore')
      const writable = await ensureWritable(loreDir)
      return {
        paired: true,
        vaultRoot: abs,
        loreDir,
        loreDirWritable: writable,
        source: 'env',
      }
    }
    notes.push(`TUSKS_VAULT_DIR points at "${abs}" but that directory isn't a recognised Tusk's Vault install (need a Lore/ folder + package.json with name "tusks-vault").`)
  }

  // 2. Sibling lookup. <repoRoot>/../tusks-vault and case/separator variants.
  const parent = path.dirname(REPO_ROOT)
  for (const name of SIBLING_CANDIDATES) {
    const candidate = path.join(parent, name)
    if (await isVaultInstall(candidate)) {
      const loreDir = path.join(candidate, 'Lore')
      const writable = await ensureWritable(loreDir)
      return {
        paired: true,
        vaultRoot: candidate,
        loreDir,
        loreDirWritable: writable,
        source: 'sibling',
      }
    }
  }

  notes.push(
    `No Tusk's Vault install detected as a sibling of ${REPO_ROOT}. ` +
      `Looked for ${SIBLING_CANDIDATES.map((n) => `"${n}"`).join(', ')}. ` +
      `Set TUSKS_VAULT_DIR in .env to point at your Vault checkout if it lives somewhere else.`
  )
  return { paired: false, source: 'none', notes }
}

// sanitizeSegment is imported below — keeps chronicle/lore/vault on
// the same shared implementation including the Windows reserved-name
// guard.

async function writeAtomic(absPath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(absPath), { recursive: true })
  const tmp = `${absPath}.${randomBytes(6).toString('hex')}.tmp`
  await fs.writeFile(tmp, content, 'utf8')
  await fs.rename(tmp, absPath)
}

/**
 * Copy a chronicle markdown into the paired Vault's Lore tree at:
 *
 *   <vaultRoot>/Lore/Tomes/<campaign>/<filename>.md
 *
 * The `Tomes/` prefix keeps Tomes-generated chronicles grouped under
 * one namespace inside the user's wider Lore corpus so they don't
 * collide with hand-written lore documents.
 */
export async function exportChronicleToVault(args: {
  campaign: string
  sessionNumber: number
  /** Pre-built markdown body from ChronicleView.buildMarkdown. */
  content: string
  /** Optional override for the file name. Defaults to the same
   *  template chronicle.ts already uses. */
  fileName?: string
}): Promise<{ written: string; relativeToVault: string }> {
  const status = await detectVault()
  if (!status.paired || !status.loreDir) {
    throw new Error('Tusk\'s Vault not detected. Install it as a sibling directory of this repo, or set TUSKS_VAULT_DIR.')
  }
  const safeCampaign = sanitizeSegment(args.campaign)
  if (!safeCampaign) {
    throw new Error('Campaign name is required to export a chronicle.')
  }
  const sn = Math.floor(args.sessionNumber)
  if (!Number.isFinite(sn) || sn <= 0) {
    throw new Error('Session number must be a positive integer.')
  }
  const defaultFileName = `Tusk's Tomes - ${safeCampaign} - Session ${sn}.md`
  const fileName = sanitizeSegment(args.fileName ?? defaultFileName) || defaultFileName
  const targetDir = path.join(status.loreDir, 'Tomes', safeCampaign)
  const absPath = path.join(targetDir, fileName)
  // v1.1.0 defence-in-depth — sanitizeSegment already strips path
  // separators + control chars + Windows reserved names, but the
  // belt-and-braces check is to resolve both paths and confirm absPath
  // is genuinely a descendant of <loreDir>/Tomes/. Catches a hypothetical
  // future sanitiser regression OR a layered-encoding edge case the
  // character-strip didn't anticipate. Throws before any disk write.
  const safeRoot = path.resolve(status.loreDir, 'Tomes')
  const resolvedTarget = path.resolve(absPath)
  if (resolvedTarget !== safeRoot && !resolvedTarget.startsWith(safeRoot + path.sep)) {
    throw new Error(
      `Refusing to write outside the Tomes vault tree (resolved="${resolvedTarget}", root="${safeRoot}"). This is a defence-in-depth check; the inputs were already sanitised.`,
    )
  }
  await writeAtomic(absPath, args.content)
  const relativeToVault = path
    .relative(status.vaultRoot!, absPath)
    .split(path.sep)
    .join('/')
  return { written: absPath, relativeToVault }
}

export function vaultRouter(): Router {
  const router = express.Router()

  router.get('/pair', async (_req, res) => {
    try {
      const status = await detectVault()
      res.json(status)
    } catch (err) {
      console.error('[api/vault/pair] failed:', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  router.post('/export-chronicle', async (req, res) => {
    try {
      const { campaign, sessionNumber, content, fileName } = req.body as {
        campaign?: string
        sessionNumber?: number
        content?: string
        fileName?: string
      }
      if (typeof campaign !== 'string' || !campaign.trim()) {
        return res.status(400).json({ error: 'campaign is required' })
      }
      if (typeof sessionNumber !== 'number' || !Number.isFinite(sessionNumber)) {
        return res.status(400).json({ error: 'sessionNumber must be a number' })
      }
      if (typeof content !== 'string' || !content.trim()) {
        return res.status(400).json({ error: 'content is required' })
      }
      const result = await exportChronicleToVault({
        campaign,
        sessionNumber,
        content,
        fileName,
      })
      res.json({ ok: true, ...result })
    } catch (err) {
      console.error('[api/vault/export-chronicle] failed:', err)
      const status = /not detected/i.test((err as Error).message) ? 404 : 500
      res.status(status).json({ error: (err as Error).message })
    }
  })

  return router
}
