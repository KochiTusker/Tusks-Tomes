# How it's built

A local-first D&D session chronicler. The core install handles paste-a-transcript
chronicling through a cloud LLM — Gemini directly, or around 400 models through a
single OpenRouter key — a Claude Code or Codex subscription you already pay for,
or a local runner.

Seven optional modules extend it, and exactly one installs anything:
**Audio Transcription** downloads a Python environment for Whisper and Craig
multitrack upload. The other six (whisper.cpp bridge, Local LLMs, Chronicle
Personas, Claude Code, Codex, Obsidian Vault lore) ship in the bundle and mount
unconditionally — see §15 for why that distinction is a type, not a
convention.

A five-phase pipeline produces a clean grounded transcript, a narrative chronicle,
a condensed retelling with catch-up bullets, and a curated extras list (jests,
gore, quotes). Pacing between cloud calls is set per provider — Gemini uses
static limits for its key tier and model, OpenRouter a requests-per-minute
figure, and the subscription CLIs and local runners are not paced.

Everything except the chosen cloud LLM API runs on the user's machine. API keys
are encrypted at rest and are sent only to the provider they belong to, and no
other device on the network can fetch them. The server binds to `127.0.0.1` by default and a same-origin middleware
on `/api/*` rejects cross-origin POSTs so a malicious page can't drive-by-trigger
an add-on install. Finished chronicles are saved back into the repo tree as
portable Markdown, and (when the optional sibling `Tusks-Lore/` folder is set
up) also as structured `.docx` files inside a shared archive both Tomes and
Tusk's Vault read from.

---

<details class="docs-section">
<summary><h2>1. System overview</h2></summary>
<div class="docs-section-body">


![A drawing of how the pieces fit. A dashed box for your machine holds the browser app, which runs the pipeline and calls Gemini and OpenRouter itself. It talks to the local server on 127.0.0.1 through the /api routes. The server holds the keystore, which keeps your API keys encrypted on this machine, the Audio Transcription module for uploads and Whisper, and your sessions and saved chronicles. Below the server sit the local runners Ollama, LM Studio and Unsloth, and the claude or codex CLI, which uses your subscription. Beside the machine, a separate dashed box holds the cloud models: Gemini and OpenRouter, reached by the app directly, and Claude and OpenAI, reached through your own CLI.](../assets/diagrams/how-the-pieces-fit.svg)

The server mounts JSON routes for the glossary, speakers, provider keys, routing, runs, sessions, chronicle, chronicle-library, lore and vault, behind three gates on `/api`: a host allowlist, a same-origin check and a LAN-write gate. The built-in modules (local runners, the Claude Code and Codex bridges, whisper.cpp, Personas, Obsidian) mount at start; Audio Transcription is the one module that installs. `RateLimitState` paces each provider. A finished chronicle is saved as Markdown under `Sessions/<campaign>/` and in `chronicle-library/`; **Save full .docx** writes into `../Tusks-Lore/Sessions/<campaign>/`. The Help tab renders these docs from `/api/docs`.

The server is launched as `npm run dev` (Vite middleware in dev) or
`npm start` (static `dist/` in prod). Both modes serve a single bundle to
`http://localhost:5173` — there is no remote tier and the server binds to
`127.0.0.1` by default. Override the interface via the `TUSKS_HOST` env var
(e.g. `TUSKS_HOST=0.0.0.0` for LAN exposure).

There are three entry points to the refinement pipeline:

1. **Multi-track upload → Whisper → SBV → refinement.** The user records
   their D&D session in Discord with Craig Bot (or any other multi-track
   recorder), downloads the resulting zip of per-speaker FLAC / WAV
   tracks, and drops the file(s) onto the **Sessions** tab, where the
   upload panel is the list's primary action.
   The server extracts the archive, lays out the audio per speaker,
   builds a manifest, and runs Whisper one utterance at a time. The
   result is a speaker-tagged `.sbv` that's one click away from the
   refinement pipeline.
2. **`.sbv` upload from YouTube auto-captions.** Caption repair — which
   lives inside the **Chronicle** tab, next to the transcript input it
   feeds — accepts an SBV directly and runs the SBV-aware variant of Phase 1
   grounding before handing off to the refinement pipeline.
3. **Raw transcript paste.** The Chronicle tab accepts free-form text.

All three converge on the same chunked, multi-phase generation in
`src/features/pipeline/lib/pipeline.ts`.

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
- **Node 22+** via **`tsx`** for native TypeScript execution.
- **Express 4** with Vite middleware in dev; serves `dist/` static in prod.
- **`multer`** with disk storage for large multi-track uploads (per-file
  cap 4 GB, up to 32 files per request).
- **`adm-zip`** for in-process Craig-zip extraction.
- **`ffmpeg-static`** + the user's FFmpeg, used to probe per-track
  durations during upload extraction.
- **`env-paths`** for cross-platform app-data resolution.
- **`crypto`** (Node built-in) for AES-256-GCM + scrypt key derivation.
- **`mammoth`** + **`pdfjs-dist`** for KB document text extraction. `pdfjs-dist` is pure JavaScript, which is why a Windows `npm install` needs no C++ build toolchain.

### LLM providers
- **`@google/genai`** (Gemini 2.5+ / 3.x) with Paid / Free tier handling.
- **OpenRouter** over its OpenAI-compatible HTTP API — one key, around 400
  models. This is how Anthropic and OpenAI models are reached; the `openai`
  SDK is the client for it.
- **Subscription CLIs** — the signed-in `claude` and `codex` binaries, invoked
  headlessly. No API key is involved and the app never handles the login.
- **OpenAI-compatible HTTP** for Ollama / LM Studio / llama.cpp /
  Unsloth Studio.

### Whisper sidecar
- **Python 3.10–3.12** in `vendor/python-venv/`.
- **`faster-whisper` `~=1.2.1`** (with `ctranslate2` `~=4.7.1`) and the **large-v3** model at
  `int8_float16` (CUDA) or `int8` (CPU).
- **`torch` ≥ 2.2 < 3**: the CUDA 12.4 build on Windows when `nvidia-smi`
  answers, the CPU build otherwise. macOS and Linux install the CPU build
  unless `--cuda` is passed. The upper bound stays at 3 because 2.6 is the
  first release with cp313 wheels. See `scripts/whisper/requirements.txt`.

---


</div>
</details>

<details class="docs-section">
<summary><h2>3. File layout</h2></summary>
<div class="docs-section-body">


