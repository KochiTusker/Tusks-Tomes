// Coverage for the bulk docx → markdown + opt-in removal endpoints
// (POST /api/lore/convert-docx and POST /api/lore/remove-docx).
//
// The critical safety property under test is the remove endpoint's refusal
// to unlink any .docx that doesn't have a sibling .md on disk. If that
// guard ever loosens the user loses on-disk lore irreversibly. Test every
// rejection branch + the happy path.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express, { type Express } from 'express'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { loreRouter } from './lore'
import { LORE_MARKER_FILENAME, LORE_MARKER_VERSION } from '../lore/detection.js'

let WORK: string
let LORE_ROOT: string
let server: http.Server
let port: number

async function serve(app: Express): Promise<number> {
  return new Promise((resolve) => {
    server = http.createServer(app)
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port)
    })
  })
}

beforeEach(async () => {
  WORK = await fs.mkdtemp(path.join(tmpdir(), 'lore-bulk-'))
  LORE_ROOT = path.join(WORK, 'Tusks-Lore')
  await fs.mkdir(path.join(LORE_ROOT, 'Sessions'), { recursive: true })
  await fs.writeFile(
    path.join(LORE_ROOT, LORE_MARKER_FILENAME),
    JSON.stringify({ version: LORE_MARKER_VERSION, createdAt: new Date().toISOString() }),
  )
  // Use vi.stubEnv instead of mutating process.env directly. Vitest's
  // default threaded pool shares process.env across concurrent test files
  // running in the same worker, and detection.test.ts also reads
  // TUSKS_LORE_DIR — direct mutation here would race with theirs and
  // cross-contaminate. stubEnv tracks the change and unstubAllEnvs in
  // afterEach restores the previous value cleanly.
  vi.stubEnv('TUSKS_LORE_DIR', LORE_ROOT)
  const app = express()
  app.use(express.json({ limit: '20mb' }))
  app.use('/api/lore', loreRouter())
  port = await serve(app)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await fs.rm(WORK, { recursive: true, force: true })
})

async function callJson(
  method: 'POST',
  routePath: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${routePath}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null }
}

