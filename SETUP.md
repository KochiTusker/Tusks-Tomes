# Setup — getting Tusk's Tomes running

This page gets you from a fresh `git clone` to a running app, in about five minutes on a clean machine. Everything past the 60-second path is collapsed by default — open the sections you need, ignore the rest.

> **Just want the app, not the source?** A signed Windows installer is on the [roadmap](ROADMAP.md). For now, you'll do a one-time clone + setup; after that, updating is a one-click button inside the app.

---

## ⚡ The 60-second path

```
git clone https://github.com/KochiTusker/Tusks-Tomes.git
cd Tusks-Tomes
```

Then, depending on your OS:

| Platform | First-time setup | Run afterwards |
|---|---|---|
| **Windows** | Double-click `setup.bat` | Double-click `Start_Tusks_Tomes.bat` |
| **macOS / Linux** | `bash setup.sh` | `bash start.sh` |
| **Power users** | `npm run setup` | `npm run dev` |

The setup step installs ~370 npm packages (~250 MB). One-time only.

Open <http://localhost:5173> in your browser. The first thing the app needs is at least one LLM API key — see the next section.

---

## 🔑 Add an LLM key

Open **Settings → API Keys** and paste at least one:

- **Google Gemini** — paid key required for the main pipeline; typically the cheapest cloud option per session. ➜ [How to get a Gemini key](docs/providers.md#google-gemini--paid-key-required-)
- **Anthropic Claude** — pay-as-you-go (~£0.05–£0.50 per session). Best narrative prose. ➜ [How to get a Claude key](docs/providers.md#anthropic-claude--pay-as-you-go-)
- **OpenAI** — pay-as-you-go, similar to Claude. ➜ [How to get an OpenAI key](docs/providers.md#openai--pay-as-you-go-)

Keys are encrypted at rest in `{configDir}/providers.enc` using a machine-bound key — they don't appear in `.env`, don't leave the host, and the GUI is the only place to manage them.

> Want to keep everything offline (no API key, no cost, no cloud)? Install the **Local LLMs** add-on from **Settings → Add-ons** and point it at [Ollama](https://ollama.com), [LM Studio](https://lmstudio.ai), or Unsloth. See [AddOns.md](AddOns.md).

---

<details>
<summary><h2>📱 Cross-device use — reading and uploading from another machine on the same Wi-Fi</h2></summary>

By default, Tusk's Tomes only listens on `127.0.0.1` — the machine running the server is the only one that can open the UI. Two environment variables let you broaden that to your home network. They're independent — the second only matters if the first is set.

### Should you turn this on?

**Yes if:** your Tomes machine is in another room (basement PC, study desktop) and you want to read chronicles from your phone / tablet on the couch · you have a home server and want every device in the house to reach it · a different machine on your network has the audio recording you want to upload (you record on a laptop, run Tomes on a desktop) · a player wants to view session transcripts in real time from their own device.

**No if:** you only use Tomes on the same machine you installed it on · you're on a network you don't fully control (apartment Wi-Fi, dorm, hotel / café / airport / library / conference) · you have smart TVs / IoT devices / guest devices on your network that you wouldn't want browsing your campaign chronicle · you're not sure (the default is safe; you can always flip it on later).

### Option A — read-only LAN access (the safe default)

Sets the server to listen on every network interface, but keeps writes blocked from non-loopback callers:

```powershell
# Windows (PowerShell, persistent across reboots):
[Environment]::SetEnvironmentVariable("TUSKS_HOST", "0.0.0.0", "User")
# Then restart Tomes. From another device on the same Wi-Fi, open:
#   http://<host-machine-IP>:5173
# (Find the IP by running `ipconfig` in PowerShell on the host machine.)
```

macOS / Linux: `export TUSKS_HOST=0.0.0.0` then restart, or add the line to `~/.bashrc` / `~/.zshrc`.

**Other devices on your Wi-Fi can now:** open the UI · browse the session list · read saved chronicles · view session transcripts (raw + cleaned) · download chronicle `.docx` files · download `.sbv` transcripts · watch live transcription progress · read the Help / Docs tab.

**They cannot:** upload audio · save / edit / delete chronicles · modify glossary or speakers · add or remove lore documents · change Settings · see your API keys · test cloud provider connections · trigger the in-app updater · launch Ollama / LM Studio / Unsloth · install or uninstall add-ons.

This is the "view from the couch" mode and is the right setting for the vast majority of cross-device use cases.

### Option B — full LAN read+write access (only if you actually need it)

Add the second variable too:

```powershell
[Environment]::SetEnvironmentVariable("TUSKS_LAN_WRITES", "1", "User")
# Restart Tomes. The boot banner now reads "LAN writes: ENABLED".
```

**Now other devices can also:** upload audio recordings (Craig zip, FLAC, WAV, MP3) · drop in `.pdf` / `.docx` lore documents · save chronicles to your Tusks-Lore folder · edit glossary, speakers, model profiles · run the 6-phase pipeline · pause and resume runs · delete sessions.

**They still cannot:** see your API keys · run the "Test connection" button against a cloud provider (it spends money) · trigger the in-app updater (it runs `git pull` on your host) · manage Unsloth credentials · launch local LLM runners · toggle dev-mode. These stay loopback-only **always**.

### What it means in plain language

Setting **`TUSKS_HOST=0.0.0.0` alone** means: anyone connected to your Wi-Fi who knows your machine's IP can BROWSE everything Tomes shows you. They can read your campaign chronicles, see the players' real names if you've captured them, and watch live transcription. They cannot break anything or take anything.

Setting **both flags** means: anyone connected to your Wi-Fi who knows your machine's IP can also CHANGE everything. They can upload garbage audio, delete chronicles, edit your glossary, or run pipelines against attacker-supplied content to burn your LLM quota.

**Your API keys are safe in both modes.** They're encrypted on disk AND the route that returns them is loopback-only AND the route that spends money via "Test connection" is loopback-only. A LAN attacker cannot drain your account even if they get full write access to everything else.

**The threat model that makes LAN exposure safe:** you trust every device that's allowed on your Wi-Fi. That includes the smart TV, the smart speakers, the kid's tablet, the visiting friend's laptop, and every IoT thing you've connected. If you're not confident about all of those, leave the toggle off.

### Turning it off

When you're done (e.g. you took the laptop to a coffee shop):

```powershell
# Wipe the persistent setting (Windows):
[Environment]::SetEnvironmentVariable("TUSKS_HOST", $null, "User")
[Environment]::SetEnvironmentVariable("TUSKS_LAN_WRITES", $null, "User")
# Restart Tomes. Banner should NOT mention LAN exposure.
```

The toggle is binary — there's no "trust this device only" partial mode. If you need that, put an authenticating reverse proxy (Caddy with basic auth, Tailscale with ACLs) in front of Tomes, but that's beyond the default install.

📖 **Full security primer:** [docs/security-quickref.md](docs/security-quickref.md)

</details>

---

<details>
<summary><h2>📋 Prerequisites — what you need before <code>setup.bat</code> runs</h2></summary>

The core install needs only two things. Add-ons need more, only when you install them.

### Required (for the core app)

- **Node.js 20+** — [download from nodejs.org](https://nodejs.org/). The LTS release is fine. Run `node -v` in a terminal to confirm; should print `v20` or higher.
- **Git** — [download from git-scm.com](https://git-scm.com/). If you cloned this repo, you already have it.

### Optional (only when you install add-ons)

- **Python 3.10 – 3.12** — needed only for the **Audio Transcription** add-on (Whisper sidecar). [Download from python.org](https://www.python.org/downloads/). Don't worry about this if you only paste transcripts.
- **NVIDIA GPU + CUDA 12.x drivers** — only if you want GPU-accelerated Whisper transcription. CPU works too, just slower (~90 min for a 4-hour session on CPU vs ~12 min on a 4070).

The full add-on list with cost / disk-space details is in [AddOns.md](AddOns.md).

</details>

---

<details>
<summary><h2>🛠️ Troubleshooting — common gotchas</h2></summary>

### Windows: `npm install` fails with "running scripts is disabled on this system"

PowerShell's default ExecutionPolicy blocks `npm.ps1`. Three fixes — pick one:

```powershell
# Option A — go through cmd just for this install:
cmd /c "npm install --no-audit --no-fund"

# Option B — fix it once for your user account (Microsoft-recommended dev setting):
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned

# Option C — easiest: just double-click setup.bat (it uses cmd.exe internally).
```

### macOS / Linux: don't `sudo bash setup.sh`

A `sudo npm install` leaves `node_modules/` root-owned and breaks every later non-sudo update. If you already did this, recover with:

```sh
sudo chown -R $USER:$(id -gn) .
# then re-run without sudo:
bash setup.sh
```

### Port 5173 in use

Set `PORT=5174` (or any free port) in `.env`. Restart `npm run dev` or `Start_Tusks_Tomes.bat`.

### `npm install` errors mentioning `node-gyp` (Windows)

This shouldn't happen any more, and if it does the fix isn't what older guides
say. **You do not need Visual Studio Build Tools.** Nothing in the dependency
tree compiles native code — `pdf-parse` was the only thing that did, and it was
replaced with a pure-JavaScript PDF reader. The only packages with install
steps are `esbuild` and `ffmpeg-static`, and both just download a prebuilt
binary.

If you're seeing a node-gyp error, it's almost certainly a stale
`node_modules`. Delete that folder and run setup again.

### Cloned into Program Files / OneDrive / a network drive

`setup.bat` / `setup.sh` do a write-probe and refuse to proceed if the working directory is read-only or sync-locked. Move the repo to a normal user folder (Documents, Desktop, home) and re-run.

### Python 3.13 detected, Whisper setup fails

`faster-whisper` (the engine behind the Audio Transcription add-on) needs **Python 3.10, 3.11, or 3.12** — torch wheels for Python 3.13 have CUDA-availability gaps that silently break the install. `npm run setup` now warns about this. Fix:

```sh
# Windows:
winget install Python.Python.3.12
# macOS (with pyenv):
pyenv install 3.12 && pyenv local 3.12
# Linux (Debian/Ubuntu):
sudo apt install python3.12 python3.12-venv
```

Then re-run `npm run whisper:setup` — the script picks the lowest compatible interpreter on `PATH`.

### NVIDIA driver too old for CUDA 12 (Whisper still on CPU)

Default Whisper install uses CUDA 12 wheels (driver ≥ 525). On older drivers (game-rig boxes that haven't updated in a year), the wheels download but PyTorch fails to initialise at runtime → falls back to CPU silently. Two fixes:

- **A** — update the driver: GeForce Experience / NVIDIA App → check for updates.
- **B** — keep the old driver, re-run with CUDA 11 wheels: `bash scripts/whisper/setup.sh --cuda 11.8` (POSIX) or set `CUDA_WHEEL=cu118` and re-run setup (Windows). CUDA 11 is supported by GTX 10-series and newer.

### Config directory not writable

The app refuses to start with a clear message like *"Config directory is not writable: `<path>`"*. This usually means:

- The repo lives in `Program Files`, OneDrive sync folder, or a read-only network drive → move the repo to `Documents`, `Desktop`, or your home folder.
- Antivirus / corporate-policy tooling has locked `%APPDATA%\Tusks-Tomes` → right-click the folder → **Properties → Security → Edit** → grant your user "Modify" permission.

Restart the dev server after fixing.

### "Couldn't decrypt providers.enc" after restoring from backup / switching machines

API keys are encrypted with a key derived from `hostname + username + platform`. If any of those change (renamed PC, copied AppData to a new machine, restored from a backup made on a different host), the encrypted blob becomes unreadable. **This is intentional** — it means a leaked AppData folder is useless on another machine.

Fix: delete `%APPDATA%\Tusks-Tomes\Config\providers.enc` (Windows) or `~/Library/Application Support/Tusks-Tomes/Config/providers.enc` (macOS) and re-enter your keys in Settings → API Keys. The `.salt` file stays — it's machine-bound but not secret.

### Render error shows "The Chronicle stalled" page

That's the top-level error boundary catching a React crash. Your settings are safe, paused runs on disk are safe. Click **Try again** — most render errors are recoverable. If it returns immediately, check `.diagnose/latest.md` (auto-refreshed on every error) and share with Claude Code or open an issue with that file attached.

</details>

---

<details>
<summary><h2>🔄 Updating after the first install</h2></summary>

### From inside the app (recommended)

**Settings → Updates → Check for updates → Apply update.** Most updates skip `npm install` and finish in seconds.

When dependencies change, the in-app updater pulls the code and surfaces a yellow banner with a copy-paste command — the dev server holds file locks on `node_modules`, so it can't run `npm install` for you safely while you're using the app. Stop the dev server, run the suggested command, restart.

### From the terminal

```sh
# Stop the dev server first.
git pull
npm install --no-audit --no-fund          # (Windows PowerShell: cmd /c npm install --no-audit --no-fund)
# Restart with npm run dev or Start_Tusks_Tomes.bat.
```

### Your data is safe across updates

Chronicles, glossary, speaker mappings, encrypted keystore, model profiles, and routing all live in the platform config directory **outside the repo** — `git pull` can never touch them. Specifically:

| Path | What's in it |
|---|---|
| `%APPDATA%\tusks-tomes\Config\` (Windows — Roaming, not Local) / `~/Library/Application Support/tusks-tomes/` (macOS) / `~/.config/tusks-tomes/` (Linux) | API keys (encrypted), glossary, speakers, model profiles, routing, add-on toggles, paused-run checkpoints |
| `<repo>/Sessions/<campaign>/...` | Auto-saved chronicle Markdown (gitignored — won't be touched by `git pull`) |
| `<repo>/vendor/python-venv/` | Whisper sidecar venv (only if the Audio Transcription add-on is installed; gitignored) |

</details>

---

<details>
<summary><h2>🧹 Uninstalling</h2></summary>

**Important contract before you run this.** The uninstaller is only safe if you invoke it exactly as documented below. Specifically:

1. **Run it as your normal user — never with `sudo` or "Run as administrator".** The script does not need elevation; running it elevated only widens what it *could* touch if a bug existed.
2. **Run it from inside the repo's root directory** (the same place you'd run `npm install`). The script refuses to start unless `package.json` says `name: "tusks-tomes"`.
3. **Don't override `TUSKS_CONFIG_DIR` / `TUSKS_DATA_DIR` / `TUSKS_CACHE_DIR` / `TUSKS_SESSIONS_DIR`** unless you set them up deliberately and know exactly where they point. The script's safety check will reject any deletion whose resolved path doesn't contain a `tusks-tomes` or `silence-beyond-the-sea` exact path segment, but the simplest defence is just not to override them.
4. **The final-step "remove the repo" command the script prints must be pasted exactly as printed** — paths inside quotes, no edits. The script can only guard its own deletions; a hand-edited `Remove-Item` / `rm -rf` you run yourself is on you.

Before any deletion, the script will require you to type `I UNDERSTAND` to acknowledge the above. Press Enter (or Ctrl-C) without typing the phrase to exit cleanly without touching anything.

If you follow this contract, the uninstaller will only ever remove paths that Tusk's Tomes itself installed.

### Run it

```sh
npm run uninstall -- --list-locations    # print every path Tusks-Tomes installs/writes
                                         # on this machine, then exit. No deletions.
                                         # Use this if you want to clean up manually.
npm run uninstall -- --dry-run           # preview what the script would delete
                                         # (no deletions, no acknowledgement prompt)
npm run uninstall                        # interactive: acknowledgement + final Y/N.
                                         # Preserves your authored content.
npm run uninstall -- --purge-user-data   # also remove glossary, speakers, personas,
                                         # API keys, session audio, and chronicles
```

The acknowledgement notice itself includes the same manual-cleanup reference, so if you decide partway through that you'd rather do it by hand, you've got the path list in front of you. Press Enter without typing the phrase to exit cleanly.

**What it removes** (by default — recreatable from a fresh setup):

- `node_modules/`, `dist/`, `dist-server/` build outputs
- `vendor/python-venv/` (the Whisper Python venv — usually the heaviest single item, ~1.5–4 GB)
- The Tusks cache directory + machine-bound state (probe cache, encryption salt, run checkpoints, model profiles, routing, settings)
- All add-on markers + auto-generated state:
  - Audio Transcription → the Python venv above
  - Local LLMs → `<configDir>/local-llm.enabled` marker
  - Personas → `<configDir>/personas-addon.enabled` marker
- Any leftover empty "silence-beyond-the-sea" legacy directories from before the project rename

**What it preserves** (your content — pass `--purge-user-data` to remove these too):

- Glossary, speakers, and personas JSON files
- Encrypted API keystore (so a reinstall doesn't lose your keys)
- Session recordings + transcripts under the data dir's `sessions/` tree
- Auto-saved chronicle Markdown under `<repo>/Sessions/`
- Unsloth Studio credentials (they're inside the encrypted keystore)

**Things the uninstaller will never touch:**

- A `Tusks-Lore` folder anywhere on disk — your lore documents are yours
- `TUSKS_SESSIONS_DIR` if you set it to a custom location
- The repo source itself — the script prints the exact `rm -rf` / `Remove-Item` command for your platform at the end
- Anything outside the repo, the Tusks app-data dir, and the legacy app-data dir
- External tools you installed separately for the add-ons — **Python, Node.js, Ollama, LM Studio, Unsloth Studio, Tusk's Vault**. These may be used by other apps on your machine; the script lists them at the end so you can decide per-tool.

The script is pure Node.js stdlib (no npm dependencies of its own) so it still runs after `node_modules` is removed: `node scripts/uninstall.mjs --help`.

**For a complete revert** (Tusk's Tomes ever ran here): run `npm run uninstall -- --purge-user-data`, follow the printed final-step commands to remove the repo, then uninstall the external tools you no longer need.

</details>

---

<details>
<summary><h2>🧑‍💻 Advanced — developer setup</h2></summary>

If you're hacking on the code rather than just running it:

```sh
npm run dev          # Express + Vite middleware on http://localhost:5173 (HMR)
npm run typecheck    # tsc --noEmit for both client (tsconfig.json) and server (tsconfig.server.json)
npm run build        # vite build + tsc -p tsconfig.server.json → dist/ + dist-server/
npm run start        # Production mode: NODE_ENV=production node dist-server/index.js
npm run smoke-test   # End-to-end health check; pings every configured provider + Whisper sidecar
npm test             # Vitest run; covers src/**/*.test.{ts,tsx} and server/**/*.test.ts
```

Run `npm run typecheck && npm test` before every commit.

### Repo layout

```
src/                React 19 + Vite SPA (the chronicler/refiner UI)
  components/       Tabs, panels, dialogs
  lib/              Pipeline, glossary cache, SBV parser, provider abstraction
  hooks/            useLocalStorage, useEta, useRefinementState

server/             Express server (tsx in dev, compiled in prod)
  index.ts          Server entrypoint
  api/              HTTP route handlers (one router per resource)
  sessions/         Session manifest reader/writer
  upload/           Multitrack zip / loose-audio extractor (audio add-on)
  whisper/          Whisper sidecar invocation (audio add-on)
  crypto/           Encrypted keystore for API keys
  addons/           Add-on registry + loader
  appData.ts        Cross-platform config / data / cache directory helpers

scripts/
  setup/            First-time setup orchestrator (check-deps.mjs)
  whisper/          Python venv bootstrap (setup.ps1, setup.sh, requirements.txt)
  smoke-test.mjs    Health-check script

setup.bat / setup.sh    Platform wrappers — call `node scripts/setup/check-deps.mjs`
Start_Tusks_Tomes.bat   Windows convenience launcher (calls npm run dev)
start.sh                POSIX equivalent

architecture.md     Full pipeline / phase-by-phase design doc
ROADMAP.md          Every milestone and the rationale behind it
README.md           End-user-facing walkthrough
AddOns.md           The opt-in add-on system
```

### Pre-flight checks before opening a PR

- `npm run typecheck` clean
- `npm test` clean
- `npm run smoke-test` clean (if you can reach the configured providers)
- New behaviour has a test (see [CONTRIBUTING.md](CONTRIBUTING.md))

</details>

---

## 🧩 Optional add-ons

The core install does paste-a-transcript chronicling against any cloud LLM. Three opt-in add-ons extend it:

- **🎙️ Audio Transcription** — Whisper + Craig multitrack + direct audio ingest
- **🦙 Local LLMs** — route any phase to Ollama / LM Studio / Unsloth
- **🎭 Chronicle Personas** — swap the narrator voice for one of six presets or your own

Each installs in one click from **Settings → Add-ons**. Full details in [AddOns.md](AddOns.md).

---

## 📚 Where to go next

- [README](README.md) — what Tusk's Tomes is, who it's for, the project story.
- [Walkthrough](docs/walkthrough.md) — your first session, end to end.
- [Architecture](architecture.md) — full system diagram, pipeline phases, module-level walkthrough.
- [Beginner's guide](docs/beginner-guide.md) — zero-terminal walkthrough for first-time GitHub users.
- [Contributing](CONTRIBUTING.md) — how to send PRs and file bugs.
- [Feedback form](https://docs.google.com/forms/d/e/1FAIpQLSdxdqOhb1SQvI3fs50gMJv_Cesh2MuxUm95QO2iZia5sFhyyQ/viewform?usp=header) — drop questions, feature ideas, or chronicle snippets. A community Discord is on the [roadmap](ROADMAP.md); the form is the interim channel.
