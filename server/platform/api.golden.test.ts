// Characterisation ("golden") tests for the HTTP surface.
//
// These pin what the server does TODAY — status code, response body and error
// text, request by request — so that a large refactor of server/ cannot change
// any of it unnoticed. They assert nothing about what the behaviour SHOULD be:
// several things pinned below look odd on purpose. When a snapshot fails after
// a refactor, the refactor changed behaviour; decide deliberately whether the
// new behaviour is the intended one, then update the snapshot.
//
// Isolation (never touches the developer's real data):
//   - every config / data / cache / sessions / lore / vault / home / temp
//     directory is redirected into one throw-away tree BEFORE the server is
//     imported (env-paths reads its variables once, at import);
//   - credential environment variables are removed;
//   - node:child_process is replaced wholesale — nothing is ever spawned;
//   - global fetch is replaced with a rejecting stub — nothing leaves the box
//     (the test client uses node:http instead);
//   - the audio install add-on is forced to mount by stubbing the readiness
//     check in server/features/transcription/services/whisper/bootstrap.ts (and pointing its venv at the tree).
//
// Routes deliberately NOT exercised are listed in SKIPPED_ROUTES at the bottom.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  childProcessMock,
  createSandbox,
  httpRequest,
  listen,
  makeNormaliser,
  multipartBody,
  spawnCapture,
  type Reply,
  type Sandbox,
} from '../testing/golden/harness.js'

type Row = Record<string, unknown>

let sandbox: Sandbox
let norm: ReturnType<typeof makeNormaliser>
let appData: typeof import('./appData.js')
let closeMain: () => Promise<void>
let mainPort = 0
let loadedAddons: string[] = []

const PORT_IN_HOST = 5173
const LOOPBACK_HOST = `127.0.0.1:${PORT_IN_HOST}`

// Fixture "keys" for the provider routes. Placeholders only.
const FIXTURE_KEY = 'not-a-real-key-not-a-real-key'

const FILLER = 'Write the passage as a plain fixture narrator, keeping every named place and character exactly as given.'
const VALID_PROMPTS = {
  phase3Cloud: `${FILLER} Source: {groundedChunk}`,
  phase3Local: `${FILLER} Source: {groundedChunk}`,
  phase5Local: `${FILLER} Review: {chronicleChunk}`,
  phase6Cloud: `${FILLER} Condense: {chronicle}`,
  phase6Local: `${FILLER} Condense: {chronicle}`,
}

type Gen = typeof import('../index.js')
let createApiApp: Gen['createApiApp']
let loadAddons: typeof import('../addons/loader.js').loadAddons

beforeAll(async () => {
  sandbox = await createSandbox('tt-golden-api-')
  norm = makeNormaliser(sandbox.root, [], { digestOver: 400 })

  // A recognisable Vault install so /api/vault/* resolves through
  // TUSKS_VAULT_DIR and never falls back to scanning real sibling folders.
  await fs.mkdir(path.join(sandbox.paths.vault, 'Lore'), { recursive: true })
  await fs.writeFile(path.join(sandbox.paths.vault, 'package.json'), JSON.stringify({ name: 'tusks-vault' }), 'utf8')

  vi.stubGlobal('fetch', async () => {
    throw new Error('network disabled in golden tests')
  })
  vi.resetModules()
  vi.doMock('node:child_process', () => childProcessMock())
  const venv = path.join(sandbox.root, 'venv')
  vi.doMock('../features/transcription/services/whisper/bootstrap.js', async () => {
    const actual = await vi.importActual<typeof import('../features/transcription/services/whisper/bootstrap.js')>('../features/transcription/services/whisper/bootstrap.js')
    return {
      ...actual,
      venvDir: () => venv,
      whisperInstalled: async () => ({
        installed: true,
        pythonPath: path.join(venv, 'python'),
        venvPath: venv,
        scriptPath: path.join(venv, 'transcribe.py'),
      }),
      whisperStatus: async () => ({
        ready: true,
        pythonPath: path.join(venv, 'python'),
        venvPath: venv,
        scriptPath: path.join(venv, 'transcribe.py'),
      }),
      runSetup: async (emit: (e: { stream: 'stdout' | 'stderr'; line: string }) => void) => {
        emit({ stream: 'stdout', line: 'stub-setup-line' })
        return 0
      },
    }
  })
  // Deterministic CLI probes for /api/providers and /api/system/cli-detect.
  spawnCapture.reset()
  spawnCapture.when('claude', () => ({ code: 0, stdout: '2.0.5 (Claude Code)\n' }))
  spawnCapture.when('codex', () => ({ code: 1 }))

  appData = await import('./appData.js')
  // Directory layout differs per OS (Roaming/Local on Windows, XDG elsewhere).
  norm.alias(appData.configDir(), '<CONFIG>')
  norm.alias(appData.dataDir(), '<DATA>')
  norm.alias(appData.cacheDir(), '<CACHE>')
  const idx = await import('../index.js')
  createApiApp = idx.createApiApp
  loadAddons = (await import('../addons/loader.js')).loadAddons

  const app = createApiApp({ host: '127.0.0.1', port: PORT_IN_HOST, lanWritesEnabled: false, bootId: 'golden-boot' })
  loadedAddons = (await loadAddons(app)).sort()
  const srv = await listen(app)
  mainPort = srv.port
  closeMain = srv.close
}, 60_000)

afterAll(async () => {
  await closeMain?.()
  vi.unstubAllGlobals()
  vi.doUnmock('node:child_process')
  vi.doUnmock('./whisper/bootstrap.js')
  await sandbox.restore()
})

// ---------------------------------------------------------------------------
// Recording helpers
// ---------------------------------------------------------------------------

/** The seeded personas are named after real public figures; pin their ids as
 *  tokens and only the length of the name and description. */
const presetAliases = new Map<string, string>()
function redactPersonaText(json: unknown): unknown {
  const fix = (p: unknown): unknown => {
    if (!p || typeof p !== 'object') return p
    const o = p as Record<string, unknown>
    if (o.preset !== true) return o
    if (typeof o.id === 'string' && !presetAliases.has(o.id)) {
      presetAliases.set(o.id, `<PRESET-${presetAliases.size + 1}>`)
      norm.alias(o.id, presetAliases.get(o.id)!)
    }
    return { ...o, name: `<len=${String(o.name).length}>`, description: `<len=${String(o.description).length}>` }
  }
  const walk = (j: unknown): unknown => {
    if (!j || typeof j !== 'object') return j
    const o = j as Record<string, unknown>
    const out: Record<string, unknown> = { ...o }
    if (Array.isArray(o.personas)) out.personas = o.personas.map(fix)
    if (o.document) out.document = walk(o.document)
    if (o.persona) out.persona = fix(o.persona)
    return out
  }
  return walk(json)
}

