// Detection + creation for the shared `Tusks-Lore/` sibling folder.
//
// The folder is intended to be a single source of truth that both
// Tusk's Tomes and Tusk's Vault can read from. Mirrors the auto-pair
// pattern already used for Vault (server/api/vault.ts).
//
// Detection order (first match wins):
//   1. Explicit override: $TUSKS_LORE_DIR
//   2. Sibling lookup: <repoRoot>/../Tusks-Lore (+ case/separator variants)
//
// A directory counts as a Tusks-Lore install if it contains a
// `tusks-lore.json` marker file with shape { "version": 1, ... }. The
// marker is what `POST /api/lore/create` writes when the user clicks
// "Create Tusk's Lore" — it stops random directories named "Tusks-Lore"
// from triggering false positives.

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promises as fs } from 'node:fs'
import { randomBytes } from 'node:crypto'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..')

const SIBLING_CANDIDATES = ['Tusks-Lore', 'tusks-lore', 'tusks_lore']

export const LORE_MARKER_FILENAME = 'tusks-lore.json'
export const LORE_MARKER_VERSION = 1

export type LoreMarker = {
  version: number
  /** ISO timestamp when the marker was written. */
  createdAt: string
  /** Optional human-readable note for the user's own reference. */
  notes?: string
}

export type LoreStatus = {
  /** True iff we found a folder with a valid marker file. */
  found: boolean
  /** Absolute path to the lore root, when found. */
  loreRoot?: string
  /** Absolute path to <loreRoot>/Sessions, when found. */
  sessionsDir?: string
  /** Number of .docx files currently in Sessions/ (recursive). */
  sessionsCount?: number
  /** True iff we successfully wrote a probe file under the folder. */
  writable?: boolean
  /** How we found the folder. */
  source: 'env' | 'sibling' | 'none'
  /** Diagnostics for the UI when found === false. */
  notes?: string[]
}

async function readMarker(dir: string): Promise<LoreMarker | null> {
  try {
    const raw = await fs.readFile(path.join(dir, LORE_MARKER_FILENAME), 'utf8')
    const parsed = JSON.parse(raw) as Partial<LoreMarker>
    if (typeof parsed.version !== 'number') return null
    return {
      version: parsed.version,
      createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : '',
      notes: typeof parsed.notes === 'string' ? parsed.notes : undefined,
    }
  } catch {
    return null
  }
}

async function isLoreInstall(dir: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dir)
    if (!stat.isDirectory()) return false
  } catch {
    return false
  }
  return (await readMarker(dir)) !== null
}

async function countDocxFiles(dir: string): Promise<number> {
  let count = 0
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      count += await countDocxFiles(abs)
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.docx')) {
      count += 1
    }
  }
  return count
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

async function statusFor(loreRoot: string, source: LoreStatus['source']): Promise<LoreStatus> {
  const sessionsDir = path.join(loreRoot, 'Sessions')
  const writable = await ensureWritable(sessionsDir)
  const sessionsCount = await countDocxFiles(sessionsDir)
  return {
    found: true,
    loreRoot,
    sessionsDir,
    sessionsCount,
    writable,
    source,
  }
}

/** Resolve the lore folder. The optional `repoRoot` lets tests anchor the
 *  sibling lookup at an isolated temp tree; production callers omit it and
 *  get the module-level REPO_ROOT, which resolves to the worktree root. */
export async function detectLore(opts?: { repoRoot?: string }): Promise<LoreStatus> {
  const root = opts?.repoRoot ?? REPO_ROOT
  const notes: string[] = []

  // 1. Env-var override.
  const envDir = process.env.TUSKS_LORE_DIR?.trim()
  if (envDir) {
    const abs = path.isAbsolute(envDir) ? envDir : path.resolve(root, envDir)
    if (await isLoreInstall(abs)) {
      return statusFor(abs, 'env')
    }
    notes.push(
      `TUSKS_LORE_DIR points at "${abs}" but no ${LORE_MARKER_FILENAME} marker was found there. ` +
        `Either create one (via the "Create Tusk's Lore" button) or fix the path.`,
    )
  }

  // 2. Sibling lookup.
  const parent = path.dirname(root)
  for (const name of SIBLING_CANDIDATES) {
    const candidate = path.join(parent, name)
    if (await isLoreInstall(candidate)) {
      return statusFor(candidate, 'sibling')
    }
  }

  notes.push(
    `No Tusk's Lore folder detected as a sibling of ${root}. ` +
      `Looked for ${SIBLING_CANDIDATES.map((n) => `"${n}"`).join(', ')}. ` +
      `Click "Create Tusk's Lore" to set one up, or set TUSKS_LORE_DIR in .env if your folder lives elsewhere.`,
  )
  return { found: false, source: 'none', notes }
}

/** Where to create the folder when the user clicks "Create Tusk's Lore".
 *  Honours `TUSKS_LORE_DIR` (matching the discovery behaviour in
 *  `detectLore()`) so tests can redirect creation into a temp directory
 *  instead of the real sibling path. Production callers leave the env
 *  var unset and get the sibling default. */
export function defaultLorePath(): string {
  const envDir = process.env.TUSKS_LORE_DIR?.trim()
  if (envDir) {
    return path.isAbsolute(envDir) ? envDir : path.resolve(REPO_ROOT, envDir)
  }
  return path.join(path.dirname(REPO_ROOT), 'Tusks-Lore')
}

/** Create the sibling Tusks-Lore folder + marker + Sessions subdir. */
export async function createLoreFolder(): Promise<LoreStatus> {
  const target = defaultLorePath()
  await fs.mkdir(path.join(target, 'Sessions'), { recursive: true })
  const markerPath = path.join(target, LORE_MARKER_FILENAME)
  // Don't overwrite an existing marker — preserve whatever the user
  // already had (notes, createdAt). Idempotent: clicking Create again
  // just confirms the folder is there.
  try {
    await fs.access(markerPath)
  } catch {
    const marker: LoreMarker = {
      version: LORE_MARKER_VERSION,
      createdAt: new Date().toISOString(),
      notes:
        'Tusk\'s Lore — shared lore base for Tusk\'s Tomes (session .docx outputs) and Tusk\'s Vault (lore/chronicle indexing). Safe to commit to a private repo.',
    }
    await fs.writeFile(markerPath, JSON.stringify(marker, null, 2), 'utf8')
  }
  return statusFor(target, 'sibling')
}
