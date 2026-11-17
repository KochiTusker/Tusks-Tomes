import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiJson, type ApiErrorMode } from './apiClient'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(() => vi.unstubAllGlobals())

function answer(status: number, body: string) {
  vi.mocked(fetch).mockImplementation(async () => new Response(body, { status }))
}

async function message(mode: ApiErrorMode, extra: { bodySlice?: number; errorPrefix?: string } = {}) {
  const err = await apiJson('/api/x', { method: 'PUT', body: {}, errorMode: mode, ...extra }).then(
    () => null,
    (e: Error) => e,
  )
  return err?.message
}

describe('apiJson', () => {
  it('returns the parsed body, and nothing for parse none', async () => {
    answer(200, '{"a":1}')
    expect(await apiJson('/api/x', { errorMode: 'status' })).toEqual({ a: 1 })
    answer(200, '')
    expect(await apiJson('/api/x', { method: 'DELETE', errorMode: 'status', parse: 'none' })).toBeUndefined()
  })

  it('words each failure mode as the callers did', async () => {
    answer(500, 'z'.repeat(10))
    expect(await message('status')).toBe('PUT /api/x failed: HTTP 500')
    expect(await message('text', { bodySlice: 4 })).toBe('PUT /api/x failed: HTTP 500. zzzz')
    expect(await message('http')).toBe('HTTP 500')
    expect(await message('http-text', { bodySlice: 4 })).toBe('HTTP 500: zzzz')
    expect(await message('status', { errorPrefix: 'save' })).toBe('save failed: HTTP 500')
    expect(await message('json')).toBe('HTTP 500')
    answer(500, '{"error":"disk full"}')
    expect(await message('json')).toBe('disk full')
  })

  it('sends a bare GET with one argument and a body as JSON with its header', async () => {
    answer(200, '{}')
    await apiJson('/api/x', { errorMode: 'status' })
    expect(vi.mocked(fetch).mock.calls[0]).toEqual(['/api/x'])
    await apiJson('/api/x', { method: 'POST', body: { k: 1 }, errorMode: 'status' })
    expect(vi.mocked(fetch).mock.calls[1]).toEqual([
      '/api/x',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"k":1}' },
    ])
  })
})
