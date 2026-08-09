// Cross-platform app-data directory helpers + atomic JSON IO.
//
// The roadmap (ROADMAP.md, "App data directory") binds persistent state to
// platform-appropriate locations rather than scattering files next to the
// repo. Every disk-backed resource introduced from Step 1 onwards routes
// through this module so the path conventions stay consistent.

import envPaths from 'env-paths'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { assertValidRunId } from './lib/validators.js'

// The app was renamed from "Silence Beyond the Sea" to "Tusk's Tomes". The
// env-paths key matches the new name; `migrateLegacyAppData()` moves any
// pre-rename config/data/cache into the new locations on first boot.
const paths = envPaths('tusks-tomes', { suffix: '' })
const legacyPaths = envPaths('silence-beyond-the-sea', { suffix: '' })

export function configDir(): string {
  return paths.config
}

export function dataDir(): string {
  return paths.data
}

export function cacheDir(): string {
  return paths.cache
}

export async function ensureDir(absPath: string): Promise<void> {
  await fs.mkdir(absPath, { recursive: true })
}

export async function readJson<T>(absPath: string, defaultValue: T): Promise<T> {
  try {
    const buf = await fs.readFile(absPath, 'utf8')
    return JSON.parse(buf) as T
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return defaultValue
    throw err
  }
}

/**
 * Write JSON atomically: write to a sibling temp file, then rename. Rename is
 * atomic on the same filesystem on Windows and POSIX, so a crash mid-write
 * leaves either the old file intact or the new file fully present — never a
 * truncated half-write.
 *
 * Best-effort cleanup: on any failure (writeFile or rename), unlink the temp
 * file so a permission glitch / cross-device move / disk-full doesn't leave
 * orphan `.tmp` siblings accumulating in the config dir. The original error
 * is re-thrown after cleanup; unlink failures are swallowed.
 */
export async function writeJson(absPath: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(absPath))
  const tmp = `${absPath}.${randomBytes(6).toString('hex')}.tmp`
  const body = JSON.stringify(value, null, 2)
  try {
    await fs.writeFile(tmp, body, 'utf8')
    await fs.rename(tmp, absPath)
  } catch (err) {
    await fs.unlink(tmp).catch(() => undefined)
    throw err
  }
}

/**
 * Like writeJson, but first copies the CURRENT file to a timestamped sibling
 * under `<dir>/.backups/`, keeping the newest `keep` copies.
 *
 * Why this exists: writeJson is atomic, so it never leaves a half-written
 * file — but atomicity is not durability. It offers no protection against a
 * caller that writes *valid but wrong* content over good data. That is not
 * hypothetical: on 2026-05-26 a glossary of user-authored safe-replacements
 * and contextual hints was replaced by the 69-byte empty seed, and because
 * no history existed the entries were unrecoverable.
 *
 * Backups are best-effort. A failure to copy or prune must never block the
 * write the user asked for, so every backup error is swallowed and logged.
 * The write itself still goes through writeJson and keeps its atomicity.
 */
