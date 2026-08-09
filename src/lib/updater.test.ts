// Contract test for the updater client. Pins the Phase 1.5 invariant
// from the UI side: applyUpdate MUST send the full 40-char confirmRemoteHead
// in the request body. A regression in [UpdaterCard.tsx:203](src/components/UpdaterCard.tsx:203)
// (e.g. passing shortSha as a "convenient default") would silently
// degrade the intent-capture defence even if the server still requires
// 40 chars — the user would get a 412 every time they tried to update.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyUpdate } from './updater'

describe('applyUpdate — request body contract', () => {
  let originalFetch: typeof fetch
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    originalFetch = globalThis.fetch
    fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, applied: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    globalThis.fetch = fetchSpy as unknown as typeof fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('POSTs to /api/updater/apply', async () => {
    await applyUpdate({ confirmRemoteHead: 'a'.repeat(40) })
    expect(fetchSpy).toHaveBeenCalledOnce()
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/updater/apply')
    expect(init.method).toBe('POST')
  })

  it('passes the FULL 40-char sha as confirmRemoteHead', async () => {
    const fullSha = 'a1b2c3d4e5f6789012345678901234567890abcd'
    await applyUpdate({ confirmRemoteHead: fullSha })
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.confirmRemoteHead).toBe(fullSha)
    expect(body.confirmRemoteHead.length).toBe(40)
  })

  it('sends Content-Type: application/json', async () => {
    await applyUpdate({ confirmRemoteHead: 'a'.repeat(40) })
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('returns the parsed response body on success', async () => {
    const result = await applyUpdate({ confirmRemoteHead: 'a'.repeat(40) })
    expect(result.ok).toBe(true)
    expect(result.applied).toBe(true)
  })

  it('returns a non-throwing body on a 412 with a structured error', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'confirmRemoteHead mismatch', ok: false }), {
        status: 412,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const result = await applyUpdate({ confirmRemoteHead: 'a'.repeat(40) })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/mismatch/)
  })

  it('throws a Network-error message on transport failure', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    await expect(applyUpdate({ confirmRemoteHead: 'a'.repeat(40) })).rejects.toThrow(
      /Network error/,
    )
  })

  it('throws on a non-JSON 500 with no body shape', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response('Internal Server Error (plain text)', { status: 500 }),
    )
    await expect(applyUpdate({ confirmRemoteHead: 'a'.repeat(40) })).rejects.toThrow(
      /HTTP 500/,
    )
  })
})