```
server/
  index.ts                # Express boot, Vite middleware, same-origin /api/* gate
  addons/
    registry.ts           # ADDON_REGISTRY: the one installable module (audio-addon)
    featureRoutes.ts      # FEATURE_ROUTES: the built-in modules, mounted in order
    loader.ts             # loadAddons(): modules mount when isReady() && configEnabled; features always mount
  platform/               # Shared server foundations used by every feature
    appData.ts            # env-paths + atomic JSON IO
    documentStore.ts      # One reader/writer for each {configDir} document
    asyncRoute.ts         # Route wrapper that turns a throw into a clean error
    cliSubscription.ts    # Shared spawn/probe logic for the Claude Code + Codex CLIs
    repoRoot.ts           # The repo root, resolved once
    validators.ts         # ID / path / URL validation
    loopbackGate.ts       # loopbackOnly()
    lanWriteGate.ts       # LAN write gate
    hostAllowlist.ts      # DNS-rebinding defence
    readiness.ts          # Bind-first start-up and the readiness gate
    routes/addons.ts      # GET /api/addons, POST /:name/install (SSE),
                          #   PATCH /:name (toggle), DELETE /:name
  features/<id>/
    routes/               # The feature's Express routers (<resource>.ts)
    services/             # Server logic the routers call
  testing/                # HTTP and spawn fixtures, golden harness

  Server features: corrections (glossary, speakers), help (docs), library
  (chronicle save, saved chronicles, .docx rendering), lore (Tusks-Lore, vault),
  maintenance (updater, diagnostics), personas, pipeline (run checkpoints),
  providers (keys, profiles, local runners, Claude Code, Codex, OpenRouter),
  routing, transcription (sessions, upload, Whisper sidecar), and
  retired-direct-api-providers (the old-key migration).

shared/                   # Types and pure helpers both sides import
  contracts/              # Request/response shapes for each document and route
  models/  personas/  speakers/  lib/

scripts/
  smoke-test.mjs          # end-to-end provider + whisper + local-LLM ping
  whisper/
    transcribe.py         # faster-whisper sidecar
    requirements.txt
    setup.ps1             # Windows venv bootstrap (CUDA-aware)
    setup.sh              # POSIX venv bootstrap

src/
  main.tsx                # Entry point
  App.tsx                 # Tabs: Sessions (audio module only), Chronicle,
                          #       Tome of Lore, Settings, Help. Caption
                          #       repair sits inside Chronicle; uploading
                          #       sits inside Sessions.
  platform/               # The App shell and what every feature shares
    apiClient.ts          # fetch wrapper for /api/*
    docClient.ts          # Client for a {configDir} document
    contexts/AddonContext.tsx  # addon list + isLoaded() / isEnabled()
    components/  hooks/  lib/  ui/   # Header, storage helpers, shadcn-style primitives
  features/<id>/
    components/           # The feature's React components
    hooks/                # Hooks owned by the feature (where it has any)
    lib/                  # Client logic and tests

  Client features: caption-repair, corrections, guardrails, help, library, lore,
  maintenance, personas, pipeline, providers, reforge, routing, transcription.

  The Chronicle pipeline lives in features/pipeline/lib:
    pipeline.ts           # Entry point for the five phases
    phases/               # One file per phase (phase1Ground.ts … phase6Condense.ts)
    chunkedGenerate.ts    # The per-chunk driver every phase runs through
    prompts.ts            # All prompt builders (cloud + local + split forms)
    chunker.ts            # \n\n-aware splitter with hard-cut fallback
    chunking.ts           # Per-provider/per-phase chunk size table
    runCheckpoint.ts      # Run checkpoint schema
  Providers live in features/providers/lib:
    rateLimit.ts          # RateLimitState: header parsing + delay math
    providers/
      llm.ts              # LLMProvider interface (incl. getNextDelayMs)
      gemini.ts           # GeminiProvider (paid/free + static tier RateLimitState)
      openrouter.ts       # OpenRouterProvider: one key, ~400 models
      claudeCode.ts       # Claude Code subscription CLI
      codex.ts            # Codex subscription CLI
      localAdapter.ts     # LLMProvider wrapper for the user-selected local provider
      localInstance.ts    # Per-instance LocalInstanceProvider (hybrid routing)
      settings.ts         # localStorage-backed provider/tier selection
      index.ts            # Registry: ensureProvidersInitialized, getActiveProvider
```

---


</div>
</details>

<details class="docs-section">
<summary><h2>4. Persistence model</h2></summary>
<div class="docs-section-body">


Durable state lives at the platform app-data roots via `env-paths`, apart from the repo's `Sessions/` folder and the sibling `Tusks-Lore/` folder. The
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
| `{configDir}/profiles.json`                                | Per-provider phase models      | JSON         |
| `{configDir}/routing.json`                                 | Routing rows + guided presets  | JSON         |
| `{configDir}/settings.json`                                | App settings                   | JSON         |
| `{configDir}/personas.json`                                | Personas (seeded on first read, never deleted by the app) | JSON |
| `{configDir}/model-availability.json`                      | Per-key probe results          | JSON         |
| `{configDir}/openrouter-models.json`                       | Cached OpenRouter catalogue    | JSON         |
| `{configDir}/openrouter-providers.json`                    | Cached provider data policies  | JSON         |
| `{configDir}/addons.json`                                  | Module toggle (installable modules only) | JSON `{ [name]: { configEnabled } }` |
| `{configDir}/runs/{runId}.json`                            | Pause/resume checkpoints       | JSON (20 MB cap) |
| `{dataDir}/chronicle-library/{id}.json`                    | Saved Chronicles library       | JSON         |
| `{cacheDir}/capability.json`                               | Local-model probe runner       | JSON         |
| `{dataDir}/sessions/{id}/manifest.json`                    | Upload extractor + live queue (audio-addon) | JSON |
| `{dataDir}/sessions/{id}/audio/{speakerId}/*.{wav,flac,…}` | Upload extractor (audio-addon) | per-speaker audio |
| `{dataDir}/sessions/{id}/transcripts/{speakerId}/*.json`   | Whisper sidecar (audio-addon)  | JSON         |
| `{dataDir}/sessions/{id}/session.sbv`                      | Live queue (audio-addon)       | SBV plaintext|
| `<repo>/vendor/python-venv/`                               | audio-addon install            | Python venv (1.5–2.5 GB download) |
| `<repo>/Sessions/<campaign>/<campaign> - Session <n>.md` | Chronicle auto-save | Markdown |
| `~/.cache/huggingface/hub` (`HF_HOME` moves it)            | Whisper model weights, first transcription (Audio Transcription module) | Hugging Face cache |
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

`server/platform/appData.ts → writeJson` always writes to a randomly-named temp
file in the same directory, then renames over the target. A crash
mid-write either leaves the previous file intact or the new file fully
present — never a truncated half-write. The chronicle save endpoint
follows the same pattern for its `.md` output.

On Windows, a rename can be refused for a moment while another save of
the same file, an antivirus scan or the search indexer has it open.
`writeJson` retries that rename a few times over about 150 ms, so two
tabs saving the same chronicle at once both succeed.

### Seed migration

Files seed themselves on first read after upgrade. The glossary seeds
from `shared/contracts/glossary.ts` if the on-disk doc is absent; the
encrypted keystore seeds from `process.env.PAID_GEMINI_API_KEY` /
`VITE_GEMINI_API_KEY` / `OPENROUTER_API_KEY` if any are present, then logs a
notice that the GUI is the recommended path.
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
`src/features/providers/lib/providers/llm.ts`).

