// Fixed JSON for every /api/* request the UI makes on load and navigation.
// Names are placeholder tokens, never real people; dates are fixed.

export type ScenarioOptions = {
  /** Audio add-on installed and mounted. */
  audio: boolean
  /** Provider keys configured, content present. False = first-run state. */
  populated: boolean
}

type RouteBody = unknown | ((req: { url: URL; method: string; body: unknown }) => unknown)
export type Route = { status?: number; body: RouteBody }

const T0 = '2026-01-02T10:00:00.000Z'

function personaPrompts(tag: string) {
  return {
    phase3Cloud: `Persona-${tag} chronicle prompt {groundedChunk}`,
    phase3Local: `Persona-${tag} local chronicle prompt {groundedChunk}`,
    phase5Local: `Persona-${tag} polish prompt {chronicleChunk}`,
    phase6Cloud: `Persona-${tag} condense prompt {chronicle}`,
    phase6Local: `Persona-${tag} local condense prompt {chronicle}`,
  }
}

const PROBE_GEMINI = {
  fetchedAt: T0,
  keyFingerprint: 'aaaaaa',
  advertised: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
  probed: [
    { id: 'gemini-2.5-pro', accessible: true, tier: 'pro', latencyMs: 900 },
    { id: 'gemini-2.5-flash', accessible: true, tier: 'flash', latencyMs: 400 },
    { id: 'gemini-2.5-flash-lite', accessible: true, tier: 'flash-lite', latencyMs: 250 },
  ],
}

const PROBE_OPENROUTER = {
  fetchedAt: T0,
  keyFingerprint: 'bbbbbb',
  advertised: ['vendor-a/model-large', 'vendor-b/model-small'],
  probed: [
    { id: 'vendor-a/model-large', accessible: true },
    { id: 'vendor-b/model-small', accessible: true },
  ],
}

const OPENROUTER_MODELS = [
  {
    id: 'vendor-a/model-large',
    name: 'Vendor-A Model-Large',
    inputPerM: 3,
    outputPerM: 15,
    contextLength: 200000,
    maxCompletionTokens: 64000,
    supportsStructuredOutputs: true,
    isModerated: false,
    isFree: false,
    inputModalities: ['text'],
    outputModalities: ['text'],
  },
  {
    id: 'vendor-b/model-small',
    name: 'Vendor-B Model-Small',
    inputPerM: 0.1,
    outputPerM: 0.4,
    contextLength: 128000,
    maxCompletionTokens: 16000,
    supportsStructuredOutputs: true,
    isModerated: true,
    isFree: false,
    inputModalities: ['text'],
    outputModalities: ['text'],
  },
  {
    id: 'vendor-c/model-free:free',
    name: 'Vendor-C Model-Free',
    inputPerM: 0,
    outputPerM: 0,
    contextLength: 32000,
    maxCompletionTokens: null,
    supportsStructuredOutputs: false,
    isModerated: true,
    isFree: true,
    inputModalities: ['text'],
    outputModalities: ['text'],
  },
]

const SESSION_ID = 'aaaaaaaa-0000-4000-8000-000000000001'

export const DOCS_LIST = [
  { slug: 'readme', title: 'Tusk’s Tomes', path: 'README.md' },
  { slug: 'docs-getting-started-quick-start', title: 'Quick start', path: 'docs/getting-started/quick-start.md' },
  { slug: 'docs-modules-audio-transcription', title: 'Audio transcription', path: 'docs/modules/audio-transcription.md' },
  { slug: 'docs-troubleshooting-diagnostic-bundles', title: 'Diagnostic bundles', path: 'docs/troubleshooting/diagnostic-bundles.md' },
]

export const DOC_BODY = {
  slug: 'docs-getting-started-quick-start',
  title: 'Quick start',
  path: 'docs/getting-started/quick-start.md',
  content: [
    '# Quick start',
    '',
    'Intro paragraph for the quick start.',
    '',
    '## Add a key',
    '',
    'Open Settings and paste a key.',
    '',
    '## Run a chronicle',
    '',
    'Paste a transcript and press the button.',
  ].join('\n'),
}