describe('POST /api/lore/remove-docx — safety invariants', () => {
  it('refuses to delete a .docx that has no sibling .md', async () => {
    await fs.writeFile(path.join(LORE_ROOT, 'Lore.docx'), 'pretend docx')
    const { status, json } = await callJson('POST', '/api/lore/remove-docx', {
      relPaths: ['Lore.docx'],
    })
    expect(status).toBe(200)
    expect(json.report).toHaveLength(1)
    expect(json.report[0].status).toBe('skipped')
    expect(json.report[0].reason).toMatch(/no sibling \.md/i)
    // File still on disk.
    await expect(fs.stat(path.join(LORE_ROOT, 'Lore.docx'))).resolves.toBeTruthy()
  })

  it('deletes the .docx when a sibling .md exists', async () => {
    await fs.writeFile(path.join(LORE_ROOT, 'Lore.docx'), 'pretend docx')
    await fs.writeFile(path.join(LORE_ROOT, 'Lore.md'), '# Lore\n\nbody')
    const { status, json } = await callJson('POST', '/api/lore/remove-docx', {
      relPaths: ['Lore.docx'],
    })
    expect(status).toBe(200)
    expect(json.report[0].status).toBe('removed')
    // .docx gone, .md preserved.
    await expect(fs.stat(path.join(LORE_ROOT, 'Lore.docx'))).rejects.toThrow()
    await expect(fs.stat(path.join(LORE_ROOT, 'Lore.md'))).resolves.toBeTruthy()
  })

  it('rejects path traversal attempts', async () => {
    const { json } = await callJson('POST', '/api/lore/remove-docx', {
      relPaths: ['../../../etc/passwd.docx'],
    })
    expect(json.report[0].status).toBe('skipped')
    expect(json.report[0].reason).toMatch(/escapes/i)
  })

  it('rejects non-.docx extensions', async () => {
    await fs.writeFile(path.join(LORE_ROOT, 'notes.md'), 'body')
    const { json } = await callJson('POST', '/api/lore/remove-docx', {
      relPaths: ['notes.md'],
    })
    expect(json.report[0].status).toBe('skipped')
    expect(json.report[0].reason).toMatch(/not a \.docx/i)
    await expect(fs.stat(path.join(LORE_ROOT, 'notes.md'))).resolves.toBeTruthy()
  })

  it('rejects Sessions/ chronicle exports even with a sibling .md', async () => {
    await fs.mkdir(path.join(LORE_ROOT, 'Sessions', 'Krome'), { recursive: true })
    await fs.writeFile(path.join(LORE_ROOT, 'Sessions', 'Krome', 'Session-01.docx'), 'export')
    await fs.writeFile(path.join(LORE_ROOT, 'Sessions', 'Krome', 'Session-01.md'), '# 01')
    const { json } = await callJson('POST', '/api/lore/remove-docx', {
      relPaths: ['Sessions/Krome/Session-01.docx'],
    })
    expect(json.report[0].status).toBe('skipped')
    expect(json.report[0].reason).toMatch(/Sessions\//)
    // Both files still on disk.
    await expect(fs.stat(path.join(LORE_ROOT, 'Sessions', 'Krome', 'Session-01.docx'))).resolves.toBeTruthy()
  })

  it('handles a mix of valid and invalid paths in one request', async () => {
    await fs.writeFile(path.join(LORE_ROOT, 'A.docx'), 'a')
    await fs.writeFile(path.join(LORE_ROOT, 'A.md'), 'a')
    await fs.writeFile(path.join(LORE_ROOT, 'B.docx'), 'b')
    // B has no sibling .md → must be refused.
    const { json } = await callJson('POST', '/api/lore/remove-docx', {
      relPaths: ['A.docx', 'B.docx'],
    })
    const a = json.report.find((r: { relPath: string }) => r.relPath === 'A.docx')
    const b = json.report.find((r: { relPath: string }) => r.relPath === 'B.docx')
    expect(a.status).toBe('removed')
    expect(b.status).toBe('skipped')
    await expect(fs.stat(path.join(LORE_ROOT, 'A.docx'))).rejects.toThrow()
    await expect(fs.stat(path.join(LORE_ROOT, 'B.docx'))).resolves.toBeTruthy()
  })

  it('400s when relPaths is missing or empty', async () => {
    const a = await callJson('POST', '/api/lore/remove-docx', {})
    expect(a.status).toBe(400)
    const b = await callJson('POST', '/api/lore/remove-docx', { relPaths: [] })
    expect(b.status).toBe(400)
  })
})

describe('POST /api/lore/convert-docx — report structure', () => {
  it('returns an empty report when no .docx files exist', async () => {
    const { status, json } = await callJson('POST', '/api/lore/convert-docx')
    expect(status).toBe(200)
    expect(json.report).toEqual([])
  })

  it('skips .docx files that already have a sibling .md', async () => {
    await fs.writeFile(path.join(LORE_ROOT, 'Existing.docx'), 'docx body')
    await fs.writeFile(path.join(LORE_ROOT, 'Existing.md'), '# already converted')
    const { json } = await callJson('POST', '/api/lore/convert-docx')
    const entry = json.report.find(
      (r: { relPath: string }) => r.relPath === 'Existing.docx',
    )
    expect(entry.status).toBe('skipped_existing_md')
    // Verify the existing .md was not overwritten.
    const md = await fs.readFile(path.join(LORE_ROOT, 'Existing.md'), 'utf8')
    expect(md).toBe('# already converted')
  })

  it('excludes Sessions/ from conversion', async () => {
    await fs.mkdir(path.join(LORE_ROOT, 'Sessions', 'Krome'), { recursive: true })
    await fs.writeFile(
      path.join(LORE_ROOT, 'Sessions', 'Krome', 'Session-01.docx'),
      'export',
    )
    const { json } = await callJson('POST', '/api/lore/convert-docx')
    // Sessions/ entry must NOT appear in the report.
    expect(
      json.report.find((r: { relPath: string }) =>
        r.relPath.startsWith('Sessions/'),
      ),
    ).toBeUndefined()
    // No .md was created in Sessions/.
    await expect(
      fs.stat(path.join(LORE_ROOT, 'Sessions', 'Krome', 'Session-01.md')),
    ).rejects.toThrow()
  })

  it('reports errors per-file without aborting the whole run', async () => {
    // First file: junk bytes → mammoth/turndown fail → error entry.
    await fs.writeFile(path.join(LORE_ROOT, 'Bad.docx'), 'not really a docx')
    // Second file: existing .md → skipped (proves the loop kept going).
    await fs.writeFile(path.join(LORE_ROOT, 'Skip.docx'), 'docx')
    await fs.writeFile(path.join(LORE_ROOT, 'Skip.md'), '# md')
    const { status, json } = await callJson('POST', '/api/lore/convert-docx')
    expect(status).toBe(200)
    const bad = json.report.find((r: { relPath: string }) => r.relPath === 'Bad.docx')
    const skip = json.report.find((r: { relPath: string }) => r.relPath === 'Skip.docx')
    // Bad.docx either errors OR successfully falls back to empty extracted
    // text — both are acceptable outcomes for non-docx bytes. The critical
    // assertion is "the loop continued past the bad file."
    expect(bad).toBeDefined()
    expect(skip.status).toBe('skipped_existing_md')
  })
})