```ts
interface LLMProvider {
  readonly name: 'gemini' | 'openrouter' | 'claudeCode' | 'codex' | 'local'
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
Phases 1, 3, and 5 all emit a split `{ cacheablePrefix, userPrompt }` —
Phase 1's prefix carries the system prompt, the KB and the rules;
Phase 5's carries the KB, the DM Q&A and the JSON format spec. Phase 3's
is drawn below: what is the same for every chunk goes in the prefix, and
the per-chunk `userPrompt` holds only the variable parts.

![One request to write the chronicle, in two parts. The top part is the same for every chunk: the rules and speech policy, your answers to the questions, and your lore. Under it sit three chunks of the transcript, each carrying the end of the prose written so far; a bracket under them marks that part as different every chunk. Both parts go down into one box, the model, and are sent as one prompt.](../assets/diagrams/what-a-prompt-is-made-of.svg)

- **OpenRouter** — framing, system prompt and cacheable prefix go into one
  system message as a single block carrying
  `cache_control: { type: 'ephemeral' }`; OpenRouter translates the
  breakpoint for the upstream model. The per-chunk `userPrompt` is a
  separate user message.
- **Gemini** — at the start of a phase with more than one chunk left,
  `createPrefixCache()` registers the system prompt + cacheable prefix as a
  `cachedContent` (60-minute TTL); later chunks send only the
  `userPrompt` and the handle. It is skipped for a prefix under about 4,000
  characters (roughly 1,000 tokens), and if creation fails the prefix goes
  inline. Cached input tokens are priced at about a quarter of normal input
  (a ~75% discount) in `pricing.ts`.
- **Claude Code, Codex and the local runners** — no cache primitive: the
  framing, system prompt, prefix and user prompt are joined into one
  prompt.

Each implementation owns its own retry/backoff and surfaces token usage
in a unified `Usage { inputTokens, cachedInputTokens?, outputTokens }`
shape.

### Registry + initialization

`src/features/providers/lib/providers/index.ts` exports `ensureProvidersInitialized()`,
which fetches the decrypted bundle from `/api/provider-keys` and
constructs all four singletons (Gemini × 3 tiers — `auto` / `paid` /
`free` — plus OpenRouter, the subscription CLIs, and Local). The pipeline awaits this at the
start of every run.

`getActiveProvider()` returns the singleton matching the user's selected
provider (legacy single-provider mode), while `getCloudProvider(name,
{ geminiTier })` resolves a specific cloud provider for the per-phase
dispatcher.

### Gemini Paid / Free tiers

Gemini exposes two key slots in the keystore (`gemini` for Paid /
billing-enabled, `geminiFallback` for the Free tier). The pipeline runs in one
of three modes, `auto`, `paid` or `free`:

| Mode | Tries first | Falls back to |
|---|---|---|
| `auto` (the default) | The paid key | The free key for the rest of the run, when the paid key reports a quota of zero or two quota errors in a row |
| `paid` | The paid key only | Nothing: the free key is never used |
| `free` | The free key only | Nothing, except that a phase whose model is on the paid-only list uses the paid key |

The *paid-only* list is the set of models the Free key's probe marks as
needing billing; a phase escalated to Paid because of it gets a toast naming
the phase and model when the phase starts.

---


</div>
</details>

<details class="docs-section">
<summary><h2>6. Encrypted key storage</h2></summary>
<div class="docs-section-body">


Keys live in `{configDir}/providers.enc` under AES-256-GCM. The cipher is standard AES, but the key is built from values the machine already knows and there is no passphrase: `hostname + username + platform` and a random 16-byte salt at `{configDir}/.salt`, run through `scryptSync`.

![A drawing of how the key to your stored API keys is made, and who can open the file. At the top, four boxes (host name, user name, platform and a random salt) feed one box, locked to this computer and this user. That produces providers.enc in your config folder. Below, under the question who can open that file, a purple padlock box labelled stays shut covers a providers.enc copied to another computer or account, such as a backup, cloud sync or a stray copy. An orange terminal box labelled opens covers a program running as you on this computer, because the app decrypts the keys for itself.](../assets/diagrams/what-the-keystore-protects.svg)

```
File format (after decryption):
{
  "gemini":         "AIza…",     // Paid / billing-enabled
  "geminiFallback": "AIza…",     // Free tier
  "openrouter":     "sk-or-…",
  "unsloth":        "{ baseUrl, … }"   // local-runner credentials, JSON-encoded
}
```

The decrypted bundle is fetched at React app boot via
`/api/provider-keys`, which answers loopback callers only. Cloud SDKs run
in-browser, so the browser sends each key straight to its own provider. No
other route returns a key: `/api/providers` (also loopback-only) returns a
summary of which slots are set.

A built-in **Test** action asks Gemini for a one-model listing, or
OpenRouter for the key's status, to verify the key works without
persisting anything or generating any text.

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
  "gemini":     { "phase1Model": "gemini-2.5-pro",
                  "phase2Model": "gemini-2.5-flash",
                  "phase3Model": "gemini-2.5-pro",
                  "phase4Model": "gemini-2.5-flash",
                  "phase6Model": "gemini-2.5-pro" },
  "openrouter": { "phase1Model": "google/gemini-2.5-flash",
                  "phase3Model": "google/gemini-2.5-pro" },
  "claudeCode": { "phase1Model": "sonnet",
                  "phase3Model": "sonnet",
                  "phase4Model": "haiku" }
}
```

Keys are the four `CloudProvider` values — `gemini`, `openrouter`,
`claudeCode`, `codex`. Direct `claude` and `openai` keys were retired along
with the direct-API integrations; those models are reached through OpenRouter
now.

Defaults: prose-heavy phases (1, 3, 3.5, 5) go to the mid-tier model;
JSON-shaped phases (2, 4) go to the cheapest model that holds the
schema. For the subscription CLIs the defaults are bare aliases
(`sonnet`, `haiku`, `default`) rather than pinned IDs, so a CLI upgrade
moves them forward on its own — a pinned ID does not, which is how a
profile ends up still naming a superseded model months later.

There is no Model Profiles editor in the UI any more; the routing rows are
the single surface for choosing a model per phase.

### Routing

`{configDir}/routing.json` tracks both the last cloud provider used and
optional per-phase hybrid overrides. Each of the five model phases
(1–5) can independently route to a specific local model:

