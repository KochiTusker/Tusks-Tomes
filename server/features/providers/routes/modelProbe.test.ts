import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { probeGeminiKey } from './modelProbe.js'

// Hoisted variables (vi.mock factories run before top-level imports).
const cacheStore = vi.hoisted<{ value: Record<string, unknown> }>(() => ({ value: {} }))

// modelProbe writes the cache through readJson/writeJson — stub those out so
// the test doesn't touch the real config directory.
vi.mock('../../../platform/appData.js', () => ({
  modelAvailabilityFile: () => '/test/model-availability.json',
  readJson: async <T,>(_p: string, def: T) => cacheStore.value as T ?? def,
  writeJson: async (_p: string, v: unknown) => {
    cacheStore.value = v as Record<string, unknown>
  },
}))

type FetchCall = { url: string; body?: string }
let fetchCalls: FetchCall[] = []

// Build a fetch impl that:
//   - returns a synthetic /v1beta/models response for the list URL
//   - returns a configurable response for each generateContent URL
function setupFetch(opts: {
  advertisedModels: Array<{ id: string; supportsGenerate?: boolean }>
  probeBehaviour: Record<string, { ok: true } | { ok: false; status: number; body: string }>
}) {
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input)
    fetchCalls.push({ url, body: typeof init?.body === 'string' ? init.body : undefined })
    if (url.includes('/v1beta/models?') || url.endsWith('/v1beta/models')) {
      return new Response(
        JSON.stringify({
          models: opts.advertisedModels.map((m) => ({
            name: `models/${m.id}`,
            supportedGenerationMethods: m.supportsGenerate === false ? [] : ['generateContent'],
          })),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    // generateContent URL — extract the model id between /models/ and :generateContent.
    const match = url.match(/\/v1beta\/models\/([^:]+):generateContent/)
    const id = match ? decodeURIComponent(match[1]) : ''
    const behaviour = opts.probeBehaviour[id]
    if (!behaviour) {
      return new Response('not configured', { status: 500 })
    }
    if (behaviour.ok) {
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(behaviour.body, { status: behaviour.status })
  })
  vi.stubGlobal('fetch', fetchMock)
}

describe('probeGeminiKey', () => {
  beforeEach(() => {
    fetchCalls = []
    cacheStore.value = {}
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reports each generateContent-capable model with its probe outcome', async () => {
    setupFetch({
      advertisedModels: [
        { id: 'gemini-2.5-pro' },
        { id: 'gemini-2.5-flash' },
        // Embedding models advertise embedContent, not generateContent, so
        // they fall outside the probe set. That capability check is the ONLY
        // gate — the probe deliberately does not filter on the model's family
        // name, or a Gemini generation named outside the pro/flash vocabulary
        // would never be tested and would never reach the picker.
        { id: 'text-embedding-004', supportsGenerate: false },
      ],
      probeBehaviour: {
        'gemini-2.5-pro': {
          ok: false,
          status: 429,
          body: '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"...generate_content_free_tier_requests...","details":[{"violations":[{"quotaMetric":"generate_content_free_tier_requests","quotaId":"...","quotaDimensions":{"model":"gemini-2.5-pro"}}]}]}}'.replace(
            'free_tier_requests',
            'free_tier_requests","limit":0,"x":"',
          ),
        },
        'gemini-2.5-flash': { ok: true },
      },
    })

    const result = await probeGeminiKey('test-key')

    // /v1beta/models was called.
    expect(fetchCalls[0].url).toContain('/v1beta/models?')

    // Only generateContent-capable models were probed.
    const probedIds = result.probed.map((p) => p.id)
    expect(probedIds).toContain('gemini-2.5-pro')
    expect(probedIds).toContain('gemini-2.5-flash')
    expect(probedIds).not.toContain('text-embedding-004')

    // The 2.5-pro probe came back inaccessible with the free-tier reason.
    const pro = result.probed.find((p) => p.id === 'gemini-2.5-pro')
    expect(pro?.accessible).toBe(false)
    expect(pro?.reason).toContain('Free tier quota: 0')

    // The 2.5-flash probe came back accessible.
    const flash = result.probed.find((p) => p.id === 'gemini-2.5-flash')
    expect(flash?.accessible).toBe(true)

    // The advertised list contains every model the listing returned (incl. embeddings).
    expect(result.advertised).toEqual(
      expect.arrayContaining(['gemini-2.5-pro', 'gemini-2.5-flash', 'text-embedding-004']),
    )

    // Fingerprint is a 6-char hex prefix of sha256(apiKey) and is stable for
    // the same input.
    expect(result.keyFingerprint).toMatch(/^[0-9a-f]{6}$/)
  })

  // The regression this whole path exists to prevent. Before tier-agnostic
  // probing, a Gemini family named outside the pro/flash vocabulary was
  // advertised by ListModels, skipped by the probe, and then dropped by the
  // picker (which returns early as soon as any probed model is accessible, so
  // it never reached the advertised-only fallback). The model was invisible
  // with no warning anywhere — the worst failure mode available, because
  // nothing told the user a model was missing.
  it('probes a model family it has never seen and tiers it as other', async () => {
    setupFetch({
      advertisedModels: [
        { id: 'gemini-2.5-flash' },
        { id: 'gemini-4-ultra' }, // hypothetical future family: no pro/flash/lite in the name
      ],
      probeBehaviour: {
        'gemini-2.5-flash': { ok: true },
        'gemini-4-ultra': { ok: true },
      },
    })

    const result = await probeGeminiKey('test-key')

    const ultra = result.probed.find((p) => p.id === 'gemini-4-ultra')
    expect(ultra?.accessible).toBe(true)
    expect(ultra?.tier).toBe('other')

    // Known families still classify correctly alongside it.
    expect(result.probed.find((p) => p.id === 'gemini-2.5-flash')?.tier).toBe('flash')
  })

  it('stamps flash-lite ahead of flash so the cheapest tier survives', async () => {
    setupFetch({
      advertisedModels: [
        { id: 'gemini-2.5-flash-lite' },
        { id: 'gemini-flash-lite-latest' },
        { id: 'gemini-pro-latest' },
      ],
      probeBehaviour: {
        'gemini-2.5-flash-lite': { ok: true },
        'gemini-flash-lite-latest': { ok: true },
        'gemini-pro-latest': { ok: true },
      },
    })

    const result = await probeGeminiKey('test-key')
    const tierOf = (id: string) => result.probed.find((p) => p.id === id)?.tier

    // Every flash-lite id also contains 'flash'. If the classifier tested
    // 'flash' first these would both land in the Flash tier and Flash Lite
    // would disappear from the picker entirely.
    expect(tierOf('gemini-2.5-flash-lite')).toBe('flash-lite')
    expect(tierOf('gemini-flash-lite-latest')).toBe('flash-lite')
    expect(tierOf('gemini-pro-latest')).toBe('pro')
  })

  it('emits different fingerprints for different keys', async () => {
    setupFetch({
      advertisedModels: [{ id: 'gemini-2.5-flash' }],
      probeBehaviour: { 'gemini-2.5-flash': { ok: true } },
    })
    const a = await probeGeminiKey('key-A')
    const b = await probeGeminiKey('key-B')
    const c = await probeGeminiKey('key-A')
    expect(a.keyFingerprint).not.toEqual(b.keyFingerprint)
    expect(a.keyFingerprint).toEqual(c.keyFingerprint)
  })

  it('classifies 403 as forbidden rather than free-tier-quota', async () => {
    setupFetch({
      advertisedModels: [{ id: 'gemini-2.5-pro' }],
      probeBehaviour: {
        'gemini-2.5-pro': { ok: false, status: 403, body: '{"error":{"code":403}}' },
      },
    })
    const result = await probeGeminiKey('test-key')
    const entry = result.probed.find((p) => p.id === 'gemini-2.5-pro')
    expect(entry?.accessible).toBe(false)
    expect(entry?.reason).toContain('Forbidden')
  })

  it('throws when /v1beta/models itself fails', async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (String(input).includes('/v1beta/models')) {
        return new Response('Bad key', { status: 401 })
      }
      return new Response('unreached', { status: 500 })
    })
    vi.stubGlobal('fetch', fetchMock)
    await expect(probeGeminiKey('bad')).rejects.toThrow(/HTTP 401/)
  })
})