export async function writeJsonBackedUp(
  absPath: string,
  value: unknown,
  keep = 10,
): Promise<void> {
  try {
    const current = await fs.readFile(absPath, 'utf8')
    // Only snapshot non-empty content — backing up a missing or empty file
    // just evicts good history from the ring.
    if (current.trim()) {
      const dir = path.join(path.dirname(absPath), '.backups')
      await ensureDir(dir)
      const base = path.basename(absPath)
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      await fs.writeFile(path.join(dir, `${base}.${stamp}.bak`), current, 'utf8')
      const all = (await fs.readdir(dir))
        .filter((f) => f.startsWith(`${base}.`) && f.endsWith('.bak'))
        .sort()
      for (const stale of all.slice(0, Math.max(0, all.length - keep))) {
        await fs.unlink(path.join(dir, stale)).catch(() => undefined)
      }
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    // ENOENT is the ordinary first-write case, not a problem worth logging.
    if (code !== 'ENOENT') {
      console.warn(`[appData] backup of ${absPath} failed (continuing):`, err)
    }
  }
  await writeJson(absPath, value)
}

export function glossaryFile(): string {
  return path.join(configDir(), 'glossary.json')
}

export function speakersFile(): string {
  return path.join(configDir(), 'speakers.json')
}

export function providersFile(): string {
  return path.join(configDir(), 'providers.enc')
}

export function saltFile(): string {
  return path.join(configDir(), '.salt')
}

export function profilesFile(): string {
  return path.join(configDir(), 'profiles.json')
}

export function routingFile(): string {
  return path.join(configDir(), 'routing.json')
}

export function addonsFile(): string {
  return path.join(configDir(), 'addons.json')
}

export function personasFile(): string {
  return path.join(configDir(), 'personas.json')
}

export function personasMarkerFile(): string {
  return path.join(configDir(), 'personas-addon.enabled')
}

export function settingsFile(): string {
  return path.join(configDir(), 'settings.json')
}

export function modelAvailabilityFile(): string {
  return path.join(configDir(), 'model-availability.json')
}

export function sessionsRoot(): string {
  // Per-user override so sessions can live in the repo (or any other
  // path) instead of %LOCALAPPDATA%. Useful when the multi-GB per-speaker
  // audio files belong on a roomier drive than C:. Resolve relative
  // paths against the current working directory, which is the repo root
  // when the dev server is launched from there.
  const override = process.env.TUSKS_SESSIONS_DIR?.trim()
  if (override) {
    return path.resolve(override)
  }
  return path.join(dataDir(), 'sessions')
}

export function capabilityFile(): string {
  return path.join(cacheDir(), 'capability.json')
}

/** Per-run checkpoints for the pause/resume feature. Each {runId}.json is
 *  a full RunCheckpoint payload (see src/lib/runCheckpoint.ts). */
export function runsDir(): string {
  return path.join(configDir(), 'runs')
}

/** Saved Chronicles library. Each {id}.json is a finished run's output
 *  (chronicle + extras + condensed + metadata), auto-saved on completion so
 *  it survives reloads/restarts. Lives under dataDir (user content, not
 *  config). Distinct from the singular /api/chronicle markdown export.
 *  See server/api/chronicleLibrary.ts. */
export function chronicleLibraryDir(): string {
  return path.join(dataDir(), 'chronicle-library')
}

export function runCheckpointFile(runId: string): string {
  // Defence-in-depth: assert at the definition. Routes SHOULD already
  // validate via isValidRunId / rejectInvalidId before calling here,
  // but a future internal caller (a background flush, a migration
  // script) that forgets still can't walk out of runsDir.
  assertValidRunId(runId)
  return path.join(runsDir(), `${runId}.json`)
}

/**
 * One-shot migration that moves an existing "silence-beyond-the-sea"
 * app-data tree into the new "tusks-tomes" locations. Safe to call on
 * every boot — exits early once the new directory has any content, and
 * never overwrites files that already exist at the destination.
 */
export async function migrateLegacyAppData(): Promise<void> {
  const movePairs: Array<[string, string]> = [
    [legacyPaths.config, paths.config],
    [legacyPaths.data, paths.data],
    [legacyPaths.cache, paths.cache],
  ]
  for (const [oldRoot, newRoot] of movePairs) {
    try {
      const oldEntries = await fs.readdir(oldRoot)
      if (oldEntries.length === 0) continue
      let newAlreadyHasFiles = false
      try {
        const newEntries = await fs.readdir(newRoot)
        if (newEntries.length > 0) newAlreadyHasFiles = true
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      }
      if (newAlreadyHasFiles) continue
      await ensureDir(newRoot)
      for (const entry of oldEntries) {
        const src = path.join(oldRoot, entry)
        const dst = path.join(newRoot, entry)
        try {
          await fs.rename(src, dst)
        } catch (err) {
          // Cross-device rename (e.g. junctions / different drives) — fall
          // back to a recursive copy + remove of the source.
          if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
            await fs.cp(src, dst, { recursive: true })
            await fs.rm(src, { recursive: true, force: true })
          } else {
            throw err
          }
        }
      }
      console.log(`[appData] migrated ${oldRoot} → ${newRoot}`)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
      console.warn('[appData] legacy migration partial failure:', err)
    }
  }
}