```json
{
  "version": 3,
  "lastSelectedProvider": "openrouter",
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

- If no cloud keys are configured (and the active provider is not local): error,
  with a pointer to Settings.
- Otherwise the session is built directly from the persisted routing —
  `lastSelectedProvider` plus any per-phase overrides.

There is no run-start provider modal. Choosing a provider at the moment you
press Run was asking the question at the point of least context; an
`ActiveProviderBanner` above the Chronicle controls now states which
connection the next run will use, with a "change" link that lands you on the
right Settings card. The phase rail below it names the model that will run
each phase, and lights up as the run progresses, so the routing is legible
before you commit rather than only afterwards.

The resolved session carries
`{ provider, profile, models, routing, geminiTier?, geminiPaidOnlyModels? }`,
and each `runPhase*` accepts both `model` (string) and `phaseTarget`
(cloud or local) so a single phase can route to a local model
independently of the rest of the run.

### Guided routing presets

Above the per-phase rows sits a ladder of complete recipes, from maximum
quality down to free. Each rung is a one-click apply of a full per-phase
recipe built by a pure helper in `src/features/routing/lib/budgetMode.ts`, unit-tested
independently of React.

Presentation rules, learned from looking at the previous version rendered
rather than in source — it was five stacked walls of prose:

- Each rung shows **one line**. Rationale, measurements and caveats live
  behind an information control.
- The saving chip states whether its number is **measured or estimated**.
  An extrapolation must never look like a measurement.
- The rung matching current routing is badged **Current**, so the user can
  see where they stand, not only where they could go.
- The recommended rung is visually distinct. Equal-weight cards are not a
  recommendation.
- The plan/usage hint is stated once in the plan bar, not repeated per rung.

Availability resolves live: API-key rungs need the key, subscription rungs
need a signed-in CLI. Applying a rung only **stages** the recipe — the
parent's Save button commits it.

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

The **Sessions** tab's upload panel accepts any combination of:

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

`server/features/transcription/services/upload/extractMultitrack.ts` streams the upload to disk via
multer disk storage, then:

1. Partitions inputs into ordered chunks (one zip = one chunk; loose
   files cluster into one chunk at their first appearance).
2. Creates a fresh `{dataDir}/sessions/{sessionId}/` and writes a stub
   `manifest.json` (atomic).
3. For each chunk:
   - Extracts the zip (`adm-zip`) into a temp workdir, or accepts the
     loose audio files in place.
   - Parses speaker identity from each filename (a `{discordUserId}-{name}`
     prefix keeps the Discord ID; a short Craig track index is used only
     for ordering and the ID becomes a stable hash of the name; with no
     numeric prefix the ID is a stable hash of the stem).
   - Moves the audio file into
     `audio/{speakerId}/{utteranceId}.{ext}` (preserving the original
     codec — no FFmpeg re-encode at this stage).
   - Measures the duration with FFmpeg (a stream-copy pass to `-f null`
     that reads the last `time=` it reaches, falling back to the
     `Duration:` header) and records a `UtteranceEntry` that starts at the
     running `cumulativeMs` offset.
   - Appends the participant + utterance to the manifest.
4. Maintains a running `cumulativeMs`, advanced by the longest track in
   each chunk, so utterances in chunk N+1 start where chunk N ended.

![Zips are dropped on the Sessions tab. Each zip holds one track per player, here PC-Alpha, PC-Beta and the DM, and the zips are laid end to end: each zip starts where the last one ends. Whisper transcribes one track at a time, on your GPU or the CPU, and the result is one transcript in time order, each line tagged with who said it.](../assets/diagrams/craig-to-transcript.svg)

The response shape is `{ sessionId, chunks: [...], tracks: [...], totalDurationMs }`.
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

`server/features/transcription/services/sessions/sessionManifest.ts` owns
the on-disk shape:

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

`scripts/whisper/transcribe.py` runs as a persistent worker, one per device. The server starts it the first time a transcription needs it and keeps it for as long as the server runs:

```
python transcribe.py --serve
  --model large-v3
  --device cuda          # or cpu
  --compute-type int8_float16
