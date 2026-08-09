# Security quick reference

A plain-English primer for users (not developers). It tells you what's safe by default, what you can change that *could* make things less safe, and what residual risks we cannot fix in code. Takes about a minute to read.

## Out of the box, you're fine if…

- You installed by running `setup.bat` (Windows) or `bash setup.sh` (macOS/Linux).
- You open the app at <http://localhost:5173> on the same machine you installed it on.
- You added your API keys via **Settings → API Keys**.

There's nothing else to configure. The app only talks to: (a) the LLM provider(s) you configured, and (b) any local LLM runner you install (Ollama / LM Studio / Unsloth — only if you opted into that add-on).

## What's automatically protected

- **Your API keys are encrypted and locked to this machine.** Copying the keystore file to another computer doesn't help an attacker — the decryption key is bound to your hostname + username + platform. Even a thief with your laptop's disk image can't extract the keys on their computer.
- **The web interface only listens on your own computer by default.** Other devices on your Wi-Fi cannot see it.
- **Even if you opt into LAN exposure, your keys stay private.** The route that returns the decrypted keys is loopback-only — visiting devices on the LAN can see the UI but get a 403 (refused) on the keys route. Inference still runs on your host machine.
- **Documents loaded into the Help tab are HTML-sanitised.** A future hostile update couldn't slip a `<script>` tag in and steal your keys via the UI.

## Things you might change that have trade-offs

### Cross-device LAN access (`TUSKS_HOST` + `TUSKS_LAN_WRITES`) — "I want to use Tomes from my tablet / phone / laptop on the same Wi-Fi"

Tusk's Tomes binds to `127.0.0.1` by default — only the machine running it can reach the UI. Two environment variables let you opt into broader access on your own network. They're independent toggles; the second only matters if the first is set.

#### Step 1 — should you turn this on at all?

**Turn it ON if any of these apply:**
- Your Tomes machine is in another room (basement PC, study desktop) and you want to read chronicles from your phone / tablet on the couch.
- You have a home server and want every device in the house to reach it.
- A different machine on your network has the audio recording you want to upload (e.g. you record on a laptop, run Tomes on a desktop).
- You want a player to view session transcripts in real time from their own device while you GM.

**Keep it OFF (the default) if any of these apply:**
- You only use Tomes on the same machine it's installed on.
- You're on a network you don't fully control: shared apartment Wi-Fi, dorm network, hotel / café / airport / library / conference Wi-Fi.
- You have IoT devices, smart TVs, or guest devices on your network that you wouldn't want browsing your chronicle.
- You're not sure. The default is safe; you can always flip it on later.

#### Step 2 — how to set it on (Windows, PowerShell)

```powershell
# Permanent for this user account (persists across reboots):
[Environment]::SetEnvironmentVariable("TUSKS_HOST", "0.0.0.0", "User")

# OR — just for the current PowerShell session (resets when you close the window):
$env:TUSKS_HOST = "0.0.0.0"

# Then restart the Tomes server. Open from your other device at:
#   http://<your-host-machine-IP>:5173
# To find your host machine's IP: open PowerShell on it and run `ipconfig`.
```

On macOS / Linux: `export TUSKS_HOST=0.0.0.0` then restart the server. To make it permanent, add the line to `~/.bashrc` / `~/.zshrc`.

When Tomes restarts with this set, the boot banner spells out exactly what's enabled (read-only or read+write) so you can confirm.

#### Step 3 — `TUSKS_HOST=0.0.0.0` alone (read-only LAN access — recommended starting point)

| Other devices on your Wi-Fi CAN... | Other devices on your Wi-Fi CANNOT... |
|---|---|
| ✅ Open the Tomes UI in a browser at `http://<host-IP>:5173` | ❌ Upload audio recordings |
| ✅ Browse the list of sessions | ❌ Save / edit / delete chronicles |
| ✅ Read saved chronicles in any session | ❌ Modify the glossary or speaker mappings |
| ✅ View session transcripts (raw + cleaned) | ❌ Add or remove lore documents |
| ✅ See live transcription progress while a session is being processed | ❌ Edit any Settings (model profiles, hybrid routing, etc.) |
| ✅ Read the Help / Docs tab | ❌ See your API keys (the keys route is loopback-only regardless) |
| ✅ Download a chronicle's `.docx` (read-only) | ❌ Run the in-app "Test connection" button against a provider |
| ✅ Download a session's `.sbv` transcript file | ❌ Trigger the in-app updater |
| ✅ See the system info (RAM/CPU/GPU detection) | ❌ Launch Ollama / LM Studio / Unsloth via the Launch button |
| ✅ Browse the add-ons list | ❌ Install or uninstall add-ons |

This is the "view from the couch" mode. It's the right setting for the vast majority of cross-device use cases.

#### Step 4 — `TUSKS_HOST=0.0.0.0` + `TUSKS_LAN_WRITES=1` (read+write LAN access — only if you actually need it)

Add this second variable only if you genuinely need to **upload, save, or modify content** from another device:

```powershell
[Environment]::SetEnvironmentVariable("TUSKS_LAN_WRITES", "1", "User")
# Restart Tomes. The boot banner now reads "LAN writes: ENABLED".
```

With both flags on:

