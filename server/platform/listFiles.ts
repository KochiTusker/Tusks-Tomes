import { promises as fs } from 'node:fs'
import path from 'node:path'

export interface FileEntry {
  filename: string
  path: string
  size: number
  modifiedAt: string
}

/**
 * The files in `dir` whose names pass `accept`, newest first. A missing or
 * unreadable directory is an empty list, and a file that vanishes between the
 * listing and the stat is left out, because the callers show a best-effort panel.
 */
export async function listFilesNewestFirst(dir: string, accept: (filename: string) => boolean): Promise<FileEntry[]> {
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return []
  }
  const stats = await Promise.all(
    entries.filter(accept).map(async (filename) => {
      const fullPath = path.join(dir, filename)
      const stat = await fs.stat(fullPath).catch(() => null)
      if (!stat) return null
      return {
        filename,
        path: fullPath,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      }
    }),
  )
  return stats
    .filter((s): s is NonNullable<typeof s> => s !== null)
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
}
