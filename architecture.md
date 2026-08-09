# Project Architecture: Tusk's Tomes

A local-first D&D session chronicler. The core install handles paste-a-transcript
chronicling through any cloud LLM (Gemini / Claude / OpenAI). Two opt-in add-ons
extend it: **Audio Transcription** (Whisper + Craig multitrack upload) for users
who want to feed audio directly, and **Local LLMs** (Ollama / LM Studio / Unsloth
routing) for users who want to keep some or all phases off the cloud entirely.
Both add-ons install in one click from Settings and can be toggled on/off
without uninstalling.

A six-phase pipeline produces a clean grounded transcript, a narrative chronicle,
a condensed retelling with catch-up bullets, and a curated extras list (jests,
gore, quotes). Pacing between cloud calls is adaptive per provider — Claude /
OpenAI rate-limit response headers drive the inter-chunk delay, Gemini uses a
static tier map. Paid users routinely see 4–5× faster runs than the legacy
fixed-pacing.

Everything except the chosen cloud LLM API runs on the user's machine. API keys
are encrypted at rest, never leave the host, and never appear in plaintext over
the wire. The server binds to `127.0.0.1` by default and a same-origin middleware
on `/api/*` rejects cross-origin POSTs so a malicious page can't drive-by-trigger
an add-on install. Finished chronicles are saved back into the repo tree as
portable Markdown, and (when the optional sibling `Tusks-Lore/` folder is set
up) also as structured `.docx` files inside a shared archive both Tomes and
Tusk's Vault read from.

---

<details class="docs-section">
<summary><h2>1. System overview</h2></summary>
<div class="docs-section-body">


```
                ┌────────────────────────────────────────────────────┐
                │  User's machine                                    │
                │                                                    │
                │  Express server (Node, tsx) — binds 127.0.0.1      │
                │  ├─ Encrypted keystore (AES-256-GCM, machine-bound)│
                │  ├─ Same-origin /api/* middleware (CSRF gate)      │
                │  ├─ Add-on registry + loader (configEnabled flag)  │
                │  ├─ JSON APIs (glossary, speakers, addons, docs,   │
                │  │             sessions, chronicle, lore, vault)   │
                │  │                                                 │
                │  ├─ [audio-addon, opt-in]                          │
                │  │   ├─ Multi-track upload + extraction            │
                │  │   ├─ Whisper sidecar (Python venv)              │
                │  │   └─ faster-whisper large-v3                    │
                │  └─ [local-llm-addon, opt-in]                      │
                │      ├─ /api/local/* same-origin proxy             │
                │      └─ /api/local-llm/detect + capability probes  │
                │                                                    │
                │  React 19 + Vite SPA  (same-origin)                │
                │  ├─ Pipeline orchestrator                          │
                │  │   └─ LLMProvider.generate(...) ────────────────────► Cloud
                │  │       └─ RateLimitState paces per provider      │   (Gemini /
                │  │                                                 │    Claude /
                │  │                                                 │    OpenAI)
                │  │  Local LLM (only if add-on loaded)              │
                │  │  ←──── /api/local/* proxy ────┘                 │
                │  │                                                 │
                │  └─ Help tab — /api/docs renders every .md in-app  │
                │                                                    │
                │  Finished chronicle → Sessions/<campaign>/….md     │
                │  ──── optional: Tusks-Lore sibling ────────────────►─ ../Tusks-Lore/
                │                                                    │   Sessions/
                │                                                    │   <campaign>/*.docx
                └────────────────────────────────────────────────────┘
```

The server is launched as `npm run dev` (Vite middleware in dev) or
`npm start` (static `dist/` in prod). Both modes serve a single bundle to
`http://localhost:5173` — there is no remote tier and the server binds to
`127.0.0.1` by default. Override the interface via the `TUSKS_HOST` env var
(e.g. `TUSKS_HOST=0.0.0.0` for LAN exposure).

There are three entry points to the refinement pipeline:

1. **Multi-track upload → Whisper → SBV → refinement.** The user records
   their D&D session in Discord with Craig Bot (or any other multi-track
   recorder), downloads the resulting zip of per-speaker FLAC / WAV
   tracks, and drops the file(s) into the **Bot** tab's upload panel.
   The server extracts the archive, lays out the audio per speaker,
   builds a manifest, and runs Whisper one utterance at a time. The
   result is a speaker-tagged `.sbv` that's one click away from the
   refinement pipeline.
2. **`.sbv` upload from YouTube auto-captions.** The Caption Repair tab
   accepts an SBV directly and runs the SBV-aware variant of Phase 1
   grounding before handing off to the refinement pipeline.
3. **Raw transcript paste.** The Chronicle tab accepts free-form text.

All three converge on the same chunked, multi-phase generation in
`src/lib/pipeline.ts`.

---


</div>
</details>

<details class="docs-section">
<summary><h2>2. Tech stack</h2></summary>
<div class="docs-section-body">


### Frontend
- **React 19** + **Vite 6** (single-page app, same-origin with the server).
- **Tailwind CSS v4** + shadcn/Radix UI primitives + `lucide-react` icons.
- **`sonner`** toast notifications.
- **`motion`** + **`tw-animate-css`** for tasteful CSS-driven micro-animation.

### Backend (local server)
- **Node 20+** via **`tsx`** for native TypeScript execution.
- **Express 4** with Vite middleware in dev; serves `dist/` static in prod.
- **`multer`** with disk storage for large multi-track uploads (per-file
  cap 4 GB, up to 32 files per request).
- **`adm-zip`** for in-process Craig-zip extraction.
- **`ffmpeg-static`** + the user's FFmpeg, used to probe per-track
  durations during upload extraction.
- **`env-paths`** for cross-platform app-data resolution.
- **`crypto`** (Node built-in) for AES-256-GCM + scrypt key derivation.
- **`mammoth`** + **`pdf-parse`** for KB document text extraction.

### LLM providers
- **`@google/genai`** (Gemini 2.5+ / 3.x) with Paid / Free tier handling.
- **`@anthropic-ai/sdk`** ≥ 0.96 (Claude 4.x — first-class `cache_control`).
- **`openai`** SDK (Responses API; GPT-5 family).
- **OpenAI-compatible HTTP** for Ollama / LM Studio / llama.cpp /
  Unsloth Studio.

### Whisper sidecar
- **Python 3.10–3.12** in `vendor/python-venv/`.
- **`faster-whisper` 1.0.3** with the **large-v3** model at
  `int8_float16` (CUDA) or `int8` (CPU).
- **`torch` ≥ 2.2 < 3** matched to the user's CUDA toolkit. (The old `< 2.6`
  upper bound was dropped: 2.6 is the first release with cp313 wheels, so
  pinning below it would have hard-blocked Python 3.13. See
  `scripts/whisper/requirements.txt`.)

---


</div>
</details>

<details class="docs-section">
<summary><h2>3. File layout</h2></summary>
<div class="docs-section-body">


