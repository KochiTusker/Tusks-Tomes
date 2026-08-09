import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import express from 'express'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

// Phase J — PUT /api/glossary now surfaces dropped-entry counts in a
// `warnings` array so the user notices when their saved glossary line
// silently disappeared due to a missing field. Hard-shape body errors
// still 400.

let WORK: string

beforeEach(async () => {
  WORK = await fs.mkdtemp(path.join(tmpdir(), 'glossary-test-'))
  vi.resetModules()
  vi.doMock('../appData.js', async () => {
    const actual = await vi.importActual<typeof import('../appData')>('../appData.js')
    return {
      ...actual,
      configDir: () => WORK,
      glossaryFile: () => path.join(WORK, 'glossary.json'),
    }
  })
})

afterEach(async () => {
  vi.doUnmock('../appData.js')
  vi.resetModules()
  await fs.rm(WORK, { recursive: true, force: true })
})

async function withGlossaryServer<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const mod = await import('./glossary.js')
  const app = express()
  app.use(express.json())
  app.use('/api/glossary', mod.glossaryRouter())
  const server: Server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${addr.port}/api/glossary`
  try {
    return await fn(baseUrl)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

describe('glossaryRouter PUT — strict validation (Phase J)', () => {
  it('happy path: well-formed entries round-trip without warnings', async () => {
    await withGlossaryServer(async (base) => {
      const res = await fetch(base, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          safeReplacements: [{ from: 'broady', to: 'Lucia' }],
          contextualHints: [],
        }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as Record<string, unknown>
      expect(body.warnings).toBeUndefined()
    })
  })

  it('returns 400 for non-object body', async () => {
    await withGlossaryServer(async (base) => {
      const res = await fetch(base, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([]),
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as Record<string, unknown>
      expect(body.field).toBe('_root')
    })
  })

  it('warns when safeReplacements entries are dropped due to missing fields', async () => {
    await withGlossaryServer(async (base) => {
      const res = await fetch(base, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          safeReplacements: [
            { from: 'valid', to: 'Valid' },
            { from: 'missing-to' }, // dropped — no `to`
            { to: 'missing-from' }, // dropped — no `from`
            { from: '', to: 'empty' }, // dropped — empty `from`
          ],
          contextualHints: [],
        }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { warnings?: string[]; safeReplacements: unknown[] }
      expect(body.warnings).toBeDefined()
      expect(body.warnings!.some((w) => w.includes('safe-replacement'))).toBe(true)
      expect(body.warnings![0]).toContain('3')
      expect(body.safeReplacements.length).toBe(1) // only `valid` survived
    })
  })

  it('warns when contextualHints entries are dropped', async () => {
    await withGlossaryServer(async (base) => {
      const res = await fetch(base, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          safeReplacements: [],
          contextualHints: [
            { canonical: 'OK', notes: 'good' },
            { canonical: 'no notes' }, // dropped — no notes
            { notes: 'no canonical' }, // dropped — no canonical
          ],
        }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { warnings?: string[] }
      expect(body.warnings).toBeDefined()
      expect(body.warnings!.some((w) => w.includes('contextual hint'))).toBe(true)
    })
  })
})

// Data-loss hardening. On 2026-05-26 a populated glossary was replaced by
// `sanitize({})` — every array empty. The seed is populated, so that write
// could only have come from a PUT carrying an empty document (the editor
// saving its blank initial state before its GET resolved). These cover the
// three defences: reads never write, empty overwrites are refused, and every
// real write leaves a restorable copy behind.
describe('glossaryRouter — destructive-write protection', () => {
  it('GET does not create the file (a read must never mutate user data)', async () => {
    await withGlossaryServer(async (baseUrl) => {
      const res = await fetch(baseUrl)
      expect(res.status).toBe(200)
      const body = await res.json()
      // Seed is served from memory...
      expect(body.safeReplacements.length).toBeGreaterThan(0)
      // ...but nothing is persisted.
      await expect(fs.access(path.join(WORK, 'glossary.json'))).rejects.toThrow()
    })
  })

  it('refuses a PUT that would empty a populated glossary', async () => {
    await withGlossaryServer(async (baseUrl) => {
      const seeded = { version: 1, safeReplacements: [{ from: 'buggo', to: 'Yuzuki' }], contextualHints: [] }
      expect((await fetch(baseUrl, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(seeded),
      })).status).toBe(200)

      const wipe = await fetch(baseUrl, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: 1, safeReplacements: [], contextualHints: [] }),
      })
      expect(wipe.status).toBe(409)
      expect((await wipe.json()).currentEntryCount).toBe(1)

      // The entry survived.
      const after = await (await fetch(baseUrl)).json()
      expect(after.safeReplacements).toHaveLength(1)
    })
  })

  it('allows a deliberate clear via ?allowEmpty=1', async () => {
    await withGlossaryServer(async (baseUrl) => {
      await fetch(baseUrl, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: 1, safeReplacements: [{ from: 'a', to: 'B' }], contextualHints: [] }),
      })
      const res = await fetch(`${baseUrl}?allowEmpty=1`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: 1, safeReplacements: [], contextualHints: [] }),
      })
      expect(res.status).toBe(200)
      expect((await (await fetch(baseUrl)).json()).safeReplacements).toHaveLength(0)
    })
  })

  it('keeps a restorable backup of the previous contents on every write', async () => {
    await withGlossaryServer(async (baseUrl) => {
      const put = (body: unknown, qs = '') =>
        fetch(`${baseUrl}${qs}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        })
      await put({ version: 1, safeReplacements: [{ from: 'buggo', to: 'Yuzuki' }], contextualHints: [] })
      await put({ version: 1, safeReplacements: [{ from: 'broady', to: 'Lucia' }], contextualHints: [] })
      // Even a sanctioned clear leaves the prior state recoverable.
      await put({ version: 1, safeReplacements: [], contextualHints: [] }, '?allowEmpty=1')

      const backups = (await fs.readdir(path.join(WORK, '.backups'))).filter((f) => f.endsWith('.bak'))
      expect(backups.length).toBeGreaterThanOrEqual(2)
      const restored = backups
        .map((f) => fs.readFile(path.join(WORK, '.backups', f), 'utf8'))
      const texts = await Promise.all(restored)
      expect(texts.some((t) => t.includes('buggo'))).toBe(true)
      expect(texts.some((t) => t.includes('broady'))).toBe(true)
    })
  })
})
