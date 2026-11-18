// GET /api/openrouter/models: the automatic-update switch, back-off and the
// offline path, end to end through the router. OpenRouter is a stub; the cache
// file lives in a temp dir and the setting is mocked.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { withRouter } from '../../../testing/httpFixture.js'

const MODELS_URL = 'https://openrouter.ai/api/v1/models'
const PROVIDERS_URL = 'https://openrouter.ai/api/frontend/v1/all-providers'
const HOUR = 60 * 60 * 1000

const RAW_MODELS = {
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
const RAW_PROVIDERS = { data: [{ displayName: 'Vendor', dataPolicy: { training: false, retainsPrompts: true } }] }

let WORK: string
let autoUpdate = true
let online = true
const openRouterCalls: string[] = []
const realFetch = globalThis.fetch

function stubFetch() {
  vi.stubGlobal('fetch', (input: unknown, init?: RequestInit) => {
    const url = String(input)
    if (!url.startsWith('https://openrouter.ai')) return realFetch(input as string, init)
    openRouterCalls.push(url)
    if (!online) return Promise.reject(new Error('getaddrinfo ENOTFOUND openrouter.ai'))
    const body = url === MODELS_URL ? RAW_MODELS : RAW_PROVIDERS
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))
  })
}

async function saveCache(ageMs: number) {
  const { normaliseCatalogue } = await import('../services/openrouterCatalogue.js')
  await fs.writeFile(
    path.join(WORK, 'openrouter-models.json'),
    JSON.stringify({
      fetchedAt: new Date(Date.now() - ageMs).toISOString(),
      models: normaliseCatalogue(RAW_MODELS),
    }),
  )
}

async function load() {
  const mod = await import('./openrouterModels.js')
  return mod
}

async function get(baseUrl: string, query = '') {
  const res = await fetch(`${baseUrl}/models${query}`)
  return { status: res.status, body: (await res.json()) as Record<string, any> }
}

beforeEach(async () => {
  WORK = await fs.mkdtemp(path.join(tmpdir(), 'or-route-'))
  autoUpdate = true
  online = true
  openRouterCalls.length = 0
  vi.resetModules()
  vi.doMock('../../../platform/appData.js', async () => {
    const actual = await vi.importActual<typeof import('../../../platform/appData')>(
      '../../../platform/appData.js',
    )
    return {
      ...actual,
      openrouterCatalogueFile: () => path.join(WORK, 'openrouter-models.json'),
      openrouterPoliciesFile: () => path.join(WORK, 'openrouter-providers.json'),
    }
  })
  vi.doMock('../../../platform/modelListSetting.js', () => ({
    readAutoUpdateModelList: async () => autoUpdate,
  }))
  stubFetch()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.doUnmock('../../../platform/appData.js')
  vi.doUnmock('../../../platform/modelListSetting.js')
  vi.resetModules()
  await fs.rm(WORK, { recursive: true, force: true })
})

