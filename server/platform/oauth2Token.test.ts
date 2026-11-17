import { describe, it, expect, vi, afterEach } from 'vitest'
import { createOAuth2TokenSource } from './oauth2Token.js'

afterEach(() => vi.restoreAllMocks())

function mockFetch(impl: () => Promise<unknown>) {
  const f = vi.fn(impl)
  vi.stubGlobal('fetch', f)
  return f
}

describe('createOAuth2TokenSource', () => {
  it('posts a form body, caches the token, and forgets on request', async () => {
    const f = mockFetch(async () => ({ ok: true, json: async () => ({ access_token: 't1' }) }))
    const src = createOAuth2TokenSource()
    expect(await src.get('http://h', 'u', 'p')).toBe('t1')
    expect(await src.get('http://h', 'u', 'p')).toBe('t1')
    expect(f).toHaveBeenCalledTimes(1)
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://h/token')
    expect(init.method).toBe('POST')
    expect(init.body).toBe('username=u&password=p')
    expect(init.signal).toBeUndefined()
    src.forget('http://h', 'u')
    await src.get('http://h', 'u', 'p')
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('applies a timeout signal only when asked', async () => {
    const f = mockFetch(async () => ({ ok: true, json: async () => ({ access_token: 't' }) }))
    await createOAuth2TokenSource({ timeoutMs: 5000 }).get('http://h', 'u', 'p')
    expect((f.mock.calls[0] as unknown as [string, RequestInit])[1].signal).toBeInstanceOf(AbortSignal)
  })

  it('returns null for a refusal, a missing token or a network error, and caches nothing', async () => {
    const src = createOAuth2TokenSource()
    mockFetch(async () => ({ ok: false }))
    expect(await src.get('http://h', 'u', 'p')).toBeNull()
    mockFetch(async () => ({ ok: true, json: async () => ({}) }))
    expect(await src.get('http://h', 'u', 'p')).toBeNull()
    mockFetch(async () => { throw new Error('down') })
    expect(await src.get('http://h', 'u', 'p')).toBeNull()
  })

  it('clear drops every cached token; sources do not share a cache', async () => {
    const f = mockFetch(async () => ({ ok: true, json: async () => ({ access_token: 't' }) }))
    const a = createOAuth2TokenSource()
    const b = createOAuth2TokenSource()
    await a.get('http://h', 'u', 'p')
    await b.get('http://h', 'u', 'p')
    expect(f).toHaveBeenCalledTimes(2)
    a.clear()
    await a.get('http://h', 'u', 'p')
    expect(f).toHaveBeenCalledTimes(3)
  })
})
