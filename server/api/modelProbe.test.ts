import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PROBE_TARGETS,
  probeClaudeKey,
  probeGeminiKey,
  probeOpenAIKey,
} from './modelProbe.js'

// Hoisted variables (vi.mock factories run before top-level imports).
const cacheStore = vi.hoisted<{ value: Record<string, unknown> }>(() => ({ value: {} }))

// modelProbe writes the cache through readJson/writeJson — stub those out so
// the test doesn't touch the real config directory.
vi.mock('../appData.js', () => ({
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

  it('reports each advertised Pro/Flash model with its probe outcome', async () => {
    setupFetch({
      advertisedModels: [
        { id: 'gemini-2.5-pro' },
        { id: 'gemini-2.5-flash' },
        { id: 'text-embedding-004' }, // not a Pro/Flash family — must NOT be probed
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

    // Only Pro/Flash family members were probed (no embedding-model probe).
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

// ────────────────────────────────────────────────────────────────────────
// Claude probe — mirrors the Gemini test shape against api.anthropic.com.
// No live API calls: every fetch is stubbed.
// ────────────────────────────────────────────────────────────────────────

function setupClaudeFetch(opts: {
  /** Per-model probe outcome — keys must be in PROBE_TARGETS.claude. */
  probeBehaviour: Record<string, { ok: true } | { ok: false; status: number; body: string }>
}) {
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input)
    fetchCalls.push({ url, body: typeof init?.body === 'string' ? init.body : undefined })
    if (url === 'https://api.anthropic.com/v1/messages') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string }
      const behaviour = opts.probeBehaviour[body.model ?? '']
      if (!behaviour) return new Response('not configured', { status: 500 })
      if (behaviour.ok) {
        return new Response(JSON.stringify({ id: 'msg_test', content: [{ type: 'text', text: '.' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(behaviour.body, { status: behaviour.status })
    }
    return new Response('unreached', { status: 500 })
  })
  vi.stubGlobal('fetch', fetchMock)
}

describe('probeClaudeKey', () => {
  beforeEach(() => {
    fetchCalls = []
    cacheStore.value = {}
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('probes every model in PROBE_TARGETS.claude and records the outcome', async () => {
    // Make every target accessible.
    const probeBehaviour: Record<string, { ok: true }> = {}
    for (const id of PROBE_TARGETS.claude) probeBehaviour[id] = { ok: true }
    setupClaudeFetch({ probeBehaviour })

    const result = await probeClaudeKey('test-claude-key')

    // Every target was probed (no advertised-list call — Anthropic has no
    // public /v1/models we can rely on, so probed === advertised here).
    expect(result.probed).toHaveLength(PROBE_TARGETS.claude.length)
    for (const target of PROBE_TARGETS.claude) {
      const entry = result.probed.find((p) => p.id === target)
      expect(entry?.accessible).toBe(true)
    }
    expect(result.advertised.sort()).toEqual([...PROBE_TARGETS.claude].sort())

    // Fingerprint shape — same SHA-256/6-char prefix convention as Gemini.
    expect(result.keyFingerprint).toMatch(/^[0-9a-f]{6}$/)

    // Each call went to /v1/messages with the right model in the body.
    const calls = fetchCalls.filter((c) => c.url === 'https://api.anthropic.com/v1/messages')
    expect(calls).toHaveLength(PROBE_TARGETS.claude.length)
  })

  it('classifies 403 as forbidden, 404 as model-not-found', async () => {
    const probeBehaviour: Record<string, { ok: false; status: number; body: string }> = {}
    probeBehaviour['claude-opus-4-7'] = { ok: false, status: 403, body: '{"error":{"type":"permission_denied"}}' }
    probeBehaviour['claude-opus-4-6'] = { ok: false, status: 404, body: '{}' }
    // Fill the rest with accessible.
    for (const id of PROBE_TARGETS.claude) {
      if (!probeBehaviour[id]) {
        ;(probeBehaviour as Record<string, { ok: true } | { ok: false; status: number; body: string }>)[id] = { ok: true }
      }
    }
    setupClaudeFetch({ probeBehaviour })

    const result = await probeClaudeKey('test-claude-key')
    expect(result.probed.find((p) => p.id === 'claude-opus-4-7')?.reason).toContain('Forbidden')
    expect(result.probed.find((p) => p.id === 'claude-opus-4-6')?.reason).toContain('not found')
  })

  it('classifies 400 invalid_request_error as "model not available"', async () => {
    const probeBehaviour: Record<string, { ok: false; status: number; body: string }> = {}
    probeBehaviour['claude-opus-4-7'] = {
      ok: false,
      status: 400,
      body: '{"type":"error","error":{"type":"invalid_request_error","message":"model: \\"claude-opus-4-7\\" was not found"}}',
    }
    for (const id of PROBE_TARGETS.claude) {
      if (!probeBehaviour[id]) {
        ;(probeBehaviour as Record<string, { ok: true } | { ok: false; status: number; body: string }>)[id] = { ok: true }
      }
    }
    setupClaudeFetch({ probeBehaviour })
    const result = await probeClaudeKey('test-key')
    const entry = result.probed.find((p) => p.id === 'claude-opus-4-7')
    expect(entry?.accessible).toBe(false)
    expect(entry?.reason).toContain('not available')
  })
})

// ────────────────────────────────────────────────────────────────────────
// OpenAI probe — uses /v1/models (advertised list) + chat/completions per model.
// ────────────────────────────────────────────────────────────────────────

function setupOpenAIFetch(opts: {
  /** Advertised model ids from /v1/models. If null, the endpoint 401s. */
  advertised: string[] | null
  probeBehaviour: Record<string, { ok: true } | { ok: false; status: number; body: string }>
}) {
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input)
    fetchCalls.push({ url, body: typeof init?.body === 'string' ? init.body : undefined })
    if (url === 'https://api.openai.com/v1/models') {
      if (opts.advertised === null) {
        return new Response('{"error":"invalid"}', { status: 401 })
      }
      return new Response(
        JSON.stringify({ data: opts.advertised.map((id) => ({ id, object: 'model' })) }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    if (url === 'https://api.openai.com/v1/chat/completions') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string }
      const behaviour = opts.probeBehaviour[body.model ?? '']
      if (!behaviour) return new Response('not configured', { status: 500 })
      if (behaviour.ok) {
        return new Response(
          JSON.stringify({ id: 'cmpl_t', choices: [{ message: { content: '.' }, finish_reason: 'stop' }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response(behaviour.body, { status: behaviour.status })
    }
    return new Response('unreached', { status: 500 })
  })
  vi.stubGlobal('fetch', fetchMock)
}

describe('probeOpenAIKey', () => {
  beforeEach(() => {
    fetchCalls = []
    cacheStore.value = {}
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('populates advertised from /v1/models AND probes every PROBE_TARGETS.openai', async () => {
    const probeBehaviour: Record<string, { ok: true }> = {}
    for (const id of PROBE_TARGETS.openai) probeBehaviour[id] = { ok: true }
    setupOpenAIFetch({
      advertised: ['gpt-5', 'gpt-4o-mini', 'text-embedding-3-small'],
      probeBehaviour,
    })

    const result = await probeOpenAIKey('test-openai-key')
    expect(result.advertised).toEqual(
      expect.arrayContaining(['gpt-5', 'gpt-4o-mini', 'text-embedding-3-small']),
    )
    expect(result.probed).toHaveLength(PROBE_TARGETS.openai.length)
    for (const target of PROBE_TARGETS.openai) {
      expect(result.probed.find((p) => p.id === target)?.accessible).toBe(true)
    }
    expect(result.keyFingerprint).toMatch(/^[0-9a-f]{6}$/)
  })

  it('classifies 403 as forbidden, 404 as model-not-found', async () => {
    const probeBehaviour: Record<string, { ok: false; status: number; body: string }> = {}
    probeBehaviour['gpt-5'] = { ok: false, status: 403, body: '{}' }
    probeBehaviour['gpt-4o'] = { ok: false, status: 404, body: '{}' }
    for (const id of PROBE_TARGETS.openai) {
      if (!probeBehaviour[id]) {
        ;(probeBehaviour as Record<string, { ok: true } | { ok: false; status: number; body: string }>)[id] = { ok: true }
      }
    }
    setupOpenAIFetch({ advertised: ['gpt-5', 'gpt-4o'], probeBehaviour })
    const result = await probeOpenAIKey('test-key')
    expect(result.probed.find((p) => p.id === 'gpt-5')?.reason).toContain('Forbidden')
    expect(result.probed.find((p) => p.id === 'gpt-4o')?.reason).toContain('not found')
  })

  it('soft-fails to PROBE_TARGETS when /v1/models 401s — probes still run', async () => {
    const probeBehaviour: Record<string, { ok: true }> = {}
    for (const id of PROBE_TARGETS.openai) probeBehaviour[id] = { ok: true }
    setupOpenAIFetch({ advertised: null, probeBehaviour })
    const result = await probeOpenAIKey('test-key')
    // Advertised list falls back to PROBE_TARGETS.openai (sorted).
    expect(result.advertised.sort()).toEqual([...PROBE_TARGETS.openai].sort())
    // Probes still completed against the same target list.
    expect(result.probed).toHaveLength(PROBE_TARGETS.openai.length)
  })

  it('classifies "must be verified" 400s with the org-verification reason', async () => {
    const probeBehaviour: Record<string, { ok: false; status: number; body: string }> = {}
    probeBehaviour['o3'] = {
      ok: false,
      status: 400,
      body: '{"error":{"message":"Your organization must be verified to use this model."}}',
    }
    for (const id of PROBE_TARGETS.openai) {
      if (!probeBehaviour[id]) {
        ;(probeBehaviour as Record<string, { ok: true } | { ok: false; status: number; body: string }>)[id] = { ok: true }
      }
    }
    setupOpenAIFetch({ advertised: ['o3'], probeBehaviour })
    const result = await probeOpenAIKey('test-key')
    expect(result.probed.find((p) => p.id === 'o3')?.reason).toContain('organization verification')
  })
})
