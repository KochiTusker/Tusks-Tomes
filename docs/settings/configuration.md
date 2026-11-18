# Configuration

Two sources of config, in priority order:

1. **In-app Settings tab.** Encrypted keystore, per-phase model routing, pipeline tuning, narrator voice, and local runner endpoints. The source of truth after first save.
2. **`.env` in the repo root.** Read by the browser build only: `VITE_` and `PAID_` values (Gemini keys and model overrides) reach the app this way. Other variables (`PORT`, `TUSKS_*`, `OPENROUTER_API_KEY`) are read from the real process environment, so set those in your shell or system environment. If no keystore exists on first boot, it is seeded from `PAID_GEMINI_API_KEY`, `VITE_GEMINI_API_KEY` and `OPENROUTER_API_KEY` found in that environment; after that the encrypted store is the source of truth.

<details class="docs-section">
<summary><h2>Where things live on disk</h2></summary>
<div class="docs-section-body">


![Three places Tusk's Tomes keeps files. The program folder holds the program code and is replaced by an update, but your Sessions folder and .env file inside it are left alone. Your profile, outside the program folder, holds settings, keys, recordings and saved chronicles, and survives an update. Next to the program folder, Tusks-Lore holds lore notes and .docx exports, and also survives an update.](../assets/diagrams/where-files-live.svg)

Paths under `<repo>` are inside the program folder; `<repo>/Sessions/`, `<repo>/vendor/` and `<repo>/.env` are gitignored. `{configDir}`, `{dataDir}`, `{cacheDir}` and the Hugging Face cache are per-user and outside the repo. `<parent>/Tusks-Lore/` sits beside the repo and is shared with Tusk's Vault. Everything under `{cacheDir}` is safe to delete.

| Path | Contents |
|---|---|
| `<repo>/Sessions/<campaign>/*.md` | Auto-saved chronicles in Markdown |
| `{dataDir}/sessions/<id>/` | Per-session audio + manifest + SBV (only used by the Audio Transcription add-on) |
| `{dataDir}/chronicle-library/<id>.json` | Saved chronicles: each finished run's chronicle, extras and condensed version |
| `{configDir}/runs/<runId>.json` | Paused-run checkpoints |
| `{configDir}/.salt` | The per-machine value the keystore key is derived from |
| `{configDir}/providers.enc` | Encrypted API keys (AES-256-GCM, machine-bound scrypt key) |
| `{configDir}/{glossary,speakers,profiles,routing}.json` | UI-edited config — glossary terms, speaker mappings, per-provider model overrides, per-phase routing |
| `{configDir}/settings.json` | App settings not covered by the files above |
| `{configDir}/personas.json` | Personas you have authored or generated. Seeded with the six presets on first read, and never deleted by the app |
| `{configDir}/model-availability.json` | Which models each configured key was measured to actually reach |
| `{configDir}/openrouter-models.json` | Cached OpenRouter model list (see Model list updates) |
| `{configDir}/openrouter-providers.json` | Cached OpenRouter provider data policies, saved beside the model list |
| `{configDir}/addons.json` | Whether you have switched a module off — distinct from whether it is installed |
| `{cacheDir}/capability.json` | Local-model capability probe results |
| `{cacheDir}/obsidian-vault/<hash>.index.json` | The entity index derived from your Obsidian vault, written when you save the vault settings or press **Reindex vault**. Never written into the vault itself |
| `{configDir}/obsidian-vault.json` | Obsidian vault path and its switches |
| `<parent>/Tusks-Lore/tusks-lore.json` | Marker file for the shared sibling Tusk's Lore folder (auto-detected; created by the **Create Tusk's Lore** button under Tome of Lore → Lore source) |
| `<parent>/Tusks-Lore/Sessions/<campaign>/Session-NN-YYYY-MM-DD-<full\|condensed>.docx` | Structured `.docx` chronicle exports written by the in-app "Save to Tusk's Lore" buttons |
| `~/.cache/huggingface/hub` (`%USERPROFILE%\.cache\huggingface\hub` on Windows; `HF_HOME` moves it) | Whisper model weights (about 3 GB), downloaded on your first transcription (safe to delete: they download again) |
| `<repo>/vendor/python-venv/` | Whisper sidecar (faster-whisper + torch) — only present when Audio Transcription is installed |
| `<repo>/.env` | Optional `VITE_` / `PAID_` keys and model overrides for the browser build |

`{configDir}`, `{dataDir}` and `{cacheDir}` resolve to:

- Windows — `%APPDATA%\tusks-tomes\Config\` (Roaming, not Local — `env-paths` puts config under `%APPDATA%`), `%LOCALAPPDATA%\tusks-tomes\Data\` and `%LOCALAPPDATA%\tusks-tomes\Cache\`
- macOS — `~/Library/Preferences/tusks-tomes/`, `~/Library/Application Support/tusks-tomes/` and `~/Library/Caches/tusks-tomes/`
- Linux — `~/.config/tusks-tomes/`, `~/.local/share/tusks-tomes/` and `~/.cache/tusks-tomes/` (`XDG_CONFIG_HOME`, `XDG_DATA_HOME` and `XDG_CACHE_HOME` move them)

The app has no variable of its own for the config, data and cache folders; only the sessions folder can be moved (`TUSKS_SESSIONS_DIR`).

The keystore being machine-bound means a leaked `providers.enc` does not decrypt on a machine with a different host name or user name. See [privacy.md](../security/overview.md) for the full trust model.


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

Variables prefixed with `VITE_` or `PAID_` are read from `.env` and inlined into the browser bundle by Vite (configured via `envPrefix` in `vite.config.ts`); keys saved in Settings are not part of the bundle. Every other variable is read by the server from your real environment, not from `.env`, and plain-named ones (like `OPENROUTER_API_KEY`) are not placed in the bundle.

> [!CAUTION]
> **Before you set `TUSKS_HOST=0.0.0.0`, read this.** It exposes Tusk's Tomes
> to your local network. Useful at home; **dangerous on hotel, café, airport or
> coworking Wi-Fi**, where the "same Wi-Fi" attacker is real and doesn't need
> to be technical — pointing a browser at your IP is enough.

The trade-offs in plain English:

Other devices (a tablet, your partner's laptop, your phone) can open the app at `http://<your-machine-IP>:5173`.