```

The model loads once, at start-up. Each utterance then arrives as one JSON line on stdin (`id`, `audio`, `speakerId`, `speakerDisplay`, `initialPrompt`, `language`), and the worker answers with line-delimited JSON on stdout: `loading` and `ready` while it starts, `progress` during a request, and one `response` per request. Without `--serve` the script transcribes a single `--audio` file and exits.

It runs `faster-whisper.transcribe(...)` with:

- `vad_filter=True` (Silero VAD)
- `word_timestamps=True`
- `condition_on_previous_text=False` (avoid hallucination cascades)
- `beam_size=5`
- `temperature=[0.0, 0.2, 0.4]` (graceful fallback ladder)
- `no_speech_threshold=0.6`

Each successful response carries
`{speakerId, speakerDisplay, durationMs, elapsedMs, model, device, language, segments[{startMs, endMs, text, words, confidence}]}`.
A failed request comes back as `ok: false` with an error message and leaves the worker running.

### Initial prompt (~200-token glossary bias)

`server/features/transcription/services/whisper/invoke.ts → buildInitialPrompt(canonicalNames)` builds
the biasing string from the glossary's `contextualHints[].canonical`
and capitalised `safeReplacements[].to` entries. The string is capped
at ~800 chars, an approximation of the ~200-token budget. Distinct names come first,
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

`server/features/transcription/services/whisper/liveQueue.ts` is a single in-process worker that drains
a serial queue of utterances against the sidecar. Both the upload path
and the legacy "process session" endpoint enqueue into the same queue,
so there is only one downstream code path. On a single-GPU machine the
serial drain is correct; on a multi-GPU machine it leaves the other cards
idle, because there is one queue and one GPU worker.

Per utterance:

1. Resolve `speakerDisplay` via the speakers map
   (`Character (Player)` / `Character` / `Player` / filename fallback).
2. Invoke the sidecar on CUDA through a worker process that stays up for
   as long as the server runs, so the model loads once. If a request fails,
   the utterance is retried on the GPU once (after a CUDA-class error the
   worker is restarted first); if that fails too, the utterance runs on a
   CPU worker at `int8`, and every later utterance, in this session or any
   other, goes straight to CPU until the server restarts, rather than
   paying for the same discovery again. When the whisper.cpp bridge is
   configured and its binary and model check out, every request goes to
   that build instead of the sidecar. The engine and device in use are
   reported to the transcription view. CPU is several times slower but
   reliable.
3. Persist the sidecar JSON to
   `transcripts/{speakerId}/{utteranceId}.json`.
4. Split each Whisper segment at any internal word-gap longer than
   2 seconds. Without this, faster-whisper occasionally returns a
   single segment covering a multi-minute stretch with several minutes
   of silence inside, which then sorts to the head of the SBV and
   confuses Phase 3 into reading it as the opening monologue.
5. Append the resulting sub-segments to an in-memory timeline with
   `absStartMs = utterance.startedAtMs + segment.startMs` (the
   utterance's offset within the session was set during extraction).
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


Lives in `src/features/pipeline/lib/phases/`, one file per phase, all exported
through `pipeline.ts`. Four model-driven phases, a half-step
Polish pass (Phase 3.5, local only), deterministic pre-processing in Phase 1
and an optional fifth phase (Condense) that the user triggers from the
finished chronicle view.

Display order:
**Phase 1 → Phase 2 → DM clarifications → Phase 3 → Phase 3.5 (polish, local only) → Phase 4 → Phase 5 (condense, optional)**

### Phase 1 — Grounding

- **Input:** raw transcript (or uploaded multi-track SBV cue text).
- **Chunk size:** set per provider and model tier (table under Chunking +
  pacing); 5,000 chars local., before any LLM call):**
  - `transcriptCleanup` strips `[Music]` / `[Laughter]` markers,
    collapses runaway fillers, normalises whitespace, quotes, and
    dashes.
  - `preGround` applies whole-word `safeReplacements` (the built-in
    `dndDictionary` first, then the user glossary).
- **LLM step:** correct lore spellings against the KB, restore
  censored expletives, preserve speaker tags exactly. The system
  prompt + KB + contextual hints are emitted as the
  **`cacheablePrefix`**; the per-chunk text is the **`userPrompt`**
  — Gemini's explicit prefix cache and OpenRouter's `cache_control`
  breakpoint hit from chunk 2 onwards.
- **Output:** grounded transcript.

### Phase 2 — Audit

- **Input:** raw + grounded transcripts (paired by chunk index). A chunk
  whose raw and grounded text match (ignoring whitespace) is skipped.
- **Chunk size:** set per provider and model tier (table under Chunking +
  pacing); 5,000 chars local. clarification questions when phonetic
  ambiguity, unresolvable attribution, consequential unclear plot
  beats, or canon contradictions remain. The cloud prompt is
  conservative ("only ask when necessary"); the local prompt is
  aggressive ("better to over-ask than ship wrong").
- **Output:** `DMQuestion[]` (JSON) shown in the DMQuestionsModal.

After Phase 2 the user reviews the questions, optionally answers
them, and triggers Phase 3.

### Phase 3 — Chronicle

- **Input:** grounded transcript + DM answers.
- **Chunk size:** set per provider and model tier (table under Chunking +
  pacing); 8,000 chars local.
- **LLM step:** novel-style narrative prose, ruthlessly filtering OOC
  chatter. Each chunk receives the last 2,000 chars of the previously
  emitted prose as a **`priorTail`** so continuity holds across
  seams. The prompt enforces character attribution: lines prefixed
  `[CharacterName (PlayerName)]` get incorporated into the prose,
  never printed verbatim.
- **Output:** continuous chronicle text.

### Phase 3.5 — Polish (local only)

- **Pass-through unless the whole run is local.** Runs only when the whole run uses a local provider. The app offers no such setting, so it does not run today.
- **Input:** the rough chronicle from Phase 3.
- **Chunk size:** 6,000 chars.
- **LLM step:** spell-correct names against the (compact) KB, smooth
  chunk-boundary seams, cut residual OOC chatter that slipped past
  Phase 3. Same bardic voice, same length or shorter.
- **Output:** polished chronicle.

### Phase 4 — Extras

- **Input:** grounded transcript + DM answers.
- **Chunk size:** set per provider and model tier (table under Chunking +
  pacing); 8,000 chars local.
- **LLM step:** extract `{ jests, gore, quotes }` per chunk. Quotes
  are classified by `kind` (`funny` / `stupid` / `dark`). Hard skips
  on dice rolls, real-world refs, table chatter.
- **Output:** merged `ExtrasOutput`.

### Phase 5 — Condense (optional, user-triggered)

- **Input:** the finished chronicle + DM answers + campaign/session
  context.
- **Chunk size:** set per provider and model tier (table under Chunking +
  pacing); 10,000 chars local.
- **LLM step:** produce
  `{ narrative, bulletPoints }` — a tightened retelling sized by the
  Condense Slider (default 20% of the chronicle's word count) plus 10–15
  catch-up bullets covering events, NPC
  interactions, and party state.
- **Output:** `CondenseOutput`. The Chronicle view exposes new
  **Condensed** and **Recap** tabs once present, and the auto-save
  re-runs to fold the new sections into the on-disk Markdown.

### Chunking + pacing

- Chunks split on `\n\n` when possible, falling back to a hard
  substring cut. See `src/features/pipeline/lib/chunker.ts`.
- Chunk **sizes** are per-(provider, model-tier)-per-phase, owned by
  `src/features/pipeline/lib/chunking.ts`. The model tier is resolved by
  `classifyModelTier(model, provider)` in `src/features/providers/lib/modelTier.ts` —
  Pro / Sonnet / GPT-5 land on `flagship`; Flash / Haiku / GPT-5-mini
  / GPT-5-nano land on `fast`; Opus lands on `frontier`. Numbers
  (chars per chunk, Phase 1 / 2 / 3 / 4 / 5):

  | Profile | flagship | fast |
  |---|---|---|
  | geminiPaid | 30k / 30k / 60k / 60k / 100k | 15k / 15k / 30k / 30k / 50k |
  | geminiFree | 15k / 15k / 35k / 35k / 60k | 8k / 8k / 18k / 18k / 30k |
  | claude | 20k / 20k / 40k / 40k / 60k | 10k / 10k / 20k / 20k / 30k |
  | openai | 15k / 15k / 30k / 30k / 50k | 8k / 8k / 15k / 15k / 25k |

  `frontier` mirrors flagship — Opus has comparable context but we
  don't push it past flagship sizes without data to justify it. Local
  LLMs share a single conservative table regardless of runner. The
  default tier is `flagship`, which applies when the model is not named.
  Claude Code uses the `claude` row, Codex and OpenRouter the `openai`
  row, and a Gemini key set to `auto` counts as `geminiPaid`. When every
  phase of a run is on a fast-tier model the sizes shrink by a further 0.7.
- Chunk **pacing** is per-provider (see
  `src/features/providers/lib/rateLimit.ts`). Gemini seeds static `RPM` /
  `TPM` values from `GEMINI_STATIC_LIMITS`, picked by the active key tier
  (paid or free) and by model (Pro or Flash). OpenRouter paces on requests
  per minute only: 20 for `:free` models, and for the rest a nominal 60
  unless an `x-ratelimit-limit` header has set a figure. Claude Code, Codex
  and local runners have no `getNextDelayMs` and are not paced. The pipeline
  calls `provider.getNextDelayMs(estimatedInputTokens, multiplier, model)`
  between chunks; the delay is
  `max(60_000 / RPM, tokens / TPM × 60_000) × 1.1 × multiplier`, less the
  time since the last call. The multiplier is 1 unless the rate-limit dialog's
  **Slow down** sets it to 3. A `Retry-After` on an OpenRouter 429 holds every
  OpenRouter model until it expires. A provider with no limit figures waits
  `CONSERVATIVE_FLOOR_MS` (65 s × multiplier) between calls after the first.
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
| 1     | OpenRouter | `cache_control: ephemeral` on the system block |
| 1     | Gemini   | Explicit `cachedContent` per phase (60-minute TTL, ~75% off cached input) |
| 1     | Claude Code, Codex | None (no provider primitive) |
| 3     | All cloud providers | Same split as Phase 1 — KB, DM Q&A and speaker/speech rules live in `cacheablePrefix`, transcript + prior tail in `userPrompt` |
| 6     | All cloud providers | Same split as Phase 1 — KB + DM Q&A + JSON format spec live in `cacheablePrefix`, campaign + chronicle chunk in `userPrompt` |
| 2, 4  | All      | No caching today; the audit and extras prompts pair raw + grounded inputs that can't share a stable prefix |
| 1–6   | Local    | None (no provider primitive)                  |
| SBV   | Cloud    | Same split as Phase 1                         |

Persona templates opt out of the cacheable split — their user-authored
text interleaves variables in ways we can't safely partition. Persona
users get the legacy uncached path; the default bardic voice gets the
cache rebate.

### Chronicle persistence

Whenever a chronicle with a campaign name is on screen and its composed
Markdown changes (the run finishing, extras arriving, the condensed
version landing), `ChronicleView` posts it to
`POST /api/chronicle/save`. A Reforge copy carries a variant that is
appended to the file name, so it lands as its own file. The server writes it
atomically to
`<repo>/Sessions/<campaign>/<campaign> - Session <n>.md`,
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

`/api/local-llm/detect` probes four default backends in parallel:

| Backend     | Default URL              | Models endpoint |
|-------------|--------------------------|-----------------|
| Ollama      | `http://localhost:11434` | `/api/tags`     |
| LM Studio   | `http://localhost:1234`  | `/v1/models`    |
| llama.cpp   | `http://localhost:8080`  | `/v1/models`    |
| Unsloth     | `http://localhost:8888`  | `/v1/models`    |

