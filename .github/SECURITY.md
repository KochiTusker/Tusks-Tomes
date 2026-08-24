# Security policy

Tusk's Tomes is a **local-first** application — it runs on your machine, binds only to `127.0.0.1` by default, has no telemetry, and only ever sends text (never audio) to the LLM provider you configure. The risk surface is small but not zero. This page lays out what's covered, what isn't, and what you can do to keep yourself safe.

## Trust model in one paragraph

Everything except the chosen cloud LLM API runs on the user's machine. API keys are encrypted at rest at `{configDir}/providers.enc` using AES-256-GCM with a scrypt-derived key bound to your machine identity (hostname + username + platform). The Express server binds to loopback by default; all `/api/*` state-changing routes are same-origin gated to block drive-by-CSRF; chronicle save paths are sanitised against traversal; the local-LLM proxy refuses any target outside loopback or RFC-1918 LAN. No audio leaves the host (Whisper runs in-process when the audio add-on is installed); the LLM provider is the only outbound destination Tomes talks to, and even then only the text it needs to refine.

## What this is NOT

Tusk's Tomes is **not** a SaaS, **not** a multi-tenant service, and **not** a hardened public-internet-facing application. The threat model below assumes a single user, on their own machine, on a network they reasonably trust. Running Tomes on a shared workstation, on a server, or on a public IP is outside the design — possible with care, but you take responsibility for the gates Tomes doesn't provide (auth, TLS, audit logging).

It also is not a substitute for keeping your provider account secure (rotate keys regularly; set spending caps) or your machine secure (full-disk encryption, OS updates, careful what you `pip install`).

---

## STRIDE — base product, no add-ons

The base install (paste-a-transcript chronicling with a cloud LLM) is the smallest attack surface. The table below names each STRIDE category, the realistic risk in this product, what the code does about it today, and what's still on you.

