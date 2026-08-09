// In-app docs viewer backend.
//
// At startup we enumerate the user-facing markdown files (everything under
// docs/ plus README.md, CONTRIBUTING.md, ROADMAP.md at the repo root) and
// build a slug→path map. CLAUDE.md is excluded — it's a developer guide
// scoped to Claude Code sessions, not user-facing documentation.
//
// Slugs are derived deterministically from the file path:
//   docs/add-ons/audio-transcription.md → "add-ons-audio-transcription"
//   README.md → "readme"
// The /api/docs/:slug route ONLY looks up paths through this Map. There is
// no string concatenation of user input with disk paths — by construction,
// path traversal is impossible. Slug regex (/^[a-z0-9-]+$/) is a second
// belt-and-braces guard.

import express, { type Router } from 'express'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// server/api/docs.ts → repo root is two levels up (or one in dist-server/api).
// Resolve relative to the compiled location; `dist-server/api/docs.js` runs
// from dist-server/ which is also one level below the repo root, so the
// same two-up resolution lands on the project root either way (Vite SSR
// mode keeps the same shape).
const REPO_ROOT = path.resolve(__dirname, '..', '..')

const SLUG_RE = /^[a-z0-9-]+$/

/** Files outside `docs/` we want surfaced in the help viewer. */
const ROOT_LEVEL_DOCS = ['README.md', 'CONTRIBUTING.md', 'ROADMAP.md']

export type DocEntry = {
  /** Stable identifier — kebab-cased relative path with `.md` stripped. */
  slug: string
  /** Human title, derived from the first `# ` heading or filename fallback. */
  title: string
  /** Relative path from repo root, displayed in the UI tree. */
  path: string
}

type DocRecord = DocEntry & { absPath: string }

let cachedDocs: Map<string, DocRecord> | null = null

function slugFromRelPath(relPath: string): string {
  const noExt = relPath.replace(/\.md$/i, '')
  // Replace any path separator (Windows or POSIX) with dashes, then collapse
  // remaining illegal characters. The result must match SLUG_RE so the
  // routing-level guard catches anything pathological.
  const dashed = noExt.replace(/[\\/]/g, '-').toLowerCase()
  return dashed.replace(/[^a-z0-9-]/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '')
}

async function extractTitle(absPath: string, fallback: string): Promise<string> {
  try {
    const buf = await fs.readFile(absPath, 'utf8')
    // Match the first `# Heading` line — markdown's H1 convention.
    const match = buf.match(/^#\s+(.+?)\s*$/m)
    if (match?.[1]) return match[1].trim()
  } catch {
    // fall through
  }
  return fallback
}

async function walkDocsDir(dir: string, relBase: string): Promise<string[]> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries) {
    const abs = path.join(dir, entry.name)
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      out.push(...(await walkDocsDir(abs, rel)))
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      out.push(`docs/${rel}`)
    }
  }
  return out
}

/** Build the slug→record map. Public so tests can call it with a fixture
 *  root; production callers use `getDocs()` which caches once. */
export async function buildDocsMap(repoRoot: string): Promise<Map<string, DocRecord>> {
  const map = new Map<string, DocRecord>()
  const docsDir = path.join(repoRoot, 'docs')

  const docsRelPaths = await walkDocsDir(docsDir, '')
  const rootRelPaths: string[] = []
  for (const name of ROOT_LEVEL_DOCS) {
    try {
      await fs.access(path.join(repoRoot, name))
      rootRelPaths.push(name)
    } catch {
      // skip missing root docs
    }
  }

  const allRelPaths = [...rootRelPaths, ...docsRelPaths]
  for (const relPath of allRelPaths) {
    const slug = slugFromRelPath(relPath)
    if (!SLUG_RE.test(slug)) {
      console.warn(`[docs] rejecting slug "${slug}" from "${relPath}" — fails regex`)
      continue
    }
    if (map.has(slug)) {
      console.warn(`[docs] duplicate slug "${slug}" — keeping first occurrence`)
      continue
    }
    const absPath = path.join(repoRoot, relPath)
    const fallbackTitle = path.basename(relPath, '.md')
    const title = await extractTitle(absPath, fallbackTitle)
    map.set(slug, { slug, title, path: relPath, absPath })
  }
  return map
}

async function getDocs(): Promise<Map<string, DocRecord>> {
  if (!cachedDocs) cachedDocs = await buildDocsMap(REPO_ROOT)
  return cachedDocs
}

/** For tests: reset the cache so a different fixture root takes effect. */
export function _resetDocsCache(): void {
  cachedDocs = null
}

export function docsRouter(): Router {
  const router = express.Router()

  router.get('/', async (_req, res) => {
    try {
      const docs = await getDocs()
      const entries: DocEntry[] = [...docs.values()].map(({ slug, title, path: p }) => ({
        slug,
        title,
        path: p,
      }))
      // Stable order: root docs first (README, CONTRIBUTING, ROADMAP), then
      // docs/ alphabetical. Helps the sidebar look like the GitHub layout.
      entries.sort((a, b) => {
        const aRoot = !a.path.includes('/')
        const bRoot = !b.path.includes('/')
        if (aRoot !== bRoot) return aRoot ? -1 : 1
        return a.path.localeCompare(b.path)
      })
      res.json({ docs: entries })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  router.get('/:slug', async (req, res) => {
    const slug = req.params.slug
    if (!SLUG_RE.test(slug)) {
      return res.status(400).json({ error: 'invalid slug' })
    }
    const docs = await getDocs()
    const entry = docs.get(slug)
    if (!entry) return res.status(404).json({ error: 'doc not found' })
    try {
      const content = await fs.readFile(entry.absPath, 'utf8')
      res.json({ slug: entry.slug, title: entry.title, path: entry.path, content })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  return router
}
