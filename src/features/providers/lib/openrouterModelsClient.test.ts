// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CATALOGUE_REFRESHED_EVENT } from '../../../platform/lib/appEvents'

type Client = typeof import('./openrouterModelsClient')

const MODEL = { id: 'vendor/model', name: 'Model', inputPerM: 1, outputPerM: 1, contextLength: 1000 }

function answer(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }))
}

// The memo lives at module level, so each test gets a fresh copy of it.
async function freshClient(): Promise<Client> {
  vi.resetModules()
  return import('./openrouterModelsClient')
}

describe('getOpenRouterCatalogue — forced refreshes', () => {
  const fetchMock = vi.fn()
  const refreshed = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    refreshed.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    window.addEventListener(CATALOGUE_REFRESHED_EVENT, refreshed)
  })

  afterEach(() => {
    window.removeEventListener(CATALOGUE_REFRESHED_EVENT, refreshed)
    vi.unstubAllGlobals()
  })

  it('keeps a good catalogue when a forced refresh fails', async () => {
    const client = await freshClient()
    fetchMock.mockReturnValueOnce(answer({ fetchedAt: '2026-11-01T00:00:00Z', models: [MODEL] }))
    await client.getOpenRouterCatalogue()

    fetchMock.mockReturnValueOnce(answer({ ok: false, error: 'upstream down', models: [] }))
    const forced = await client.getOpenRouterCatalogue({ force: true })
    expect(forced.error).toBe('upstream down')

    // The next plain read is served from the memo, which still holds the list.
    const after = await client.getOpenRouterCatalogue()
    expect(after.models).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('keeps a good catalogue when a forced refresh cannot reach the server', async () => {
    const client = await freshClient()
    fetchMock.mockReturnValueOnce(answer({ fetchedAt: '2026-11-01T00:00:00Z', models: [MODEL] }))
    await client.getOpenRouterCatalogue()

    fetchMock.mockRejectedValueOnce(new Error('offline'))
    await client.getOpenRouterCatalogue({ force: true })
    expect((await client.getOpenRouterCatalogue()).models).toHaveLength(1)
  })

  it('announces a forced refresh only when it came back with models', async () => {
    const client = await freshClient()

    fetchMock.mockReturnValueOnce(answer({ ok: false, error: 'upstream down', models: [] }))
    await client.getOpenRouterCatalogue({ force: true })
    fetchMock.mockReturnValueOnce(answer({}, 503))
    await client.getOpenRouterCatalogue({ force: true })
    expect(refreshed).not.toHaveBeenCalled()

    fetchMock.mockReturnValueOnce(answer({ fetchedAt: '2026-11-16T00:00:00Z', models: [MODEL] }))
    await client.getOpenRouterCatalogue({ force: true })
    expect(refreshed).toHaveBeenCalledTimes(1)
  })

  it('does not announce a plain read', async () => {
    const client = await freshClient()
    fetchMock.mockReturnValueOnce(answer({ fetchedAt: '2026-11-16T00:00:00Z', models: [MODEL] }))
    await client.getOpenRouterCatalogue()
    expect(refreshed).not.toHaveBeenCalled()
  })
})