| Category | Risk | Mitigation in place | Your responsibility |
|---|---|---|---|
| **Spoofing** | A malicious page in your browser tries to use Tomes's API to drive an action (install an add-on, save settings, exfil keys via a bug). | Server binds to `127.0.0.1` by default; same-origin middleware on `/api/*` rejects cross-origin POST/PUT/PATCH/DELETE; the keys endpoint returns nothing on the public summary route. The `/api/provider-keys` route (decrypted keystore) is also gated by a loopback-only middleware that checks the actual TCP peer (not the spoofable `Host` header) — visiting LAN devices get a 403 even when `TUSKS_HOST=0.0.0.0` is set. **A LAN-write gate (Phase 7) additionally blocks all non-GET requests from LAN sources unless the user explicitly sets `TUSKS_LAN_WRITES=1`** — so opting into LAN exposure gives visitors read-only access by default. | If you opt into LAN exposure (`TUSKS_HOST=0.0.0.0`), your keys are still safe and LAN visitors can only BROWSE (read chronicles, transcripts, lists); they can't upload or change anything unless you also set `TUSKS_LAN_WRITES=1`. Only do this on trusted home / office networks; never on public Wi-Fi. See [docs/security-quickref.md](../docs/security/overview.md) for the plain-English version. |
| **Tampering** | Browser script modifies persisted settings (routing, glossary, profiles). | Same-origin gate on every state-changing route; keystore is AES-256-GCM and the decrypted bundle never appears in any public response. | Keep your browser sandboxed — don't paste untrusted JS into the devtools console; don't install browser extensions you haven't vetted. |
| **Repudiation** | A user denies having modified state. | N/A in a single-user local app — there's no auth boundary to repudiate within. | N/A. |
| **Information disclosure** | An attacker who has read access to your config directory + your machine identity (hostname + username + platform) can decrypt `providers.enc`. | The decryption key is machine-bound — copying `providers.enc` to a different machine doesn't help an attacker. Atomic writes (rename-from-tmp) prevent half-written exposure during saves. | Don't share `{configDir}/providers.enc`; if your machine is compromised, **rotate your provider keys immediately** (revoke + reissue at each provider's console). The keystore is obfuscation, not high-grade crypto. |
| **Denial of service** | An LLM provider exhausts its quota mid-run; the pipeline fails halfway through. | The rate-limit dialog catches quota errors mid-pipeline and offers four user-controlled paths (stop+export / slow-down 3× / pause+save / fallback). On-disk checkpoints let you resume tomorrow. | Watch your provider dashboard — Tomes can pause your run, but it won't alert you to billing surprises. Set spending caps at the provider for paid keys. |
| **Elevation of privilege** | An attacker tries to escalate from in-Tomes capability to OS capability. | No auth boundaries exist within the app (no users, no roles), so there is no "privilege" to escalate to within Tomes itself. The server runs as your user account, with your user account's filesystem permissions. | Run Tomes as a regular user, not root / admin. Don't `sudo bash setup.sh` — the script refuses sudo for exactly this reason. |

### Path-traversal + injection — the boring-but-important bits

- The chronicle save endpoint sanitises the campaign name (strips `\/:*?"<>|` + control characters) and resolves against `<repo>/Sessions/` before writing, so a malicious campaign string can't escape the directory.
- The docs viewer (`/api/docs/:slug`) uses an allowlist-based slug→path Map built at startup; there is no string-concatenation of user input with disk paths.
- Run-checkpoint IDs (`/api/runs/:id`) are validated against `/^[a-zA-Z0-9_-]{1,64}$/` — any other shape returns 400 before reaching disk.
- The `/api/sessions/:id/*` endpoints (audio-addon only) validate `:id` against the same regex.

These don't appear in the STRIDE table because they're "doors stay closed" rather than distinct categories — but they're load-bearing pieces of the same baseline.

---

## Add-on-specific implications

Installing Audio Transcription widens the surface in narrow, documented ways. It is the only module that installs anything, and can be installed, toggled off, or uninstalled at any time from **Settings → Transcription**. The remaining modules ship with the app and add no files to your disk.

### Audio Transcription

Adds a Python venv at `<repo>/vendor/python-venv/` (~1.5 GB) and runs `faster-whisper` in-process for transcription. **No audio leaves the host.**

Additional risk: the venv has Python's normal filesystem capabilities — if the venv is tampered with, a compromised package could read anything your user account can read. Mitigation: install only via Settings → Transcription (which uses the bundled, version-pinned setup scripts at `scripts/whisper/setup.ps1` / `.sh`); don't `pip install` random packages into `vendor/python-venv/`. The bundled `requirements.txt` is the trust boundary.

### Local LLMs

Mounts `/api/local/*` as a localhost + RFC-1918 same-origin proxy so the browser can reach Ollama / LM Studio / Unsloth (which are different ports = different origins). The proxy validates every target URL through `PRIVATE_HOST_RE` — anything outside loopback or private LAN ranges is rejected; it is **not** an open proxy.

Additional risk: if you set `TUSKS_HOST=0.0.0.0` *and* expose Tomes on your LAN, another device on the same LAN could route requests through your local Ollama. Mitigation: keep `TUSKS_HOST=127.0.0.1` (the default) unless you genuinely need LAN access; never put Tomes on a public IP without an auth layer in front.

### Chronicle Personas

Marker file only — `{configDir}/personas-addon.enabled` + the `personas.json` user-authored prompt store. No new attack surface: persona templates can interpolate chronicle text via the existing `{varName}` placeholder syntax (no code execution); the default bardic voice stays available and is never editable so a broken persona can't lock you out of the pipeline.

---

## Supported versions

Tusk's Tomes is a rolling release tracking `main`. The latest commit on `main` is the only supported version. The in-app updater (**Settings → Maintenance**) keeps you current; security fixes ship there first.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security problems.**

Use this private channel:

1. **GitHub's private vulnerability reporting** — open this repository on GitHub, click the **Security** tab, then **Report a vulnerability**. GitHub keeps the report private and routes it directly to the maintainers. This is currently the only supported private channel — a community Discord with a moderator-DM route is on the [roadmap](../docs/about/roadmap.md), and this section will be updated once it launches.

Please include:

- A description of the issue and its potential impact
- Reproduction steps or a proof-of-concept
- The version / commit SHA you tested against
- Any suggested remediation (optional)

We'll acknowledge within 72 hours and aim to ship a fix within 14 days for high-severity issues. We'll credit you in the release notes unless you'd prefer to stay anonymous.

For non-sensitive coordination (i.e. not a vulnerability — design questions, hardening suggestions, threat-model discussion), the [feedback form](https://docs.google.com/forms/d/e/1FAIpQLSdxdqOhb1SQvI3fs50gMJv_Cesh2MuxUm95QO2iZia5sFhyyQ/viewform?usp=header) is fine. **Do not put vulnerability details into the form** — Google Forms is not a private channel for security reports; use GitHub's private vulnerability reporting for anything sensitive.

## Scope

In scope:

- The Express server (`server/`) and its API routes
- The encrypted keystore (`server/crypto/keyStore.ts`)
- The Whisper sidecar (`scripts/whisper/`) when the audio add-on is installed
- The in-app updater (`scripts/update/`, `server/api/updater.ts`)
- The React SPA (`src/`)
- The local LLM proxy (`server/api/localProxy.ts`) when the local-llm add-on is installed
- The run-checkpoint storage (`server/api/runs.ts`)

Out of scope:

- Vulnerabilities in upstream dependencies (please report those to the upstream project; we'll bump as soon as a patched version ships)
- Vulnerabilities that require a malicious LLM provider you've already configured (you trust your own API key — that's a different threat model from "Tomes leaks the key")
- Social-engineering vectors that require the user to manually run arbitrary attacker-supplied code from their dashboard
- LLM prompt-injection attacks delivered through the transcript content itself — the model is the trust boundary there, not Tomes; the chronicle output is unconditionally untrusted text and should be reviewed before sharing

## Disclosure

Once a fix has shipped to `main`, we'll publish a brief security advisory on the repo. Once the community Discord launches (see [ROADMAP.md](../docs/about/roadmap.md)), security-fix announcements will also be posted in `#announcements`.