type HitOpts = {
  json?: unknown
  rawBody?: string | Buffer
  contentType?: string
  headers?: Record<string, string>
  port?: number
  hostHeader?: string
  /** Record only status + content type (bodies that carry stack traces etc.). */
  statusOnly?: boolean
  /** Record a digest of a non-JSON body instead of its text. */
  digestText?: boolean
  /** Record the body's keys / length only. */
  keysOnly?: boolean
  /** Rewrite the parsed JSON body before it is normalised and recorded. */
  transform?: (json: unknown) => unknown
  /** Register run-specific ids found in the response before it is normalised. */
  alias?: (r: Reply) => Array<[string, string]>
  label?: string
}

async function hit(method: string, p: string, o: HitOpts = {}): Promise<{ reply: Reply; row: Row }> {
  const reply = await httpRequest({
    port: o.port ?? mainPort,
    hostHeader: o.hostHeader ?? LOOPBACK_HOST,
    method,
    path: p,
    json: o.json,
    rawBody: o.rawBody,
    contentType: o.contentType,
    headers: o.headers,
  })
  for (const [v, t] of o.alias?.(reply) ?? []) norm.alias(v, t)
  const transform = o.transform ?? (p.startsWith('/api/personas') ? redactPersonaText : undefined)
  const transformed = reply.json !== undefined && transform ? transform(reply.json) : reply.json
  const row: Row = { request: norm.str(`${method} ${p}`), ...(o.label ? { note: o.label } : {}) }
  if (o.json !== undefined) row.sent = norm.walk(o.json)
  if (o.rawBody !== undefined && typeof o.rawBody === 'string') row.sentRaw = norm.str(o.rawBody)
  row.status = reply.status
  row.contentType = reply.contentType
  if (o.statusOnly) return { reply, row }
  if (reply.json !== undefined) {
    row.body = o.keysOnly ? shapeOf(transformed) : norm.walk(transformed)
  } else if (reply.status !== 204 && reply.text.length > 0) {
    row.body =
      o.digestText || o.keysOnly
        ? { textLength: reply.text.length, head: norm.str(reply.text.slice(0, 40)) }
        : norm.str(reply.text)
  }
  return { reply, row }
}

/** Record a request; returns the reply for follow-up logic. */
async function rec(rows: Row[], method: string, p: string, o: HitOpts = {}): Promise<Reply> {
  const { reply, row } = await hit(method, p, o)
  rows.push(row)
  return reply
}

function shapeOf(v: unknown): unknown {
  if (Array.isArray(v)) return { array: v.length, first: v.length ? shapeOf(v[0]) : null }
  if (v && typeof v === 'object') {
    const out: Record<string, string> = {}
    for (const k of Object.keys(v as object).sort()) out[k] = typeof (v as Record<string, unknown>)[k]
    return out
  }
  return typeof v
}

async function readConfigFile(name: string): Promise<unknown> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path.join(appData.configDir(), name), 'utf8'))
    return norm.walk(name === 'personas.json' ? redactPersonaText(parsed) : parsed)
  } catch (err) {
    return `<${(err as NodeJS.ErrnoException).code ?? 'error'}>`
  }
}