```
server/
  index.ts                # Express boot, Vite middleware, same-origin /api/* gate
  appData.ts              # env-paths + atomic JSON IO (includes addonsFile())
  pdfParse.ts             # PDF text extractor for KB uploads
  addons/
    registry.ts           # ADDON_REGISTRY: audio-addon, local-llm-addon
    loader.ts             # loadAddons(): mounts when isReady() && configEnabled
  api/
    glossary.ts           # GET/PUT /api/glossary
    speakers.ts           # GET/PUT /api/speakers
    providers.ts          # encrypted keystore CRUD + test endpoint
    providerKeys.ts       # internal: returns decrypted keys to the SPA
    profiles.ts           # per-provider model profiles
    routing.ts            # last selected provider + per-phase hybrid routing
    addons.ts             # GET /api/addons, POST /:name/install (SSE),
                          #   PATCH /:name (toggle), DELETE /:name
    docs.ts               # GET /api/docs, GET /api/docs/:slug (allowlist)
    lore.ts               # GET /api/lore/status, POST /create,
                          #   POST /save-chronicle (renders .docx)
    sessions.ts           # list / read / delete sessions, stream SBV, live state
    chronicle.ts          # POST /api/chronicle/save → Sessions/<campaign>/*.md
    system.ts             # CPU / RAM / GPU info for the routing recommender
    vault.ts              # GET /api/vault/pair, POST /export-chronicle
    [opt-in audio-addon]
    whisper.ts            # /api/whisper/status, POST /api/whisper/setup (SSE)
    transcribe.ts         # POST /api/sessions/:id/transcribe (legacy/replay)
    upload.ts             # multi-track upload + transcribe-multitrack
    [opt-in local-llm-addon]
    localProxy.ts         # /api/local/list-models|generate|launch (CORS proxy)
    localLLM.ts           # local-provider detection + persisted probe results
    probe.ts              # POST /api/local-llm/probe (mini-probe runner)
  lore/
    detection.ts          # Sibling Tusks-Lore folder detection + create
    docxRenderer.ts       # Chronicle → .docx Buffer (full + condensed modes)
  sessions/
    liveSessionBridge.ts  # Decouples sessions.ts from the audio addon
    sessionManifest.ts    # Session-folder manifest reader / writer
  upload/
    extractMultitrack.ts  # Craig zip / loose-audio → per-speaker session layout
  whisper/
    bootstrap.ts          # venv probing + runSetup() SSE
    invoke.ts             # spawn transcribe.py, parse JSON, build initial prompt
    liveQueue.ts          # in-process per-utterance Whisper worker queue
    sessionPipeline.ts    # legacy "process session" wrapper around liveQueue
  crypto/
    keyStore.ts           # AES-256-GCM keystore (scrypt + machine identity)
  localProbe/
    fixtures.ts           # 5 JSON + 1 grounding fixture
    runner.ts             # scores structuredJsonScore + groundingScore

scripts/
  smoke-test.mjs          # end-to-end provider + whisper + local-LLM ping
  whisper/
    transcribe.py         # faster-whisper sidecar
    requirements.txt
    setup.ps1             # Windows venv bootstrap (CUDA-aware)
    setup.sh              # POSIX venv bootstrap

src/
  App.tsx                 # Tabs: Chronicle, Caption Repair, Tome of Lore,
                          #       Upload+Sessions (audio-addon only),
                          #       Settings, Help
  contexts/
    AddonContext.tsx      # React context: addon list + isLoaded() / isEnabled()
  lib/
    pipeline.ts           # Phase 1–6 chunked orchestration
    sbvGround.ts          # SBV-cue-preserving variant of Phase 1
    prompts.ts            # All prompt builders (cloud + local + split forms)
    chunker.ts            # \n\n-aware splitter with hard-cut fallback
    chunking.ts           # Per-provider/per-phase chunk size table
    rateLimit.ts          # RateLimitState — header parsing + delay math
    preGround.ts          # deterministic safeReplacements + hints formatter
    transcriptCleanup.ts  # [Music]/[Laughter] markers, fillers, whitespace
    kbCompact.ts          # heuristic glossary extraction for tight local contexts
    multitrackUpload.ts   # XHR-based multipart upload client + progress events
    sessions.ts           # RunSession resolver (autoResolve + buildSession)
    sessionsClient.ts     # /api/sessions client + session list helpers
    liveSession.ts        # live SBV polling + speaker mapping refresh
    routing.ts            # /api/routing client
    profiles.ts           # /api/profiles client
    cloudKeys.ts          # per-key option resolver for the ProviderSelectModal
    glossary.ts           # /api/glossary client + in-memory cache
    speakers.ts           # /api/speakers client + cache
    providerSettings.ts   # /api/providers client (UI summary)
    localLLM.ts           # /api/local-llm client (only used when addon loaded)
    lore.ts               # /api/lore client (status / create / save-chronicle)
    vault.ts              # /api/vault client (pair / export-chronicle)
    pipelineToasts.ts     # Shared cleanup/preGround toast helpers (with tests)
    system.ts             # /api/system/info client
    recommendations.ts    # routing recommender (RAM / VRAM / model heuristics)
    reasoning.ts          # OpenAI reasoning-effort + Gemini thinking budget
    gemini.ts             # Back-compat shim (hasApiKey, listAvailableModels)
    constants.ts          # MAX_OUTPUT_TOKENS + retry constants (chunk sizes
                          #   moved to chunking.ts; pacing moved to rateLimit.ts)
    sbv.ts                # SBV parser + formatter (with tests)
    storage.ts            # localStorage helpers + quota-exceeded event bridge
    providers/
      llm.ts              # LLMProvider interface (incl. getNextDelayMs)
      gemini.ts           # GeminiProvider (paid/free + static tier RateLimitState)
      claude.ts           # ClaudeProvider (cache_control + header harvest)
      openai.ts           # OpenAIProvider (Responses API + header harvest)
      local.ts            # Legacy free-function local proxy
      localAdapter.ts     # LLMProvider wrapper for the user-selected local provider
      localInstance.ts    # Per-instance LocalInstanceProvider (hybrid routing)
      settings.ts         # localStorage-backed provider/tier selection
      hardware.ts         # VRAM advisories for local models
      types.ts            # ProviderId + ProviderSettings
      index.ts            # Registry: ensureProvidersInitialized, getActiveProvider
  components/
    RefinementTool.tsx    # Chronicle tab orchestrator
    PhaseProgress.tsx     # In-flight phase progress card
    DMQuestionsModal.tsx  # Phase 2 clarification surface
    ChronicleView.tsx     # Finished chronicle, extras, condensed, auto-save,
                          #   Send-to-Vault + Save-to-Lore (.docx) buttons
    UploadPanel.tsx       # Multi-track upload UI (audio-addon)
    LiveTranscript.tsx    # During/after-transcription view (audio-addon)
    CaptionRepair.tsx     # SBV-mode entry point
    SessionsList.tsx      # Sessions tab (audio-addon): list, replay, delete
    KnowledgeBaseManager.tsx
    GlossaryEditor.tsx
    SpeakerEditor.tsx
    ProviderSettings.tsx
    ModelProfileEditor.tsx
    ProviderSelectModal.tsx
    AddonsManager.tsx     # Settings card: install/uninstall/toggle each add-on
    DocsViewer.tsx        # Help tab content; renders /api/docs with react-markdown
    LoreCard.tsx          # Settings card: detect/create sibling Tusks-Lore folder
    LocalLLMPanel.tsx     # Only rendered when local-llm-addon loaded
    HybridRoutingEditor.tsx # Only rendered when local-llm-addon loaded
    WhisperSettings.tsx   # Only rendered when audio-addon loaded
    VaultPairCard.tsx     # Settings: Tusk's Vault pairing status
    ModelDiagnostics.tsx  # "Check available models" + per-provider picker
    RunnerInstructions.tsx# How to start Ollama / LM Studio / Unsloth
    ui/                   # shadcn-style primitives (button, card, tabs, …)
```

---


</div>
</details>

<details class="docs-section">
<summary><h2>4. Persistence model</h2></summary>
<div class="docs-section-body">


All durable state lives at the platform app-data root via `env-paths`. The
React app never touches the filesystem directly — it goes through Express
APIs. `localStorage` is reserved for ephemeral UI state (refinement
workflow position, KB documents, last-active-tab feel).

### Files on disk

| Path                                                       | Owner                          | Format       |
|------------------------------------------------------------|--------------------------------|--------------|
| `{configDir}/glossary.json`                                | Glossary editor                | JSON (seeded)|
| `{configDir}/speakers.json`                                | Speaker editor                 | JSON         |
| `{configDir}/providers.enc`                                | Keystore                       | AES-256-GCM  |
| `{configDir}/.salt`                                        | Keystore                       | 16 random bytes |
| `{configDir}/profiles.json`                                | Model Profile editor           | JSON         |
| `{configDir}/routing.json`                                 | ProviderSelect + HybridRouting | JSON         |
| `{configDir}/addons.json`                                  | AddonsManager toggle           | JSON `{ [name]: { configEnabled } }` |
| `{configDir}/local-llm.enabled`                            | local-llm-addon marker         | Empty file (presence = installed) |
| `{cacheDir}/capability.json`                               | Probe runner (local-llm-addon) | JSON         |
| `{dataDir}/sessions/{id}/manifest.json`                    | Upload extractor + live queue (audio-addon) | JSON |
| `{dataDir}/sessions/{id}/audio/{speakerId}/*.{wav,flac,…}` | Upload extractor (audio-addon) | per-speaker audio |
| `{dataDir}/sessions/{id}/transcripts/{speakerId}/*.json`   | Whisper sidecar (audio-addon)  | JSON         |
| `{dataDir}/sessions/{id}/session.sbv`                      | Live queue (audio-addon)       | SBV plaintext|
| `<repo>/vendor/python-venv/`                               | audio-addon install            | Python venv (~2 GB) |
| `<repo>/Sessions/<campaign>/Silence Beyond the Sea - <campaign> - Session <n>.md` | Chronicle auto-save | Markdown |
| `<parent>/Tusks-Lore/tusks-lore.json`                      | Lore detection marker          | JSON `{ version, createdAt, notes? }` |
| `<parent>/Tusks-Lore/Sessions/<campaign>/Session-NN-YYYY-MM-DD-<full\|condensed>.docx` | Save-to-Lore button | Word `.docx` (via `docx` package) |

