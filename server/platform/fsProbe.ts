import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

/**
 * Whether a directory can be written to: creates it if missing, then writes
 * and removes a throwaway file. Never throws; an unwritable directory is a
 * `false`, because callers surface it as a status rather than an error.
 */
export async function ensureWritable(dir: string): Promise<boolean> {
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
