// @vitest-environment jsdom
// What each module sends and what a person reads when the server says no.
// These pin the wording and the request shape so the modules can share one
// client without either moving.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getProfiles, putProfiles } from '@/features/providers/lib/profiles'
import { getRouting } from '@/features/routing/lib/routing'
import { createLoreFolder, getLoreStatus, saveChronicleToLore } from '@/features/lore/lib/lore'
import { exportChronicleToVault, getVaultPairStatus } from '@/features/lore/lib/vault'
import {
  deleteProviderKey,
  getAvailabilityCache,
  getProvidersSummary,
  putProviderKey,
} from '@/features/providers/lib/providerSettings'
import {
  deleteChronicle,
  getChronicle,
  listChronicles,
  saveChronicle,
  updateChronicle,
} from '@/features/library/lib/chronicleLibrary'
import { deleteRun, listRuns } from '@/features/pipeline/lib/runStorage'
import {
  checkForUpdates,
  getUpdaterStatus,
  lockDevMode,
  switchToPublicRemote,
} from '@/features/maintenance/lib/updater'
import {
  clearUnslothConfig,
  detectLocalBackends,
  getProbeResults,
  getUnslothConfig,
  putUnslothConfig,
  runProbe,
} from '@/features/providers/lib/localLLM'
import { getLiveSession, refreshLiveLabels } from '@/features/transcription/lib/liveSession'
import { deleteSession, listSessions } from '@/features/transcription/lib/sessionsClient'
import { probeClaudeCode } from '@/features/providers/lib/connections'

const JSON_HEADERS = { 'Content-Type': 'application/json' }

type Case = {
  name: string
  call: () => Promise<unknown>
  url: string
  /** The second argument fetch receives; undefined for a bare GET. */
  init?: RequestInit
  /** What a 503 with the body "nope" reads as. */
  message: string
}

const doc = { version: 1 } as never

const CASES: Case[] = [
  { name: 'probeClaudeCode', call: () => probeClaudeCode(), url: '/api/claude-code/status', message: 'HTTP 503' },
  { name: 'getProfiles', call: () => getProfiles(), url: '/api/profiles', message: 'GET /api/profiles failed: HTTP 503' },
  {
    name: 'putProfiles',
    call: () => putProfiles(doc),
    url: '/api/profiles',
    init: { method: 'PUT', headers: JSON_HEADERS, body: '{"version":1}' },
    message: 'PUT /api/profiles failed: HTTP 503. nope',
  },
  { name: 'getRouting', call: () => getRouting(), url: '/api/routing', message: 'GET /api/routing failed: HTTP 503' },
  { name: 'getLoreStatus', call: () => getLoreStatus(), url: '/api/lore/status', message: 'GET /api/lore/status failed: HTTP 503. nope' },
  { name: 'createLoreFolder', call: () => createLoreFolder(), url: '/api/lore/create', init: { method: 'POST' }, message: 'HTTP 503' },
  {
    name: 'saveChronicleToLore',
    call: () => saveChronicleToLore({ chronicle: 'c' } as never),
    url: '/api/lore/save-chronicle',
    init: { method: 'POST', headers: JSON_HEADERS, body: '{"chronicle":"c"}' },
    message: 'HTTP 503',
  },
  { name: 'getVaultPairStatus', call: () => getVaultPairStatus(), url: '/api/vault/pair', message: 'GET /api/vault/pair failed: HTTP 503. nope' },
  {
    name: 'exportChronicleToVault',
    call: () => exportChronicleToVault({ campaign: 'c' } as never),
    url: '/api/vault/export-chronicle',
    init: { method: 'POST', headers: JSON_HEADERS, body: '{"campaign":"c"}' },
    message: 'HTTP 503',
  },
  { name: 'getProvidersSummary', call: () => getProvidersSummary(), url: '/api/providers', message: 'GET /api/providers failed: HTTP 503' },
  {
    name: 'putProviderKey',
    call: () => putProviderKey('gemini', 'k'),
    url: '/api/providers/gemini',
    init: { method: 'PUT', headers: JSON_HEADERS, body: '{"key":"k"}' },
    message: 'PUT /api/providers/gemini failed: HTTP 503. nope',
  },
  {
    name: 'deleteProviderKey',
    call: () => deleteProviderKey('gemini'),
    url: '/api/providers/gemini',
    init: { method: 'DELETE' },
    message: 'DELETE /api/providers/gemini failed: HTTP 503. nope',
  },
  {
    name: 'getAvailabilityCache',
    call: () => getAvailabilityCache(),
    url: '/api/providers/availability',
    message: 'GET /api/providers/availability failed: HTTP 503',
  },
  { name: 'listChronicles', call: () => listChronicles(), url: '/api/chronicle-library', message: 'GET /api/chronicle-library failed: HTTP 503' },
  {
    name: 'getChronicle',
    call: () => getChronicle('a b'),
    url: '/api/chronicle-library/a%20b',
    message: 'GET /api/chronicle-library/a b failed: HTTP 503',
  },
  {
    name: 'saveChronicle',
    call: () => saveChronicle({ title: 't' } as never),
    url: '/api/chronicle-library',
    init: { method: 'POST', headers: JSON_HEADERS, body: '{"title":"t"}' },
    message: 'POST /api/chronicle-library failed: HTTP 503. nope',
  },
  {
    name: 'updateChronicle',
    call: () => updateChronicle('a b', { title: 't' } as never),
    url: '/api/chronicle-library/a%20b',
    init: { method: 'PUT', headers: JSON_HEADERS, body: '{"title":"t"}' },
    message: 'PUT /api/chronicle-library/a b failed: HTTP 503. nope',
  },
  {
    name: 'deleteChronicle',
    call: () => deleteChronicle('a b'),
    url: '/api/chronicle-library/a%20b',
    init: { method: 'DELETE' },
    message: 'DELETE /api/chronicle-library/a b failed: HTTP 503',
  },
  { name: 'listRuns', call: () => listRuns(), url: '/api/runs', message: 'GET /api/runs failed: HTTP 503' },
  {
    name: 'deleteRun',
    call: () => deleteRun('r 1'),
    url: '/api/runs/r%201',
    init: { method: 'DELETE' },
    message: 'DELETE /api/runs/r 1 failed: HTTP 503',
  },
  { name: 'getUpdaterStatus', call: () => getUpdaterStatus(), url: '/api/updater/status', message: 'HTTP 503: nope' },
  { name: 'checkForUpdates', call: () => checkForUpdates(), url: '/api/updater/check', init: { method: 'POST' }, message: 'HTTP 503: nope' },
  {
    name: 'switchToPublicRemote',
    call: () => switchToPublicRemote(),
    url: '/api/settings',
    init: { method: 'POST', headers: JSON_HEADERS, body: '{"updaterRemote":"origin"}' },
    message: 'HTTP 503: nope',
  },
  { name: 'lockDevMode', call: () => lockDevMode(), url: '/api/settings/dev-auth/lock', init: { method: 'POST' }, message: 'HTTP 503: nope' },
  { name: 'detectLocalBackends', call: () => detectLocalBackends(), url: '/api/local-llm/detect', message: 'detect failed: HTTP 503' },
  { name: 'getProbeResults', call: () => getProbeResults(), url: '/api/local-llm/probes', message: 'probes failed: HTTP 503' },
  {
    name: 'runProbe',
    call: () => runProbe({ baseUrl: 'u', modelId: 'm' }),
    url: '/api/local-llm/probe',
    init: { method: 'POST', headers: JSON_HEADERS, body: '{"baseUrl":"u","modelId":"m"}' },
    message: 'probe failed: HTTP 503. nope',
  },
  { name: 'getUnslothConfig', call: () => getUnslothConfig(), url: '/api/local-llm/unsloth-config', message: 'unsloth-config failed: HTTP 503' },
  {
    name: 'putUnslothConfig',
    call: () => putUnslothConfig({ baseUrl: 'u' } as never),
    url: '/api/local-llm/unsloth-config',
    init: { method: 'PUT', headers: JSON_HEADERS, body: '{"baseUrl":"u"}' },
    message: 'unsloth-config save failed: HTTP 503. nope',
  },
  {
    name: 'clearUnslothConfig',
    call: () => clearUnslothConfig(),
    url: '/api/local-llm/unsloth-config',
    init: { method: 'DELETE' },
    message: 'unsloth-config clear failed: HTTP 503',
  },
  { name: 'getLiveSession', call: () => getLiveSession('s1'), url: '/api/sessions/s1/live', message: 'GET /api/sessions/s1/live failed: HTTP 503' },
  {
    name: 'refreshLiveLabels',
    call: () => refreshLiveLabels('s1'),
    url: '/api/sessions/s1/live/refresh',
    init: { method: 'POST' },
    message: 'POST live/refresh failed: HTTP 503',
  },
  { name: 'listSessions', call: () => listSessions(), url: '/api/sessions', message: 'GET /api/sessions failed: HTTP 503' },
  {
    name: 'deleteSession',
    call: () => deleteSession('s1'),
    url: '/api/sessions/s1',
    init: { method: 'DELETE' },
    message: 'DELETE /api/sessions/s1 failed: HTTP 503',
  },
]

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(() => vi.unstubAllGlobals())