export const SBV_TEXT = [
  '0:00:01.000,0:00:03.500',
  '[PC-Alpha] We reach Place-Delta at dawn.',
  '',
  '0:00:04.000,0:00:06.200',
  '[DM] The gates of Place-Delta stand open.',
  '',
  '0:00:07.000,0:00:09.000',
  '[PC-Bravo] I pay the toll to Faction-Echo.',
  '',
].join('\n')

export function buildRoutes(opts: ScenarioOptions): Record<string, Route> {
  const { audio, populated } = opts
  const r: Record<string, Route> = {}
  const get = (path: string, body: RouteBody, status = 200) => {
    r[`GET ${path}`] = { body, status }
  }

  // Served to the in-browser provider singletons; placeholder strings only.
  get('/api/provider-keys', populated ? { gemini: 'placeholder-key-a', openrouter: 'placeholder-key-b' } : {})

  get(
    '/api/providers',
    populated
      ? { configured: ['gemini', 'openrouter'], hasFallback: { gemini: false } }
      : { configured: [], hasFallback: { gemini: false } },
  )
  get(
    '/api/routing',
    populated
      ? {
          version: 3,
          lastSelectedProvider: 'gemini',
          geminiTier: 'paid',
          perPhase: {
            phase1: { target: 'cloud', cloudProvider: 'gemini', geminiTier: 'paid', modelId: 'gemini-2.5-flash' },
            phase3: { target: 'cloud', cloudProvider: 'openrouter', modelId: 'vendor-a/model-large' },
            phase4: { target: 'cloud', cloudProvider: 'openrouter', modelId: 'vendor-b/model-small' },
          },
        }
      : { version: 3, lastSelectedProvider: null },
  )
  get(
    '/api/providers/availability',
    populated ? { gemini: PROBE_GEMINI, openrouter: PROBE_OPENROUTER } : {},
  )
  get('/api/profiles', {
    version: 1,
    profiles: {
      gemini: {
        phase1Model: 'gemini-2.5-flash',
        phase2Model: 'gemini-2.5-flash',
        phase3Model: 'gemini-2.5-pro',
        phase4Model: 'gemini-2.5-flash',
      },
      claudeCode: {
        phase1Model: 'sonnet',
        phase2Model: 'sonnet',
        phase3Model: 'opus',
        phase4Model: 'sonnet',
      },
      codex: {
        phase1Model: 'codex-mini',
        phase2Model: 'codex-mini',
        phase3Model: 'codex-large',
        phase4Model: 'codex-mini',
      },
      openrouter: {
        phase1Model: 'vendor-b/model-small',
        phase2Model: 'vendor-b/model-small',
        phase3Model: 'vendor-a/model-large',
        phase4Model: 'vendor-b/model-small',
      },
    },
  })
  get('/api/openrouter/models', {
    ok: true,
    fetchedAt: T0,
    models: OPENROUTER_MODELS,
    providerPolicies: [{ name: 'Vendor-A', trains: false, retains: false, retentionDays: null }],
  })

  get('/api/settings', {
    updaterRemote: 'origin',
    disableThinkingOnGrounding: false,
    phase1AliasHints: false,
    reassembleQuotes: false,
    retrieveVaultKb: false,
    autoUpdateModelList: true,
    claudeCodePlan: 'unknown',
    codexPlan: 'unknown',
    perPhaseThinking: {},
    devTestMode: { enabled: false, maxChars: 24000 },
  })

  get('/api/personas', {
    selectedId: populated ? 'persona-two' : null,
    personas: [
      {
        id: 'persona-one',
        name: 'Persona-One',
        description: 'A gruff narrator preset.',
        preset: true,
        updatedAt: T0,
        prompts: personaPrompts('One'),
      },
      {
        id: 'persona-two',
        name: 'Persona-Two',
        description: 'A wry narrator preset.',
        preset: true,
        updatedAt: T0,
        prompts: personaPrompts('Two'),
      },
      {
        id: 'persona-custom',
        name: 'Persona-Custom',
        description: 'Authored by the user.',
        updatedAt: T0,
        prompts: personaPrompts('Custom'),
      },
    ],
  })

  get('/api/runs', {
    runs: populated
      ? [
          {
            runId: 'run-fixture-1',
            schemaVersion: 2,
            createdAt: T0,
            pausedAt: T0,
            pausedReason: 'user',
            campaign: 'Campaign-One',
            sessionNumber: 4,
            progress: { phase: 3, chunkIndex: 2, totalChunks: 6 },
          },
        ]
      : [],
  })

  get(
    '/api/chronicle-library',
    {
      chronicles: populated
        ? [
            {
              id: 'chron-1',
              createdAt: T0,
              campaign: 'Campaign-One',
              sessionNumber: 3,
              provider: 'gemini',
              wordCount: 1840,
              hasExtras: true,
              hasCondensed: false,
              hasGroundedTranscript: true,
              hasChronicle: true,
            },
            {
              id: 'chron-2',
              createdAt: '2026-01-01T10:00:00.000Z',
              campaign: 'Campaign-One',
              sessionNumber: 2,
              provider: 'openrouter',
              wordCount: 920,
              hasExtras: false,
              hasCondensed: true,
              hasGroundedTranscript: false,
              hasChronicle: true,
            },
          ]
        : [],
    },
  )

  get(
    '/api/lore/documents',
    populated
      ? {
          found: true,
          loreRoot: '<lore-root>',
          source: 'tusks-lore',
          documents: [
            {
              id: 'doc-1',
              name: 'Place-Delta.md',
              relPath: 'Places/Place-Delta.md',
              type: 'md',
              text: '# Place-Delta\nA walled city.',
              sizeBytes: 28,
              modifiedAt: T0,
            },
            {
              id: 'doc-2',
              name: 'Faction-Echo.md',
              relPath: 'Factions/Faction-Echo.md',
              type: 'md',
              text: '# Faction-Echo\nA toll-keeping guild.',
              sizeBytes: 36,
              modifiedAt: T0,
            },
          ],
        }
      : { found: false, source: 'tusks-lore', notes: ['No lore folder found next to the app.'] },
  )
  get(
    '/api/lore/status',
    populated
      ? {
          found: true,
          loreRoot: '<lore-root>',
          sessionsDir: '<lore-root>/Sessions',
          sessionsCount: 2,
          writable: true,
          source: 'sibling',
          defaultPath: '<default-lore-path>',
        }
      : { found: false, source: 'none', notes: ['No lore folder found.'], defaultPath: '<default-lore-path>' },
  )
  get(
    '/api/lore/index',
    populated
      ? {
          status: 'ok',
          loreRoot: '<lore-root>',
          index: {
            schema: 1,
            builtAt: T0,
            byEntity: {
              'Place-Delta': { file: 'Places/Place-Delta.md', type: 'place', aliases: ['Delta'] },
              'Faction-Echo': { file: 'Factions/Faction-Echo.md', type: 'faction', aliases: [] },
            },
            filesWithFrontmatter: ['Places/Place-Delta.md'],
            filesWithoutFrontmatter: ['Factions/Faction-Echo.md'],
          },
        }
      : { status: 'no-lore', index: null },
  )
  get('/api/vault/pair', populated
    ? { paired: false, source: 'none', notes: ['Sister project not found.'] }
    : { paired: false, source: 'none', notes: ['Sister project not found.'] })
  get('/api/obsidian/status', {
    enabled: false,
    vaultPath: '',
    modeB: false,
    useClaudeMdContext: false,
    vaultExists: false,
    entityIndexExists: false,
    claudeMdPresent: false,
    entityCount: null,
    indexCachedAt: null,
  })

  get(
    '/api/glossary',
    populated
      ? {
          version: 1,
          safeReplacements: [
            { from: 'delter', to: 'Place-Delta' },
            { from: 'echo guild', to: 'Faction-Echo' },
          ],
          contextualHints: [
            { canonical: 'PC-Alpha', commonMishears: ['alpha'], notes: 'The first player character.' },
          ],
        }
      : { version: 1, safeReplacements: [], contextualHints: [] },
  )
  get(
    '/api/speakers',
    populated
      ? {
          version: 1,
          speakers: [
            { discordUserId: 'speaker-1', discordDisplayName: 'Handle-One', playerName: 'Player-One', characterName: 'PC-Alpha' },
            { discordUserId: 'speaker-2', discordDisplayName: 'Handle-Two', playerName: 'Player-Two', characterName: 'PC-Bravo' },
          ],
        }
      : { version: 1, speakers: [] },
  )

  get('/api/addons', {
    addons: [
      {
        name: 'audio-addon',
        displayName: 'Audio Transcription',
        description: 'Whisper sidecar and the Sessions tab.',
        wip: false,
        docSlug: 'docs-modules-audio-transcription',
        enabled: audio,
        configEnabled: true,
        loaded: audio,
      },
    ],
  })

  get(
    '/api/claude-code/status',
    populated
      ? { installed: true, version: '1.2.3', authenticated: true }
      : { installed: false, version: null, authenticated: false },
  )
  get('/api/codex/status', { installed: false, version: null, authenticated: false })
  get('/api/local-llm/detect', {
    backends: [
      { name: 'ollama', baseUrl: 'http://localhost:11434', reachable: false, models: [] },
      { name: 'lmstudio', baseUrl: 'http://localhost:1234', reachable: false, models: [] },
      { name: 'llamacpp', baseUrl: 'http://localhost:8080', reachable: false, models: [] },
      { name: 'unsloth', baseUrl: 'http://localhost:8888', reachable: false, models: [] },
    ],
  })
  get('/api/local-llm/probes', { results: [] })
  get('/api/local-llm/unsloth-config', { configured: false })
  get('/api/system/info', {
    ramGb: 32,
    cpuCount: 8,
    cpuModel: 'CPU-Model-X',
    platform: 'linux',
    arch: 'x64',
    gpu: { detected: false, source: null },
    python: { found: true, version: '3.11.0', supported: true },
  })
  get('/api/whisper-cpp/status', { configured: false })
  get('/api/updater/status', {
    installedViaGit: true,
    branch: 'main',
    clean: true,
    head: { sha: '0'.repeat(40), shortSha: '0000000', subject: 'Release vX', author: 'Author-One', date: T0 },
    remoteHead: { sha: '0'.repeat(40), shortSha: '0000000', subject: 'Release vX', author: 'Author-One', date: T0 },
    pendingCommits: [],
    aheadCommits: [],
    remoteName: 'origin',
  })
  get('/api/diagnostics/config', { logFilePath: '<log-dir>/diagnostics.log' })
  get('/api/diagnose/recent', {
    bundles: populated
      ? [{ filename: 'bundle-1.md', path: '<diag-dir>/bundle-1.md', size: 2048, modifiedAt: T0 }]
      : [],
  })

  get('/api/docs', { docs: DOCS_LIST })
  r[`GET /api/docs/${encodeURIComponent('docs-getting-started-quick-start')}`] = { body: DOC_BODY }
  r[`GET /api/docs/${encodeURIComponent('docs-modules-audio-transcription')}`] = {
    body: {
      slug: 'docs-modules-audio-transcription',
      title: 'Audio transcription',
      path: 'docs/modules/audio-transcription.md',
      content: '# Audio transcription\n\nHow to install the audio module.\n\n## Requirements\n\nA GPU helps.',
    },
  }

  if (audio) {
    get('/api/sessions', {
      sessions: [
        {
          version: 1,
          sessionId: SESSION_ID,
          guildId: 'guild',
          voiceChannelId: 'channel',
          voiceChannelName: 'Table',
          startedAt: '2026-01-01T19:00:00.000Z',
          endedAt: '2026-01-01T23:03:00.000Z',
          participants: [
            {
              discordUserId: 'speaker-1',
              utterances: [
                {
                  utteranceId: 'ut-1',
                  startedAt: '2026-01-01T19:00:00.000Z',
                  durationMs: 4000,
                  audioPath: 'speaker-1/ut-1.flac',
                  transcript: null,
                },
              ],
            },
          ],
          processing: { transcribedAt: '2026-01-01T23:30:00.000Z', sbvPath: 'session.sbv' },
        },
      ],
    })
    get(`/api/sessions/${SESSION_ID}/sbv`, SBV_TEXT)
    get('/api/whisper/status', {
      installed: true,
      ready: true,
      device: 'cpu',
      model: 'base',
    })
  }

  return r
}