Each reports `{ reachable, models[], error? }`. The Local LLM panel
shows reachable backends with their installed models. The server can
also spawn a runner through `POST /api/local/launch` (Ollama with
FlashAttention + 4-bit KV cache, the LM Studio CLI, or Unsloth Studio),
but the panel has no button for it.

### Authentication

The local-LLM proxy supports three auth schemes per backend:

1. Explicit `bearerToken` — sent verbatim.
2. `username` + `password` — exchanged at `/token` via OAuth2 password
   flow; the resulting JWT is cached for 30 minutes. Used by Unsloth
   Studio's FastAPI-style auth.
3. `username` + `password` fallback to HTTP Basic when OAuth2 isn't
   available.

The proxy refuses to forward to anything outside loopback or private-network
addresses (validated by `validateLocalBaseUrl` in
`server/platform/validators.ts`; a hostname passes when it resolves to
such an address) — it is not an open proxy.

### Mini-probe (2 tests)

`server/features/providers/services/localProbe/runner.ts`:

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
restarts. The routing rows read from this cache when
offering local models per phase.

### Hardware-aware recommender

`src/features/routing/lib/recommendations.ts` combines `/api/system/info` (RAM, CPU,
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

- Gemini and OpenRouter retry up to 4 times (`MAX_RETRIES`) after the
  first attempt before a phase fails. Claude Code and Codex do not retry: a
  usage limit pauses the run with a checkpoint instead.
- Rate-limit and transient errors wait 35 seconds (`TRANSIENT_RETRY_MS`)
  before each retry, and 65 seconds (`EXHAUSTION_RETRY_MS`) before the last.
- OpenRouter 429 and 5xx responses (500, 502, 503, 520, 524): when the
  response **does** include `Retry-After`, the provider parses it via
  `retryAfterFromError` and waits exactly that long instead of the fixed
  wait; the same delay also goes into `RateLimitRegistry.noteRetryAfter()`,
  which holds every OpenRouter model so the next chunk honours the window too.
- Gemini does not read `Retry-After`. Its 5xx and transport errors use their
  own schedule of 3, 8, 20 and 45 seconds (`TRANSIENT_5XX_BACKOFF_MS`), and a
  daily quota with no free key to swap to fails at once and saves a
  checkpoint instead of retrying.
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
OpenRouter, Claude Code and Codex rely on a TTRPG framing line ("Mature themes are
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
- API keys are encrypted at rest under a machine-bound key (derived
  from the host name, user name and platform; there is no passphrase).
  They are fetched in-memory at React app boot and live in JS
  heap only.
- No telemetry, no analytics, no third-party tracking.

![A drawing of what leaves your machine. At the top, a dashed box for your machine lists what is never sent anywhere: your recordings and Whisper, the files Tomes saves, and local runners, which stay on this computer or your LAN. Below it, one arrow runs to each destination. The model you chose receives the transcript, prompt and lore when you press Run, and just the key when you press Test; Claude Code and Codex go through their own CLI. Package sites (npm, GitHub, PyPI, PyTorch and Hugging Face) are contacted once, at install or first use. github.com is contacted when you press Check for updates, for a git fetch. openrouter.ai is asked for its public model list and its provider data policies at most once a day, with nothing of yours sent; you can switch automatic updates off in Settings.](../assets/diagrams/what-goes-over-the-network.svg)
- The local-LLM proxy at `/api/local/*` always mounts, like the other
  built-in routes. It forwards only to loopback or private-network
  addresses (`validateLocalBaseUrl` in `server/platform/validators.ts`,
  which also accepts a hostname that resolves to a private address), so it
  is not an open proxy. `/api/local/launch`, which starts a runner process,
  answers only to the host machine itself.
- Add-on install endpoints (`POST /api/addons/:name/install`, `POST
  /api/whisper/setup`) are POST + same-origin-gated, so a drive-by
  `<img src=…>` cannot trigger them.
- Add-on disable: even after install, a user can flip the
  `configEnabled` toggle in Settings → Transcription. The loader skips
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
  `npm install`. Does **not** run `whisper:setup` — Whisper is an
  optional module installed from the in-app Settings → Transcription UI.
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
Anything genuinely heavier — today that means only the Whisper audio
environment — sits behind a registry so a user who never wants it never pays
the disk or dependency cost. Everything else ships in
the bundle and simply mounts.

### Registry + loader

Two lists, because there are two different things.

`server/addons/registry.ts` exports `ADDON_REGISTRY: AddonDefinition[]`, the
**installable** modules. Today that is one entry. Each definition declares:

- `kind` — always `'install'`.
- `name` — machine-stable identifier (`audio-addon`).
- `displayName` / `description` / `wip` — UI metadata.
- `docSlug` — optional `/api/docs` slug for the "Read docs" link.
- `registerRoutes(app: Express): void` — mount the module's endpoints.
- `isReady(): Promise<boolean>` — prerequisites present? Called on every
  server start, and the sole source of truth for "installed".
- `install(emit): Promise<number>` — returns the underlying script's
  exit code; non-zero means failure.
- `uninstall(): Promise<void>` — remove prerequisites.

`server/addons/featureRoutes.ts` exports `FEATURE_ROUTES: FeatureDefinition[]`,
the features that ship with the app and always mount. A `FeatureDefinition`
carries the same metadata and `registerRoutes(app)`, and nothing else: no
`isReady()`, no install lifecycle. Each feature owns the function that mounts its
routes, beside its routers, and the list is in the order they mount.

`server/addons/loader.ts → loadAddons(app)` runs at server start. It:

1. For each installable module: reads `{configDir}/addons.json` and skips if
   `configEnabled === false`, then calls `await addon.isReady()` and skips if
   false; otherwise mounts routes via `addon.registerRoutes(app)` and records the
   name in an in-memory `Set` exposed as `isAddonLoaded(name)`.
2. Then walks `FEATURE_ROUTES` and mounts every one unconditionally — neither
   `isReady()` nor the `addons.json` toggle applies, because there is no install
   state for either to describe. Their names go in the same `Set`.

Failure of any step (a thrown `isReady`, a thrown `registerRoutes`) is
caught and logged; the loader continues to the next entry so one bad
one can't brick startup. Tests in `server/addons/loader.test.ts`
pin this behaviour.

### Modules and features

The split answers one question: **does turning this on put bytes on disk that
weren't there before?**

| List | Lifecycle | Today |
|---|---|---|
| `ADDON_REGISTRY` | Carries `isReady()`, `install()`, `uninstall()`. `isReady()` gates mounting and is the sole source of truth for "installed". | Exactly one: `audio-addon`, whose payload is a Python environment. |
| `FEATURE_ROUTES` | None. Ships with the app and always mounts. | The other six. |

The types make the distinction structural rather than conventional: a
`FeatureDefinition` **cannot** carry an `uninstall()` body, because the type has
no such field. An uninstall that deleted the user's authored `personas.json` is
therefore not expressible, rather than merely discouraged by a comment.

Whether a feature is *usable* — CLI on `PATH`, runner reachable, vault path
set — is a detection question its own status endpoint answers, not an
installation question.

Any `{configDir}/*.enabled` marker files already on disk are not consulted by
the app, and it does not delete them (a full uninstall via
`scripts/uninstall.mjs` removes the two it knows about). Likewise a stale
`configEnabled: false` in `addons.json` is ignored for features.

### Three-state model (installable modules only)

For a `kind: 'install'` module the UI surfaces three distinct flags, all
returned by `GET /api/addons`:

| Flag             | Source                                | Meaning                                            |
|------------------|---------------------------------------|----------------------------------------------------|
| `enabled`        | `addon.isReady()`                     | Prerequisites installed on disk                    |
| `configEnabled`  | `{configDir}/addons.json`             | User hasn't toggled this module off                |
| `loaded`         | `isAddonLoaded(name)`                 | Routes are mounted in the current process          |

The three diverge between install/uninstall/toggle and the next server
restart — `loaded` only updates at boot. `AddonsManager.tsx` shows a
"Restart required to activate/deactivate" pill when
`loaded !== (enabled && configEnabled)`, covering install, uninstall, and
toggle in a single rule.

A failing `isReady()` is caught per module and returned inline as
`readyError` rather than failing the whole list with a 500 — one module's
broken prerequisite check must not hide the others.

### Endpoints (`server/platform/routes/addons.ts`)

| Method | Path                       | Behaviour |
|--------|----------------------------|-----------|
| GET    | `/api/addons`              | List **installable** modules with all three flags + `docSlug`. Features are deliberately absent: they configure themselves through their own surfaces (connection rows, the lore-source switch), so an install/uninstall row for them would be ceremony around nothing. |
| POST   | `/api/addons/:name/install`| SSE stream of install logs; final `done` event carries the real `exitCode` |
| PATCH  | `/api/addons/:name`        | `{ configEnabled: boolean }` toggle; persists to `addons.json` |
| DELETE | `/api/addons/:name`        | Calls `addon.uninstall()` |

Install endpoints are POST (not GET) so an `<img src=…>` can't trigger
them. The SSE response shape works fine over POST because the React
side consumes it via `fetch().body.getReader()`, not `EventSource`.

### Currently registered

`server/addons/registry.ts` and `server/addons/featureRoutes.ts` are the
source of truth.

- **`audio-addon`** *(installable)* — Whisper sidecar + the Sessions tab.
  `isReady()` checks that the venv's Python and
  `scripts/whisper/transcribe.py` exist on disk (it spawns nothing at start-up).
  `install()` runs `scripts/whisper/setup.{ps1,sh}` and forwards the
  child process's exit code. Routes: `/api/sessions/*` (transcribe +
  upload extensions), `/api/whisper/*`.
- **`personas-addon`** *(feature)* — Chronicle Personas. The router seeds the
  six presets on first read, so `personas.json` never needs to exist and
  nothing deletes it. Routes: `/api/personas/*`.
- **`local-llm-addon`** *(feature)* — Ollama / LM Studio / Unsloth routing.
  Routes: `/api/local/*` (proxy + launch) and `/api/local-llm/*` (detection,
  capability probes, Unsloth auth config).
- **`claude-code-addon`** *(feature)* — routes phases through a signed-in
  Claude Code CLI. Routes: `/api/claude-code/*`.
- **`codex-addon`** *(feature)* — the same against the OpenAI Codex CLI, and
  deliberately independent of the Claude Code feature. Routes: `/api/codex/*`.
- **`whisper-cpp-addon`** *(feature)* — bridges to a whisper.cpp build the user
  compiles, covering AMD, Intel and Apple GPUs. Routes: `/api/whisper-cpp/*`.
- **`obsidian-vault-addon`** *(feature)* — read-only Obsidian vault as a lore
  source. Routes: `/api/obsidian/*`, behind a `loopbackOnly()` gate.

> [!CAUTION]
> The `loopbackOnly()` gate on the Obsidian router is load-bearing. Every
> route on it mutates host state: `POST /config` accepts an arbitrary absolute
> path and persists it as the app's lore read root, `/generate-claude-md`
> writes a file into it, `/graphify-build` spawns a process with its cwd there,
> and `/pick-folder` opens a native dialog on the host desktop. Combined with
> `GET /api/lore/documents` — which returns the full body of every `.md` under
> that root — an ungated `/config` is arbitrary file read. Harmless on the
> default `127.0.0.1` bind, but `TUSKS_HOST=0.0.0.0` is a documented option and
> would expose all of it unauthenticated. Mounting unconditionally
> makes this gate **more** important, not less.

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

### Detection (`server/features/lore/services/detection.ts`)

First match wins:

1. `$TUSKS_LORE_DIR` env override (absolute or relative to repo root).
2. Sibling lookup: `<repoRoot>/../{Tusks-Lore, tusks-lore, tusks_lore}`.

A directory counts as a Lore install if it has a `tusks-lore.json`
marker file with a parseable `version` field. The marker prevents
random folders named "Tusks-Lore" from triggering false positives.

`createLoreFolder()` writes the marker + an empty `Sessions/`
subdirectory at the default sibling path. Idempotent: re-running
preserves an existing marker's `createdAt`.

### DOCX rendering (`server/features/library/services/docxRenderer.ts`)

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

### Endpoints (`server/features/lore/routes/lore.ts`)

| Method | Path                        | Behaviour |
|--------|-----------------------------|-----------|
| GET    | `/api/lore/status`          | Detection result + sessions count + `defaultPath` |
| POST   | `/api/lore/create`          | Scaffold the sibling folder; idempotent |
| POST   | `/api/lore/save-chronicle`  | Render the .docx and write to `<lore>/Sessions/<campaign>/Session-NN-YYYY-MM-DD-<mode>.docx` |

### Client surface

- `src/features/lore/components/LoreCard.tsx` — Settings card showing detection
  status, sessions count, writability, and the **Create Tusk's Lore**
  button when not detected.
- `src/features/library/components/ChronicleView.tsx` — adds **Save full .docx** and
  **Save condensed .docx** buttons (the condensed one only when a
  Phase 5 output exists) when the Lore folder is detected.

---


</div>
</details>

<details class="docs-section">
<summary><h2>17. In-app docs viewer</h2></summary>
<div class="docs-section-body">


The Help tab renders the same `.md` files that live in the GitHub
repo, inside the app. Stays consistent with the GitHub render because
both consume the same files.

### Endpoint (`server/features/help/routes/docs.ts`)

At startup the docs router walks `docs/**/*.md` plus `CONTRIBUTING.md`,
`.github/SECURITY.md` and `.github/CODE_OF_CONDUCT.md`, skips a short list of
notes about maintaining the repository, leaves out the repo-root `README.md`
(the project's shopfront, not help for someone already inside the app) and
builds a slug→absPath Map. Slugs derive from the
relative path: `docs/extras/audio-transcription.md` →
`docs-extras-audio-transcription`. Slugs must match `/^[a-z0-9-]+$/` AND
exist in the precomputed Map — there is no string-concatenation of user
input with disk paths, so path traversal is impossible by construction.

### Client (`src/features/help/components/DocsViewer.tsx`)

Renders with `react-markdown` + `remark-gfm`, plus `rehype-raw` and `rehype-sanitize` so inline HTML is allowed but sanitised.
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


![A paused run in three steps, top to bottom. 1, the run stops: you halt it, a rate limit hits, or a chunk fails. 2, a checkpoint is saved on your machine. 3, a banner offers Resume or trash, straight away or the next time you open Tomes; Resume carries the run on.](../assets/diagrams/pause-and-resume.svg)

Resume carries on at the saved chunk for Ground, Chronicle and Extras. For Audit and Condense the saved state comes back, but Resume does not run the phase; you run it again from its start. Trash discards a checkpoint you no longer want, and a clean finish deletes it.

A run saves a snapshot to disk when it pauses, so the app can be closed and the run resumed later.

### On-disk schema (`src/features/pipeline/lib/runCheckpoint.ts`)

```ts
type RunCheckpoint = {
  schemaVersion: 2
  runId: string
  createdAt: string
  pausedAt: string
  pausedReason: 'user' | 'quota' | 'error'
  routing: RoutingDocument      // snapshot, so resume re-uses the same providers
  safetyMultiplier: number      // the slow-down dial state at pause time
  refinementState: RefinementState  // grounded, dmQuestions/Answers, chronicle, extras, condensed
  progress: { phase: 1|2|3|4|6, chunkIndex: number, totalChunks: number }
  runFingerprint?: string       // 16 hex chars of SHA-256 over the Phase 1 prep inputs
  inputSnapshot?: Phase1InputSnapshot  // the Phase 1 chunks, captured at the first chunk_done
}
```

`schemaVersion` is bumped when the on-disk shape changes; resume
refuses to load mismatched versions and surfaces an "export the partial
output, then delete this checkpoint" path instead.

### Storage (`server/features/pipeline/routes/runs.ts`)

| Method | Path | Behaviour |
|--------|------|-----------|
| GET | `/api/runs` | Lists summaries (campaign, session #, paused phase, paused timestamp). Sorted most-recently-paused first. |
| GET | `/api/runs/:id` | Full checkpoint payload |
| PUT | `/api/runs/:id` | Atomic write to `{configDir}/runs/{runId}.json`. 20 MB cap → 413 |
| DELETE | `/api/runs/:id` | Idempotent — already-gone returns 200 |

Path-safety: `:id` is validated against `/^[a-zA-Z0-9_-]{1,64}$/` so
traversal attempts can't reach disk.

### Client surface

- **Pause** has three entry points, each of which writes the checkpoint
  via `saveRun()` and aborts the chunk loop: the **Halt pipeline** button
  (`pausedReason: 'user'`), the rate-limit dialog's *Pause and save for
  later* option (§19, `'quota'`), and an automatic pause when a chunk fails
  after work has accumulated (`'quota'` for a daily-quota or
  subscription-window error, otherwise `'error'`). Phase 3.5 (Polish) is not a
  checkpoint phase, so there is nothing to save while it runs.
- **ResumeRunBanner** (`src/features/pipeline/components/ResumeRunBanner.tsx`) renders
  above the Chronicle tab when checkpoints exist. Lists each with
  campaign / paused-phase / chunk-progress; Resume + Delete buttons.
- **Resume click** hydrates `RefinementState` from the checkpoint,
  restores the safetyMultiplier, and (per the planner in
  `src/features/pipeline/lib/resumeFlow.ts`) decides whether to continue at
  `startChunkIndex` or restart the paused phase from chunk 0. Phases 1, 3
  and 4 continue at the saved chunk with the output so far, then chain the
  phases the saved output selection still owes (Phase 1 → Phase 2;
  Phase 3 → Phase 3.5 → Phase 4 → Phase 5; Phase 4 → Phase 5). Phases 2 and 5
  are planned as restarts from chunk 0, and Resume does not dispatch them
  itself: it restores the state and the phase is run again from there.
- **Fingerprint.** At pause time the checkpoint stores a hash of the
  Phase 1 prep inputs: the raw transcript, the glossary's safe replacements
  and contextual hints, the lore alias index, and the alias-hints setting
  (`src/features/pipeline/lib/runFingerprint.ts`). It is compared again on
  resume only when the paused phase is Phase 1. A mismatch shows a warning
  toast and logs `fingerprint_mismatch`; it never blocks the resume. When
  the checkpoint carries an `inputSnapshot` (a Phase 1 chunk had finished)
  the resume re-uses the saved chunks, so glossary edits do not move the
  boundaries; without one, Phase 1 re-chunks against the live glossary.
- **Clean finish** calls `deleteRun(id)` (the picture above shows it).

---


</div>
</details>

<details class="docs-section">
<summary><h2>19. Rate-limit dialog</h2></summary>
<div class="docs-section-body">


| Provider | On a 429 (too many requests) |
|---|---|
| Gemini | Names the kind of limit and opens the rate-limit dialog. A daily quota is a message that says per day, or three exhaustions within five minutes; a rate limit is per minute or unclear. Anything else waits and retries with no dialog. |
| OpenRouter | Waits what its `Retry-After` header says; without one, 35 seconds, and 65 before the last of four retries. |
| Claude Code and Codex | Do not retry: the run pauses and saves a checkpoint. |

Behind the dialog a rate-limited Gemini call keeps retrying, with 35-second waits and 65 seconds before the last of four retries. A daily quota with no other key to switch to stops at once.

The provider classifies a Gemini 429 (`classifyExhaustion` in `src/features/providers/lib/providers/gemini.ts`) as `rate_limit`, `daily_quota` or `transient`. It reads the `PerDay` or `PerMinute` shape of the quota, and three exhaustions within five minutes on the same key upgrade a generic `rate_limit` to `daily_quota`.

The provider emits a `quota_exhausted` `ProviderEvent`; the pipeline's
`providerEventForwarder` translates it into a `quota_exhausted`
`PipelineEvent` tagged with the active phase; the React subscriber in
`RefinementTool` opens `RateLimitDialog`. Four choices:

| Choice | Action |
|---|---|
| **Stop and export** | Aborts the run + downloads the partial chronicle as Markdown (via `buildPartialMarkdown` in `src/features/library/lib/exportMarkdown.ts`) |
| **Slow down (3×)** | Sets `safetyMultiplierRef.current = 3`; the next chunk's pacing call reads this. Disabled when `quotaKind === 'daily_quota'` |
| **Pause and save for later** | Writes a checkpoint (§18) then aborts |
| **Switch to paid key for the rest** | Sets the routing's Gemini tier to paid (`fallbackToPaid` in `src/features/pipeline/lib/fallbackFlow.ts`), writes a checkpoint and aborts; Resume from the banner continues on the paid key. Disabled when no paid Gemini key is configured, when the active tier is already paid, or when the run has already moved to the free key |

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
- Whisper large-v3 at `int8_float16` on an NVIDIA GPU takes about 10 minutes
  per hour of session at five or six speaker tracks, the figure the setup
  script prints; a 4-hour six-speaker session takes around 40 minutes. CPU is
  several times slower.
- Cloud refinement wall-clock time depends on the transcript's length, the
  models routed to each phase and the provider's pacing; the progress card
  shows an ETA for each phase.
- Logs: server `console.*` to the terminal running `npm run dev`;
  browser `console.*` to devtools (F12).
- Finished chronicles land at
  `<repo>/Sessions/<campaign>/<campaign> - Session <n>.md`.
  The folder is gitignored — commit a specific session by adding it
  explicitly if you want it tracked.
- The legacy `localStorage` schema keys (`kb_documents`,
  `refinement_state`, `provider_settings`, `campaign`,
  `sessionNumber`, etc.) are still in use for items classified as
  ephemeral. Any new persistent state goes to disk via the Express
  APIs.


</div>
</details>
