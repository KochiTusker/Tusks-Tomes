import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { buildDocsMap } from './docs'
import { ADDON_REGISTRY } from '../addons/registry'

// Tests run against a fresh temp repo root so they don't depend on the
// real docs/ tree. Each test reuses the same fixture for speed.
let ROOT: string

beforeAll(async () => {
  ROOT = await fs.mkdtemp(path.join(tmpdir(), 'docs-router-'))
  await fs.writeFile(path.join(ROOT, 'README.md'), '# Tusk\'s Tomes\nintro')
  await fs.writeFile(path.join(ROOT, 'CONTRIBUTING.md'), '# Contributing\n')
  await fs.writeFile(path.join(ROOT, 'ROADMAP.md'), '# Roadmap\n')
  // Repo-root contributor guides stay out of the docs viewer.
  await fs.writeFile(path.join(ROOT, 'CLAUDE.md'), '# Claude guide\n')
  await fs.mkdir(path.join(ROOT, 'docs'), { recursive: true })
  await fs.writeFile(path.join(ROOT, 'docs', 'faq.md'), '# Frequently Asked\nbody')
  await fs.writeFile(path.join(ROOT, 'docs', 'no-heading.md'), 'no leading heading')
  await fs.mkdir(path.join(ROOT, 'docs', 'add-ons'), { recursive: true })
  await fs.writeFile(
    path.join(ROOT, 'docs', 'add-ons', 'audio-transcription.md'),
    '# Audio Transcription Add-on\ndetails',
  )
  // A non-markdown file in docs/ — must be ignored.
  await fs.writeFile(path.join(ROOT, 'docs', 'image.png'), 'not markdown')
})

afterAll(async () => {
  await fs.rm(ROOT, { recursive: true, force: true })
})

describe('buildDocsMap', () => {
  it('includes CONTRIBUTING from the repo root', async () => {
    const map = await buildDocsMap(ROOT)
    expect(map.has('contributing')).toBe(true)
  })

  // The README is the shopfront: badges, a donate button, and screenshots of
  // this very application. Serving it inside the app shows the reader pictures
  // of the window they are already looking at.
  it('excludes README.md from the in-app viewer', async () => {
    const map = await buildDocsMap(ROOT)
    expect(map.has('readme')).toBe(false)
  })

  // The roadmap moved under docs/about/ in the restructure. It is still
  // surfaced — the docs/ walk finds it — just no longer promoted from the root.
  it('does not promote a root-level ROADMAP.md any more', async () => {
    const map = await buildDocsMap(ROOT)
    expect(map.has('roadmap')).toBe(false)
  })

  it('excludes repo-root contributor guides', async () => {
    const map = await buildDocsMap(ROOT)
    expect(map.has('claude')).toBe(false)
  })

  it('walks docs/ recursively and slugs the path', async () => {
    const map = await buildDocsMap(ROOT)
    expect(map.has('docs-faq')).toBe(true)
    expect(map.has('docs-add-ons-audio-transcription')).toBe(true)
  })

  it('ignores non-markdown files in docs/', async () => {
    const map = await buildDocsMap(ROOT)
    for (const entry of map.values()) {
      expect(entry.path.toLowerCase()).toMatch(/\.md$/)
    }
  })

  it('extracts the H1 title from each doc', async () => {
    const map = await buildDocsMap(ROOT)
    expect(map.get('contributing')?.title).toBe('Contributing')
    expect(map.get('docs-add-ons-audio-transcription')?.title).toBe(
      'Audio Transcription Add-on',
    )
  })

  it("falls back to the filename when there's no H1", async () => {
    const map = await buildDocsMap(ROOT)
    expect(map.get('docs-no-heading')?.title).toBe('no-heading')
  })

  it('produces only slugs that match the safe regex /^[a-z0-9-]+$/', async () => {
    const map = await buildDocsMap(ROOT)
    const safe = /^[a-z0-9-]+$/
    for (const slug of map.keys()) {
      expect(slug, `slug "${slug}" failed regex`).toMatch(safe)
    }
  })

  it('every record points to a file inside the provided root (no traversal)', async () => {
    const map = await buildDocsMap(ROOT)
    const normalizedRoot = path.resolve(ROOT) + path.sep
    for (const record of map.values()) {
      const abs = path.resolve(record.absPath) + (record.absPath.endsWith(path.sep) ? '' : '')
      expect(abs.startsWith(normalizedRoot)).toBe(true)
    }
  })
})

// Slugs are derived from the file path, so any doc rename silently breaks the
// "Read docs" button on a module row unless the registry is updated in step.
// That is not hypothetical: the registry shipped slugs missing the leading
// "docs-" segment, so every one of those buttons 404'd, and nothing failed.
describe('module docSlugs resolve to a real doc', () => {
  it('every docSlug in the registry exists in the docs map', async () => {
    const repoRoot = path.resolve(__dirname, '..', '..')
    const map = await buildDocsMap(repoRoot)
    const declared = ADDON_REGISTRY.map((a) => a.docSlug).filter(
      (s): s is string => typeof s === 'string',
    )

    expect(declared.length, 'expected the registry to declare docSlugs').toBeGreaterThan(0)
    for (const slug of declared) {
      expect(
        map.has(slug),
        `docSlug "${slug}" resolves to nothing — the Read docs button would 404`,
      ).toBe(true)
    }
  })
})
