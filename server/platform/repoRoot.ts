import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_NAME = 'tusks-tomes'

let cached: string | undefined

function isRepoRoot(dir: string): boolean {
  try {
    const raw = fs.readFileSync(path.join(dir, 'package.json'), 'utf8')
    return (JSON.parse(raw) as { name?: unknown }).name === PACKAGE_NAME
  } catch {
    return false
  }
}

/**
 * The repository root: the nearest ancestor of this module holding the
 * `tusks-tomes` package.json. Found by walking up rather than by counting
 * `..`, so it holds whether the server runs from source (tsx) or from the
 * built output, and survives files moving. Cached after the first call.
 */
export function repoRoot(): string {
  if (cached) return cached
  const start = path.dirname(fileURLToPath(import.meta.url))
  let dir = start
  for (;;) {
    if (isRepoRoot(dir)) {
      cached = dir
      return dir
    }
    const parent = path.dirname(dir)
    if (parent === dir) {
      throw new Error(
        `Could not find the ${PACKAGE_NAME} repository root: no package.json named "${PACKAGE_NAME}" in ${start} or any parent directory.`,
      )
    }
    dir = parent
  }
}
