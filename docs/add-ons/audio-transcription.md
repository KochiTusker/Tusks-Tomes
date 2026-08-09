# 🎙️ Audio Transcription add-on

This is the add-on that turns recordings into text, using
[`faster-whisper`](https://github.com/SYSTRAN/faster-whisper) running on your
own machine. It adds the **Upload** and **Sessions** tabs and the full Craig
workflow. Your audio never leaves the computer, which was the whole point —
I wasn't willing to upload my friends' voices to somebody's cloud, and I
assumed I wasn't alone in that.

It's also the biggest and most fragile thing here: a 1.5–2.5 GB download, a
Python dependency, and — read this bit — an **NVIDIA** GPU or nothing. If that sounds
like more than you want to take on, [Workflow B](../workflows.md) gets you a
transcript with none of it.

> 🔎 **View in app:** this doc renders inside Tusk's Tomes too — open the **Help** tab and pick "Audio Transcription Add-on", or click **Read docs** from the add-on row in Settings.

| | |
|---|---|
| **Name** | `audio-addon` |
| **Adds tabs** | Upload, Sessions |
| **Disk footprint** | ~2 GB (Whisper venv + torch wheels) |
| **Runtime cost** | Idle when not transcribing |
| **Hard prereq** | Python 3.10–3.12 on PATH |
| **Optional prereq** | An **NVIDIA** GPU + recent drivers (~7× faster than CPU). AMD / Intel / Apple GPUs are not used at all — see the note below. |

---

<details class="docs-section">
<summary><h2>What it enables</h2></summary>
<div class="docs-section-body">


Without this add-on, your only path into the pipeline is **paste text** or **drop a pre-made `.sbv`**. With the add-on enabled, the **Upload** tab accepts:

- **[Craig](https://craig.chat) multitrack `.zip` files** — one or many, with staged batch upload for sessions split across hour-long Craig chunks. Per-speaker tracks survive into the chronicle, so every line is attributed to the right player and character.
- **Loose per-speaker WAV / FLAC files** — drop one file per speaker, label them in the speaker-mapping table.
- **Single-track audio (any common format)** — transcribed without speaker attribution, but you still get the cleaned narrative chronicle.

The **Sessions** tab is the history view of everything you've uploaded — re-open old transcripts, re-run pipelines with different model profiles, export to Tusk's Vault, or send to the Chronicle tab for refinement.

---


</div>
</details>

<details class="docs-section">
<summary><h2>Installation</h2></summary>
<div class="docs-section-body">


### From the in-app manager (recommended)

1. Open **Settings → Add-ons**.
2. Find the **Audio Transcription** card → click **Install**.
3. Watch the live install log — it streams every line from the setup script. Takes 1–5 minutes depending on your connection (faster-whisper + torch wheels are ~2 GB).
4. When the toast says **"Restart npm run dev"**, stop the server with `Ctrl+C` and relaunch it.
5. The Upload and Sessions tabs appear on next load.

If install fails partway through, the most common cause is Python not being on PATH. Open a fresh terminal, run `python --version` — if it prints anything other than `Python 3.10.x` / `3.11.x` / `3.12.x`, that's your fix. Re-install Python (Windows installer → tick **"Add python.exe to PATH"**) and retry.

### From the CLI (advanced users)

Same outcome, more control:

```sh
# Windows (CPU or GPU — script auto-detects CUDA via nvidia-smi)
npm run whisper:setup

# macOS / Linux (CPU only)
npm run whisper:setup:posix

# macOS / Linux (CUDA 12.4)
bash scripts/whisper/setup.sh --cuda 12.4
```

Scripts live in `scripts/whisper/` — plain readable shell, no admin elevation. Audit them first if you'd like.

### Disabling without uninstalling

The toggle on the add-on row flips the feature on or off without removing the 2 GB Python venv. Useful when you want to free RAM/CPU temporarily but expect to come back. A disabled add-on hides the Upload / Sessions tabs and unmounts the routes on next restart; the venv and your session data stay untouched on disk.

### Uninstalling

**Settings → Add-ons → Uninstall** wipes `vendor/python-venv/` and disables the routes. Or, manually: `rm -rf vendor/python-venv/`. No residual state in the core app.

---


</div>
</details>

<details class="docs-section">
<summary><h2>What it costs you</h2></summary>
<div class="docs-section-body">


- **Disk:** ~2 GB on first install (torch is the bulk of it). The venv lives at `vendor/python-venv/` inside the repo.
- **First-transcription wait:** Whisper downloads the model the first time it runs (~3 GB for `large-v3`). After that, transcription is local-only.
- **Time per session:** ~12 min for a 4-hour session on an NVIDIA 4070, ~90 min on CPU. The dashboard shows live progress.
- **Network:** Zero outbound calls after the initial install + model download. Audio stays on your machine forever.

---


</div>
</details>

<details class="docs-section">
<summary><h2>Workflow A — YouTube audio captures</h2></summary>
<div class="docs-section-body">


Have a session uploaded to YouTube (public / private / unlisted)? Two options:

1. **Caption Repair** (no add-on needed) — download the auto-caption `.sbv` from YouTube Studio, drop it in.
2. **Audio Transcription add-on** — extract the audio yourself with `yt-dlp` or your tool of choice, drop the audio into the Upload tab. Whisper produces better, more consistent quality than YouTube's auto-captions.

---


</div>
</details>

<details class="docs-section">
<summary><h2>Workflow B — Craig multitrack (the premium pipeline)</h2></summary>
<div class="docs-section-body">


This is the workflow Tusk's Tomes was originally designed around. **[Craig](https://craig.chat)** is a free, donation-supported Discord recording bot that records each speaker to their own audio track. The per-speaker tracks survive through Whisper into the chronicle, so every line in the final write-up is correctly attributed.

**One-time Craig setup** (~2 minutes):

1. Open <https://craig.chat> → **Invite Craig**.
2. Pick your D&D Discord server. Approve.
3. Done — Craig runs on their infrastructure, no hosting needed.

**During the session:**

1. Everyone joins voice. Type `:craig:, join` in any text channel. Craig records each speaker to their own track.
2. At the end: `:craig:, stop`. Craig DMs you a download link valid for 7 days.

**After the session:**

1. Click the link → **Multi-track FLAC** (the default). You'll get a `.zip` per Craig chunk (Craig rolls hourly). Download all of them.
2. Tusk's Tomes → **Upload tab** → drag all the zips in. Either upload everything at once OR use the **staged batch upload** flow:
   - Drop your first set → **Save Part 1** → green confirmation appears.
   - Click **Add another batch** → drop the next set → **Save Part 2**. Repeat as needed.
   - Click **All audio uploaded — start transcription**.
3. Whisper grinds through each track from each batch. The speaker-mapping table appears in the same view — edit player + character names while Whisper runs.
4. Click the green **Use this transcript for refinement** button → Chronicle tab → **Run**.

The resulting `.sbv` interleaves every speaker from every batch chronologically into one merged transcript with `[Character (Player)]` labels.

---


</div>
</details>

<details class="docs-section">
<summary><h2>A shout-out to Craig</h2></summary>
<div class="docs-section-body">


The Craig workflow **only works because [Craig](https://craig.chat) exists.** Run by [Yahweasel](https://github.com/Yahweasel) — free for everyone, no rate limits, no premium tier, no dark patterns. The per-speaker multitrack output is the gold standard for TTRPG Discord recording.

**If it works for you, go and support Craig directly — [craig.chat](https://craig.chat).** This project sends no money to Craig and is not affiliated with them. We just rely on their excellent work.

---


</div>
</details>

<details class="docs-section">
<summary><h2>GPU acceleration (optional, but worth it)</h2></summary>
<div class="docs-section-body">


A CUDA-capable NVIDIA GPU cuts a 4-hour session's transcription from ~90 minutes to ~12 minutes. The install script auto-detects your GPU via `nvidia-smi` and installs the matching torch wheel.

If `nvidia-smi` exists but reports an older CUDA version, pass `--cuda 11.8` (or whatever your driver supports) to the install script — or delete `vendor/python-venv/` and re-run `npm run whisper:setup`, which re-probes.

No GPU? The CPU path works fine — you'll just want to start transcription before dinner instead of during it.

---


</div>
</details>

<details class="docs-section">
<summary><h2>Troubleshooting</h2></summary>
<div class="docs-section-body">


| Symptom | Likely cause | Fix |
|---|---|---|
| "Python not found" during install | Python not on PATH | Re-install Python with **"Add to PATH"** ticked; open a fresh terminal |
| Torch import failure on first transcription | CUDA mismatch | Delete `vendor/python-venv/`, re-run install with `--cuda <your-version>` |
| Install hangs at ~80% | Slow connection / large torch download | Wait it out (~2 GB); the SSE log keeps you informed |
| Transcription runs on CPU even with GPU present | `nvidia-smi` not on PATH | Reinstall NVIDIA drivers; verify with `nvidia-smi` in a terminal |
| Upload tab still missing after install | Forgot to restart the dev server | `Ctrl+C` then `npm run dev` again |

For anything else, drop a note in the [feedback form](https://docs.google.com/forms/d/e/1FAIpQLSdxdqOhb1SQvI3fs50gMJv_Cesh2MuxUm95QO2iZia5sFhyyQ/viewform?usp=header) — a community Discord with a `#support` channel is on the [roadmap](../../ROADMAP.md), and the form is the interim path.

---


</div>
</details>

<details class="docs-section">
<summary><h2>Files this add-on touches</h2></summary>
<div class="docs-section-body">


| Path | Purpose |
|---|---|
| `vendor/python-venv/` | Python virtual environment (faster-whisper + torch) |
| `scripts/whisper/setup.ps1` / `setup.sh` | Install scripts |
| `server/whisper/` | Whisper sidecar invocation + per-session transcription queue |
| `server/upload/` | Multitrack zip / loose-audio extractor |
| `server/api/whisper.ts`, `transcribe.ts`, `upload.ts` | HTTP routes (mounted only when add-on is enabled) |

When the add-on is disabled, none of these routes are mounted — Express returns 404, no Python import is attempted. See [`architecture.md`](../../architecture.md) for the registry/loader implementation.


</div>
</details>
