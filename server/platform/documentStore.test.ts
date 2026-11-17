import { describe, it, expect, vi, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const slogMock = vi.fn()
vi.mock('./slog.js', () => ({ slog: (...a: unknown[]) => slogMock(...a) }))

import { createDocumentStore, rejectNonObjectBody } from './documentStore.js'

type Doc = { n: number }
let dirs: string[] = []
async function tmpFile(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'docstore-'))
  dirs.push(d)
  return path.join(d, 'doc.json')
}
afterEach(async () => {
  slogMock.mockReset()
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })))
  dirs = []
})
const sanitize = (i: unknown): Doc => ({ n: Number((i as Doc)?.n) || 0 })

describe('createDocumentStore', () => {
  it('persists the seed on first read by default', async () => {
    const file = await tmpFile()
    const store = createDocumentStore<Doc>({ file: () => file, seed: () => ({ n: 7 }), sanitize })
    expect(await store.load()).toEqual({ n: 7 })
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ n: 7 })
  })

  it('keeps the seed in memory when persistSeedOnRead is false', async () => {
    const file = await tmpFile()
    const store = createDocumentStore<Doc>({ file: () => file, seed: () => ({ n: 7 }), sanitize, persistSeedOnRead: false })
    expect(await store.load()).toEqual({ n: 7 })
    await expect(fs.readFile(file, 'utf8')).rejects.toThrow()
  })

  it('sanitizes an existing file and saves through the chosen writer', async () => {
    const file = await tmpFile()
    await fs.writeFile(file, JSON.stringify({ n: '3', extra: true }))
    const write = vi.fn(async () => undefined)
    const store = createDocumentStore<Doc>({ file: () => file, seed: () => ({ n: 0 }), sanitize, write })
    expect(await store.load()).toEqual({ n: 3 })
    await store.save({ n: 9 })
    expect(write).toHaveBeenCalledWith(file, { n: 9 })
  })

  it('migrates before sanitizing, logging and saving once only when changed', async () => {
    const file = await tmpFile()
    await fs.writeFile(file, JSON.stringify({ n: 1 }))
    const onChanged = vi.fn()
    const store = createDocumentStore<Doc>({
      file: () => file,
      seed: () => ({ n: 0 }),
      sanitize,
      migrate: (d) => (d.n === 1 ? { doc: { n: 2 }, changed: true, onChanged } : { doc: d, changed: false }),
    })
    expect(await store.load()).toEqual({ n: 2 })
    expect(onChanged).toHaveBeenCalledTimes(1)
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ n: 2 })
    expect(await store.load()).toEqual({ n: 2 })
    expect(onChanged).toHaveBeenCalledTimes(1)
  })
})

describe('rejectNonObjectBody', () => {
  function res() {
    const out = { status: 0, body: undefined as unknown }
    const r = { status: (s: number) => { out.status = s; return r }, json: (b: unknown) => { out.body = b } }
    return { r: r as never, out }
  }
  it.each([[undefined, 'undefined'], [[], 'object'], ['x', 'string'], [null, 'object']])('rejects %j', (body, received) => {
    const { r, out } = res()
    expect(rejectNonObjectBody({ body } as never, r, 'glossary')).toBe(true)
    expect(out).toEqual({ status: 400, body: { error: 'Request body must be a JSON object', field: '_root', received } })
    expect(slogMock).toHaveBeenCalledWith('glossary', { event: 'putGlossary_rejected', field: '_root', received })
  })
  it('lets an object through without answering', () => {
    const { r, out } = res()
    expect(rejectNonObjectBody({ body: {} } as never, r, 'speakers')).toBe(false)
    expect(out.status).toBe(0)
  })
})
