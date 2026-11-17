import { describe, it, expect, vi, afterEach } from 'vitest'
import { asyncRoute } from './asyncRoute.js'

afterEach(() => vi.restoreAllMocks())

function fakeRes() {
  const out = { status: 0, body: undefined as unknown }
  const res = { status: (s: number) => { out.status = s; return res }, json: (b: unknown) => { out.body = b } }
  return { res: res as never, out }
}

describe('asyncRoute', () => {
  it('passes the request and response through and leaves a handled response alone', async () => {
    const { res, out } = fakeRes()
    const seen: unknown[] = []
    await asyncRoute('t', async (req, r) => { seen.push(req, r) })({ id: 1 } as never, res, vi.fn())
    expect(seen).toEqual([{ id: 1 }, res])
    expect(out.status).toBe(0)
  })

  it('logs a thrown error under the tag and answers 500 with its message', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { res, out } = fakeRes()
    const boom = new Error('boom')
    await asyncRoute('api/x GET', async () => { throw boom })({} as never, res, vi.fn())
    expect(spy).toHaveBeenCalledWith('[api/x GET] failed:', boom)
    expect(out).toEqual({ status: 500, body: { error: 'boom' } })
  })

  it('also catches a synchronous throw', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { res, out } = fakeRes()
    await asyncRoute('t', () => { throw new Error('sync') })({} as never, res, vi.fn())
    expect(out.body).toEqual({ error: 'sync' })
  })
})
