// Caching, back-off and the automatic-update switch for the OpenRouter
// catalogue. The network is a stub and the cache file lives in a temp dir.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

type Svc = typeof import('./openrouterCatalogue')

const HOUR = 60 * 60 * 1000
const RAW = {
  data: [
    {
      id: 'vendor/model',
      name: 'Vendor: Model',
      context_length: 100000,
      pricing: { prompt: '0.000001', completion: '0.000002' },
      top_provider: { max_completion_tokens: 8000, is_moderated: false },
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      supported_parameters: ['max_tokens'],
    },
  ],
}

let WORK: string
let svc: Svc
const fetchMock = vi.fn()

function ok(body: unknown = RAW) {
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))
}

async function saveCache(ageMs: number) {
  const fetchedAt = new Date(Date.now() - ageMs).toISOString()
  await fs.writeFile(
    path.join(WORK, 'openrouter-models.json'),
    JSON.stringify({ fetchedAt, models: svc.normaliseCatalogue(RAW) }),
  )
  return fetchedAt
}

beforeEach(async () => {
  WORK = await fs.mkdtemp(path.join(tmpdir(), 'or-cat-'))
  vi.resetModules()
  vi.doMock('../../../platform/appData.js', async () => {
    const actual = await vi.importActual<typeof import('../../../platform/appData')>(
      '../../../platform/appData.js',
    )
    return { ...actual, openrouterCatalogueFile: () => path.join(WORK, 'openrouter-models.json') }
  })
  svc = await import('./openrouterCatalogue.js')
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.doUnmock('../../../platform/appData.js')
  vi.resetModules()
  await fs.rm(WORK, { recursive: true, force: true })
})

