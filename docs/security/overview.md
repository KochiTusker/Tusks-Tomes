# Security and privacy

A plain-English primer for users, not developers. It tells you what's safe by default, what you can change that *could* make things less safe, and what residual risks cannot be fixed in code.

Tusk's Tomes was built on the conviction that your campaign — and your players' voices — belong on your hardware. Everything below follows from that.

## The short version

- **Session audio never leaves your computer.** Only the text transcript, the prompt and the lore text each phase uses go to the model you chose.
- **Your API keys are encrypted at rest and bound to this machine.** A copied file does not decrypt under another host name or user account.
- **The server listens only on your own computer** unless you explicitly opt into LAN access.
- **No telemetry, no analytics, no phone-home.** Ever.
- **A fresh clone holds zero credentials and zero recordings** — only source and templates.

## Known risks and limitations

These are the risks we know about, set out before you install so you can judge them for yourself. Most are deliberate trade-offs of a local-first app built for one person on their own machine; each says why, and what you can do about it. When an update closes a gap, it comes off this list. The detail behind every item is further down this page.

### On a default install

- **You trust everything you install.** Setup installs about 686 npm packages (345 of them are what a built copy needs at run time), and four of them have install scripts on Windows and Linux, five on macOS; `package.json` approves only ffmpeg-static's, which downloads an ffmpeg program from GitHub. The optional Audio Transcription module adds PyTorch, installed from a version range rather than one exact version, more Python packages from PyPI, and about 3 GB of Whisper model weights from Hugging Face the first time you transcribe. Updates arrive only when you click to check for them and apply them.
  *What you can do:* install from a release you have looked at, and read what an update brings before you apply it. *Status:* a deliberate trade-off; this is how most open-source software installs.
- **The app has no login.** It listens only on `127.0.0.1`, so other devices cannot reach it, but every program and every user account on this computer can, including the route that hands your stored keys to the page.
  *What you can do:* run Tomes under your own account on a computer you do not share, and keep that computer free of malware. *Status:* a deliberate trade-off for a single-user app on your own machine.
- **Your sessions are stored as ordinary files.** Audio, transcripts, chronicles, your glossary and your speaker names, which can include players' real names, sit unencrypted in your user profile and in the `Sessions/` folder inside the program folder.
  *What you can do:* turn on full-disk encryption, and delete sessions you no longer need. *Status:* a deliberate trade-off; your operating system's disk encryption is the protection here.
- **Your API keys have no passphrase.** They are encrypted with a key built from this computer's host name, user name and platform and a salt kept beside them. A copied file does not open on another computer, but anything running as you can read them.
  *What you can do:* set a spending cap at each provider, and rotate your keys if anything looks wrong. *Status:* a deliberate trade-off, so the app can start without asking you for a password.
- **Two requests leave without you pressing Run.** Tomes checks two public lists from OpenRouter at most once a day: its models, so new models and current prices reach the cost estimates and the model picker, and each provider's data policy. The requests carry nothing of yours.
  *What you can do:* untick **Keep the model list up to date automatically** in the Model lists strip under **Settings → Providers & models**. Tomes then keeps using the list it has and only contacts openrouter.ai when you press Re-check. *Status:* on by default; your choice.
- **What you send, the provider reads.** When you press Run, the transcript, the prompts and the lore each phase needs go over HTTPS to the providers you chose, under their own privacy terms. Audio never leaves your computer.
  *What you can do:* route Ground, Audit and Extras to a local model, so that text stays here; the chronicle and the condensed recap always go to a cloud model or a subscription. *Status:* how the app works.
- **Codex can read files on your computer.** When a phase runs through Codex, it works in its read-only sandbox, which stops it writing files but not reading them, so a transcript with planted instructions could try to make it read something. (Claude Code runs these calls with its tools, its MCP servers and your personal settings switched off.)
  *What you can do:* read a chronicle before you share it. *Status:* a deliberate trade-off.
- **Players can plant instructions in what they say.** With Gemini, OpenRouter or Claude Code, that can only change the text that comes back; the app shows model output as plain text, so it cannot run anything in the page.
  *What you can do:* read a chronicle before you post it. *Status:* inherent in sending a transcript to a language model.

### If you turn on LAN access

LAN access is off by default. These apply only once you set `TUSKS_HOST`.

- **Traffic on your network is plain HTTP.** Anyone on the network can read it, and a device that gets in the middle can change it. With `TUSKS_HOST=0.0.0.0`, any device on the network can read your sessions; with `TUSKS_LAN_WRITES=1` as well, it can change them, start the Audio Transcription install and send prompts through your local runner. Your stored keys and the host-only routes stay on the host either way.
  *What you can do:* use LAN access only on a network you trust, and turn it off when you leave; for anything wider, put an authenticating, encrypted proxy in front. *Status:* a deliberate trade-off.