- Your API keys are **still safe**. The `/api/provider-keys` route is loopback-only regardless of `TUSKS_HOST`. Devices visiting from elsewhere on the LAN get a 403 on that route. Your stored Gemini, OpenRouter and runner credentials are never served to other devices.
- **LAN writes are OFF by default.** Other devices can BROWSE chronicles, transcripts, and session lists. They cannot upload audio, save chronicles, edit the glossary or routing, or modify anything else unless you also set `TUSKS_LAN_WRITES=1`. Saving the app's own settings, and everything that touches your keys, stays on the host either way. So if a stranger gets onto your Wi-Fi by accident, they can look but not touch.
- **Everything readable IS visible to anyone on the same Wi-Fi.** Transcripts in progress, finished chronicles, your campaign + session metadata — anyone who can reach your IP can browse them.

If you also want to **upload from your phone, drag transcripts in from another machine, or edit the glossary from a tablet**, set `TUSKS_LAN_WRITES=1` in addition to `TUSKS_HOST=0.0.0.0`. This opens the write surface to every LAN device — only do it on networks where you trust every connected device. The app prints a loud warning at boot when this is on.

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


Pacing between cloud chunks is **automatic and per-provider**. The delay before each chunk is `max(60 s ÷ requests per minute, input tokens ÷ tokens per minute × 60 s) × 1.1`, less the time since the last call, and the **Slow down** option in the rate-limit dialog multiplies it by 3. Gemini uses a static table keyed on the key tier (paid or free) and the model (Pro or Flash): paid Pro 150 requests and 2,000,000 tokens a minute, paid Flash 1,000 and 4,000,000, free Pro 2 and 32,000, free Flash 10 and 250,000. OpenRouter is paced on requests per minute only: 20 for `:free` models and a nominal 60 for the rest. A 429 `Retry-After` is honoured.

Per-provider chunk sizes live in `src/features/pipeline/lib/chunking.ts`:

Sizes are keyed on **(provider profile, model tier)**, not on the provider
alone. A fast-tier model runs chunks roughly half the flagship size: cheaper per
call, and it degrades less on long inputs, so quality holds at lower token
counts. Figures below are the flagship row, in chars, for Phase 1 / 2 / 3 / 4 / 5:

- Gemini paid: 30k / 30k / 60k / 60k / 100k
- Gemini free: 15k / 15k / 35k / 35k / 60k (throughput-tight)
- Claude profile (Claude Code): 20k / 20k / 40k / 40k / 60k
- OpenAI profile (Codex): 15k / 15k / 30k / 30k / 50k — OpenRouter maps onto this row
- Local (any runner): 5k / 5k / 8k / 8k / 10k, plus 6k for Phase 3.5, which only local runs use — conservative; consumer GPUs lose accuracy on long contexts

Override by editing the constants — no env var. The rate-limit state itself is in `src/features/providers/lib/rateLimit.ts` and is per-provider singleton.


</div>
</details>

<details class="docs-section">
<summary><h2>Model list updates</h2></summary>
<div class="docs-section-body">

**Keep the model list up to date automatically** (Settings, Providers and models, under Model lists) is on by default. The app keeps a copy of OpenRouter's public model list, with prices and context sizes, and asks `openrouter.ai` for a newer one at most once a day. Cost estimates, chunk sizes, output limits and the model picker all read that copy, so new models and price changes show up without you doing anything. The request is anonymous and carries no key, transcript or lore. OpenRouter's list of each provider's data policy (whether it trains on or keeps your prompts) is kept the same way, beside the model list.

Turn it off and the app never contacts `openrouter.ai` for the list by itself. It keeps using the copy it has, however old, until you press **Re-check** on the Model lists strip. If a check fails (offline, or OpenRouter is down), the saved list keeps working, is marked as stale, and the app waits an hour before trying again, doubling the wait up to a day. With no saved list and no connection the app still runs; model prices and limits then fall back to built-in defaults.

</div>
</details>

<details class="docs-section">
<summary><h2>Updating</h2></summary>
<div class="docs-section-body">


The in-app updater lives at **Settings → Maintenance → Check for updates → Apply update**. One click pulls the latest code from `main` (fast-forward only, and only on a clean checkout of `main`) and prompts you to restart. When the dependencies changed, it shows the `npm install` command to run after you stop the app. Your encrypted keystore, sessions, glossary, lore, and other gitignored state survive untouched.

Prefer the terminal?

```sh
git pull && npm install
```

Either path requires Git installed locally. If you downloaded the ZIP and don't have Git, the cleanest update path is to re-download the ZIP from GitHub and unzip over your existing folder — your gitignored files survive that too.

Updates are **free, optional, and never required**. If a release breaks something for you, just don't update yet — the version you have keeps working.


</div>
</details>
