// Round-trip + guard tests for the Saved Chronicles library store.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import express from 'express'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

let WORK: string

beforeEach(async () => {
  WORK = await fs.mkdtemp(path.join(tmpdir(), 'chronlib-test-'))
  vi.resetModules()
  vi.doMock('../appData.js', async () => {
    const actual = await vi.importActual<typeof import('../appData')>('../appData.js')
    return { ...actual, chronicleLibraryDir: () => WORK }
  })
})

afterEach(async () => {
  vi.doUnmock('../appData.js')
  vi.resetModules()
  await fs.rm(WORK, { recursive: true, force: true })
})

async function withServer<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const mod = await import('./chronicleLibrary.js')
  const app = express()
  app.use(express.json())
  app.use('/api/chronicle-library', mod.chronicleLibraryRouter())
  const server: Server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${addr.port}/api/chronicle-library`
  try {
    return await fn(baseUrl)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

const post = (base: string, body: unknown) =>
  fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

describe('chronicle-library store', () => {
  it('saves, lists, fetches, updates, and deletes a chronicle', async () => {
    await withServer(async (base) => {
      // Save
      const saveRes = await post(base, {
        campaign: 'Too Many Bruisers',
        sessionNumber: 24,
        provider: 'claudeCode',
        chronicle: 'The party marched at dawn. ' .repeat(5),
      })
      expect(saveRes.status).toBe(201)
      const saved = await saveRes.json()
      expect(saved.id).toBeTruthy()
      expect(saved.createdAt).toBeTruthy()

      // List (summary, no heavy content)
      const list = await (await fetch(base)).json()
      expect(list.chronicles).toHaveLength(1)
      expect(list.chronicles[0]).toMatchObject({
        id: saved.id,
        campaign: 'Too Many Bruisers',
        sessionNumber: 24,
        provider: 'claudeCode',
        hasExtras: false,
        hasCondensed: false,
      })
      expect(list.chronicles[0].wordCount).toBeGreaterThan(0)

      // Update — add extras
      const upd = await fetch(`${base}/${saved.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ extras: { quotes: ['ha'], jests: [], gore: [] } }),
      })
      expect(upd.status).toBe(200)

      // Fetch full — extras present, chronicle intact
      const full = await (await fetch(`${base}/${saved.id}`)).json()
      expect(full.extras).toEqual({ quotes: ['ha'], jests: [], gore: [] })
      expect(full.chronicle).toContain('marched at dawn')

      // Delete
      expect((await fetch(`${base}/${saved.id}`, { method: 'DELETE' })).status).toBe(200)
      expect((await fetch(`${base}/${saved.id}`)).status).toBe(404)
      expect((await (await fetch(base)).json()).chronicles).toHaveLength(0)
    })
  })

  it('round-trips the refusal manifest + dmQuestions/dmAnswers on POST and PUT', async () => {
    await withServer(async (base) => {
      const refusals = [
        {
          id: 'r-1',
          phase: 'phase2_audit',
          chunkIndex: 3,
          totalChunks: 13,
          sourceSpan: 'grounded span text',
          refusedText: "I can't help with that.",
          marker: '',
          chunkSizeChars: 40000,
          repaired: false,
          createdAt: '2026-06-04T00:00:00.000Z',
        },
      ]
      // POST carries the manifest + context snapshots.
      const saved = await (
        await post(base, {
          campaign: 'Too Many Bruisers',
          sessionNumber: 24,
          chronicle: 'The party marched at dawn.',
          refusals,
          dmQuestions: [{ id: 'q1', question: 'Who opened the gate?' }],
          dmAnswers: { q1: 'Lucia did.' },
        })
      ).json()
      const afterPost = await (await fetch(`${base}/${saved.id}`)).json()
      expect(afterPost.refusals).toEqual(refusals)
      expect(afterPost.dmQuestions).toEqual([{ id: 'q1', question: 'Who opened the gate?' }])
      expect(afterPost.dmAnswers).toEqual({ q1: 'Lucia did.' })

      // PUT flips the refusal to repaired; untouched fields persist.
      const repaired = [{ ...refusals[0], repaired: true }]
      const upd = await fetch(`${base}/${saved.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refusals: repaired }),
      })
      expect(upd.status).toBe(200)
      const afterPut = await (await fetch(`${base}/${saved.id}`)).json()
      expect(afterPut.refusals[0].repaired).toBe(true)
      // dmQuestions untouched by the PUT (merge keeps existing).
      expect(afterPut.dmQuestions).toEqual([{ id: 'q1', question: 'Who opened the gate?' }])
    })
  })

  it('rejects a save with no chronicle text (400)', async () => {
    await withServer(async (base) => {
      expect((await post(base, { campaign: 'x', sessionNumber: 1, chronicle: '   ' })).status).toBe(400)
    })
  })

  it('rejects an id that fails the safe-id regex (path-traversal guard)', async () => {
    await withServer(async (base) => {
      // A '.' is disallowed by ID_RE → rejected with 400 before any fs
      // access. (Using a dotted id rather than '..' since the URL parser
      // would collapse '..' before the request is even sent.)
      expect((await fetch(`${base}/bad.id`)).status).toBe(400)
      expect((await fetch(`${base}/has.dot`, { method: 'DELETE' })).status).toBe(400)
    })
  })
})
