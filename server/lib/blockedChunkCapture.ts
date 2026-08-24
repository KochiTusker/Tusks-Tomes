// Persists the full prompt body of a chunk Gemini rejected with
// PROHIBITED_CONTENT / BLOCKLIST / SPII. Lets the user empirically inspect
// what content the unconfigurable filter classified as forbidden — a
// ground-truth fixture for the safety probe (Phase 7).
//
// Opt-in only — the client-side `persistBlockedChunks` toggle (default OFF)
// gates whether the pipeline ever POSTs here. Disk path lives next to the
// diagnose bundles (`.diagnose/blocked-chunks/<phase>-<ISO>.txt`), which is
// already gitignored under the `.diagnose/` wildcard.
//
// File shape: a small key=value header (one line per field) followed by a
// `---` separator, then the raw prompt text. Easy to grep, easy to read,
// works with the existing diagnose-bundle tooling because the file is just
// plain text.

import { promises as fs } from 'node:fs'
import path from 'node:path'

/** Cap on the number of files we keep in `.diagnose/blocked-chunks/`. The
 *  user can clear at any time; this just prevents unbounded growth across
 *  many runs. Matches the BACKUP_LIMIT for diagnose bundles in spirit. */
export const BLOCKED_CHUNK_FILE_LIMIT = 50

export type CapturePayload = {
  phase?: string | null
  index?: number | null
  totalChunks?: number | null
  model?: string | null
  tier?: string | null
  blockReason?: string | null
  prompt: string
}

export type CaptureResult = {
  filename: string
  path: string
  bytesWritten: number
}

/** Sanitize a phase id into a filename component. */
function sanitizePhase(phase: string | null | undefined): string {
  if (!phase || typeof phase !== 'string') return 'unknown_phase'
  return phase.replace(/[^a-zA-Z0-9_-]/g, '_')
}

/** Write a captured blocked-chunk payload to
 *  `.diagnose/blocked-chunks/<phase>-<ISO>.txt`. Atomic via tmp + rename.
 *  Returns the filename + absolute path so the caller can echo to the
 *  user / log it. */
export async function captureBlockedChunk(
  payload: CapturePayload,
  opts: { repoRoot?: string } = {},
): Promise<CaptureResult> {
  const repoRoot = opts.repoRoot ?? process.cwd()
  const dir = path.join(repoRoot, '.diagnose', 'blocked-chunks')
  await fs.mkdir(dir, { recursive: true })

  const isoStamp = new Date().toISOString().replace(/[:.]/g, '-')
  const phase = sanitizePhase(payload.phase)
  const filename = `${phase}-${isoStamp}.txt`
  const fullPath = path.join(dir, filename)

  const headerLines = [
    `# phase=${payload.phase ?? 'unknown'}`,
    `# index=${typeof payload.index === 'number' ? payload.index : 'unknown'}`,
    `# totalChunks=${typeof payload.totalChunks === 'number' ? payload.totalChunks : 'unknown'}`,
    `# model=${payload.model ?? 'unknown'}`,
    `# tier=${payload.tier ?? 'unknown'}`,
    `# blockReason=${payload.blockReason ?? 'PROHIBITED_CONTENT'}`,
    `# capturedAt=${new Date().toISOString()}`,
    '---',
    '',
  ]
  const body = headerLines.join('\n') + (payload.prompt ?? '')

  await fs.writeFile(fullPath + '.tmp', body, 'utf8')
  await fs.rename(fullPath + '.tmp', fullPath)

  await pruneCapturedChunks(dir)

  return {
    filename,
    path: fullPath,
    bytesWritten: Buffer.byteLength(body, 'utf8'),
  }
}

/** Prune the directory to BLOCKED_CHUNK_FILE_LIMIT most recent files. */
export async function pruneCapturedChunks(dir: string): Promise<void> {
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return
  }
  const files = entries.filter((name) => name.endsWith('.txt'))
  if (files.length <= BLOCKED_CHUNK_FILE_LIMIT) return
  // Filenames embed an ISO timestamp; lexicographic sort = chronological.
  files.sort((a, b) => b.localeCompare(a))
  const toDelete = files.slice(BLOCKED_CHUNK_FILE_LIMIT)
  await Promise.all(
    toDelete.map((name) => fs.unlink(path.join(dir, name)).catch(() => undefined)),
  )
}

/** List the captured blocked-chunk files, newest first. Used by the
 *  Diagnostics card's recent-captures panel. */
export async function listCapturedChunks(
  opts: { repoRoot?: string } = {},
): Promise<Array<{ filename: string; path: string; size: number; modifiedAt: string }>> {
  const repoRoot = opts.repoRoot ?? process.cwd()
  const dir = path.join(repoRoot, '.diagnose', 'blocked-chunks')
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return []
  }
  const files = entries.filter((name) => name.endsWith('.txt'))
  const stats = await Promise.all(
    files.map(async (filename) => {
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