describe('getCatalogue: current caching', () => {
  it('serves a fresh cache without any request', async () => {
    const at = await saveCache(HOUR)
    const cat = await svc.getCatalogue()
    expect(cat.fetchedAt).toBe(at)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fetches and saves when there is no cache', async () => {
    fetchMock.mockReturnValueOnce(ok())
    const cat = await svc.getCatalogue()
    expect(cat.models.map((m) => m.id)).toEqual(['vendor/model'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe(svc.OPENROUTER_MODELS_URL)
    expect((await svc.readCachedCatalogue())?.fetchedAt).toBe(cat.fetchedAt)
  })

  it('force asks again even when the cache is fresh', async () => {
    await saveCache(HOUR)
    fetchMock.mockReturnValueOnce(ok())
    await svc.getCatalogue({ force: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('throws when the fetch fails and nothing is saved', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    await expect(svc.getCatalogue()).rejects.toThrow('offline')
  })
})

describe('getCatalogue: stale copy', () => {
  it('serves the old copy at once and refreshes behind it', async () => {
    const old = await saveCache(25 * HOUR)
    fetchMock.mockReturnValueOnce(ok())
    const first = await svc.getCatalogue()
    expect(first.fetchedAt).toBe(old)
    await svc.settleCatalogueRefresh()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect((await svc.getCatalogue()).fetchedAt).not.toBe(old)
  })

  it('keeps serving the saved copy when the refresh fails, and marks it stale', async () => {
    const old = await saveCache(25 * HOUR)
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    expect((await svc.getCatalogue()).fetchedAt).toBe(old)
    await svc.settleCatalogueRefresh()
    const status = svc.catalogueStatus(await svc.readCachedCatalogue(), true)
    expect(status.stale).toBe(true)
    // A fixed phrase, never the raw error text: the route is readable from the LAN.
    expect(status.lastError).toBe(svc.LAST_CHECK_FAILED)
    expect(status.source).toBe('openrouter.ai')
  })

  it('hands back a fresh list even when it cannot be saved, and backs off', async () => {
    vi.doMock('../../../platform/appData.js', async () => {
      const actual = await vi.importActual<typeof import('../../../platform/appData')>(
        '../../../platform/appData.js',
      )
      // Reading finds no saved copy; every save fails with a path in its message.
      return {
        ...actual,
        openrouterCatalogueFile: () => path.join(WORK, 'openrouter-models.json'),
        writeJson: async () => {
          throw new Error(`EACCES: permission denied, open '${path.join(WORK, 'openrouter-models.json')}'`)
        },
      }
    })
    vi.resetModules()
    const local = await import('./openrouterCatalogue.js')
    fetchMock.mockReturnValueOnce(ok())
    const cat = await local.getCatalogue({ force: true })
    expect(cat.models).toHaveLength(1)
    const status = local.catalogueStatus(null, true)
    expect(status.lastError).toBe(local.LAST_CHECK_FAILED)
    expect(JSON.stringify(status)).not.toContain(WORK)
    // The fetched list stays in use while the back-off holds off the next
    // attempt, and nothing that reaches a caller names the path.
    const again = await local.getCatalogue()
    expect(again.models).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('reports a fixed phrase, not the raw error, when there is no list and the back-off holds', async () => {
    fetchMock.mockRejectedValueOnce(new Error(`EACCES: permission denied, open '${WORK}'`))
    await expect(svc.getCatalogue()).rejects.toThrow()
    await expect(svc.getCatalogue()).rejects.toThrow(svc.LAST_CHECK_FAILED)
    await svc.getCatalogue().catch((err: Error) => expect(err.message).not.toContain(WORK))
  })

  it('a forced refresh that fails still serves the saved copy', async () => {
    const old = await saveCache(2 * HOUR)
    fetchMock.mockRejectedValueOnce(new Error('HTTP 503'))
    expect((await svc.getCatalogue({ force: true })).fetchedAt).toBe(old)
  })
})

describe('getCatalogue: back-off', () => {
  it('does not retry on every request after a failure', async () => {
    await saveCache(25 * HOUR)
    fetchMock.mockRejectedValue(new Error('offline'))
    await svc.getCatalogue()
    await svc.settleCatalogueRefresh()
    await svc.getCatalogue()
    await svc.getCatalogue()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('waits an hour after the first failure, then two, then four', async () => {
    await saveCache(25 * HOUR)
    fetchMock.mockRejectedValue(new Error('offline'))
    const attempt = async () => {
      await svc.getCatalogue()
      await svc.settleCatalogueRefresh()
    }
    await attempt()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    vi.setSystemTime(Date.now() + HOUR - 1000)
    await attempt()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    vi.setSystemTime(Date.now() + 2000)
    await attempt()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    vi.setSystemTime(Date.now() + 2 * HOUR - 1000)
    await attempt()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    vi.setSystemTime(Date.now() + 2000)
    await attempt()
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('caps the wait at the TTL', () => {
    expect(svc.backoffDelayMs(1)).toBe(HOUR)
    expect(svc.backoffDelayMs(3)).toBe(4 * HOUR)
    expect(svc.backoffDelayMs(10)).toBe(svc.CATALOGUE_TTL_MS)
    expect(svc.backoffDelayMs(0)).toBe(0)
  })

  it('an explicit refresh ignores the wait and a success clears it', async () => {
    await saveCache(25 * HOUR)
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    await svc.getCatalogue()
    await svc.settleCatalogueRefresh()
    fetchMock.mockReturnValueOnce(ok())
    await svc.getCatalogue({ force: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(svc.catalogueStatus(await svc.readCachedCatalogue(), true).stale).toBe(false)
  })

  it('shares one request between concurrent callers', async () => {
    fetchMock.mockReturnValue(ok())
    await Promise.all([svc.getCatalogue(), svc.getCatalogue(), svc.getCatalogue()])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('getCatalogue: automatic updates off', () => {
  it('never fetches by itself, however old the saved copy is', async () => {
    const old = await saveCache(400 * 24 * HOUR)
    const cat = await svc.getCatalogue({ autoUpdate: false })
    expect(cat.fetchedAt).toBe(old)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(svc.catalogueStatus(cat, false).stale).toBe(true)
  })

  it('does not fetch when nothing is saved either; it reports that instead', async () => {
    await expect(svc.getCatalogue({ autoUpdate: false })).rejects.toThrow(/automatic updates are off/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('an explicit refresh still fetches', async () => {
    await saveCache(400 * 24 * HOUR)
    fetchMock.mockReturnValueOnce(ok())
    const cat = await svc.getCatalogue({ force: true, autoUpdate: false })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(Date.now() - Date.parse(cat.fetchedAt)).toBeLessThan(5000)
  })
})

describe('getCatalogue: offline with an empty cache', () => {
  it('rejects, then stops asking until the back-off ends', async () => {
    fetchMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND openrouter.ai'))
    await expect(svc.getCatalogue()).rejects.toThrow('ENOTFOUND')
    // While the back-off holds, the reply is a fixed phrase, not the raw error.
    await expect(svc.getCatalogue()).rejects.toThrow(svc.LAST_CHECK_FAILED)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(svc.findModel(null, 'vendor/model')).toBeNull()
  })
})