Env-var overrides for the disk roots:

- `TUSKS_SESSIONS_DIR` — session audio + transcripts root (handy when a
  multi-GB session is better kept on a roomier drive than the default
  `%LOCALAPPDATA%` / `~/.local/share`).
- `TUSKS_VAULT_DIR` — explicit path to a Tusk's Vault checkout when the
  sibling-directory auto-detect doesn't find it.
- `TUSKS_LORE_DIR` — explicit path to the shared `Tusks-Lore/` folder
  when it isn't a sibling of the repo root.

### Writes are atomic

`server/appData.ts → writeJson` always writes to a randomly-named temp
file in the same directory, then renames over the target. A crash
mid-write either leaves the previous file intact or the new file fully
present — never a truncated half-write. The chronicle save endpoint
follows the same pattern for its `.md` output.

### Seed migration

Files seed themselves on first read after upgrade. The glossary seeds
from `src/data/corrections.ts` if the on-disk doc is absent; the
encrypted keystore seeds from `process.env.PAID_GEMINI_API_KEY` /
`VITE_GEMINI_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` if any
are present, then logs a notice that the GUI is the recommended path.
The app was previously named "Silence Beyond the Sea"; the
`migrateLegacyAppData()` helper at server boot moves any pre-rename
`env-paths` tree to the new `tusks-tomes` locations.

---


</div>
</details>

<details class="docs-section">
<summary><h2>5. Provider abstraction</h2></summary>
<div class="docs-section-body">


The pipeline never speaks to a vendor SDK directly. Every phase calls
`provider.generate({...})` against `LLMProvider` (defined in
`src/lib/providers/llm.ts`).

```ts
interface LLMProvider {
  readonly name: 'gemini' | 'claude' | 'openai' | 'local'
  generate(req: GenerateRequest, opts?: GenerateOptions): Promise<GenerateResponse>
  listModels(): Promise<string[]>
  estimateCost?(usage: Usage, model: string): number
}

type GenerateRequest = {
  systemPrompt: string
  cacheablePrefix?: string   // KB + glossary; identical across chunks in a run
  userPrompt: string         // chunk + dynamic content
  model: string
  maxOutputTokens: number
  temperature?: number
  responseFormat?: 'text' | 'json'
  safetyMode?: 'permissive' | 'default'
}
```

The `cacheablePrefix` split is what unlocks provider-native caching.
Phases 1, 3, and 6 all emit a split `{ cacheablePrefix, userPrompt }` —
Phase 1's prefix carries the KB + glossary; Phase 3's carries the
speaker-attribution rules + DM Q&A; Phase 6's carries the KB + DM Q&A
+ JSON format spec. The per-chunk userPrompt holds only the variable
parts (transcript chunk, prior chronicle tail, etc.).

- **Claude** — attaches `cache_control: { type: 'ephemeral' }` to the
  cacheable system block. The TTRPG framing + user system prompt is the
  first (uncached) block.
- **OpenAI** — the `instructions` field carries framing + system +
  cacheable prefix as a stable string; OpenAI's automatic prefix cache
  hits at ≥1024 tokens.
- **Gemini** — concatenates the prefix into the system content. The
  implicit prefix cache on Gemini 2.5 still rebates ~75% on a stable
  prefix; explicit `cachedContent` wiring is a separate follow-up.

Each implementation owns its own retry/backoff and surfaces token usage
in a unified `Usage { inputTokens, cachedInputTokens?, outputTokens }`
shape.

### Registry + initialization

`src/lib/providers/index.ts` exports `ensureProvidersInitialized()`,
which fetches the decrypted bundle from `/api/provider-keys` and
constructs all four singletons (Gemini × 3 tiers — `auto` / `paid` /
`free` — plus Claude, OpenAI, Local). The pipeline awaits this at the
start of every run.

`getActiveProvider()` returns the singleton matching the user's selected
provider (legacy single-provider mode), while `getCloudProvider(name,
{ geminiTier })` resolves a specific cloud provider for the per-phase
dispatcher.

### Gemini Paid / Free tiers

Gemini exposes two key slots in the keystore (`gemini` for Paid /
billing-enabled, `geminiFallback` for the Free tier). The pipeline can
run in three modes:

- **`auto`** — Paid first, fail over to Free on hard-zero quota or
  repeated exhaustion.
- **`paid`** — Paid only; never touches the Free key.
- **`free`** — Free only, except that any phase whose model is in the
  pre-computed *paid-only* list (Gemini 3.x identifiers that 404 against
  the Free key) is escalated to Paid for that phase, with a warning
  banner shown before the run starts.

---


</div>
</details>

<details class="docs-section">
<summary><h2>6. Encrypted key storage</h2></summary>
<div class="docs-section-body">


Keys live in `{configDir}/providers.enc` under AES-256-GCM. The
encryption key is derived from a stable machine identity
(`hostname + username + platform`) via `scryptSync`, salted by a random
16-byte value at `{configDir}/.salt`. This is **obfuscation**, not
high-grade cryptography — keys are recoverable on the same machine. The
Settings UI states this explicitly.

```
File format (after decryption):
{
  "gemini":         "AIza…",     // Paid / billing-enabled
  "geminiFallback": "AIza…",     // Free tier
  "claude":         "sk-ant-…",
  "openai":         "sk-…"
}
```

The decrypted bundle is fetched **once** at React app boot via
`/api/provider-keys` (server-internal, localhost-only). Cloud SDKs run
in-browser. The keys never appear in any user-facing endpoint response —
the public `/api/providers` only returns a summary of which slots are
set.

A built-in **Test** action runs a 1-token call (or, for Gemini, a free
`ListModels` lookup) to verify the key works without persisting
anything.

---


</div>
</details>

<details class="docs-section">
<summary><h2>7. Profiles, routing, and run-start session resolution</h2></summary>
<div class="docs-section-body">


### Profiles

`{configDir}/profiles.json` stores per-provider, per-phase model
assignments:

```json
{
  "gemini": { "phase1Model": "gemini-2.5-pro",
              "phase2Model": "gemini-2.5-flash",
              "phase3Model": "gemini-2.5-pro",
              "phase4Model": "gemini-2.5-flash",
              "phase6Model": "gemini-2.5-pro" },
  "claude": { "phase1Model": "claude-sonnet-4-6",
              "phase3Model": "claude-sonnet-4-6",
              "useCacheControl": true },
  "openai": { "phase1Model": "gpt-5-mini",
              "phase3Model": "gpt-5" }
}
```

Defaults: prose-heavy phases (1, 3, 5, 6) go to the mid-tier model;
JSON-shaped phases (2, 4) go to the cheapest model that holds the
schema.

### Routing

`{configDir}/routing.json` tracks both the last cloud provider used and
optional per-phase hybrid overrides. Each of the five model phases
(1–4, 6) can independently route to a specific local model:

```json
{
  "version": 2,
  "lastSelectedProvider": "claude",
  "perPhase": {
    "phase1": { "target": "local", "modelId": "qwen2.5:14b" },
    "phase2": { "target": "local", "modelId": "qwen2.5:14b" },
    "phase3": { "target": "cloud" },
    "phase4": { "target": "local", "modelId": "qwen2.5:14b" },
    "phase6": { "target": "cloud" }
  }
}
```

### `RunSession` at run start

When the user clicks **Run**, `RefinementTool` calls
`autoResolveSession()`:

- If no cloud keys are configured: error (with a pointer to Settings).
- If exactly one cloud key option is configured: build the `RunSession`
  directly.
- If multiple (including Gemini Paid vs Free as separate options): open
  `ProviderSelectModal` showing each candidate's per-phase model list.
  The user picks; the choice is persisted as `lastSelectedProvider` for
  the next run.

The resolved session carries
`{ provider, profile, models, routing, geminiTier?, geminiPaidOnlyModels? }`,
and each `runPhase*` accepts both `model` (string) and `phaseTarget`
(cloud or local) so a single phase can route to a local model
independently of the rest of the run.

### Budget mode

