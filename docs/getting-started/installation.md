# Installation

This page gets you from a fresh `git clone` to a running app, in about five minutes on a clean machine. Everything past the 60-second path is collapsed by default — open the sections you need, ignore the rest.

> **Just want the app, not the source?** A signed Windows installer is on the [roadmap](../about/roadmap.md). For now, you'll do a one-time clone + setup; after that, updating is a one-click button inside the app.

---

## The 60-second path

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

The setup step installs the app's npm packages (a few hundred MB). One-time only.

Windows is the tested platform. `setup.sh` and `start.sh` are written for macOS and Linux, but nobody has run the app end to end there yet; see [Known issues](../troubleshooting/known-issues.md).

Starting prints the app's numbered start-up steps and then a line that says `READY` with the address. The launchers open <http://localhost:5173> in your browser at that moment; with `npm run dev`, open it yourself. The first start after setup or an update takes 15–30 seconds while the app prepares its files; later starts take a few seconds. Opening the address early shows a dark "starting…" page that names the current step and turns into the app on its own.

The first thing the app needs is at least one LLM API key — see the next section.

---

## Add an LLM key

Open **Settings → Providers & models** and paste at least one:

- **Google Gemini** — paid key required for the main pipeline; typically the cheapest cloud option per session. [How to get a Gemini key](../models/choosing-a-provider.md#google-gemini--paid-key-required)
- **OpenRouter** — one key reaches around 400 models, including every Anthropic and OpenAI model, at pass-through rates. [How to get an OpenRouter key](../models/choosing-a-provider.md#openrouter--one-key-around-400-models)

Keys are encrypted at rest in `{configDir}/providers.enc` using a machine-bound key — they don't appear in `.env`, are sent only to the provider they belong to, and the GUI is the only place to manage them.

> [!TIP]
> Want the mechanical phases on your own machine for nothing? Local
> routing ships with the app — no install and no restart. Start
> [Ollama](https://ollama.com), [LM Studio](https://lmstudio.ai), or Unsloth,
> then open **Settings → Providers & models**; the panel detects it, and
> **Detect again** repeats the check. Local models take Ground, Audit and
> Extras; the chronicle still needs a cloud model or a subscription. See
> [Extras & integrations](../extras/README.md).

---

<details>
<summary><h2>Cross-device use — reading and uploading from another machine on the same Wi-Fi</h2></summary>

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

![A drawing in two parts. At the top, a dashed box for this computer, the host, says that by default only this computer opens Tomes. It lists what always stays on the host whatever you set: API keys and the Test button, the in-app updater, saving app settings, and starting a local runner. Below it, a dashed box for devices on your Wi-Fi holds two boxes side by side, and a dashed arrow runs from each up to the host, labelled that devices get a 403 for that list. The first box, with a laptop and an eye, is TUSKS_HOST=0.0.0.0: a device can read chronicles, transcripts, live progress and .sbv downloads. The second, in orange, with a laptop and a pencil, is TUSKS_LAN_WRITES=1 as well: a device can also write, meaning upload audio, save, edit, delete, install Audio Transcription and download .docx files.](../assets/diagrams/who-on-your-network.svg)

A device can also browse the session list, the system info, the add-ons list and the Help / Docs tab. Anything that writes, including the `.docx` download, answers 403 in this mode.

This is the "view from the couch" mode and is the right setting for the vast majority of cross-device use cases.

### Option B — full LAN read+write access (only if you actually need it)

Add the second variable too:

```powershell
[Environment]::SetEnvironmentVariable("TUSKS_LAN_WRITES", "1", "User")
# Restart Tomes. The boot banner reads "LAN writes (uploads, settings edits, saves): ENABLED".
```

The second lane in the drawing adds the writes. Two details it does not carry: running the pipeline from another device works with a local runner only (phases routed to a cloud model need the stored keys, which only the host can fetch, and the Claude Code and Codex routes answer the host only), and installing or removing Audio Transcription runs the install on your host. Unsloth credentials and the dev-mode toggle also stay on the host.

### What it means in plain language

Setting **`TUSKS_HOST=0.0.0.0` alone** means: anyone connected to your Wi-Fi who knows your machine's IP can BROWSE everything Tomes shows you. They can read your campaign chronicles, see the players' real names if you've captured them, and watch live transcription. They cannot break anything or take anything.

Setting **both flags** means: anyone connected to your Wi-Fi who knows your machine's IP can also CHANGE everything. They can upload garbage audio, delete chronicles, edit your glossary, or push their own prompts through your local runner.

**Your API keys are safe in both modes.** They're encrypted on disk AND the route that returns them is loopback-only AND the route behind the **Test** button, which sends your stored key to the provider, is loopback-only. A device on your network cannot read your stored keys, even with write access to everything else.

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

 **Full security primer:** [docs/security-quickref.md](../security/overview.md)

</details>

---

<details>
<summary><h2>Prerequisites — what you need before <code>setup.bat</code> runs</h2></summary>

Two things, and that is the whole core requirement:

- **Node.js 22+** — [download from nodejs.org](https://nodejs.org/). The LTS release is fine. Run `node -v` to confirm; it should print `v22` or higher.
- **Git** — [download from git-scm.com](https://git-scm.com/). If you cloned this repo, you already have it.

Python and an NVIDIA GPU matter only if you later install Audio Transcription,
and you can add them at any point.

**[Requirements](requirements.md)** is the full picture: what each dependency is
for, what happens if you skip it, and what the optional ones actually buy you.

</details>

---

<details>
<summary><h2>Troubleshooting — common gotchas</h2></summary>

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

### "Node.js … is older than Tusk's Tomes supports"

The terminal window shows this boxed warning at startup when your Node.js is
older than the app supports, usually because an update raised the minimum. The
app keeps running, but parts of it may fail. The box names both versions and the
install command for your system (`winget install OpenJS.NodeJS.LTS` on Windows,
for example; the LTS installer from [nodejs.org](https://nodejs.org/) works
everywhere). To upgrade:

1. Stop the app (Ctrl+C in its window).
2. Install the newer Node.js.
3. Open a **new** terminal window, so it finds the new Node, and check with `node -v`.
4. Run `npm install --no-audit --no-fund`, then start the app again.

### Port 5173 in use

Set the `PORT` environment variable to `5174` (or any free port) in your shell or system environment; the app does not read `.env` for it. Restart `npm run dev` or `Start_Tusks_Tomes.bat`.

### `npm install` errors mentioning `node-gyp` (Windows)

**You do not need Visual Studio Build Tools.** Nothing in the dependency tree compiles native code, and `esbuild` and `ffmpeg-static` run install steps that just download a prebuilt binary. A node-gyp error is almost certainly a stale `node_modules`: delete that folder and run setup again.

### Cloned into Program Files / OneDrive / a network drive

`setup.bat` / `setup.sh` do a write-probe and refuse to proceed if the working directory is read-only or sync-locked. Move the repo to a normal user folder (Documents, Desktop, home) and re-run.

### Python 3.13 detected, Whisper setup fails

`faster-whisper` (the engine behind Audio Transcription) is verified on **Python 3.10, 3.11 and 3.12**. Python 3.13 is untested. `npm run setup` warns about it, and the in-app Install check stops before the download starts; `npm run whisper:setup` run by hand does not check the version. Fix:

```sh
# Windows:
winget install Python.Python.3.12
# macOS (with pyenv):
pyenv install 3.12 && pyenv local 3.12
# Linux (Debian/Ubuntu):
sudo apt install python3.12 python3.12-venv
```

Then make sure `python` (`python3` on macOS and Linux) on your `PATH` runs that version, delete `vendor/python-venv/` if it exists (the setup script reuses an existing one), and re-run `npm run whisper:setup`.

### NVIDIA driver too old for CUDA 12 (Whisper still on CPU)

The Windows install uses the CUDA 12.4 torch build (`cu124`) whenever `nvidia-smi` answers; the macOS and Linux install uses the CPU build unless you pass `--cuda`. On older drivers (game-rig boxes that haven't updated in a year), the wheels download but the GPU cannot be used at run time, and Whisper falls back to the CPU; the live transcript view says so. Two fixes:

- **A** — update the driver: GeForce Experience / NVIDIA App → check for updates.
- **B** (macOS and Linux only) — keep the old driver, re-run with CUDA 11 wheels: `bash scripts/whisper/setup.sh --cuda 11.8`. CUDA 11 is supported by GTX 10-series and newer. The Windows script takes no options and installs the CUDA 12.4 build, so on Windows use option A.

### Config directory not writable

The app refuses to start with a message that says *"Config directory is not writable"* and names the folder it tried. This usually means:

- The repo lives in `Program Files`, OneDrive sync folder, or a read-only network drive → move the repo to `Documents`, `Desktop`, or your home folder.
- Antivirus / corporate-policy tooling has locked `%APPDATA%\tusks-tomes` → right-click the folder → **Properties → Security → Edit** → grant your user "Modify" permission.

Restart the dev server after fixing.

### "Couldn't decrypt providers.enc" after restoring from backup / switching machines

API keys are encrypted with a key derived from `hostname + username + platform`. If any of those change (renamed PC, copied AppData to a new machine, restored from a backup made on a different host), the encrypted blob becomes unreadable. **This is intentional** — it means a leaked AppData folder is useless on another machine.

Fix: delete `%APPDATA%\tusks-tomes\Config\providers.enc` (Windows), `~/Library/Preferences/tusks-tomes/providers.enc` (macOS) or `~/.config/tusks-tomes/providers.enc` (Linux) and re-enter your keys in Settings → Providers & models. The `.salt` file stays — it's machine-bound but not secret.

### Render error shows "The Chronicle stalled" page

That's the top-level error boundary catching a React crash. Your settings are safe, paused runs on disk are safe. Click **Try again** — most render errors are recoverable. If it returns immediately, check `.diagnose/latest.md` (auto-refreshed on every error) and share with Claude Code or open an issue with that file attached.

</details>

---

<details>
<summary><h2>Updating after the first install</h2></summary>

### From inside the app (recommended)

**Settings → Maintenance → Check for updates → Apply update.** Most updates skip `npm install` and finish in seconds.

When dependencies change, the in-app updater pulls the code and surfaces a yellow banner with a copy-paste command — the dev server holds file locks on `node_modules`, so it can't run `npm install` for you safely while you're using the app. Stop the dev server, run the suggested command, restart.

When an update needs a newer Node.js than you have, the updater's output says
so and gives the install command; install it before you run `npm install`. The
app also warns at every start until you upgrade; the Node.js entry under
Troubleshooting above has the steps.

### From the terminal

```sh
# Stop the dev server first.
git pull
npm install --no-audit --no-fund          # (Windows PowerShell: cmd /c npm install --no-audit --no-fund)
# Restart with npm run dev or Start_Tusks_Tomes.bat.
```

### Your data is safe across updates

![Three places Tusk's Tomes keeps files. The program folder holds the program code and is replaced by an update, but your Sessions folder and .env file inside it are left alone. Your profile, outside the program folder, holds settings, keys, recordings and saved chronicles, and survives an update. Next to the program folder, Tusks-Lore holds lore notes and .docx exports, and also survives an update.](../assets/diagrams/where-files-live.svg)

An update replaces only the program's tracked code. Inside the program folder, git ignores these, so an update leaves them alone:

| Inside the program folder | What it is |
|---|---|
| `node_modules/`, `dist/`, `dist-server/` | JavaScript libraries and built output |
| `vendor/` | The optional audio environment, `vendor/python-venv/` |
| `.env` | Per-machine settings |
| `Sessions/` | Your finished chronicles as Markdown |

Your glossary, keys, personas, module on/off switches, session audio and saved chronicles live outside the program folder, so `git pull` touches none of them. The per-user folders are:

| Folder | Path |
|---|---|
| Config | `%APPDATA%\tusks-tomes\Config\` (Windows — Roaming, not Local) / `~/Library/Preferences/tusks-tomes/` (macOS) / `~/.config/tusks-tomes/` (Linux) |
| Data | `%LOCALAPPDATA%\tusks-tomes\Data\` (Windows) / `~/Library/Application Support/tusks-tomes/` (macOS) / `~/.local/share/tusks-tomes/` (Linux) |
| Whisper model cache | `~/.cache/huggingface/hub` (`%USERPROFILE%\.cache\huggingface\hub` on Windows; `HF_HOME` moves it), filled the first time you transcribe audio. The uninstaller leaves this folder alone |

</details>

---

<details>
<summary><h2>Uninstalling</h2></summary>

**Important contract before you run this.** The uninstaller is only safe if you invoke it exactly as documented below. Specifically:

1. **Run it as your normal user — never with `sudo` or "Run as administrator".** The script does not need elevation; running it elevated only widens what it *could* touch if a bug existed.
2. **Run it from inside the repo's root directory** (the same place you'd run `npm install`). The script works out which folder to clean from its own location, not from where you run it, and refuses to start unless the `package.json` there says `name: "tusks-tomes"`.
3. **Don't set `TUSKS_CONFIG_DIR` / `TUSKS_DATA_DIR` / `TUSKS_CACHE_DIR` in the shell you run it from.** Only the uninstaller reads those three (the app itself always uses the platform folders); if they are set it aims at those paths and prints a warning. `TUSKS_SESSIONS_DIR` is read by both, and the uninstaller never touches that folder. The script's safety check rejects any deletion whose resolved path is neither inside the repo nor under a folder named `tusks-tomes` or `silence-beyond-the-sea`, but the simplest defence is not to set them.
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

**Removed every time**

- `node_modules/`, `dist/` and `dist-server/`.
- `vendor/`, including the audio environment if there is one.
- The cache folder.
- Settings, routing, paused runs and the other machine-bound state.

**Kept, unless you pass `--purge-user-data`**

- Glossary, speakers and personas.
- `providers.enc` (your keys), kept together with the `.salt` file that opens it, so kept keys still open after a reinstall.
- Your sessions and chronicles, in `sessions/` and in the repo's `Sessions/` folder.

**Never touched**

- `chronicle-library/`: delete it by hand if you want it gone.
- The Hugging Face cache of Whisper weights.
- `Tusks-Lore/` and any `TUSKS_SESSIONS_DIR` folder.
- Programs you installed, such as Node, Python and Ollama. They are listed at the end for you to decide.

Also:

- `vendor/` holds everything an add-on put there; for Audio Transcription that is the Whisper Python venv, usually the heaviest single item at about 1.5–2.5 GB.
- The uninstaller also removes the model profiles (`profiles.json`) and the add-on toggle state (`addons.json`), along with any `local-llm.enabled` and `personas-addon.enabled` marker files in the config directory (the app does not read them) and any leftover empty "silence-beyond-the-sea" legacy directories.
- Kept keys open again after a reinstall. After `--purge-user-data` the keys are gone, so enter them again in Settings → Providers & models. Unsloth Studio credentials are kept inside the same encrypted keystore.
- The repo source itself is never touched: the script prints the exact `rm -rf` / `Remove-Item` command for your platform at the end. Nothing outside the repo, the Tusks app-data dir and the legacy app-data dir is touched.
- External tools you installed separately for the modules — **Python, Node.js, Ollama, LM Studio, Unsloth Studio, Tusk's Vault** — are not removed. They may be used by other apps on your machine; the script lists them at the end so you can decide per tool.

The script is pure Node.js stdlib (no npm dependencies of its own) so it still runs after `node_modules` is removed: `node scripts/uninstall.mjs --help`.

**For a complete revert** (Tusk's Tomes ever ran here): run `npm run uninstall -- --purge-user-data`, delete the `chronicle-library/` folder in the data folder and the Whisper model cache if you used them, follow the printed final-step commands to remove the repo, then uninstall the external tools you do not need.

</details>

---

<details>
<summary><h2>Advanced — developer setup</h2></summary>

If you're hacking on the code rather than just running it:

```sh
npm run dev          # Express + Vite middleware on http://localhost:5173 (HMR)
npm run typecheck    # tsc --noEmit for both client (tsconfig.json) and server (tsconfig.server.json)
npm run build        # vite build + tsc -p tsconfig.server.json → dist/ + dist-server/
npm run start        # Production mode: NODE_ENV=production node dist-server/server/index.js
npm run smoke-test   # End-to-end health check; pings every configured provider + Whisper sidecar
npm test             # Vitest run; covers src, server, shared, scripts and engineering
```

Run `npm run typecheck && npm test` before every commit.

### Repo layout

```
src/                React 19 + Vite SPA (the chronicler/refiner UI)
  platform/         App shell and what every feature shares (API client, UI primitives, storage helpers)
  features/<id>/    One folder per feature: components/, hooks/, lib/
                    (pipeline, providers, routing, lore, corrections, transcription, ...)

server/             Express server (tsx in dev, compiled in prod)
  index.ts          Server entrypoint
  addons/           Module registry + loader, and the built-in feature routes
  platform/         Shared foundations (app-data paths, request gates, validators)
  features/<id>/    routes/ (Express routers) and services/ (server logic)
                    providers: encrypted keystore, profiles, local runners, CLI bridges
                    transcription: sessions, multitrack upload, Whisper sidecar
                    pipeline: run checkpoints

shared/             Contracts and pure helpers both sides import

scripts/
  setup/            First-time setup orchestrator (check-deps.mjs)
  whisper/          Python venv bootstrap (setup.ps1, setup.sh, requirements.txt, transcribe.py)
  launch/           Opens the browser once /api/health reports ready (used by the .bat)
  update/           Applies in-app updates
  smoke-test.mjs    Health-check script
  uninstall.mjs     Removes what Tomes installed

setup.bat / setup.sh    Platform wrappers — call `node scripts/setup/check-deps.mjs`
Start_Tusks_Tomes.bat   Windows convenience launcher (calls npm run dev)
start.sh                POSIX equivalent

docs/               User documentation (also rendered in the Help tab)
```

### Pre-flight checks before opening a PR

- `npm run typecheck` clean
- `npm test` clean
- `npm run smoke-test` clean (if you can reach the configured providers)
- New behaviour has a test (see [CONTRIBUTING.md](../../CONTRIBUTING.md))

</details>

---

## Optional modules

The core install does paste-a-transcript chronicling against any cloud LLM. Seven modules extend it:

- **Audio Transcription** — Whisper + Craig multitrack + direct audio ingest
- **whisper.cpp bridge** — transcription on AMD, Intel and Apple GPUs, using a build you compile
- **Local LLMs** — route Ground, Audit or Extras to Ollama / LM Studio / Unsloth
- **Chronicle Personas** — swap the narrator voice for one of six presets or your own
- **Claude Code** / **Codex** — spend a subscription you already pay for instead of API credit
- **Obsidian Vault lore** — ground chronicles against a read-only Obsidian vault

> [!TIP]
> **Only Audio Transcription installs anything**, from **Settings →
> Transcription**. The other six ship with the app — no Install button, no
> restart. Each one detects whether what it needs (a CLI, a runner, a vault folder) is there.

Full details in [Extras & integrations](../extras/README.md).

---

## Where to go next

- [README](../../README.md) — what Tusk's Tomes is, who it's for, the project story.
- [Walkthrough](quickstart.md) — your first session, end to end.
- [Architecture](../about/how-its-built.md) — full system diagram, pipeline phases, module-level walkthrough.
- [Beginner's guide](without-a-terminal.md) — zero-terminal walkthrough for first-time GitHub users.
- [Contributing](../../CONTRIBUTING.md) — how to send PRs and file bugs.
- [Feedback form](https://docs.google.com/forms/d/e/1FAIpQLSdxdqOhb1SQvI3fs50gMJv_Cesh2MuxUm95QO2iZia5sFhyyQ/viewform?usp=header) — drop questions, feature ideas, or chronicle snippets. A community Discord is on the [roadmap](../about/roadmap.md); the form is the interim channel.
