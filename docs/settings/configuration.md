# Configuration

Two sources of config, in priority order:

1. **In-app Settings tab.** Encrypted keystore, per-phase model routing, pipeline tuning, narrator voice, and local runner endpoints. The source of truth after first save.
2. **`.env` in the repo root.** Seeds the keystore on first boot only. Subsequent runs read from the encrypted store. Useful for CI / containerised deploys.

<details class="docs-section">
<summary><h2>Where things live on disk</h2></summary>
<div class="docs-section-body">


| Path | Contents | Persistence boundary |
|---|---|---|
| `<repo>/Sessions/<campaign>/*.md` | Auto-saved chronicles in Markdown | Committable to your own private fork |
| `{dataDir}/tusks-tomes/sessions/<id>/` | Per-session audio + manifest + SBV (only used by the Audio Transcription add-on) | Per-user, outside the repo |
| `{configDir}/tusks-tomes/providers.enc` | Encrypted API keys (AES-256-GCM, machine-bound scrypt key) | Per-user, outside the repo |
| `{configDir}/tusks-tomes/{glossary,speakers,profiles,routing}.json` | UI-edited config — glossary terms, speaker mappings, per-provider model overrides, per-phase routing | Per-user, outside the repo |
| `{configDir}/tusks-tomes/settings.json` | App settings not covered by the files above | Per-user, outside the repo |
| `{configDir}/tusks-tomes/personas.json` | Personas you have authored or generated. Seeded with the six presets on first read, and never deleted by the app | Per-user, outside the repo |
| `{configDir}/tusks-tomes/model-availability.json` | Which models each configured key was measured to actually reach | Per-user, outside the repo |
| `{configDir}/tusks-tomes/openrouter-models.json` | Cached OpenRouter catalogue | Per-user, outside the repo |
| `{configDir}/tusks-tomes/addons.json` | Whether you have switched a module off — distinct from whether it is installed | Per-user, outside the repo |
| `{cacheDir}/tusks-tomes/capability.json` | Local-model capability probe results | Per-user, outside the repo, safe to delete |
| `<parent>/Tusks-Lore/tusks-lore.json` | Marker file for the shared sibling Tusk's Lore folder (auto-detected; created by Settings → "Create Tusk's Lore") | Sibling to this repo, shared with Tusk's Vault |
| `<parent>/Tusks-Lore/Sessions/<campaign>/Session-NN-YYYY-MM-DD-<full\|condensed>.docx` | Structured `.docx` chronicle exports written by the in-app "Save to Tusk's Lore" buttons | Sibling to this repo, shared with Tusk's Vault |
| `<repo>/vendor/python-venv/` | Whisper sidecar (faster-whisper + torch) — only present when Audio Transcription is installed | Local to this clone, gitignored |
| `<repo>/.env` | Optional env-var keys + overrides | Local to this clone, gitignored |

`{configDir}` resolves to:

- Windows — `%APPDATA%\tusks-tomes\Config\` (Roaming, not Local — `env-paths` puts config under `%APPDATA%`; only data and cache sit under `%LOCALAPPDATA%`)
- macOS — `~/Library/Application Support/tusks-tomes`
- Linux — `~/.config/tusks-tomes`

The keystore being machine-bound means even if `providers.enc` leaked, the keys are unrecoverable on any other machine. See [privacy.md](../security/overview.md) for the full trust model.


</div>
</details>

<details class="docs-section">
<summary><h2>Useful environment variables</h2></summary>
<div class="docs-section-body">


| Variable | Purpose |
|---|---|
| `PAID_GEMINI_API_KEY` | Billing-enabled Gemini key (required for Gemini 3.x) |
| `VITE_GEMINI_API_KEY` | Free-tier Gemini fallback |
| `OPENROUTER_API_KEY` | OpenRouter key seed — one key reaches around 400 models |
| `VITE_MODEL_PRO` / `VITE_MODEL_FLASH` | Override default Gemini model IDs |
| `PORT` | Dev server port (default 5173) |
| `TUSKS_HOST` | Interface to bind (default `127.0.0.1`). Set to `0.0.0.0` to expose to LAN — see the callout below before doing this |
| `TUSKS_LAN_WRITES` | When set with `TUSKS_HOST=0.0.0.0`: also allow **writes** (uploads, settings edits, saves) from other LAN devices. Default OFF — LAN visitors can only READ. Set to `1` to enable. See the callout below |
| `TUSKS_SESSIONS_DIR` | Override where multi-GB session audio lives |
| `TUSKS_VAULT_DIR` | Override sister-Vault auto-detect path (see [vault.md](../extras/tusks-vault.md)) |
| `TUSKS_LORE_DIR` | Override the sibling `Tusks-Lore/` auto-detect path. The folder holds `tusks-lore.json` (marker) + `Sessions/<campaign>/*.docx` (chronicle archive); same folder is read by Tusk's Vault for the shared lore base |

Variables prefixed with `VITE_` or `PAID_` are inlined into the browser bundle by Vite (configured via `envPrefix` in `vite.config.ts`). Plain-named server-only vars (like `OPENROUTER_API_KEY`) are **never** sent to the browser.

> [!CAUTION]
> **Before you set `TUSKS_HOST=0.0.0.0`, read this.** It exposes Tusk's Tomes
> to your local network. Useful at home; **dangerous on hotel, café, airport or
> coworking Wi-Fi**, where the "same Wi-Fi" attacker is real and doesn't need
> to be technical — pointing a browser at your IP is enough.

The trade-offs in plain English:

Other devices (a tablet, your partner's laptop, your phone) can open the app at `http://<your-machine-IP>:5173`.

- Your API keys are **still safe**. The `/api/provider-keys` route is loopback-only regardless of `TUSKS_HOST`. Devices visiting from elsewhere on the LAN get a 403 on that route. Your Gemini, OpenRouter and runner credentials never leave your computer.
- **LAN writes are OFF by default.** Other devices can BROWSE chronicles, transcripts, and session lists. They cannot upload audio, save chronicles, change settings, or modify anything else unless you also set `TUSKS_LAN_WRITES=1`. So if a stranger gets onto your Wi-Fi by accident, they can look but not touch.
- **Everything readable IS visible to anyone on the same Wi-Fi.** Transcripts in progress, finished chronicles, your campaign + session metadata — anyone who can reach your IP can browse them.

If you also want to **upload from your phone, drag transcripts in from another machine, or edit settings from a tablet**, set `TUSKS_LAN_WRITES=1` in addition to `TUSKS_HOST=0.0.0.0`. This opens the write surface to every LAN device — only do it on networks where you trust every connected device. The app prints a loud warning at boot when this is on.

If you only need to read chronicles from another device, consider exporting the chronicle as a `.docx` from the Sessions tab and emailing it to yourself instead. That avoids LAN exposure entirely.

For the full security picture (keystore machine-binding, what runs over the network, residual risks we cannot fix in code), see [security-quickref.md](../security/overview.md).


</div>
</details>

<details class="docs-section">
<summary><h2>What a fresh clone contains</h2></summary>
<div class="docs-section-body">


Source code, setup scripts, the launcher, and configuration **templates only**. Nothing in this list contains personal data or credentials.


</div>
</details>

<details class="docs-section">
<summary><h2>What gets created at runtime</h2></summary>
<div class="docs-section-body">


`node_modules/`, optionally the Python environment (Audio Transcription), `Sessions/`, the encrypted keystore, the settings JSONs listed above, `.env`, model caches, session manifests — all gitignored.


</div>
</details>

<details class="docs-section">
<summary><h2>Pacing & chunk sizes</h2></summary>
<div class="docs-section-body">


Pacing between cloud chunks is **automatic and per-provider**. Each call reads the provider's rate-limit response headers (`anthropic-ratelimit-*`, `x-ratelimit-*`) and computes the next safe interval. Gemini uses a static tier map keyed on which key you populated (`PAID_GEMINI_API_KEY` vs `VITE_GEMINI_API_KEY`). 429 `Retry-After` is honoured precisely.

Per-provider chunk sizes live in `src/lib/chunking.ts`:

Sizes are keyed on **(provider profile, model tier)**, not on the provider
alone. A fast-tier model runs chunks roughly half the flagship size: cheaper per
call, and it degrades less on long inputs, so quality holds at lower token
counts. Figures below are the flagship row, in chars, for Phase 1 / 2 / 3 / 4 / 6:

- Gemini paid: 30k / 30k / 60k / 60k / 100k
- Gemini free: 15k / 15k / 35k / 35k / 60k (throughput-tight)
- Claude profile: 20k / 20k / 40k / 40k / 60k
- OpenAI profile: 15k / 15k / 30k / 30k / 50k — OpenRouter maps onto this row
- Local (any runner): 5k / 5k / 8k / 8k / 6k (Phase 5) / 10k — conservative; consumer GPUs lose accuracy on long contexts

Override by editing the constants — no env var. The rate-limit state itself is in `src/lib/rateLimit.ts` and is per-provider singleton.


</div>
</details>

<details class="docs-section">
<summary><h2>Updating</h2></summary>
<div class="docs-section-body">


The in-app updater lives at **Settings → Maintenance → Check for updates → Apply update**. One click pulls the latest code from `main`, re-runs `npm install`, and prompts you to restart. Your encrypted keystore, sessions, glossary, lore, and other gitignored state survive untouched.

Prefer the terminal?

```sh
git pull && npm install
```

Either path requires Git installed locally. If you downloaded the ZIP and don't have Git, the cleanest update path is to re-download the ZIP from GitHub and unzip over your existing folder — your gitignored files survive that too.

Updates are **free, optional, and never required**. If a release breaks something for you, just don't update yet — the version you have keeps working.


</div>
</details>