describe('GET /api/openrouter/models', () => {
  it('fetches both lists on first use and reports where they came from', async () => {
    const { openrouterModelsRouter } = await load()
    await withRouter('/api/openrouter', openrouterModelsRouter(), async (base) => {
      const { status, body } = await get(base)
      expect(status).toBe(200)
      expect(body.models).toHaveLength(1)
      expect(body.providerPolicies).toHaveLength(1)
      expect(body.status).toMatchObject({ source: 'openrouter.ai', autoUpdate: true, stale: false })
      expect(openRouterCalls.sort()).toEqual([PROVIDERS_URL, MODELS_URL].sort())
    })
  })

  it('makes no request to either OpenRouter URL when automatic updates are off', async () => {
    autoUpdate = false
    await saveCache(400 * 24 * HOUR)
    const { openrouterModelsRouter } = await load()
    await withRouter('/api/openrouter', openrouterModelsRouter(), async (base) => {
      const { body } = await get(base)
      expect(body.models).toHaveLength(1)
      expect(body.providerPolicies).toEqual([])
      expect(body.status).toMatchObject({ autoUpdate: false, stale: true })
      expect(openRouterCalls).toEqual([])
    })
  })

  it('still fetches both when the user re-checks, even with automatic updates off', async () => {
    autoUpdate = false
    await saveCache(400 * 24 * HOUR)
    const { openrouterModelsRouter } = await load()
    await withRouter('/api/openrouter', openrouterModelsRouter(), async (base) => {
      const { body } = await get(base, '?refresh=1')
      expect(openRouterCalls.sort()).toEqual([PROVIDERS_URL, MODELS_URL].sort())
      expect(body.providerPolicies).toHaveLength(1)
      expect(body.status).toMatchObject({ autoUpdate: false, stale: false })
      // ...and the saved copy is then used with no further requests.
      openRouterCalls.length = 0
      await get(base)
      expect(openRouterCalls).toEqual([])
    })
  })

  it('keeps the provider policies across a restart, so automatic updates off still shows them', async () => {
    await saveCache(0)
    const first = await load()
    await withRouter('/api/openrouter', first.openrouterModelsRouter(), async (base) => {
      expect((await get(base)).body.providerPolicies).toHaveLength(1)
    })
    // A fresh module stands in for a restart: nothing in memory, only the files.
    vi.resetModules()
    autoUpdate = false
    openRouterCalls.length = 0
    const second = await load()
    await withRouter('/api/openrouter', second.openrouterModelsRouter(), async (base) => {
      // Two requests at once, as the app and the model-list strip make at startup:
      // both wait for the one read of the saved file.
      const [a, b] = await Promise.all([get(base), get(base)])
      const saved = [{ name: 'Vendor', trains: false, retains: true, retentionDays: null }]
      expect(a.body.providerPolicies).toEqual(saved)
      expect(b.body.providerPolicies).toEqual(saved)
      expect(openRouterCalls).toEqual([])
    })
  })

  it('ignores saved policies dated in the future', async () => {
    autoUpdate = false
    await saveCache(0)
    await fs.writeFile(
      path.join(WORK, 'openrouter-providers.json'),
      JSON.stringify({
        fetchedAt: Date.now() + 30 * 24 * HOUR,
        policies: [{ name: 'Vendor', trains: false, retains: false, retentionDays: null }],
      }),
    )
    const { openrouterModelsRouter } = await load()
    await withRouter('/api/openrouter', openrouterModelsRouter(), async (base) => {
      expect((await get(base)).body.providerPolicies).toEqual([])
    })
  })

  it('drops malformed saved policy rows and ignores an unreadable file', async () => {
    autoUpdate = false
    await saveCache(0)
    const file = path.join(WORK, 'openrouter-providers.json')
    await fs.writeFile(
      file,
      JSON.stringify({
        fetchedAt: Date.now(),
        policies: [
          { name: 'Good', trains: true, retains: false, retentionDays: 30 },
          { name: 'NoFlags' },
          { name: 'BadDays', trains: false, retains: false, retentionDays: '30' },
        ],
      }),
    )
    const { openrouterModelsRouter } = await load()
    await withRouter('/api/openrouter', openrouterModelsRouter(), async (base) => {
      expect((await get(base)).body.providerPolicies).toEqual([
        { name: 'Good', trains: true, retains: false, retentionDays: 30 },
      ])
    })
    vi.resetModules()
    await fs.writeFile(file, '{ not json')
    const again = await load()
    await withRouter('/api/openrouter', again.openrouterModelsRouter(), async (base) => {
      const { status, body } = await get(base)
      expect(status).toBe(200)
      expect(body.models).toHaveLength(1)
      expect(body.providerPolicies).toEqual([])
    })
  })

  it('serves the saved list, marked stale, when OpenRouter cannot be reached', async () => {
    await saveCache(25 * HOUR)
    online = false
    const { openrouterModelsRouter, settlePolicyRefresh } = await load()
    const { settleCatalogueRefresh } = await import('../services/openrouterCatalogue.js')
    await withRouter('/api/openrouter', openrouterModelsRouter(), async (base) => {
      const first = await get(base)
      expect(first.body.models).toHaveLength(1)
      await settleCatalogueRefresh()
      await settlePolicyRefresh()
      const second = await get(base)
      expect(second.body.models).toHaveLength(1)
      expect(second.body.status).toMatchObject({ stale: true })
      expect(second.body.status.lastError).toBeTruthy()
      expect(second.body.status.lastError).not.toContain('ENOTFOUND')
      // One attempt per list, then back-off: the second page load asked for nothing.
      expect(openRouterCalls).toHaveLength(2)
    })
  })

  it('works with an empty cache and no network: an empty list, not an error status', async () => {
    online = false
    const { openrouterModelsRouter } = await load()
    await withRouter('/api/openrouter', openrouterModelsRouter(), async (base) => {
      const first = await get(base)
      expect(first.status).toBe(200)
      expect(first.body).toMatchObject({ ok: false, models: [], providerPolicies: [] })
      const calls = openRouterCalls.length
      await get(base)
      await get(base)
      expect(openRouterCalls.length).toBe(calls)
    })
  })

  it('with an empty cache and automatic updates off, asks for nothing and says why', async () => {
    autoUpdate = false
    const { openrouterModelsRouter } = await load()
    await withRouter('/api/openrouter', openrouterModelsRouter(), async (base) => {
      const { status, body } = await get(base)
      expect(status).toBe(200)
      expect(body).toMatchObject({ ok: false, models: [] })
      expect(body.error).toMatch(/automatic updates are off/)
      expect(openRouterCalls).toEqual([])
    })
  })
})
