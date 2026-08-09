# 🔐 Privacy & security

Tusk's Tomes was built on the conviction that your campaign — and your players' voices — belong on your hardware. The trust model:

- **Session audio never leaves your computer.** Craig zips and per-speaker WAV/FLAC files live in `{dataDir}/tusks-tomes/sessions/` by default. Only the text transcript + prompt scaffolding is sent to the LLM provider you chose. With the Audio Transcription add-on installed, transcription runs entirely on your CPU/GPU via `faster-whisper`.
- **Server binds to `127.0.0.1` by default.** Other devices on your LAN cannot reach the UI without explicit opt-in (`TUSKS_HOST=0.0.0.0`).
- **Cross-origin POSTs are rejected.** A same-origin middleware on `/api/*` rejects any state-changing request whose `Origin` header doesn't match the listener. Combined with the loopback bind, drive-by-CSRF (e.g. a malicious page in another tab triggering an add-on install) is closed.
- **API keys are encrypted at rest** in `{configDir}/tusks-tomes/providers.enc` via **AES-256-GCM with a machine-bound scrypt key** (hostname + username + platform). The dashboard never shows raw keys back — only "configured / not configured" indicators. Even if `providers.enc` leaked, the keys are useless on any other machine.
- **Whisper is fully local** (with the Audio Transcription add-on installed). Audio decoding (`ffmpeg-static`), transcription (`faster-whisper`), and segment timing all happen on your CPU/GPU. Audio never hits the network.
- **Local LLM routing is fully local** (with the [Local LLMs add-on](add-ons/local-llm.md) installed). The same-origin proxy validates that target URLs are localhost / RFC1918 only and never acts as an open proxy.
- **No telemetry, no analytics, no phone-home.** Outbound network calls: the LLM provider you picked (only when you run a pipeline), optional Tusk's Vault file copies (purely local filesystem operations), and `npm run smoke-test` pings if you choose to run them.
- **A fresh clone contains zero credentials, zero recordings, zero personal state** — only source code + templates. Everything per-user is created at runtime in platform-standard locations outside the repo.
- **You can audit every byte.** ~7,000 lines of TypeScript + a Python sidecar. The setup scripts are plain readable shell. The keystore implementation lives in `server/crypto/`.

<details class="docs-section">
<summary><h2>What goes over the network</h2></summary>
<div class="docs-section-body">


| When | Where | What |
|---|---|---|
| You click **Run** on the pipeline | LLM provider you configured | Text transcript + prompt scaffolding for that phase only |
| You hit **Detect** in Settings → Local LLM (Local LLMs add-on installed) | Loopback / private LAN only (validated) | Capability probe to the local LLM endpoint |
| You install the Audio Transcription add-on | pypi.org + pytorch.org (one-time) | `faster-whisper` + `torch` wheels |
| You first transcribe with Whisper | Hugging Face (one-time per model) | The Whisper model weights (~3 GB for `large-v3`) |
| You hit **Check for updates** | github.com | `git fetch` against the public repo |
| You run `npm run smoke-test` | Every provider you've configured | A small health-check prompt |

**That's the entire outbound list.** No background pings, no usage stats, no "anonymous" metrics.


</div>
</details>

<details class="docs-section">
<summary><h2>What the encrypted keystore protects you from</h2></summary>
<div class="docs-section-body">


The machine-bound scrypt key means:

- ✅ Your `providers.enc` being read on the **same machine** by an attacker who has your filesystem (but not your account) → keys still recoverable on that machine but not exfiltrated to theirs.
- ✅ Backups / cloud-sync replicating `providers.enc` → useless on the restore target machine.
- ✅ Repo-leak scenarios → impossible, since `providers.enc` is in `{configDir}` not the repo.
- ❌ Doesn't protect you from someone with a live shell on your machine *as your user*. At that point they can ask the running app for keys via the API. Standard threat-model boundary.


</div>
</details>

<details class="docs-section">
<summary><h2>Tusk's Vault interop is purely filesystem-based</h2></summary>
<div class="docs-section-body">


When you click **Send to Vault** on a finished chronicle, Tomes copies the markdown into `<vault>/Lore/Tomes/<campaign>/<file>.md`. That's a `cp`-equivalent — no network, no API, no third party. The two repos find each other via sibling-directory detection (see [vault.md](vault.md)).


</div>
</details>