// Ordered: later groups build on state the earlier ones leave in the temp tree.
describe('HTTP golden — ordered scenarios', () => {
  it('00 add-ons mounted at boot (audio forced on)', () => {
    expect(loadedAddons).toMatchSnapshot()
  })

  // -------------------------------------------------------------------------
  it('01 first run: GET routes against an empty config', async () => {
    const rows: Row[] = []
    for (const p of [
      '/api/health',
      '/api/boot',
      '/api/glossary',
      '/api/speakers',
      '/api/profiles',
      '/api/routing',
      '/api/settings',
      '/api/personas',
      '/api/runs',
      '/api/chronicle-library',
      '/api/sessions',
      '/api/addons',
      '/api/providers',
      '/api/providers/availability',
      '/api/provider-keys',
      '/api/diagnostics/config',
      '/api/diagnostics/recent',
      '/api/obsidian/status',
      '/api/whisper/status',
      '/api/whisper-cpp/status',
      '/api/local-llm/detect',
      '/api/local-llm/probes',
      '/api/local-llm/unsloth-config',
      '/api/openrouter/models',
      '/api/lore/index',
      '/api/vault/pair',
      '/api/system/cli-detect',
      '/api/sessions/no-such-session',
      '/api/sessions/no-such-session/live',
      '/api/sessions/no-such-session/sbv',
      '/api/sessions/no-such-session/transcribe/status',
      '/api/docs/no-such-doc',
      '/api/no-such-route',
    ]) {
      await rec(rows, 'GET', p, p === '/api/no-such-route' ? { digestText: true } : {})
    }
    // Host-specific / repo-content payloads: pin only their shape.
    const info = await rec(rows, 'GET', '/api/system/info', { statusOnly: true })
    rows.push({ systemInfoKeys: Object.keys(info.json as object).sort() })
    await rec(rows, 'GET', '/api/docs', { keysOnly: true })
    expect(rows).toMatchSnapshot()
  })

  // -------------------------------------------------------------------------
  it('02 glossary and speakers: validation, round trips, guards', async () => {
    const rows: Row[] = []
    await rec(rows, 'PUT', '/api/glossary', { json: ['not', 'an', 'object'] })
    await rec(rows, 'PUT', '/api/glossary', { rawBody: '"just a string"', contentType: 'application/json', statusOnly: true })
    await rec(rows, 'PUT', '/api/glossary', { rawBody: '{broken', contentType: 'application/json', statusOnly: true })
    await rec(rows, 'PUT', '/api/glossary', { json: {} })
    await rec(rows, 'PUT', '/api/glossary', {
      json: {
        safeReplacements: [
          { from: '  mispelt-alpha  ', to: 'Place-Delta' },
          { from: '', to: 'dropped-empty-from' },
          { from: 'dropped-no-to' },
        ],
        contextualHints: [
          { canonical: 'PC-Alpha', commonMishears: ['pea see', 7], notes: 'A fixture character.' },
          { canonical: 'NoNotes' },
        ],
      },
    })
    await rec(rows, 'GET', '/api/glossary')
    await rec(rows, 'PUT', '/api/glossary', { json: { safeReplacements: [], contextualHints: [] } })
    await rec(rows, 'PUT', '/api/glossary?allowEmpty=1', { json: { safeReplacements: [], contextualHints: [] } })
    await rec(rows, 'GET', '/api/glossary')
    rows.push({ onDisk: await readConfigFile('glossary.json') })

    await rec(rows, 'PUT', '/api/speakers', { json: [1] })
    await rec(rows, 'PUT', '/api/speakers', {
      json: {
        speakers: [
          { discordUserId: 'user-1', playerName: 'Player-One', characterName: 'PC-Alpha' },
          { discordUserId: '', playerName: 'dropped' },
          { playerName: 'dropped-no-id' },
        ],
      },
    })
    await rec(rows, 'GET', '/api/speakers')
    expect(rows).toMatchSnapshot()
  })

  // -------------------------------------------------------------------------
  it('03 personas: seed, create, update, select, delete, validation', async () => {
    const rows: Row[] = []
    const list = await rec(rows, 'GET', '/api/personas')
    const doc = list.json as { personas: Array<{ id: string; preset?: boolean }>; selectedId: string | null }
    const firstPreset = doc.personas[0]?.id ?? ''

    await rec(rows, 'PUT', '/api/personas/selected', { json: { selectedId: 'does-not-exist' } })
    await rec(rows, 'PUT', '/api/personas/selected', { json: { selectedId: firstPreset } })
    await rec(rows, 'PUT', '/api/personas/selected', { json: { selectedId: null } })
    await rec(rows, 'PUT', '/api/personas/selected', { json: {} })

    await rec(rows, 'POST', '/api/personas', { json: {} })
    await rec(rows, 'POST', '/api/personas', { json: { name: '   ' } })
    await rec(rows, 'POST', '/api/personas', { json: { name: 'Fixture Narrator', description: 'for tests', prompts: { phase3Cloud: 42 } } })
    const created = await rec(rows, 'POST', '/api/personas', {
      json: {
        name: 'Fixture Narrator',
        description: 'A narrator for tests.',
        id: 'client-supplied-id-is-ignored',
        preset: true,
        prompts: { ...VALID_PROMPTS, bogus: 'dropped' },
      },
      alias: (r) => {
        const p = (r.json as { persona?: { id?: string } } | undefined)?.persona
        return p?.id ? [[p.id, '<PERSONA-A>']] : []
      },
    })
    const newId = (created.json as { persona: { id: string } }).persona.id

    await rec(rows, 'PUT', '/api/personas/does-not-exist', { json: { name: 'x' } })
    await rec(rows, 'PUT', `/api/personas/${newId}`, { json: { name: '' } })
    await rec(rows, 'PUT', `/api/personas/${newId}`, { json: { name: 'Renamed Narrator', prompts: { phase6Cloud: 'short {chronicle}' } } })
    await rec(rows, 'PUT', `/api/personas/${newId}`, { json: { name: 'Renamed Narrator', prompts: { phase6Cloud: `${FILLER} Condense this: {chronicle}` } } })
    await rec(rows, 'PUT', '/api/personas/selected', { json: { selectedId: newId } })
    await rec(rows, 'DELETE', '/api/personas/does-not-exist')
    await rec(rows, 'DELETE', `/api/personas/${newId}`)
    await rec(rows, 'GET', '/api/personas', { keysOnly: true })
    expect(rows).toMatchSnapshot()
  })

  // -------------------------------------------------------------------------
  it('04 routing: validation errors, valid writes, retired-provider migration', async () => {
    const rows: Row[] = []
    const bad: Array<[string, unknown]> = [
      ['array body', [1]],
      ['version is a string', { version: 'x' }],
      ['version 0', { version: 0 }],
      ['version newer than server', { version: 4 }],
      ['version 2.5', { version: 2.5 }],
      ['unknown lastSelectedProvider', { lastSelectedProvider: 'bogus' }],
      ['retired provider claude is no longer accepted', { lastSelectedProvider: 'claude' }],
      ['retired provider openai is no longer accepted', { lastSelectedProvider: 'openai' }],
      ['bad geminiTier', { geminiTier: 'gold' }],
      ['perPhase is an array', { perPhase: [] }],
      ['perPhase.phase1 is a string', { perPhase: { phase1: 'x' } }],
      ['perPhase.phase1 bad target', { perPhase: { phase1: { target: 'moon' } } }],
      ['perPhase cloud bad provider', { perPhase: { phase2: { target: 'cloud', cloudProvider: 'nope' } } }],
      ['perPhase cloud retired provider', { perPhase: { phase2: { target: 'cloud', cloudProvider: 'claude' } } }],
      ['perPhase cloud bad geminiTier', { perPhase: { phase3: { target: 'cloud', geminiTier: 'gold' } } }],
      ['perPhase local without modelId', { perPhase: { phase4: { target: 'local' } } }],
      ['perPhase local empty modelId', { perPhase: { phase4: { target: 'local', modelId: '' } } }],
    ]
    for (const [label, body] of bad) await rec(rows, 'PUT', '/api/routing', { json: body, label })

    await rec(rows, 'PUT', '/api/routing', { rawBody: '"str"', contentType: 'application/json', statusOnly: true })
    await rec(rows, 'PUT', '/api/routing', { json: {}, label: 'empty object is valid' })
    await rec(rows, 'PUT', '/api/routing', {
      json: {
        version: 3,
        lastSelectedProvider: 'gemini',
        geminiTier: 'paid',
        perPhase: {
          phase1: { target: 'cloud', cloudProvider: 'gemini', geminiTier: 'free', modelId: 'model-unknown-alpha' },
          phase2: { target: 'local', modelId: 'local-model-alpha' },
          phase3: { target: 'cloud' },
          bogusPhase: { target: 'cloud' },
        },
      },
      label: 'valid document with an unprobed model id (warning, not error)',
    })
    await rec(rows, 'GET', '/api/routing')
    rows.push({ onDisk: await readConfigFile('routing.json') })

    // Retired providers: a document written by an older version.
    await fs.writeFile(
      path.join(appData.configDir(), 'routing.json'),
      JSON.stringify({
        version: 2,
        lastSelectedProvider: 'claude',
        perPhase: {
          phase1: { target: 'cloud', cloudProvider: 'openai', modelId: 'gpt-5-mini' },
          phase3: { target: 'cloud', cloudProvider: 'claude', modelId: 'claude-sonnet-4-6' },
          phase4: { target: 'cloud', cloudProvider: 'gemini', modelId: 'gemini-2.5-flash' },
        },
      }),
      'utf8',
    )
    await rec(rows, 'GET', '/api/routing', { label: 'stored doc naming claude/openai is migrated on read' })
    rows.push({ onDiskAfterMigration: await readConfigFile('routing.json') })
    await rec(rows, 'GET', '/api/routing', { label: 'second read is stable' })

    // Leave a known routing doc behind for the later groups.
    await rec(rows, 'PUT', '/api/routing', { json: { version: 3, lastSelectedProvider: 'openrouter' } })
    expect(rows).toMatchSnapshot()
  })

  // -------------------------------------------------------------------------
  it('05 profiles and settings', async () => {
    const rows: Row[] = []
    await rec(rows, 'PUT', '/api/profiles', { json: [] })
    await rec(rows, 'PUT', '/api/profiles', { json: { profiles: 'nope' } })
    await rec(rows, 'PUT', '/api/profiles', { json: { profiles: { gemini: 7 } } })
    await rec(rows, 'PUT', '/api/profiles', { json: { profiles: { gemini: { phase1Model: 5 } } } })
    await rec(rows, 'PUT', '/api/profiles', {
      json: {
        profiles: {
          gemini: { phase1Model: 'model-alpha', useContextCache: false, extra: 'dropped' },
          claude: { phase3Model: 'model-beta', useCacheControl: false },
          openrouter: { phase6Model: 'vendor/model-gamma' },
        },
      },
    })
    await rec(rows, 'GET', '/api/profiles')
    rows.push({ onDisk: await readConfigFile('profiles.json') })

    await rec(rows, 'POST', '/api/settings', { json: [] })
    await rec(rows, 'POST', '/api/settings', { json: { claudeCodePlan: 'platinum', codexPlan: 'gold', updaterRemote: 'moon', devTestMode: { enabled: true, maxChars: 5 } } })
    await rec(rows, 'POST', '/api/settings', {
      json: {
        disableThinkingOnGrounding: true,
        phase1AliasHints: true,
        reassembleQuotes: true,
        retrieveVaultKb: true,
        claudeCodePlan: 'max5x',
        codexPlan: 'plus',
        perPhaseThinking: { phase1: true, phase2: false, phase3: true },
        devTestMode: { enabled: true, maxChars: 999999 },
        unknownKey: 1,
      },
    })
    await rec(rows, 'GET', '/api/settings')
    await rec(rows, 'POST', '/api/settings', { rawBody: '{oops', contentType: 'application/json', statusOnly: true })
    await rec(rows, 'POST', '/api/settings', {
      json: { disableThinkingOnGrounding: false, phase1AliasHints: false, reassembleQuotes: false, retrieveVaultKb: false, claudeCodePlan: 'unknown', codexPlan: 'unknown', perPhaseThinking: {}, devTestMode: { enabled: false, maxChars: 24000 } },
    })

    // Dev-mode unlock.
    await rec(rows, 'POST', '/api/settings/dev-auth', { json: {} })
    await rec(rows, 'POST', '/api/settings/dev-auth', { json: { email: '   ' } })
    await rec(rows, 'POST', '/api/settings/dev-auth', { json: { email: 'x'.repeat(255) } })
    await rec(rows, 'POST', '/api/settings/dev-auth', { json: { email: 'dev-unlock-fixture' } })
    await rec(rows, 'GET', '/api/settings')
    await rec(rows, 'POST', '/api/settings/dev-auth/lock', { json: {} })
    await rec(rows, 'POST', '/api/settings', { json: { updaterRemote: 'origin' } })
    await rec(rows, 'GET', '/api/settings')
    expect(rows).toMatchSnapshot()
  })

  // -------------------------------------------------------------------------
  it('06 runs (checkpoints) and chronicle library', async () => {
    const rows: Row[] = []
    for (const id of ['bad.id', 'a b', '%2e%2e', 'x'.repeat(65)]) {
      await rec(rows, 'GET', `/api/runs/${encodeURIComponent(id)}`)
      await rec(rows, 'PUT', `/api/runs/${encodeURIComponent(id)}`, { json: { createdAt: 'x' } })
      await rec(rows, 'DELETE', `/api/runs/${encodeURIComponent(id)}`)
    }
    await rec(rows, 'GET', '/api/runs/run-alpha')
    await rec(rows, 'PUT', '/api/runs/run-alpha', {
      json: {
        schemaVersion: 1,
        createdAt: '2026-01-02T03:04:05.000Z',
        pausedAt: '2026-01-02T03:10:05.000Z',
        pausedReason: 'user',
        refinementState: { campaign: 'Campaign-Alpha', sessionNumber: 3 },
        progress: { phase: 3, chunkIndex: 2, totalChunks: 9 },
      },
    })
    await rec(rows, 'PUT', '/api/runs/run-malformed', { json: { createdAt: 'x' } })
    await rec(rows, 'PUT', '/api/runs/run-badphase', { json: { createdAt: 'x', pausedAt: 'y', progress: { phase: 5 } } })
    await rec(rows, 'PUT', '/api/runs/run-array', { json: [1, 2] })
    await rec(rows, 'GET', '/api/runs', { label: 'malformed checkpoints are omitted from the list' })
    await rec(rows, 'GET', '/api/runs/run-alpha')
    await rec(rows, 'GET', '/api/runs/run-malformed', { label: 'stored but malformed → 404' })
    await rec(rows, 'DELETE', '/api/runs/run-alpha')
    await rec(rows, 'DELETE', '/api/runs/run-alpha', { label: 'second delete is still ok' })
    await rec(rows, 'DELETE', '/api/runs/run-malformed')
    await rec(rows, 'DELETE', '/api/runs/run-badphase')
    await rec(rows, 'DELETE', '/api/runs/run-array')
    await rec(rows, 'GET', '/api/runs')

    await rec(rows, 'POST', '/api/chronicle-library', { json: {} })
    await rec(rows, 'POST', '/api/chronicle-library', { json: { chronicle: '   ' } })
    const created = await rec(rows, 'POST', '/api/chronicle-library', {
      json: { chronicle: 'The party reached Place-Delta.', campaign: 'Campaign-Alpha', sessionNumber: 4, provider: 'gemini', extras: { quotes: [] }, groundedTranscript: 'g', refusals: [], dmQuestions: ['q'], dmAnswers: { q: 'a' } },
      alias: (r) => {
        const id = (r.json as { id?: string } | undefined)?.id
        return id ? [[id, '<CHRONICLE-A>']] : []
      },
    })
    const id = (created.json as { id: string }).id
    await rec(rows, 'GET', '/api/chronicle-library')
    await rec(rows, 'GET', `/api/chronicle-library/${id}`)
    await rec(rows, 'GET', '/api/chronicle-library/bad.id')
    await rec(rows, 'GET', '/api/chronicle-library/missing-id')
    await rec(rows, 'PUT', '/api/chronicle-library/bad.id', { json: { chronicle: 'x' } })
    await rec(rows, 'PUT', '/api/chronicle-library/missing-id', { json: { chronicle: 'x' } })
    await rec(rows, 'PUT', `/api/chronicle-library/${id}`, { json: { chronicle: 'Edited chronicle.', condensed: { narrative: 'n' } } })
    await rec(rows, 'GET', `/api/chronicle-library/${id}`)
    await rec(rows, 'DELETE', '/api/chronicle-library/bad.id')
    await rec(rows, 'DELETE', `/api/chronicle-library/${id}`)
    await rec(rows, 'DELETE', `/api/chronicle-library/${id}`, { label: 'second delete' })
    await rec(rows, 'GET', '/api/chronicle-library')
    expect(rows).toMatchSnapshot()
  })

  // -------------------------------------------------------------------------
  it('07 diagnostics, diagnose and chronicle export validation', async () => {
    const rows: Row[] = []
    await rec(rows, 'GET', '/api/diagnostics/config')
    await rec(rows, 'POST', '/api/diagnostics/config', { json: { terminal: false, file: false } })
    await rec(rows, 'GET', '/api/diagnostics/config')
    await rec(rows, 'POST', '/api/diagnostics/log', { json: {} })
    await rec(rows, 'POST', '/api/diagnostics/log', { json: { entries: 'nope' } })
    await rec(rows, 'POST', '/api/diagnostics/log', { json: { entries: [{ ts: 1, level: 'info', source: 'golden', event: 'golden_event' }] } })
    await rec(rows, 'GET', '/api/diagnostics/recent?limit=1000', { keysOnly: true })
    await rec(rows, 'POST', '/api/diagnostics/clear-ring', { json: {} })
    await rec(rows, 'POST', '/api/diagnostics/clear-file', { json: {} })
    // The bundle writer and the chunk-capture endpoint write into the working
    // directory (the repo), so only their input validation is exercised.
    await rec(rows, 'POST', '/api/diagnose/capture-blocked-chunk', { json: {} })
    await rec(rows, 'POST', '/api/diagnose/capture-blocked-chunk', { json: { prompt: '' } })

    await rec(rows, 'POST', '/api/chronicle/save', { json: {} })
    await rec(rows, 'POST', '/api/chronicle/save', { json: { campaign: 'Campaign-Alpha' } })
    await rec(rows, 'POST', '/api/chronicle/save', { json: { campaign: 'Campaign-Alpha', sessionNumber: 0 } })
    await rec(rows, 'POST', '/api/chronicle/save', { json: { campaign: 'Campaign-Alpha', sessionNumber: 2, content: '   ' } })
    await rec(rows, 'POST', '/api/chronicle/docx', { json: {} })
    const docx = await rec(rows, 'POST', '/api/chronicle/docx', {
      json: { campaign: 'Campaign-Alpha', sessionNumber: 2, chronicle: 'A short chronicle.', mode: 'condensed' },
      statusOnly: true,
    })
    rows.push({
      docxDownload: {
        status: docx.status,
        contentType: docx.contentType,
        contentDisposition: docx.headers['content-disposition'],
        zipMagic: docx.raw.subarray(0, 2).toString('latin1'),
      },
    })
    expect(rows).toMatchSnapshot()
  })

  // -------------------------------------------------------------------------
  it('08 providers and provider keys (incl. the retired claude/openai names)', async () => {
    const rows: Row[] = []
    await rec(rows, 'GET', '/api/providers')
    for (const name of ['bogus', 'claude', 'openai']) {
      await rec(rows, 'PUT', `/api/providers/${name}`, { json: { key: FIXTURE_KEY } })
      await rec(rows, 'GET', '/api/provider-keys', { label: `after PUT ${name}` })
      await rec(rows, 'DELETE', `/api/providers/${name}`)
      await rec(rows, 'GET', '/api/provider-keys', { label: `after DELETE ${name}` })
      await rec(rows, 'POST', `/api/providers/${name}/test`, { json: {} })
      await rec(rows, 'POST', `/api/providers/${name}/probe`, { json: {} })
    }
    await rec(rows, 'PUT', '/api/providers/gemini', { json: {} })
    await rec(rows, 'PUT', '/api/providers/gemini', { json: { key: '   ' } })
    await rec(rows, 'PUT', '/api/providers/gemini', { json: { key: 42 } })
    await rec(rows, 'POST', '/api/providers/gemini/test', { json: {}, label: 'no key stored yet' })
    await rec(rows, 'POST', '/api/providers/openrouter/probe', { json: {}, label: 'no key stored yet' })
    await rec(rows, 'PUT', '/api/providers/gemini', { json: { key: `  ${FIXTURE_KEY}  ` } })
    await rec(rows, 'PUT', '/api/providers/geminiFree', { json: { key: `${FIXTURE_KEY}-free` } })
    await rec(rows, 'PUT', '/api/providers/openrouter', { json: { key: `${FIXTURE_KEY}-or` } })
    await rec(rows, 'GET', '/api/providers')
    await rec(rows, 'GET', '/api/provider-keys')
    await rec(rows, 'POST', '/api/providers/gemini/test', { json: {}, label: 'network disabled → ok:false' })
    await rec(rows, 'POST', '/api/providers/openrouter/test', { json: {}, label: 'network disabled → ok:false' })
    await rec(rows, 'POST', '/api/providers/openrouter/probe', { json: {} })
    await rec(rows, 'POST', '/api/providers/gemini/probe', { json: {}, label: 'network disabled' })
    await rec(rows, 'GET', '/api/providers/availability')
    await rec(rows, 'DELETE', '/api/providers/geminiFree')
    await rec(rows, 'DELETE', '/api/providers/gemini')
    await rec(rows, 'DELETE', '/api/providers/openrouter')
    await rec(rows, 'GET', '/api/providers')
    await rec(rows, 'GET', '/api/provider-keys')
    expect(rows).toMatchSnapshot()
  })

  // -------------------------------------------------------------------------
  it('09 lore folder and documents', async () => {
    const rows: Row[] = []
    // TUSKS_LORE_DIR points inside the temp tree; create it first so detection
    // never falls through to scanning real sibling folders.
    await rec(rows, 'POST', '/api/lore/create', { json: {} })
    await rec(rows, 'POST', '/api/lore/create', { json: {}, label: 'idempotent' })
    await rec(rows, 'GET', '/api/lore/status')
    await rec(rows, 'GET', '/api/lore/documents')
    await rec(rows, 'GET', '/api/lore/index')

    const md = multipartBody('file', 'Note-Alpha.md', '# Place-Delta\n\nA fixture note.\n')
    await rec(rows, 'POST', '/api/lore/documents', { rawBody: md.body, contentType: md.contentType })
    await rec(rows, 'POST', '/api/lore/documents', { rawBody: md.body, contentType: md.contentType, label: 'duplicate' })
    await rec(rows, 'POST', '/api/lore/documents?overwrite=1', { rawBody: md.body, contentType: md.contentType, label: 'overwrite' })
    const bin = multipartBody('file', 'tool.exe', 'MZ', 'application/octet-stream')
    await rec(rows, 'POST', '/api/lore/documents', { rawBody: bin.body, contentType: bin.contentType })
    const noName = multipartBody('file', '..', 'x')
    await rec(rows, 'POST', '/api/lore/documents', { rawBody: noName.body, contentType: noName.contentType })
    await rec(rows, 'POST', '/api/lore/documents', { json: {} })
    await rec(rows, 'POST', '/api/lore/documents', { json: { name: 'Migrated-Note.docx', text: 'migrated text' }, label: 'JSON migration path forces .txt' })
    await rec(rows, 'GET', '/api/lore/documents')
    await rec(rows, 'GET', '/api/lore/index')

    await rec(rows, 'DELETE', '/api/lore/documents')
    await rec(rows, 'DELETE', '/api/lore/documents?relPath=..%2F..%2Fescape.md')
    await rec(rows, 'DELETE', '/api/lore/documents?relPath=tusks-lore.json')
    await rec(rows, 'DELETE', '/api/lore/documents?relPath=missing.md')
    await rec(rows, 'DELETE', '/api/lore/documents?relPath=Note-Alpha.md')
    await rec(rows, 'DELETE', '/api/lore/documents?relPath=Migrated-Note.txt')
    await rec(rows, 'GET', '/api/lore/documents')

    await rec(rows, 'GET', '/api/lore/template', { statusOnly: true })
    await rec(rows, 'POST', '/api/lore/migration/revert', { json: {} })
    await rec(rows, 'POST', '/api/lore/migration/revert', { json: { relPath: '../../x.md' } })
    await rec(rows, 'POST', '/api/lore/migration/revert', { json: { relPath: 'no-backup.md' } })
    await rec(rows, 'POST', '/api/lore/save-chronicle', { json: {} })
    await rec(rows, 'POST', '/api/lore/convert-docx', { json: {} })
    await rec(rows, 'POST', '/api/lore/remove-docx', { json: {} })
    expect(rows).toMatchSnapshot()
  })

  // -------------------------------------------------------------------------
  it('10 sessions, uploads, transcription status (add-on routes)', async () => {
    const rows: Row[] = []
    const dir = path.join(sandbox.paths.sessions, 'sess-alpha')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      path.join(dir, 'manifest.json'),
      JSON.stringify({
        version: 1,
        sessionId: 'sess-alpha',
        guildId: 'guild-1',
        voiceChannelId: 'voice-1',
        voiceChannelName: 'Channel-Alpha',
        startedAt: '2026-01-02T03:04:05.000Z',
        endedAt: '2026-01-02T05:04:05.000Z',
        participants: [
          {
            discordUserId: 'user-1',
            discordDisplayName: 'Player-One',
            utterances: [{ utteranceId: 'u1', startedAtMs: 0, endedAtMs: 2000, filename: 'u1.wav', durationMs: 2000 }],
          },
        ],
        processing: { transcribedAt: '2026-01-02T06:00:00.000Z', sbvPath: 'session.sbv' },
      }),
      'utf8',
    )
    await fs.writeFile(
      path.join(dir, 'session.sbv'),
      '0:00:00.000,0:00:02.000\nPC-Alpha: A fixture line.\n\n0:00:02.000,0:00:04.000\nPC-Alpha: Another fixture line.\n',
      'utf8',
    )

    await rec(rows, 'GET', '/api/sessions')
    await rec(rows, 'GET', '/api/sessions/sess-alpha')
    await rec(rows, 'GET', '/api/sessions/sess-alpha/live')
    const sbv = await rec(rows, 'GET', '/api/sessions/sess-alpha/sbv')
    rows.push({ sbvDownload: { status: sbv.status, contentDisposition: sbv.headers['content-disposition'], text: sbv.text } })
    await rec(rows, 'GET', '/api/sessions/sess-alpha/transcribe/status')
    await rec(rows, 'POST', '/api/sessions/sess-alpha/live/refresh', { json: {} })
    for (const bad of ['bad.id', 'a%20b']) {
      await rec(rows, 'GET', `/api/sessions/${bad}`)
      await rec(rows, 'GET', `/api/sessions/${bad}/live`)
      await rec(rows, 'GET', `/api/sessions/${bad}/sbv`)
      await rec(rows, 'DELETE', `/api/sessions/${bad}`)
      await rec(rows, 'POST', `/api/sessions/${bad}/transcribe`, { json: {} })
      await rec(rows, 'GET', `/api/sessions/${bad}/transcribe/status`)
    }
    await rec(rows, 'POST', '/api/sessions/no-such-session/transcribe-multitrack', { json: {} })
    await rec(rows, 'POST', '/api/sessions/upload-multitrack', { json: {} })
    await rec(rows, 'POST', '/api/sessions/no-such-session/append-multitrack', { json: {} })
    await rec(rows, 'DELETE', '/api/sessions/no-such-session/upload-multitrack')
    await rec(rows, 'DELETE', '/api/sessions/no-such-session/audio')
    await rec(rows, 'DELETE', '/api/sessions/sess-alpha/audio', { label: 'fixture session' })
    await rec(rows, 'DELETE', '/api/sessions/sess-alpha')
    await rec(rows, 'DELETE', '/api/sessions/sess-alpha', { label: 'second delete' })
    await rec(rows, 'GET', '/api/sessions')

    await rec(rows, 'GET', '/api/whisper/status')
    const setup = await rec(rows, 'POST', '/api/whisper/setup', { json: {} })
    rows.push({ setupStream: { status: setup.status, contentType: setup.contentType, events: setup.text.split('\n').filter((l) => l.startsWith('event:') || l.startsWith('data:')) } })
    await rec(rows, 'DELETE', '/api/whisper')
    expect(rows).toMatchSnapshot()
  })

  // -------------------------------------------------------------------------
  it('11 add-on management routes', async () => {
    const rows: Row[] = []
    await rec(rows, 'GET', '/api/addons')
    await rec(rows, 'PATCH', '/api/addons/no-such-addon', { json: { configEnabled: false } })
    await rec(rows, 'PATCH', '/api/addons/personas-addon', { json: { configEnabled: false } })
    await rec(rows, 'PATCH', '/api/addons/audio-addon', { json: {} })
    await rec(rows, 'PATCH', '/api/addons/audio-addon', { json: { configEnabled: 'yes' } })
    await rec(rows, 'PATCH', '/api/addons/audio-addon', { json: { configEnabled: false } })
    await rec(rows, 'GET', '/api/addons')
    rows.push({ addonsJsonOnDisk: await readConfigFile('addons.json') })
    await rec(rows, 'PATCH', '/api/addons/audio-addon', { json: { configEnabled: true } })
    await rec(rows, 'POST', '/api/addons/no-such-addon/install', { json: {} })
    await rec(rows, 'POST', '/api/addons/local-llm-addon/install', { json: {} })
    const install = await rec(rows, 'POST', '/api/addons/audio-addon/install', { json: {} })
    rows.push({ installStream: { status: install.status, contentType: install.contentType, events: install.text.split('\n').filter((l) => l.startsWith('event:') || l.startsWith('data:')) } })
    await rec(rows, 'DELETE', '/api/addons/no-such-addon')
    await rec(rows, 'DELETE', '/api/addons/claude-code-addon')
    await rec(rows, 'DELETE', '/api/addons/audio-addon')
    await rec(rows, 'GET', '/api/addons')
    expect(rows).toMatchSnapshot()
  })

  // -------------------------------------------------------------------------
  it('12 local runners, whisper.cpp, obsidian, vault, parse', async () => {
    const rows: Row[] = []
    // Local proxy + local-llm: only validation and unreachable-runner paths.
    await rec(rows, 'POST', '/api/local/list-models', { json: {} })
    await rec(rows, 'POST', '/api/local/list-models', { json: { provider: 'ollama' } })
    await rec(rows, 'POST', '/api/local/list-models', { json: { provider: 'ollama', baseUrl: 'http://8.8.8.8:11434' } })
    await rec(rows, 'POST', '/api/local/list-models', { json: { provider: 'lmstudio', baseUrl: 'http://127.0.0.1:1234' }, label: 'allowed address, runner unreachable' })
    await rec(rows, 'POST', '/api/local/generate', { json: {} })
    await rec(rows, 'POST', '/api/local/generate', { json: { provider: 'ollama', baseUrl: 'http://8.8.8.8:11434', body: {} } })
    await rec(rows, 'POST', '/api/local/generate', { json: { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', body: { model: 'm', prompt: 'p' } }, label: 'allowed address, runner unreachable' })
    await rec(rows, 'POST', '/api/local/launch', { json: {} })
    await rec(rows, 'POST', '/api/local/launch', { json: { provider: 'nonsense' } })
    for (const provider of ['ollama', 'lmstudio', 'unsloth']) {
      const before = spawnCapture.records().length
      await rec(rows, 'POST', '/api/local/launch', { json: { provider }, label: 'runner not running, so it is spawned' })
      rows.push({
        launchSpawned: spawnCapture.records().slice(before).map((r) => ({
          command: r.command,
          args: r.args,
          shell: r.options.shell,
          detached: r.options.detached,
          stdio: r.options.stdio,
        })),
      })
    }
    await rec(rows, 'POST', '/api/local-llm/probe', { json: {} })
    await rec(rows, 'POST', '/api/local-llm/probe', { json: { baseUrl: 'http://8.8.8.8:11434' } })
    await rec(rows, 'POST', '/api/local-llm/probe', { json: { baseUrl: 'http://8.8.8.8:11434', modelId: 'm' } })
    await rec(rows, 'PUT', '/api/local-llm/unsloth-config', { json: {} })
    await rec(rows, 'PUT', '/api/local-llm/unsloth-config', { json: { baseUrl: 'http://8.8.8.8:8888' } })
    await rec(rows, 'PUT', '/api/local-llm/unsloth-config', { json: { baseUrl: 'http://127.0.0.1:8888', username: 'user-a', password: 'placeholder', bearerToken: 'placeholder' } })
    await rec(rows, 'GET', '/api/local-llm/unsloth-config')
    await rec(rows, 'DELETE', '/api/local-llm/unsloth-config')
    await rec(rows, 'GET', '/api/local-llm/unsloth-config')

    // whisper.cpp
    await rec(rows, 'POST', '/api/whisper-cpp/config', { json: { binaryPath: 'relative/main', modelPath: '' } })
    await rec(rows, 'POST', '/api/whisper-cpp/config', { json: { binaryPath: '', modelPath: 'relative/model.bin' } })
    await rec(rows, 'POST', '/api/whisper-cpp/config', { json: { binaryPath: path.join(sandbox.root, 'no-such-bin'), modelPath: path.join(sandbox.root, 'no-such-model.bin') } })
    await rec(rows, 'GET', '/api/whisper-cpp/status')
    await rec(rows, 'POST', '/api/whisper-cpp/config', { json: {} })

    // Obsidian read-only vault source.
    const vault = path.join(sandbox.root, 'obsidian-vault')
    await fs.mkdir(vault, { recursive: true })
    await fs.writeFile(path.join(vault, 'Place-Delta.md'), '---\naliases: [Delta-Place]\ntype: location\n---\n# Place-Delta\nA fixture place.\n', 'utf8')
    await rec(rows, 'GET', '/api/obsidian/status')
    await rec(rows, 'GET', '/api/obsidian/convertible')
    await rec(rows, 'POST', '/api/obsidian/convert', { json: {} })
    await rec(rows, 'POST', '/api/obsidian/reindex', { json: {} })
    await rec(rows, 'GET', '/api/obsidian/readiness')
    await rec(rows, 'GET', '/api/obsidian/preview')
    await rec(rows, 'POST', '/api/obsidian/generate-claude-md', { json: {} })
    await rec(rows, 'POST', '/api/obsidian/config', { json: { enabled: true, vaultPath: '' } })
    await rec(rows, 'POST', '/api/obsidian/config', { json: { enabled: true, vaultPath: 'relative/path' } })
    await rec(rows, 'POST', '/api/obsidian/config', { json: { enabled: true, vaultPath: path.join(sandbox.root, 'missing-vault') } })
    await rec(rows, 'POST', '/api/obsidian/config', { json: { enabled: true, vaultPath: vault, modeB: false, useClaudeMdContext: false } })
    await rec(rows, 'GET', '/api/obsidian/status')
    await rec(rows, 'GET', '/api/obsidian/convertible')
    await rec(rows, 'POST', '/api/obsidian/convert', { json: {} })
    await rec(rows, 'POST', '/api/obsidian/convert', { json: { paths: [] } })
    await rec(rows, 'POST', '/api/obsidian/convert', { json: { paths: [1] } })
    await rec(rows, 'POST', '/api/obsidian/reindex', { json: {} })
    await rec(rows, 'GET', '/api/obsidian/readiness')
    await rec(rows, 'GET', '/api/obsidian/preview?limit=1')
    await rec(rows, 'GET', '/api/lore/documents', { label: 'obsidian source overrides the lore folder' })
    await rec(rows, 'GET', '/api/lore/index', { label: 'obsidian source overrides the lore folder' })
    await rec(rows, 'POST', '/api/obsidian/generate-claude-md', { json: {} })
    await rec(rows, 'POST', '/api/obsidian/generate-claude-md', { json: {}, label: 'already exists' })
    await rec(rows, 'POST', '/api/obsidian/config', { json: { enabled: false, vaultPath: '' }, label: 'switch the source off again' })
    await rec(rows, 'GET', '/api/lore/documents', { label: 'back on the lore folder' })

    // Vault pairing (TUSKS_VAULT_DIR fixture).
    await rec(rows, 'GET', '/api/vault/pair')
    await rec(rows, 'POST', '/api/vault/export-chronicle', { json: {} })
    await rec(rows, 'POST', '/api/vault/export-chronicle', { json: { campaign: 'Campaign-Alpha' } })
    await rec(rows, 'POST', '/api/vault/export-chronicle', { json: { campaign: 'Campaign-Alpha', sessionNumber: 'x', content: 'c' } })
    await rec(rows, 'POST', '/api/vault/export-chronicle', { json: { campaign: 'Campaign-Alpha', sessionNumber: 2 } })
    await rec(rows, 'POST', '/api/vault/export-chronicle', { json: { campaign: 'Campaign-Alpha', sessionNumber: 2, content: 'A chronicle.', fileName: 'Chronicle-Alpha.md' } })

    // Parse endpoints without a file.
    await rec(rows, 'POST', '/api/parse/pdf', { json: {} })
    await rec(rows, 'POST', '/api/parse/docx', { json: {} })
    expect(rows).toMatchSnapshot()
  })

  // -------------------------------------------------------------------------
  it('13 loopback / LAN / origin gating', async () => {
    const rows: Row[] = []
    const lanServer = async (lanWrites: boolean, host: string) => {
      const app = createApiApp({ host, port: PORT_IN_HOST, lanWritesEnabled: lanWrites, bootId: 'golden-boot' })
      await loadAddons(app)
      // Present every connection as coming from another device on the network.
      return listen((req, res) => {
        Object.defineProperty(req.socket, 'remoteAddress', { value: '192.168.1.50', configurable: true })
        app(req, res)
      })
    }

    // TUSKS_HOST=0.0.0.0, LAN writes OFF (the default).
    const lan = await lanServer(false, '0.0.0.0')
    try {
      const o = { port: lan.port, hostHeader: '192.168.1.10:5173' }
      for (const [m, p] of [
        ['GET', '/api/health'],
        ['GET', '/api/glossary'],
        ['PUT', '/api/glossary'],
        ['POST', '/api/chronicle/save'],
        ['GET', '/api/provider-keys'],
        ['GET', '/api/providers'],
        ['GET', '/api/diagnostics/config'],
        ['GET', '/api/diagnose/recent'],
        ['GET', '/api/updater/status'],
        ['GET', '/api/settings'],
        ['POST', '/api/settings'],
        ['POST', '/api/settings/dev-auth'],
        ['GET', '/api/system/cli-detect'],
        ['GET', '/api/system/info'],
        ['GET', '/api/claude-code/status'],
        ['POST', '/api/claude-code/generate'],
        ['GET', '/api/codex/status'],
        ['POST', '/api/codex/generate'],
        ['GET', '/api/whisper-cpp/status'],
        ['GET', '/api/local-llm/unsloth-config'],
        ['GET', '/api/obsidian/status'],
        ['GET', '/api/personas'],
        ['GET', '/api/sessions'],
      ] as const) {
        await rec(rows, m, p, { ...o, json: m === 'GET' ? undefined : {}, statusOnly: p === '/api/system/info' })
      }
    } finally {
      await lan.close()
    }

    // TUSKS_HOST=0.0.0.0, LAN writes ON.
    const lanOn = await lanServer(true, '0.0.0.0')
    try {
      const o = { port: lanOn.port, hostHeader: '192.168.1.10:5173' }
      await rec(rows, 'POST', '/api/chronicle/save', { ...o, json: {}, label: 'LAN writes on' })
      await rec(rows, 'GET', '/api/provider-keys', { ...o, label: 'LAN writes on' })
      await rec(rows, 'POST', '/api/settings', { ...o, json: {}, label: 'LAN writes on' })
      await rec(rows, 'POST', '/api/claude-code/generate', { ...o, json: { prompt: 'p' }, label: 'LAN writes on' })
      await rec(rows, 'POST', '/api/codex/generate', { ...o, json: { prompt: 'p' }, label: 'LAN writes on' })
    } finally {
      await lanOn.close()
    }

    // Default loopback bind: Host-header allowlist and Origin check.
    await rec(rows, 'GET', '/api/health', { hostHeader: 'attacker.example:5173' })
    await rec(rows, 'GET', '/api/health', { hostHeader: 'localhost:5173' })
    await rec(rows, 'GET', '/api/health', { hostHeader: '[::1]:5173' })
    await rec(rows, 'POST', '/api/chronicle/save', { json: {}, headers: { Origin: 'http://evil.example' } })
    await rec(rows, 'POST', '/api/chronicle/save', { json: {}, headers: { Origin: 'http://localhost:5173' } })
    await rec(rows, 'POST', '/api/chronicle/save', { json: {}, headers: { Origin: 'http://127.0.0.1:5173' } })
    await rec(rows, 'POST', '/api/chronicle/save', { json: {}, headers: { Origin: 'not a url' } })
    await rec(rows, 'GET', '/api/health', { headers: { Origin: 'http://evil.example' }, label: 'GET is never origin-checked' })
    expect(rows).toMatchSnapshot()
  })

  // -------------------------------------------------------------------------
  it('14 state left on disk after every group', async () => {
    const rows: Row[] = []
    for (const f of ['glossary.json', 'speakers.json', 'profiles.json', 'routing.json', 'settings.json', 'personas.json', 'addons.json', 'diagnostics-config.json']) {
      rows.push({ file: f, content: await readConfigFile(f) })
    }
    const listing = async (root: string): Promise<string[]> => {
      const out: string[] = []
      const walk = async (d: string) => {
        let entries: import('node:fs').Dirent[] = []
        try {
          entries = await fs.readdir(d, { withFileTypes: true })
        } catch {
          return
        }
        for (const e of entries) {
          const abs = path.join(d, e.name)
          if (e.isDirectory()) await walk(abs)
          else out.push(norm.str(abs).split('<TMP>/').join('').replace(/\d{4}-\d{2}-\d{2}T[\d-]+Z-[0-9a-f]{6}/g, '<ID>').replace(/[0-9a-f]{12}\.index\.json$/, '<HASH-OF-VAULT-PATH>.index.json'))
        }
      }
      await walk(root)
      return out.sort()
    }
    rows.push({ treeUnderTemp: (await listing(sandbox.root)).filter((p) => !/\.salt|providers\.enc|ostmp\/ffmpeg|\.bak$/.test(p)) })
    expect(rows).toMatchSnapshot()
  })
})

describe('HTTP golden — routes deliberately not exercised', () => {
  // Each entry is a route this file does NOT call, with the reason. The test
  // below pins the LIST, so adding or removing a route forces a decision.
  const SKIPPED_ROUTES: Record<string, string> = {
    'POST /api/diagnose/bundle': 'writes .diagnose/ into the working directory (the repo) and runs git',
    'GET /api/diagnose/recent': 'reads .diagnose/ from the working directory (the repo); only its loopback gate is pinned',
    'GET /api/diagnose/captured-chunks': 'reads from the working directory (the repo)',
    'POST /api/diagnose/capture-blocked-chunk (valid body)': 'writes into the working directory (the repo); validation errors are pinned',
    'POST /api/chronicle/save (valid body)': 'writes under <repo>/Sessions; validation errors are pinned',
    'GET /api/updater/status': 'runs git against the real checkout (only its loopback gate is pinned)',
    'POST /api/updater/check': 'runs git fetch against the real checkout',
    'POST /api/updater/apply': 'pulls and restarts the app',
    'POST /api/lore/index/rebuild': 'rebuilds from the real alias-index manager state',
    'GET /api/lore/migration/preview': 'spawns node on scripts/lore/extract-aliases.mjs',
    'POST /api/lore/migration/apply': 'spawns node on scripts/lore/extract-aliases.mjs',
    'GET /api/lore/status | documents before the lore folder exists': 'detection falls back to scanning real sibling folders and probe-writes into them',
    'POST /api/obsidian/pick-folder': 'opens a native folder dialog',
    'POST /api/obsidian/graphify-build': 'spawns the graphify CLI',
    'POST /api/sessions/:id/transcribe (valid id)': 'starts the Whisper worker; only the invalid-id guard is pinned',
    'POST /api/sessions/upload-multitrack (with files)': 'extracts audio with ffmpeg; only the no-files error is pinned',
    'POST /api/sessions/:id/append-multitrack (with files)': 'extracts audio with ffmpeg; only the no-files error is pinned',
    'POST /api/parse/docx (with a file)': 'parser output is library-version dependent',
    'GET /api/docs (content), GET /api/docs/:slug (known slug)': 'enumerates the repo docs/ tree, which changes with every documentation edit; only the shape and the 404 are pinned',
    'GET /api/system/info (values)': 'host hardware; only the shape is pinned',
  }
  it('lists the skipped routes', () => {
    expect(SKIPPED_ROUTES).toMatchSnapshot()
  })
})