Hybrid Routing has a **Budget mode** preset that swaps every phase to
the fast-tier model for the active provider (`gemini-2.5-flash`,
`claude-haiku-4-5`, `gpt-5-mini`). One click, one toast, one Save.
Companion **Clear overrides** button resets every phase back to its
default profile model. Both buttons are pure helpers — the actual
mapping lives in `src/lib/budgetMode.ts` and is unit-tested
independently of React.

---


</div>
</details>

<details class="docs-section">
<summary><h2>8. The multi-track upload pipeline</h2></summary>
<div class="docs-section-body">


This is the canonical way audio gets into the app. Recording happens
externally (Craig Bot in Discord is what we test against; any multi-
track recorder that produces per-speaker audio files works). Tusk's
Tomes is purely a post-processor — it does not connect to Discord, does
not join voice channels, and does not need a Discord bot token.

### What the user uploads

The **Bot** tab's upload panel accepts any combination of:

- **One or more `.zip` files** containing per-speaker audio tracks
  (e.g. four 1-hour Craig zips of the same session). Each zip is
  treated as an ordered *chunk*; cross-chunk speakers with the same
  Craig-derived ID are merged into one participant.
- **Loose audio files** (`.wav`, `.flac`, `.ogg`, `.opus`, `.mp3`,
  `.m4a`, `.aac`). All loose files in a single upload form one chunk
  at the position they appear in the user-controlled file order.

Per-file size limit is 4 GB, with up to 32 files per request — well
above what a 4-hour, 8-speaker FLAC capture produces.

### Stage 1 — extraction (`POST /api/sessions/upload-multitrack`)

`server/upload/extractMultitrack.ts` streams the upload to disk via
multer disk storage, then:

1. Partitions inputs into ordered chunks (one zip = one chunk; loose
   files cluster into one chunk at their first appearance).
2. Creates a fresh `{dataDir}/sessions/{sessionId}/` and writes a stub
   `manifest.json` (atomic).
3. For each chunk:
   - Extracts the zip (`adm-zip`) into a temp workdir, or accepts the
     loose audio files in place.
   - Parses speaker identity from each filename (`{numericPrefix}-{name}`
     handles Craig and most index-prefixed conventions; falls back to a
     stable hash of the stem when no numeric prefix exists).
   - Moves the audio file into
     `audio/{speakerId}/{utteranceId}.{ext}` (preserving the original
     codec — no FFmpeg re-encode at this stage).
   - Probes the duration via FFmpeg (`-i`, parse the `Duration:` line)
     and records a `UtteranceEntry` with chunk-relative timing.
   - Appends the participant + utterance to the manifest.
4. Maintains a running `cumulativeMs` so utterances in chunk N+1
   start where chunk N ended — the time-stitching that lets four
   sequential 1-hour zips replay as one 4-hour session.

The response shape is `{ sessionId, chunks: [...], tracks: [...] }`.
The UI uses this to render a speaker preview table where the user can
rename loose-file speakers before transcription begins. Zip-internal
speakers are derived from filenames at extraction time and can be
adjusted later through the Speaker editor.

### Stage 2 — transcribe (`POST /api/sessions/:id/transcribe-multitrack`)

The handler returns 202 immediately and kicks off
`transcribeExistingSession(sessionId)` against the live queue (§9). The
UI then polls `/api/sessions/:id/live` every couple of seconds for
running progress, the in-flight SBV, and a list of observed
participants.

### Stage 3 — cleanup affordances

- `DELETE /api/sessions/:id/upload-multitrack` — drop the partially-
  uploaded session before transcription starts.
- `DELETE /api/sessions/:id/audio` — keep the manifest, per-utterance
  transcript JSONs, and `session.sbv`, but wipe the multi-GB audio
  tracks once the user is satisfied with the transcript. Surfaced as
  the *Delete audio (keep transcript)* button in the Sessions tab.

### Session manifest schema

`server/bot/sessionManifest.ts` (so named for historical reasons; it's
now the manifest module for the upload pipeline) owns the on-disk
shape:

```ts
type SessionManifest = {
  version: 1
  sessionId: string
  guildId: string             // empty for uploads
  voiceChannelId: string      // empty for uploads
  voiceChannelName: string    // user-supplied "session label" or "Uploaded session"
  startedAt: string           // ISO-8601
  endedAt: string | null
  participants: ParticipantEntry[]
  processing: {
    transcribedAt: string | null
    sbvPath: string | null    // 'session.sbv' once finalised
    errors?: string[]         // per-utterance Whisper failures
  }
}
```

The upload extractor and Whisper queue are the only writers; the
React-side Sessions tab is a read-only consumer (plus a delete
button).

---


</div>
</details>

<details class="docs-section">
<summary><h2>9. The Whisper sidecar</h2></summary>
<div class="docs-section-body">


### Contract

`scripts/whisper/transcribe.py` is invoked once per utterance:

```
python transcribe.py
  --audio <file>
  --speaker-id <speakerId>
  --speaker-display "<Character (Player)>"
  --initial-prompt "<glossary biasing string>"
  --model large-v3
  --device cuda          # or cpu
  --compute-type int8_float16
```

It runs `faster-whisper.transcribe(...)` with:

- `vad_filter=True` (Silero VAD)
- `word_timestamps=True`
- `condition_on_previous_text=False` (avoid hallucination cascades)
- `beam_size=5`
- `temperature=[0.0, 0.2, 0.4]` (graceful fallback ladder)
- `no_speech_threshold=0.6`

Output is a single JSON document on stdout with
`{speakerDisplay, durationMs, segments[{startMs, endMs, text, words, confidence}]}`.
Errors go to stderr; non-zero exit code on failure.

### Initial prompt (~200-token glossary bias)

