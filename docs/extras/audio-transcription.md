# Audio Transcription

This is the add-on that turns recordings into text, using
[`faster-whisper`](https://github.com/SYSTRAN/faster-whisper) running on your
own machine. It adds the **Sessions** tab, with uploading as its primary action, and the full Craig
workflow. Your audio never leaves the computer, which was the whole point —
I wasn't willing to upload my friends' voices to somebody's cloud, and I
assumed I wasn't alone in that.

It's also the biggest and most fragile thing here: a download of about 1.5–2.5 GB, a
Python dependency, and — read this bit — an **NVIDIA** GPU if you want it fast, since
any other card runs on the processor unless you bring a [whisper.cpp build](whisper-cpp.md).
If that sounds like more than you want to take on, [the YouTube route](../importing/youtube-captions.md)
gets you a transcript with none of it.

> [!NOTE]
> **View in app:** this doc renders inside Tusk's Tomes too — open the **Help** tab and pick "Audio Transcription", or click **Read docs** from the Transcription row in Settings.

This is the one module that genuinely installs something. Everything else in Tomes ships with the app.

| | |
|---|---|
| **Name** | `audio-addon` |
| **Adds tabs** | Sessions (the upload panel sits at the top of it) |
| **Disk footprint** | About 1.5–2.5 GB for the venv + torch wheels, plus the large-v3 model weights fetched into the Hugging Face cache on your first transcription |
| **Runtime cost** | Nothing runs until your first transcription; after that the Whisper worker keeps the model loaded until you stop the app |
| **Hard prereq** | Python 3.10–3.12 on PATH |
| **Optional prereq** | An **NVIDIA** GPU + recent drivers (several times faster than CPU). AMD / Intel / Apple GPUs are not used by this engine — see the [whisper.cpp bridge](whisper-cpp.md). |

---

<details class="docs-section">
<summary><h2>What it enables</h2></summary>
<div class="docs-section-body">


Without this add-on, your only path into the pipeline is **paste text** or **drop a pre-made `.sbv`**. With the add-on installed, the upload panel at the top of the **Sessions** tab accepts:

- **[Craig](https://craig.chat) multitrack `.zip` files** — one or many, with staged batch upload for sessions split across hour-long Craig chunks. Per-speaker tracks survive into the chronicle, so every line is attributed to the right player and character.
- **Loose per-speaker WAV / FLAC files** — drop one file per speaker, label them in the speaker-mapping table.
- **Single-track audio (any common format)** — transcribed without speaker attribution, but you still get the cleaned narrative chronicle.

The **Sessions** tab is the history view of everything you've uploaded — re-open old transcripts, re-run pipelines with different per-phase routing (**Settings** → **Providers & models**), export to Tusk's Vault, or send to the Chronicle tab for refinement.

---


</div>
</details>

<details class="docs-section">
<summary><h2>Installation</h2></summary>
<div class="docs-section-body">


### From the in-app manager (recommended)

1. Open **Settings → Transcription**.
2. Find **Audio Transcription** → click **Install**. A short check of your Python and graphics card opens first; **Download and install (~1.5 GB)** starts the install once it passes. With no NVIDIA card it asks you to acknowledge that transcription will be slow, and an unsupported Python blocks the install.
3. Watch the live install log — it streams every line from the setup script. It takes roughly 5–15 minutes, depending on your connection (the Python environment plus wheels is about 1.5–2.5 GB).
4. When the toast says **"Restart Tusk's Tomes to activate it"**, stop the server with `Ctrl+C` (or close its window) and start it again.
5. The **Sessions** tab appears on next load, with uploading as the first thing on it.

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

The toggle on the row switches the module off without removing the Python environment, which is useful when you want to free RAM or CPU for a while. After the next restart the Sessions tab is hidden and the module's routes are not mounted; the environment and your session data stay on disk.

![The states of the Audio Transcription module. Not installed: the row offers Install. Install, with a live log, leads to Installed, not running: the row says Enabled with a Restart required to activate pill, and the Sessions tab is still hidden. Restarting Tomes leads to Active, where the Sessions tab is shown. From Active, switch off and restart reaches Switched off, where the environment stays on disk, and switch on and restart returns to Active. Uninstall, from Active or Switched off, deletes the environment but not your sessions and returns to Not installed; a restart finishes it.](../assets/diagrams/module-states.svg)

### Uninstalling

**Settings → Transcription → Uninstall** wipes `vendor/python-venv/`; the Sessions tab goes at the next restart. Or, manually: `rm -rf vendor/python-venv/`. What stays behind is the on/off switch in `addons.json` (only if you ever flipped it) and the model weights, which live in the Hugging Face cache that `faster-whisper` uses by default, not in the venv.

> [!WARNING]
> Uninstalling removes the transcription environment, not your sessions.
> Transcribed audio and transcripts live in the sessions directory and are left
> alone.

---


</div>
</details>

<details class="docs-section">
<summary><h2>What it costs you</h2></summary>
<div class="docs-section-body">


- **Disk:** about 1.5–2.5 GB on install, with torch the bulk of it. The venv lives at `vendor/python-venv/` inside the repo. The large-v3 model weights are a separate download that `faster-whisper` fetches the first time you actually transcribe something, into the Hugging Face cache in your user profile (`~/.cache/huggingface/hub`, moved by `HF_HOME`), so the install figure is not the final on-disk total.
- **First-transcription wait:** Whisper downloads the model the first time it runs (~3 GB for `large-v3`). After that, transcription is local-only.
- **Time per session:** about 10 minutes per hour of session at five or six speaker tracks on a mid-range NVIDIA card, so roughly half an hour for a three-hour session. CPU-only is several times slower. The dashboard shows live progress.
- **Network:** Zero outbound calls after the initial install + model download. Audio stays on your machine forever.

---


</div>
</details>

<details class="docs-section">
<summary><h2>Route B — YouTube audio captures</h2></summary>
<div class="docs-section-body">


Have a session uploaded to YouTube (public / private / unlisted)? Two options:

1. **Caption Repair** (no add-on needed; it sits inside the **Chronicle** tab) — download the auto-caption `.sbv` from YouTube Studio, drop it in.
2. **Audio Transcription** — extract the audio yourself with `yt-dlp` or your tool of choice, then drop it onto the **Sessions** tab. Whisper produces better, more consistent quality than YouTube's auto-captions.

---


</div>
</details>

<details class="docs-section">
<summary><h2>Route C — Craig multitrack (the premium pipeline)</h2></summary>
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
2. Tusk's Tomes → **Sessions** tab → drag all the zips in. Either upload everything at once OR use the **staged batch upload** flow:
   - Drop your first set → **Save Part 1** → green confirmation appears.
   - Click **Add another batch** → drop the next set → **Save Part 2**. Repeat as needed.
   - Click **All audio uploaded — start transcription**.
3. Whisper grinds through each track from each batch. The speaker-mapping table appears in the same view — edit player + character names while Whisper runs.
4. Click the green **Use this transcript for refinement** button → Chronicle tab → **Begin the Chronicle**.

![Zips are dropped on the Sessions tab. Each zip holds one track per player, here PC-Alpha, PC-Beta and the DM, and the zips are laid end to end: each zip starts where the last one ends. Whisper transcribes one track at a time, on your GPU or the CPU, and the result is one transcript in time order, each line tagged with who said it.](../assets/diagrams/craig-to-transcript.svg)

Every line of the resulting `.sbv` carries a `[Character (Player)]` label.

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


A CUDA-capable NVIDIA GPU transcribes at about 10 minutes per hour of session with five or six speaker tracks — roughly half an hour for a three-hour session on a mid-range card, where the CPU path takes several times longer. On Windows the install script checks for an NVIDIA card with `nvidia-smi` and installs the CUDA 12.4 build of torch when it answers, the CPU build when it does not. The macOS and Linux script installs the CPU build unless you pass `--cuda`. If the GPU cannot be used at run time, Whisper drops to the processor until the app is restarted.

On macOS or Linux, pass `--cuda <version>` to `scripts/whisper/setup.sh` (for example `bash scripts/whisper/setup.sh --cuda 11.8`) to install a CUDA build of torch. The Windows script takes no options. To redo the install, delete `vendor/python-venv/` and re-run `npm run whisper:setup`, which checks `nvidia-smi` again.

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
| Torch import failure on first transcription | CUDA mismatch | Delete `vendor/python-venv/` and re-run the install (on macOS and Linux with `--cuda <your-version>`) |
| Install hangs at ~80% | Slow connection / large torch download | Wait it out (about 1.5–2.5 GB); the SSE log keeps you informed |
| Transcription runs on CPU even with GPU present | `nvidia-smi` not on PATH | Reinstall NVIDIA drivers; verify with `nvidia-smi` in a terminal |
| Sessions tab still missing after install | Forgot to restart the dev server | `Ctrl+C` then `npm run dev` again |

For anything else, drop a note in the [feedback form](https://docs.google.com/forms/d/e/1FAIpQLSdxdqOhb1SQvI3fs50gMJv_Cesh2MuxUm95QO2iZia5sFhyyQ/viewform?usp=header) — a community Discord with a `#support` channel is on the [roadmap](../about/roadmap.md), and the form is the interim path.

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
| `server/features/transcription/services/whisper/` | Whisper sidecar invocation + per-session transcription queue |
| `server/features/transcription/services/upload/` | Multitrack zip / loose-audio extractor |
| `server/features/transcription/routes/whisper.ts`, `transcribe.ts`, `upload.ts` | HTTP routes (mounted only when the add-on is installed and switched on) |
| `{configDir}/addons.json` | The on/off switch, written only when you flip it |
| `~/.cache/huggingface/` (outside the repo) | The large-v3 model weights `faster-whisper` downloads on the first transcription |

When the add-on is disabled, none of these routes are mounted — Express returns 404, no Python import is attempted. See [`architecture.md`](../about/how-its-built.md) for the registry/loader implementation.


</div>
</details>