- **Web pages you visit can reach Tomes through your network address.** On the default address a Host-name check turns such pages away; with LAN access on, that check is not active.
  *What you can do:* turn LAN access off when you are not using it. *Status:* a deliberate trade-off; LAN access is off by default.
- **Keys placed in `.env` are built into the page.** `VITE_` and `PAID_` values from `.env` become part of the page your browser loads, and with LAN access on, other devices load the same page.
  *What you can do:* save your keys in **Settings → Providers & models** rather than in `.env`. *Status:* a deliberate trade-off; Settings is the normal place for keys.

More detail: [what goes over the network](#what-goes-over-the-network), [what the keystore protects you from](#what-the-encrypted-keystore-protects-you-from), [LAN access step by step](#cross-device-lan-access-tusks_host--tusks_lan_writes--i-want-to-use-tomes-from-my-tablet--phone--laptop-on-the-same-wi-fi) and [residual risks](#residual-risks-we-cannot-fix-in-code).

## Out of the box, you're fine if…

- You installed by running `setup.bat` (Windows) or `bash setup.sh` (macOS/Linux).
- You open the app at <http://localhost:5173> on the same machine you installed it on.
- You added your API keys via **Settings → Providers & models**.

There's nothing else to configure. The app talks to the LLM provider(s) you configured and to any local LLM runner you run (Ollama / LM Studio / Unsloth). The only other traffic is the short list under [What goes over the network](#what-goes-over-the-network): package installs, one-off model downloads, the update check and a public list of models.

## What's automatically protected

- **Your API keys are encrypted and locked to this machine.** The decryption key is derived from your hostname + username + platform, so a copy of the keystore file does not decrypt on a computer with a different host name or user name.
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

![A drawing in two parts. At the top, a dashed box for this computer, the host, says that by default only this computer opens Tomes. It lists what always stays on the host whatever you set: API keys and the Test button, the in-app updater, saving app settings, and starting a local runner. Below it, a dashed box for devices on your Wi-Fi holds two boxes side by side, and a dashed arrow runs from each up to the host, labelled that devices get a 403 for that list. The first box, with a laptop and an eye, is TUSKS_HOST=0.0.0.0: a device can read chronicles, transcripts, live progress and .sbv downloads. The second, in orange, with a laptop and a pencil, is TUSKS_LAN_WRITES=1 as well: a device can also write, meaning upload audio, save, edit, delete, install Audio Transcription and download .docx files.](../assets/diagrams/who-on-your-network.svg)

A device can also browse the session list, the system info, the add-ons list and the Help / Docs tab. Writes, including the `.docx` download, answer 403 in this mode, and the host-only list never opens to the network.

This is the "view from the couch" mode. It's the right setting for the vast majority of cross-device use cases.

#### Step 4 — `TUSKS_HOST=0.0.0.0` + `TUSKS_LAN_WRITES=1` (read+write LAN access — only if you actually need it)

Add this second variable only if you genuinely need to **upload, save, or modify content** from another device:

```powershell
[Environment]::SetEnvironmentVariable("TUSKS_LAN_WRITES", "1", "User")
# Restart Tomes. The boot banner reads "LAN writes (uploads, settings edits, saves): ENABLED".
```

With both flags on:

The second lane in the drawing adds the writes. Two details it does not carry: running the pipeline from another device works with a local runner only (phases routed to a cloud model need the stored keys, which only the host can fetch, and the Claude Code and Codex routes answer the host only), and installing or removing Audio Transcription runs the install on your host.

The host-only list is the architectural backstop: even with full LAN-write access, anything that reads your stored credentials, uses them, starts a local runner on your host, or runs the updater stays loopback-only, as do Unsloth credentials, the dev-mode toggle and saving app settings. The boot banner explicitly tells you this.

#### Step 5 — security implications, in plain language

Setting **`TUSKS_HOST=0.0.0.0` alone** means: anyone connected to your Wi-Fi who knows your machine's IP can BROWSE everything Tomes shows you. They can read your campaign chronicles, see the players' real names if you've captured them, and watch live transcription as it happens. They cannot break anything or take anything — but **they can read the prose**.

Setting **both flags** means: anyone connected to your Wi-Fi who knows your machine's IP can also CHANGE everything. They can upload garbage audio, delete chronicles, edit your glossary so the next chronicle calls everyone by the wrong name, or push their own prompts through your local runner.

**In both modes**, your stored API keys stay on the host — they're encrypted with AES-256-GCM under a machine-bound key AND the route that hands them out is loopback-only AND the route that triggers an outbound provider test is loopback-only. A device on your network cannot read them, even with write access to everything else.

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

## What goes over the network

![A drawing of what leaves your machine. At the top, a dashed box for your machine lists what is never sent anywhere: your recordings and Whisper, the files Tomes saves, and local runners, which stay on this computer or your LAN. Below it, one arrow runs to each destination. The model you chose receives the transcript, prompt and lore when you press Run, and just the key when you press Test; Claude Code and Codex go through their own CLI. Package sites (npm, GitHub, PyPI, PyTorch and Hugging Face) are contacted once, at install or first use. github.com is contacted when you press Check for updates, for a git fetch. openrouter.ai is asked for its public model list and its provider data policies at most once a day, with nothing of yours sent; you can switch automatic updates off in Settings.](../assets/diagrams/what-goes-over-the-network.svg)

Two more cases are not in the drawing. Opening the Local LLMs panel or pressing **Detect again** sends a capability probe to a loopback or private-LAN address only (validated). `npm run smoke-test` sends a small health-check prompt to every provider you have configured.

**That is the entire outbound list.** No background pings, no usage stats, no
"anonymous" metrics.

> [!TIP]
> **Local runners and Whisper send nothing out while they work.** Audio decoding,
> transcription and segment timing all happen on your own CPU or GPU. Whisper's
> only network use is the one-off package and model downloads in the table above,
> and the local-model proxy validates that every target URL is loopback or private LAN
> before it will forward anything. It is not an open proxy.

## What the encrypted keystore protects you from

![A drawing of how the key to your stored API keys is made, and who can open the file. At the top, four boxes (host name, user name, platform and a random salt) feed one box, locked to this computer and this user. That produces providers.enc in your config folder. Below, under the question who can open that file, a purple padlock box labelled stays shut covers a providers.enc copied to another computer or account, such as a backup, cloud sync or a stray copy. An orange terminal box labelled opens covers a program running as you on this computer, because the app decrypts the keys for itself.](../assets/diagrams/what-the-keystore-protects.svg)

Because the key comes from the host name, user name and platform, a `providers.enc` copied by a backup, cloud sync or anything else does not open where those differ. The file lives in the config directory, not the repo.

> [!CAUTION]
> It does **not** protect you from someone with a live shell on your machine as
> your user. At that point they can simply ask the running app for the keys.
> That is the standard threat-model boundary for any local-first app that stores
> credentials, and no amount of encryption at rest moves it.

## Tusk's Vault interop is purely filesystem-based

Sending a finished chronicle to Tusk's Vault copies the markdown into
`<vault>/Lore/Tomes/<campaign>/<file>.md`. That is a copy operation — no
network, no API, no third party. The two projects find each other by sibling
directory detection; see [the Vault guide](../extras/tusks-vault.md).

## Residual risks we cannot fix in code

- **The keystore is a lock against copied files, not a password.** The cipher is AES-256-GCM, but the key comes from your host name, user name and platform plus a salt kept beside the file, so the app opens it without asking you. If your computer is compromised (malware running as you, or another user with admin access), the attacker can read the decrypted keys at runtime — the app decrypts them itself and hands them to the browser to make LLM calls. Rotate your API keys at the provider's dashboard immediately if you suspect compromise. This is true of every local-first app that stores credentials.
- **DNS rebinding has a small (≤60 s) window** for the local-LLM proxy. We resolve the hostname once and cache it; the actual `fetch()` re-resolves. A hostile DNS server answering 127.0.0.1 to our lookup, then a public IP to the fetch, could in theory slip through. Mitigated by pointing local-LLM at a literal IP (`192.168.1.42`) or `localhost` rather than a hostname.
- **Prompt injection** through the transcript content is on the LLM, not on us. A player who knows the app is being used could put adversarial text in the chat that tricks the model into producing weird chronicle content. Read chronicles before sharing them publicly.
- **You ARE the security boundary** between Tomes and the public internet. No login, no audit log, no per-IP rate-limits. Keep your machine secure (OS updates, antivirus on Windows, full-disk encryption); Tomes inherits your machine's security posture.

## What you need to do

Three things, total:

1. **Add API keys** at **Settings → Providers & models**. The app won't generate chronicles without one.
2. **Keep your machine secure** — OS updates, antivirus on Windows, full-disk encryption. Tomes inherits your machine's security.
3. **Rotate your API keys at the provider's dashboard** every few months, or immediately if anything weird happens (charges you don't recognise, a colleague using your laptop without permission, suspected malware).

## Next

- [What it installs, and what could go wrong](what-it-installs.md) — the honest version
- [Security policy](../../.github/SECURITY.md) — threat model in STRIDE form, and how to report a vulnerability
- [Configuration](../settings/configuration.md) — exactly where every file lives