| Other devices on your Wi-Fi CAN now (in addition to all the reads above)... | Other devices on your Wi-Fi STILL CANNOT... |
|---|---|
| ✅ Upload audio recordings (Craig zip, FLAC, WAV, MP3) | ❌ See your API keys — loopback-only **always** |
| ✅ Drop in `.pdf` / `.docx` lore documents | ❌ Run the "Test connection" button against a cloud provider (it spends money) |
| ✅ Save chronicles to your Tusks-Lore folder | ❌ Trigger the in-app updater (it runs `git pull` on your host) |
| ✅ Edit glossary entries, speaker mappings, model profiles | ❌ Manage Unsloth credentials (it stores secrets) |
| ✅ Run the 6-phase pipeline against a transcript | ❌ Launch Ollama / LM Studio / Unsloth via the Launch button (it spawns processes) |
| ✅ Pause and resume runs | ❌ Toggle dev-mode (it pulls pre-release builds) |
| ✅ Delete sessions and chronicles | |

The "STILL CANNOT" column is the architectural backstop: even with full LAN-write access, anything that touches your credentials, spends your money, or modifies your host machine's state stays loopback-only. The boot banner explicitly tells you this.

#### Step 5 — security implications, in plain language

Setting **`TUSKS_HOST=0.0.0.0` alone** means: anyone connected to your Wi-Fi who knows your machine's IP can BROWSE everything Tomes shows you. They can read your campaign chronicles, see the players' real names if you've captured them, and watch live transcription as it happens. They cannot break anything or take anything — but **they can read the prose**.

Setting **both flags** means: anyone connected to your Wi-Fi who knows your machine's IP can also CHANGE everything. They can upload garbage audio, delete chronicles, edit your glossary so the next chronicle calls everyone by the wrong name, or run their own pipeline against attacker-supplied content to burn your free-tier LLM quota.

**In both modes**, your API keys are safe — they're locked to the host machine by AES-256-GCM with a machine-bound key AND the route that hands them out is loopback-only AND the route that triggers an outbound provider-test is loopback-only. A LAN attacker cannot spend your money even if they get full write access to everything else.

**The threat model that makes LAN exposure safe:** you trust every device that's allowed on your Wi-Fi. That includes the smart TV, the smart speakers, the kid's tablet, the visiting friend's laptop, and any IoT thing you've connected. If you're not confident about all of those, leave the toggle off.

#### Step 6 — turning it off

When you're done (e.g. you took the laptop to a coffee shop):

```powershell
# Wipe the persistent setting:
[Environment]::SetEnvironmentVariable("TUSKS_HOST", $null, "User")
[Environment]::SetEnvironmentVariable("TUSKS_LAN_WRITES", $null, "User")

# Restart Tomes. The boot banner should NOT mention LAN exposure.
```

The toggle is binary; there's no "trust this device only" partial mode. If you need that level of granularity, put an authenticating reverse proxy (Caddy with basic auth, Tailscale with ACLs) in front of Tomes — but that's beyond the scope of the default install.

### Running on a server / cloud VM

Tusk's Tomes was not designed for this. There is no login system, no audit log, no user accounts. If you put it on a public IP, **anyone on the internet** who finds the address can use the app, browse transcripts, and burn through your LLM credits. We do not have a deployment guide for this configuration. If you go ahead anyway, put an authenticating reverse proxy (Caddy with basic auth, Cloudflare Tunnel with access policies, etc.) in front of it.

### Local-LLM with a non-default backend URL

If you point Unsloth/LM Studio/Ollama at a custom URL via Settings, that URL is validated to be a local / private LAN address. We refuse to send credentials to a public IP. There is a small TOCTOU window where DNS-rebinding can theoretically slip past — see "Residual risks" below.

## Residual risks we cannot fix in code

- **The keystore is obfuscation, not bank-grade crypto.** If your computer is compromised (malware running as you, or another user with admin access), the attacker can read the decrypted keys at runtime — the app itself decrypts them whenever it makes an LLM call. Rotate your API keys at the provider's dashboard immediately if you suspect compromise. This is true of every local-first app that stores credentials.
- **DNS rebinding has a small (≤60 s) window** for the local-LLM proxy. We resolve the hostname once and cache it; the actual `fetch()` re-resolves. A hostile DNS server answering 127.0.0.1 to our lookup, then a public IP to the fetch, could in theory slip through. Mitigated by pointing local-LLM at a literal IP (`192.168.1.42`) or `localhost` rather than a hostname.
- **Prompt injection** through the transcript content is on the LLM, not on us. A player who knows the app is being used could put adversarial text in the chat that tricks the model into producing weird chronicle content. Read chronicles before sharing them publicly.
- **You ARE the security boundary** between Tomes and the public internet. No login, no audit log, no per-IP rate-limits. Keep your machine secure (OS updates, antivirus on Windows, full-disk encryption); Tomes inherits your machine's security posture.

## What you need to do

Three things, total:

1. **Add API keys** at **Settings → API Keys**. The app won't generate chronicles without one.
2. **Keep your machine secure** — OS updates, antivirus on Windows, full-disk encryption. Tomes inherits your machine's security.
3. **Rotate your API keys at the provider's dashboard** every few months, or immediately if anything weird happens (charges you don't recognise, a colleague using your laptop without permission, suspected malware).

For technical details (encryption algorithm, threat model in STRIDE form, scope of network calls), see [docs/privacy.md](privacy.md) and [.github/SECURITY.md](../.github/SECURITY.md).