`server/whisper/invoke.ts → buildInitialPrompt(canonicalNames)` builds
the biasing string from the glossary's `contextualHints[].canonical`
and capitalised `safeReplacements[].to` entries. The string is capped
at ~800 chars (Whisper's hard limit). Distinct names come first,
truncated when full.

### Setup + readiness

`scripts/whisper/setup.ps1` (Windows) / `setup.sh` (POSIX) create
`vendor/python-venv/` and install torch + faster-whisper. The Windows
script detects `nvidia-smi` and installs the CUDA wheel; POSIX
defaults to CPU with `--cuda 12.4` as an opt-in.

`/api/whisper/status` reports `{ ready, pythonPath, venvPath,
scriptPath, error? }`. `/api/whisper/setup` streams the setup script's
stdout/stderr as Server-Sent Events so the UI can show live progress.

### The live queue

`server/whisper/liveQueue.ts` is a single in-process worker that drains
a serial queue of utterances against the sidecar. Both the upload path
and the legacy "process session" endpoint enqueue into the same queue,
so there is only one downstream code path. On a single-GPU machine the
serial drain is correct; on a multi-GPU machine the bottleneck is the
sidecar's load-once-per-process model warm-up rather than the queue.

Per utterance:

1. Resolve `speakerDisplay` via the speakers map
   (`Character (Player)` / `Character` / `Player` / filename fallback).
2. Invoke the sidecar on CUDA. On a `STATUS_STACK_BUFFER_OVERRUN`
   (0xC0000409) — a known Windows CUDA/cuDNN re-init flake when one
   sidecar process exits and the next loads the model — the queue
   retries the same utterance on CPU with `int8` once before giving up.
   CPU is 6–10× slower but reliable.
3. Persist the sidecar JSON to
   `transcripts/{speakerId}/{utteranceId}.json`.
4. Split each Whisper segment at any internal word-gap longer than
   2 seconds. Without this, faster-whisper occasionally returns a
   single segment covering a multi-minute stretch with several minutes
   of silence inside, which then sorts to the head of the SBV and
   confuses Phase 3 into reading it as the opening monologue.
5. Append the resulting sub-segments to an in-memory timeline with
   `absStartMs = utterance.startedAtMs + segment.startMs` (the
   utterance's chunk-relative start was set during extraction).
6. Re-emit `session.sbv` after every utterance, sorted by absolute
   start time, with cue bodies prefixed `[Character (Player)] <text>`.

Re-writing the SBV after every utterance means:

- A server crash mid-session loses at most one utterance's worth of
  work.
- The same `session.sbv` file is the artifact the refinement pipeline
  consumes — there is no separate "live" code path downstream.
- Updates to `speakers.json` (e.g. filling in a missing player name)
  can be picked up by `refreshLiveSbv(sessionId)`, which re-emits the
  cues against the new mapping without re-running Whisper.

Errors during transcription are appended both to the in-memory
`state.errors` array (surfaced in the live status endpoint) and to
`manifest.processing.errors` (durable once the in-memory state is
forgotten on server restart).

---


</div>
</details>

<details class="docs-section">
<summary><h2>10. The refinement pipeline</h2></summary>
<div class="docs-section-body">


Lives in `src/lib/pipeline.ts`. Five model-driven phases, plus
deterministic pre-processing in Phase 1 and an optional sixth pass
(Condense) that the user triggers from the finished chronicle view.

Display order:
**Phase 1 → Phase 2 → DM clarifications → Phase 3 → Phase 5 (polish, local only) → Phase 4 → Phase 6 (condense, optional)**

### Phase 1 — Grounding

- **Input:** raw transcript (or uploaded multi-track SBV cue text).
- **Chunk size:** 15,000 chars cloud / 5,000 chars local.
- **Pre-processing (deterministic, before any LLM call):**
  - `transcriptCleanup` strips `[Music]` / `[Laughter]` markers,
    collapses runaway fillers, normalises whitespace, quotes, and
    dashes.
  - `preGround` applies whole-word `safeReplacements` (the built-in
    `dndDictionary` first, then the user glossary).
- **LLM step:** correct lore spellings against the KB, restore
  censored expletives, preserve speaker tags exactly. The system
  prompt + KB + contextual hints are emitted as the
  **`cacheablePrefix`**; the per-chunk text is the **`userPrompt`**
  — Claude's `cache_control` and OpenAI's automatic prefix cache hit
  from chunk 2 onwards.
- **Output:** grounded transcript.

### Phase 2 — Audit

- **Input:** raw + grounded transcripts (paired by chunk index).
- **Chunk size:** 15,000 chars cloud / 5,000 chars local.
- **LLM step:** surface DM clarification questions when phonetic
  ambiguity, unresolvable attribution, consequential unclear plot
  beats, or canon contradictions remain. The cloud prompt is
  conservative ("only ask when necessary"); the local prompt is
  aggressive ("better to over-ask than ship wrong").
- **Output:** `DMQuestion[]` (JSON) shown in the DMQuestionsModal.

After Phase 2 the user reviews the questions, optionally answers
them, and triggers Phase 3.

### Phase 3 — Chronicle

- **Input:** grounded transcript + DM answers.
- **Chunk size:** 35,000 chars cloud / 8,000 chars local.
- **LLM step:** novel-style narrative prose, ruthlessly filtering OOC
  chatter. Each chunk receives the last 2,000 chars of the previously
  emitted prose as a **`priorTail`** so continuity holds across
  seams. The prompt enforces character attribution: lines prefixed
  `[CharacterName (PlayerName)]` get incorporated into the prose,
  never printed verbatim.
- **Output:** continuous chronicle text.

### Phase 5 — Polish (local only)

- **Pass-through for cloud.** Runs only when the active provider is
  local — cloud chronicles from Phase 3 are already coherent.
- **Input:** the rough chronicle from Phase 3.
- **Chunk size:** 6,000 chars.
- **LLM step:** spell-correct names against the (compact) KB, smooth
  chunk-boundary seams, cut residual OOC chatter that slipped past
  Phase 3. Same bardic voice, same length or shorter.
- **Output:** polished chronicle.

### Phase 4 — Extras

- **Input:** grounded transcript + DM answers.
- **Chunk size:** 35,000 chars cloud / 8,000 chars local.
- **LLM step:** extract `{ jests, gore, quotes }` per chunk. Quotes
  are classified by `kind` (`funny` / `stupid` / `dark`). Hard skips
  on dice rolls, real-world refs, table chatter.
- **Output:** merged `ExtrasOutput`.

### Phase 6 — Condense (optional, user-triggered)

- **Input:** the finished chronicle + DM answers + campaign/session
  context.
- **Chunk size:** 60,000 chars cloud / 10,000 chars local — the
  chronicle is usually coherent enough to fit in one chunk so the
  condenser can see the whole arc.
- **LLM step:** produce
  `{ narrative, bulletPoints }` — a tightened retelling (~30–50% of
  the source) plus 10–15 catch-up bullets covering events, NPC
  interactions, and party state.
- **Output:** `CondenseOutput`. The Chronicle view exposes new
  **Condensed** and **Recap** tabs once present, and the auto-save
  re-runs to fold the new sections into the on-disk Markdown.

### Chunking + pacing

- Chunks split on `\n\n` when possible, falling back to a hard
  substring cut. See `src/lib/chunker.ts`.
- Chunk **sizes** are per-(provider, model-tier)-per-phase, owned by
  `src/lib/chunking.ts`. The model tier is resolved by
  `classifyModelTier(model, provider)` in `src/lib/modelTier.ts` —
  Pro / Sonnet / GPT-5 land on `flagship`; Flash / Haiku / GPT-5-mini
  / GPT-5-nano land on `fast`; Opus lands on `frontier`. Numbers
  (chars per chunk, Phase 1 / 2 / 3 / 4 / 6):

  | Profile | flagship | fast |
  |---|---|---|
  | geminiPaid | 30k / 30k / 60k / 60k / 100k | 15k / 15k / 30k / 30k / 50k |
  | geminiFree | 15k / 15k / 35k / 35k / 60k | 8k / 8k / 18k / 18k / 30k |
  | claude | 20k / 20k / 40k / 40k / 60k | 10k / 10k / 20k / 20k / 30k |
  | openai | 15k / 15k / 30k / 30k / 50k | 8k / 8k / 15k / 15k / 25k |

  `frontier` mirrors flagship — Opus has comparable context but we
  don't push it past flagship sizes without data to justify it. Local
  LLMs share a single conservative table regardless of runner. The
  default tier is `flagship`, so callers that omit the model fall back
  to the same numbers as before A3 — byte-for-byte back-compat.
- Chunk **pacing** is per-provider, derived from response headers (see
  `src/lib/rateLimit.ts`). Claude / OpenAI populate `RateLimitState`
  from `anthropic-ratelimit-*` and `x-ratelimit-*` headers each call;
  Gemini seeds static `RPM` / `TPM` values from `GEMINI_STATIC_LIMITS`
  based on which key is in play (`PAID_GEMINI_API_KEY` vs
  `VITE_GEMINI_API_KEY`). The pipeline calls
  `provider.getNextDelayMs(estimatedInputTokens)` between chunks; the
  delay is `max(60_000 / RPM, tokens / TPM × 60_000) × 1.1`. 429
  `Retry-After` overrides the calculated delay precisely. The legacy
  fixed 65-second `INTER_CHUNK_DELAY_MS` constant is gone.
- Local providers return 0 from `getNextDelayMs` — no API rate limit
  to respect. Per-phase `target: 'local'` overrides skip pacing for
  just that phase even on a cloud-default run.
- Inside each phase, abort signals propagate to provider calls
  (browser fetch + every cloud SDK honour AbortSignal).

### Per-phase routing dispatch

`chunkedGenerate` checks `args.phaseTarget`. When `target === 'local'`,
it instantiates a `LocalInstanceProvider` against that model's
`{ baseUrl, modelId }` for the duration of the phase, instead of
dispatching through `getActiveProvider()`. The local provider routes
via the existing `/api/local/generate` server proxy (single-origin to
avoid CORS).

When `target === 'cloud'`, the explicit `cloudProvider` from
`RunSession` is honoured, with the optional Gemini tier escalation
described in §5.

### Caching summary

| Phase | Provider | Caching mechanism                              |
|-------|----------|-----------------------------------------------|
| 1     | Claude   | `cache_control: ephemeral` on system block    |
| 1     | OpenAI   | Automatic prefix cache (≥1024 tokens prefix) |
| 1     | Gemini   | Implicit prefix cache (~75% rebate on stable prefix; explicit `cachedContent` deferred) |
| 3     | Claude / OpenAI / Gemini | Same split as Phase 1 — speaker rules + DM Q&A live in `cacheablePrefix`, transcript + prior tail in `userPrompt` |
| 6     | Claude / OpenAI / Gemini | Same split as Phase 1 — KB + DM Q&A + JSON format spec live in `cacheablePrefix`, campaign + chronicle chunk in `userPrompt` |
| 2, 4  | All      | No caching today; the audit and extras prompts pair raw + grounded inputs that can't share a stable prefix |
| 1–6   | Local    | None (no provider primitive)                  |
| SBV   | Cloud    | Same split as Phase 1                         |

Persona templates opt out of the cacheable split — their user-authored
text interleaves variables in ways we can't safely partition. Persona
users get the legacy uncached path; the default bardic voice gets the
cache rebate.

### Chronicle persistence

When the chronicle reaches the "done" state (Phase 4 complete) and
again whenever Phase 6 lands, `ChronicleView` posts the composed
Markdown to `POST /api/chronicle/save`. The server writes it
atomically to
`<repo>/Sessions/<campaign>/Silence Beyond the Sea - <campaign> - Session <n>.md`,
sanitising the campaign segment for path safety. Auto-save de-dupes
by content fingerprint so an unrelated re-render doesn't cause an
extra write; failures clear the fingerprint so the next change
retries. The `Sessions/` directory is gitignored — users decide
whether to commit individual chronicles.

---


</div>
</details>

<details class="docs-section">
<summary><h2>11. Local-LLM detection + probing</h2></summary>
<div class="docs-section-body">


### Detection

`/api/local-llm/detect` probes three default backends in parallel:

| Backend     | Default URL              | Models endpoint |
|-------------|--------------------------|-----------------|
| Ollama      | `http://localhost:11434` | `/api/tags`     |
| LM Studio   | `http://localhost:1234`  | `/v1/models`    |
| llama.cpp   | `http://localhost:8080`  | `/v1/models`    |
| Unsloth     | `http://localhost:8888`  | `/v1/models`    |

Each reports `{ reachable, models[], error? }`. The Local LLM panel
shows reachable backends with their installed models, and the
**Launch** button can spawn a runner (Ollama with FlashAttention +
4-bit KV cache, LM Studio CLI, or Unsloth Studio with auto-open of
the login page).

### Authentication

The local-LLM proxy supports three auth schemes per backend:

1. Explicit `bearerToken` — sent verbatim.
2. `username` + `password` — exchanged at `/token` via OAuth2 password
   flow; the resulting JWT is cached for 30 minutes. Used by Unsloth
   Studio's FastAPI-style auth.
3. `username` + `password` fallback to HTTP Basic when OAuth2 isn't
   available.

The proxy refuses to forward to anything outside loopback or RFC-1918
private LAN addresses (validated by `PRIVATE_HOST_RE` in
`server/index.ts`) — it is not an open proxy.

### Mini-probe (2 tests)

`server/localProbe/runner.ts`:

1. **Structured JSON adherence** — 5 short prompts requiring
   strict-JSON replies matching a hand-crafted schema. Score =
   passes / 5; threshold for Phase 2 / 4 eligibility is `0.8`.
2. **Grounding fidelity** — a 200-word transcript snippet with 5
   known mishearings + 5 distractors in the glossary; the model must
   apply only the 5 expected corrections without inventing anything
   else. Score = `corrected/5 − 0.2 × invented`, clamped to `[0, 1]`.
   Threshold for Phase 1 eligibility is `0.7`. Phase 3 is currently
   held back from local regardless of score (deferred work: a richer
   prose-quality probe).

Results persist in `{cacheDir}/capability.json` so probes survive
restarts. The Hybrid Routing editor reads from this cache when
offering local models per phase.

### Hardware-aware recommender

`src/lib/recommendations.ts` combines `/api/system/info` (RAM, CPU,
NVIDIA VRAM via `nvidia-smi`) with the user's chosen local model to
flag obvious mismatches before the user commits — e.g. a 32B model
on 8 GB VRAM gets a "won't fit" badge in the routing editor.

---


</div>
</details>

<details class="docs-section">
<summary><h2>12. Rate limiting + safety</h2></summary>
<div class="docs-section-body">


### Retry strategy

- 4 retry attempts (`MAX_RETRIES`) before a phase fails.
- Transient 429 / 5xx (when the response did **not** include a
  `Retry-After` header): 35-second backoff (`TRANSIENT_RETRY_MS`).
- Final attempt fallback: 65-second backoff (`EXHAUSTION_RETRY_MS`).
- When a 429 response **does** include `Retry-After`, the provider
  parses it via `retryAfterFromError` (Claude / OpenAI) and waits
  exactly that long instead of the static constant; the same delay is
  also fed into `RateLimitState.noteRetryAfter()` so the next chunk
  honours the window too.
- Gemini-specific: hard-zero-quota (`limit: 0`) triggers an immediate
  swap to the fallback key in `auto` mode, provided both `gemini` and
  `geminiFallback` were decrypted at boot. Two consecutive exhaustion
  errors also swap; on swap, the `RateLimitState` is re-seeded with
  the free-tier RPM/TPM so pacing stays accurate after the flip.

### Output token budget

`MAX_OUTPUT_TOKENS = 32,768` by default (overridable via
`VITE_MAX_OUTPUT_TOKENS`). Comfortably above what any single chunk
needs (~4× typical chunk output size) so `MAX_TOKENS` finish reasons
are rare. The 8,192 default that shipped earlier was a Gemini
1.0-era leftover that bit on grounding work.

### Mature content

Cloud providers receive `safetyMode: 'permissive'`. Gemini applies
`HarmBlockThreshold.BLOCK_NONE` across all four user-tier categories.
Claude and OpenAI rely on a TTRPG framing line ("Mature themes are
expected: profanity, violence, dark humour, sexual references, gore —
preserve them verbatim") injected as the first system block.

### Inter-chunk pacing

Adaptive per-provider, not a fixed constant. See "Chunking + pacing" in
§10 for the full formula. Drops to 0 for local providers (the
`LocalProviderAdapter` doesn't implement `getNextDelayMs`) and for
individual phases marked `target: 'local'`.

### Safety multiplier — the slow-down dial

The rate-limit dialog (see §19) offers a **Slow down** option that
multiplies inter-chunk pacing by 3×. The multiplier threads through
`chunkedGenerate` as either a literal `number` or a `() => number`
getter; when the dialog mid-run sets the multiplier, the chunk loop
reads the latest value before each chunk's pacing call. Default `1.0`
preserves byte-for-byte spacing for existing callers — only users who
explicitly pick "slow down" see the dilated pacing.

---


</div>
</details>

<details class="docs-section">
<summary><h2>13. Security & privacy</h2></summary>
<div class="docs-section-body">


- The server **binds to `127.0.0.1` by default**. Override with
  `TUSKS_HOST` (e.g. `TUSKS_HOST=0.0.0.0` for LAN exposure on a trusted
  network). No external IP is exposed by default.
- A same-origin middleware mounted on `/api/*` rejects any
  state-changing request (POST/PUT/PATCH/DELETE) whose `Origin` header
  doesn't match the listener — closes drive-by-CSRF (e.g. a malicious
  tab triggering an add-on install). Missing `Origin` is allowed so
  curl / smoke-test / other non-browser tooling still works.
- API keys are encrypted at rest under a machine-bound passphrase.
  They are fetched in-memory once at React app boot and live in JS
  heap only.
- KB documents, transcripts, recordings, and chronicles never leave
  the user's machine. Cloud LLM calls send only the chunk text +
  system prompt + KB excerpts the user uploaded.
- No telemetry, no analytics, no third-party tracking.
- Whisper (when the audio-addon is installed) runs locally; no audio
  leaves the host.
- The local-LLM proxy at `/api/local/*` (mounted by the local-llm-addon
  only) accepts requests to loopback / RFC1918 private LAN addresses
  only, validated via `PRIVATE_HOST_RE` in `server/api/localProxy.ts`.
  It is not an open proxy. Default installs return 404 on these routes
  because the add-on isn't loaded.
- Add-on install endpoints (`POST /api/addons/:name/install`, `POST
  /api/whisper/setup`) are POST + same-origin-gated. The previous GET
  variants were converted to close drive-by `<img src=…>` triggering.
- Add-on disable: even after install, a user can flip the
  `configEnabled` toggle in Settings → Add-ons. The loader skips
  toggled-off add-ons at next start; their routes are never mounted.
- Audio files are written to disk in the codec they arrived in
  (FLAC / WAV / OGG…) by design, so the user can audit them. Delete
  via the Sessions UI (audio-only or whole-session) or by removing
  the session directory.
- The chronicle save endpoint refuses path traversal (campaign
  segments are stripped of `\/:*?"<>|` and control characters before
  composition) and always writes inside the repo's `Sessions/`
  directory. The Tusks-Lore `.docx` writer uses the same sanitizer
  before composing `<loreRoot>/Sessions/<campaign>/...`.
- The docs viewer (`/api/docs/:slug`) uses an allowlist-based slug map
  built at startup: slugs match `/^[a-z0-9-]+$/` AND must exist in the
  precomputed Map. There is no string-concatenation of user input with
  filesystem paths — path traversal is impossible by construction.

---


</div>
</details>

<details class="docs-section">
<summary><h2>14. Build + deployment</h2></summary>
<div class="docs-section-body">


- `npm run dev` — Express + Vite middleware on `127.0.0.1:5173`.
- `npm run build` — `vite build` (SPA bundle) +
  `tsc -p tsconfig.server.json` (`dist-server/`).
- `npm start` — production: static `dist/` served by Express, same
  routes.
- `npm run typecheck` — frontend + server type-check (both
  `tsconfig.json` and `tsconfig.server.json`).
- `npm test` — Vitest runs `src/**/*.test.{ts,tsx}` and
  `server/**/*.test.ts`. Covers chunking, rate limiting, SBV
  round-trip, pipeline toasts, add-on loader (error isolation +
  configEnabled gating), liveSessionBridge no-op default, docs router
  slug allowlist, and Tusks-Lore detection.
- `npm run smoke-test` — end-to-end ping of every configured provider
  plus Whisper readiness across three lifecycles (not-installed /
  installed-restart-required / ready). Non-zero exit on real failures;
  "skipped" results don't count as failures.
- `npm run setup` — first-time-install path: checks Node/Python, runs
  `npm install`. Does **not** run `whisper:setup` — Whisper is now an
  opt-in add-on installed from the in-app Settings → Add-ons UI.
- `npm run whisper:setup` / `npm run whisper:setup:posix` — bootstrap
  the Python venv. Called by the audio-addon's `install()` handler;
  also runnable from the CLI for advanced users.
- **CI** — `.github/workflows/ci.yml` runs `npm ci` + `npm run
  typecheck` + `npm test` on every push and pull-request against
  `main`. Smoke-test stays out of CI (needs live provider keys).

---


</div>
</details>

<details class="docs-section">
<summary><h2>15. Add-on system</h2></summary>
<div class="docs-section-body">


The core install ships paste-a-transcript chronicling through cloud LLMs.
Anything heavier — Whisper audio, local-LLM routing — is gated behind a
small registry-based add-on system so a user who never wants it never
pays the disk / dependency cost.

### Registry + loader

`server/addons/registry.ts` exports `ADDON_REGISTRY: AddonDefinition[]`.
Each `AddonDefinition` declares:

- `name` — machine-stable identifier (`audio-addon`, `local-llm-addon`).
- `displayName` / `description` / `wip` — UI metadata.
- `docSlug` — optional `/api/docs` slug for the "Read docs" link.
- `isReady(): Promise<boolean>` — prerequisites present?
- `install(emit): Promise<number>` — returns the underlying script's
  exit code; non-zero means failure.
- `uninstall(): Promise<void>` — remove prerequisites.
- `registerRoutes(app: Express): void` — mount the add-on's
  endpoints.

`server/addons/loader.ts → loadAddons(app)` runs at server start. For
each registered add-on it:

1. Reads `{configDir}/addons.json` (the user's toggle state).
2. Skips the add-on if `configEnabled === false`.
3. Calls `await addon.isReady()`. Skips if false.
4. Mounts routes via `addon.registerRoutes(app)`.
5. Records the name in an in-memory `Set` exposed as
   `isAddonLoaded(name)`.

Failure of any step (a thrown `isReady`, a thrown `registerRoutes`) is
caught and logged; the loader continues to the next add-on so one bad
addon can't brick startup. Tests in `server/addons/loader.test.ts`
pin this behaviour.

### Three-state model

The UI surfaces three distinct flags per add-on, all returned by
`GET /api/addons`:

| Flag             | Source                                | Meaning                                            |
|------------------|---------------------------------------|----------------------------------------------------|
| `enabled`        | `addon.isReady()`                     | Prerequisites installed on disk                    |
| `configEnabled`  | `{configDir}/addons.json`             | User hasn't toggled this add-on off                |
| `loaded`         | `isAddonLoaded(name)`                 | Routes are mounted in the current process          |

The three diverge between install/uninstall/toggle and the next server
restart — `loaded` only updates at boot. `AddonsManager.tsx` shows a
"Restart required to activate/deactivate" pill when
`loaded !== (enabled && configEnabled)`, covering install,
uninstall, and toggle in a single rule.

### Endpoints (`server/api/addons.ts`)

| Method | Path                       | Behaviour |
|--------|----------------------------|-----------|
| GET    | `/api/addons`              | List add-ons with all three flags + `docSlug` |
| POST   | `/api/addons/:name/install`| SSE stream of install logs; final `done` event carries the real `exitCode` |
| PATCH  | `/api/addons/:name`        | `{ configEnabled: boolean }` toggle; persists to `addons.json` |
| DELETE | `/api/addons/:name`        | Calls `addon.uninstall()` |

Install endpoints are POST (not GET) so an `<img src=…>` can't trigger
them. The SSE response shape works fine over POST because the React
side consumes it via `fetch().body.getReader()`, not `EventSource`.

### Currently registered add-ons

- **`audio-addon`** — Whisper sidecar + Upload/Sessions tabs.
  `isReady()` checks for `vendor/python-venv/` via `whisperStatus()`.
  `install()` runs `scripts/whisper/setup.{ps1,sh}` and forwards the
  child process's exit code. Routes: `/api/sessions/*` (transcribe +
  upload extensions), `/api/whisper/*`.
- **`local-llm-addon`** — Ollama / LM Studio / Unsloth routing.
  `isReady()` checks for a `{configDir}/local-llm.enabled` marker
  (the runners themselves are installed by the user separately, so the
  add-on is essentially a feature flag plus its proxy code).
  `install()` writes the marker; `uninstall()` removes it. Routes:
  `/api/local/*` (proxy + launch) and `/api/local-llm/*` (detection +
  capability probes + Unsloth auth config).
- **`personas-addon`** — Chronicle Personas. `isReady()` checks for a
  `{configDir}/personas-addon.enabled` marker. `install()` writes the
  marker + seeds `personas.json` with the six bundled presets;
  `uninstall()` removes both, returning Phase 3 / 5 / 6 to the locked
  bardic default. Routes: `/api/personas/*` (CRUD + draft).

### Future add-ons

The registry is open. The roadmap names three candidates that fit the
current contract cleanly:

- **Whisper diarisation** for single-track audio — adds speaker labels
  to recordings that don't have per-speaker source files (podcast
  VODs, Zoom recordings). Sits alongside the audio-addon's existing
  per-utterance transcription queue.
- **SRT / VTT caption parsers** — sister formats to `.sbv` that share
  Phase 1's grounding pipeline; adds one router and a small parser.
- **In-PDF image OCR** — handles scanned session notes and
  handwritten lore. Sits in the lore pipeline as a pre-extract step
  before `pdf-parse`.

Each would follow the same `AddonDefinition` contract: `isReady()`
probes its prerequisites, `install()` runs an SSE-streamed setup
script, `registerRoutes(app)` mounts its endpoints, the loader
respects the `configEnabled` toggle.

---


</div>
</details>

<details class="docs-section">
<summary><h2>16. Tusks-Lore — shared sibling folder</h2></summary>
<div class="docs-section-body">


Optional sibling folder both Tusk's Tomes and Tusk's Vault read from.
Holds a `.docx` archive of finished chronicles and (in future) a
shared lore corpus. Not an add-on — it's a sibling-detected
filesystem feature analogous to Vault pairing.

### Detection (`server/lore/detection.ts`)

First match wins:

1. `$TUSKS_LORE_DIR` env override (absolute or relative to repo root).
2. Sibling lookup: `<repoRoot>/../{Tusks-Lore, tusks-lore, tusks_lore}`.

A directory counts as a Lore install if it has a `tusks-lore.json`
marker file with a parseable `version` field. The marker prevents
random folders named "Tusks-Lore" from triggering false positives.

`createLoreFolder()` writes the marker + an empty `Sessions/`
subdirectory at the default sibling path. Idempotent: re-running
preserves an existing marker's `createdAt`.

### DOCX rendering (`server/lore/docxRenderer.ts`)

`renderChronicleDocx({ campaign, sessionNumber, chronicle, extras,
condensed, mode })` returns a `Buffer` via the `docx` npm package.
Document structure:

1. Title block — campaign · session # · mode · date.
2. Body — full chronicle prose (`mode='full'`) or condensed
   narrative + bullet recap (`mode='condensed'`). Falls back to full
   when `condensed` is null.
3. Gallery of Jests (bullets).
4. Gallery of Gore (bullets).
5. Memorable Quotes grouped by kind (Funny / Stupid / Dark) with
   speaker bolded + quote italicised.

The extras blocks render in **both** modes — only the chronicle body
differs.

### Endpoints (`server/api/lore.ts`)

| Method | Path                        | Behaviour |
|--------|-----------------------------|-----------|
| GET    | `/api/lore/status`          | Detection result + sessions count + `defaultPath` |
| POST   | `/api/lore/create`          | Scaffold the sibling folder; idempotent |
| POST   | `/api/lore/save-chronicle`  | Render the .docx and write to `<lore>/Sessions/<campaign>/Session-NN-YYYY-MM-DD-<mode>.docx` |

### Client surface

- `src/components/LoreCard.tsx` — Settings card showing detection
  status, sessions count, writability, and the **Create Tusk's Lore**
  button when not detected.
- `src/components/ChronicleView.tsx` — adds **Save full .docx** and
  **Save condensed .docx** buttons (the condensed one only when a
  Phase 6 output exists) when the Lore folder is detected.

---


</div>
</details>

<details class="docs-section">
<summary><h2>17. In-app docs viewer</h2></summary>
<div class="docs-section-body">


The Help tab renders the same `.md` files that live in the GitHub
repo, inside the app. Stays consistent with the GitHub render because
both consume the same files.

### Endpoint (`server/api/docs.ts`)

At startup the docs router walks `docs/**/*.md` + repo-root `README.md`,
`CONTRIBUTING.md`, `ROADMAP.md` (deliberately excludes `CLAUDE.md` —
developer-only) and builds a slug→absPath Map. Slugs derive from the
relative path: `docs/add-ons/audio-transcription.md` →
`add-ons-audio-transcription`. Slugs must match `/^[a-z0-9-]+$/` AND
exist in the precomputed Map — there is no string-concatenation of user
input with disk paths, so path traversal is impossible by construction.

### Client (`src/components/DocsViewer.tsx`)

Uses `react-markdown` + `remark-gfm` (the only new runtime deps).
Sidebar groups docs by their parent folder; defaults to the README on
open. Add-on cards (and `WhisperSettings`) dispatch a
`sbts:open-doc` CustomEvent that flips the active tab to **Help**
and asks the viewer to load a specific slug.

---


</div>
</details>

<details class="docs-section">
<summary><h2>18. Run checkpoints + resume</h2></summary>
<div class="docs-section-body">


Long-running cloud pipelines can hit per-day quotas on free-tier keys
that don't reset until midnight UTC. The pause / resume feature lets a
user save a full snapshot of an in-flight run to disk, close the app,
come back tomorrow when the quota refills, and resume from the exact
chunk they paused on.

### On-disk schema (`src/lib/runCheckpoint.ts`)

```ts
type RunCheckpoint = {
  schemaVersion: 1
  runId: string
  createdAt: string
  pausedAt: string
  pausedReason: 'user' | 'quota' | 'error'
  routing: RoutingDocument      // snapshot, so resume re-uses the same providers
  safetyMultiplier: number      // the slow-down dial state at pause time
  refinementState: RefinementState  // grounded, dmQuestions/Answers, chronicle, extras, condensed
  progress: { phase: 1|2|3|4|6, chunkIndex: number, totalChunks: number }
}
```

`schemaVersion` is bumped when the on-disk shape changes; resume
refuses to load mismatched versions and surfaces an "export the partial
output, then delete this checkpoint" path instead.

### Storage (`server/api/runs.ts`)

| Method | Path | Behaviour |
|--------|------|-----------|
| GET | `/api/runs` | Lists summaries (campaign, session #, paused phase, paused timestamp). Sorted most-recently-paused first. |
| GET | `/api/runs/:id` | Full checkpoint payload |
| PUT | `/api/runs/:id` | Atomic write to `{configDir}/runs/{runId}.json`. 20 MB cap → 413 |
| DELETE | `/api/runs/:id` | Idempotent — already-gone returns 200 |

Path-safety: `:id` is validated against `/^[a-zA-Z0-9_-]{1,64}$/` so
traversal attempts can't reach disk.

### Client surface

- **Pause** option in the rate-limit dialog (§19) writes the checkpoint
  via `saveRun()` then aborts the chunk loop.
- **ResumeRunBanner** (`src/components/ResumeRunBanner.tsx`) renders
  above the Chronicle tab when checkpoints exist. Lists each with
  campaign / paused-phase / chunk-progress; Resume + Delete buttons.
- **Resume click** hydrates `RefinementState` from the checkpoint,
  restores the safetyMultiplier, and (per the planner in
  `src/lib/resumeFlow.ts`) decides whether to continue at
  `startChunkIndex` or restart the paused phase from chunk 0. Mid-chunk
  auto-continuation for Phase 3+ is wired for the next release; for now
  the user re-triggers the remaining phases from the restored state.
- **Clean finish** (after Phase 4 success) automatically calls
  `deleteRun(id)` so the banner stops nagging once a run completes.

---


</div>
</details>

<details class="docs-section">
<summary><h2>19. Rate-limit dialog</h2></summary>
<div class="docs-section-body">


When Gemini emits a 429 mid-pipeline, the provider classifies it
(`classifyExhaustion` in `src/lib/providers/gemini.ts`) as one of
`rate_limit` / `daily_quota` / `transient`. The classification looks
at quotaId/quotaMetric shape (`PerDay` vs `PerMinute`) and falls back
to a heuristic — three exhaustions within five minutes on the same key
upgrades a generic `rate_limit` to `daily_quota`, on the assumption
that sustained 429s without a per-minute qualifier mean the daily
bucket is empty.

The provider emits a `quota_exhausted` `ProviderEvent`; the pipeline's
`providerEventForwarder` translates it into a `quota_exhausted`
`PipelineEvent` tagged with the active phase; the React subscriber in
`RefinementTool` opens `RateLimitDialog`. Four choices:

| Choice | Action |
|---|---|
| **Stop and export** | Aborts the run + downloads the partial chronicle as Markdown (via `buildPartialMarkdown` in `src/lib/exportMarkdown.ts`) |
| **Slow down (3×)** | Sets `safetyMultiplierRef.current = 3`; the next chunk's pacing call reads this. Disabled when `quotaKind === 'daily_quota'` |
| **Pause and save for later** | Writes a checkpoint (§18) then aborts |
| **Switch to paid key for the rest** | Aborts + advisory toast pointing the user at Settings → Hybrid Routing. Disabled when no paid Gemini key is configured. Live mid-run flip is a follow-up. |

The same `ProviderEvent` channel also surfaces `auto_fallback` events
when Gemini's existing free→paid soft-swap fires — those land as
toasts so the previously-silent swap is now visible.

---


</div>
</details>

<details class="docs-section">
<summary><h2>20. Operational notes</h2></summary>
<div class="docs-section-body">


- A 4-hour D&D session with 6 active speakers recorded by Craig Bot
  ships as roughly **0.5–1.5 GB** of FLAC across one or more zips.
  Tusk's Tomes preserves the original codec — the upload extractor
  does not re-encode — so on-disk size mirrors what came out of Craig.
  The Sessions tab shows running disk usage and offers an *audio-only*
  delete once the transcript looks good.
- Whisper large-v3 on an RTX 3070 Ti at `int8_float16` runs 5–10×
  realtime per utterance; total transcription on a 4-hour session
  typically finishes in well under an hour.
- The cloud refinement on a typical session (~30k words grounded)
  takes 10–20 minutes wall-clock with Tier-1 pacing on Gemini, faster
  on pay-as-you-go Claude / OpenAI tiers.
- Logs: server `console.*` to the terminal running `npm run dev`;
  browser `console.*` to devtools (F12).
- Finished chronicles land at
  `<repo>/Sessions/<campaign>/Silence Beyond the Sea - <campaign> - Session <n>.md`.
  The folder is gitignored — commit a specific session by adding it
  explicitly if you want it tracked.
- The legacy `localStorage` schema keys (`kb_documents`,
  `refinement_state`, `provider_settings`, `campaign`,
  `sessionNumber`, etc.) are still in use for items classified as
  ephemeral. Any new persistent state goes to disk via the Express
  APIs.


</div>
</details>