describe('error text and request shape, module by module', () => {
  for (const c of CASES) {
    it(`${c.name}: a refusal reads as before`, async () => {
      vi.mocked(fetch).mockImplementation(async () => new Response('nope', { status: 503 }))
      const err = await c.call().then(
        () => null,
        (e: Error) => e,
      )
      expect(err?.message).toBe(c.message)
    })

    it(`${c.name}: sends the same request`, async () => {
      vi.mocked(fetch).mockImplementation(async () => new Response('{}', { status: 200 }))
      await c.call().catch(() => undefined)
      const args = vi.mocked(fetch).mock.calls[0]
      expect(args[0]).toBe(c.url)
      if (c.init === undefined) expect(args).toHaveLength(1)
      else expect(args[1]).toEqual(c.init)
    })
  }

  it('lore and vault prefer the error the server wrote', async () => {
    vi.mocked(fetch).mockImplementation(
      async () => new Response(JSON.stringify({ error: 'Vault is read-only' }), { status: 403 }),
    )
    await expect(createLoreFolder()).rejects.toThrow(new Error('Vault is read-only'))
    await expect(exportChronicleToVault({ campaign: 'c' } as never)).rejects.toThrow(
      new Error('Vault is read-only'),
    )
  })

  it('text-mode errors keep only as much of the body as they did', async () => {
    const long = 'y'.repeat(500)
    const check = async (fn: () => Promise<unknown>, keep: number) => {
      vi.mocked(fetch).mockImplementation(async () => new Response(long, { status: 500 }))
      const err = (await fn().then(
        () => null,
        (e: Error) => e,
      )) as Error
      expect(err.message.endsWith('. ' + 'y'.repeat(keep))).toBe(true)
      expect(err.message.length).toBe(err.message.indexOf('. ') + 2 + keep)
    }
    await check(() => getLoreStatus(), 200)
    await check(() => getVaultPairStatus(), 200)
    await check(() => putProfiles(doc), 300)
    await check(() => putProviderKey('gemini', 'k'), 300)
    await check(() => saveChronicle({} as never), 300)
    await check(() => runProbe({ baseUrl: 'u', modelId: 'm' }), 400)
    await check(() => putUnslothConfig({} as never), 300)
  })
})
