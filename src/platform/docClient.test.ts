import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDocClient } from './docClient'

type Doc = { n: number }

function reply(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createDocClient', () => {
  it('fetches once, shares the request, and serves the cache afterwards', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValue(reply(200, { n: 1 }))
    const c = createDocClient<Doc>({ path: '/api/x' })
    expect(c.peek()).toBeNull()
    const [a, b] = await Promise.all([c.get(), c.get()])
    expect(a).toEqual({ n: 1 })
    expect(b).toBe(a)
    await c.get()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(c.peek()).toBe(a)
  })

  it('normalises what the server sent', async () => {
    vi.mocked(fetch).mockResolvedValue(reply(200, { n: 1 }))
    const c = createDocClient<Doc>({ path: '/api/x', normalise: (d) => ({ n: d.n + 1 }) })
    expect(await c.get()).toEqual({ n: 2 })
  })

  it('names the method, path and status when a read fails, and does not cache the failure', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValueOnce(reply(500, 'boom'))
    const c = createDocClient<Doc>({ path: '/api/x' })
    await expect(c.get()).rejects.toThrow('GET /api/x failed: HTTP 500')
    fetchMock.mockResolvedValueOnce(reply(200, { n: 3 }))
    expect(await c.get()).toEqual({ n: 3 })
  })

  it('puts the whole document, caches the answer and tells subscribers', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValue(reply(200, { n: 9 }))
    const c = createDocClient<Doc>({ path: '/api/x' })
    const heard: Doc[] = []
    const off = c.subscribe((d) => heard.push(d))
    expect(await c.put({ n: 5 })).toEqual({ n: 9 })
    expect(fetchMock).toHaveBeenCalledWith('/api/x', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{"n":5}',
    })
    expect(heard).toEqual([{ n: 9 }])
    expect(c.peek()).toEqual({ n: 9 })
    off()
    c.emit({ n: 10 })
    expect(heard).toHaveLength(1)
  })

  it('reports a failed write with the first 400 characters of the body', async () => {
    vi.mocked(fetch).mockResolvedValue(reply(400, 'x'.repeat(500)))
    const c = createDocClient<Doc>({ path: '/api/x' })
    await expect(c.put({ n: 1 })).rejects.toThrow(new RegExp(`^PUT /api/x failed: HTTP 400\. x{400}$`))
  })
})
