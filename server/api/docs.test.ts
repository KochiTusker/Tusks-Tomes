import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { buildDocsMap } from './docs'

// Tests run against a fresh temp repo root so they don't depend on the
// real docs/ tree. Each test reuses the same fixture for speed.
let ROOT: string

beforeAll(async () => {
  ROOT = await fs.mkdtemp(path.join(tmpdir(), 'docs-router-'))
  await fs.writeFile(path.join(ROOT, 'README.md'), '# Tusk\'s Tomes\nintro')
  await fs.writeFile(path.join(ROOT, 'CONTRIBUTING.md'), '# Contributing\n')
  await fs.writeFile(path.join(ROOT, 'ROADMAP.md'), '# Roadmap\n')
  // CLAUDE.md should be intentionally excluded from the docs viewer.
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
  it('includes README, CONTRIBUTING, ROADMAP from the repo root', async () => {
    const map = await buildDocsMap(ROOT)
    expect(map.has('readme')).toBe(true)
    expect(map.has('contributing')).toBe(true)
    expect(map.has('roadmap')).toBe(true)
  })

  it('excludes CLAUDE.md (developer-only doc)', async () => {
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
    expect(map.get('readme')?.title).toBe("Tusk's Tomes")
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
