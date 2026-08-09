# 🎙️ Getting a session in — three ways

The hard part was never writing the chronicle. It's getting four hours of six
people talking over each other into text at all. There are three routes, and
which one suits you depends mostly on how you record and what hardware you have
lying about.

Worth saying up front: **C gives the best result, and A is the easiest**. If
you're not sure, start with A or B and move up later. Nothing is locked in —
you can use a different route every week if you like.

| Route | Add-on needed? | Who said what? | Suits you if… |
|---|---|---|---|
| **A — Paste a transcript** | None | Whatever's already in the text | You've got a transcript from somewhere already |
| **B — Record, let YouTube transcribe** | None | **None at all** — see the disclaimer below | You've no NVIDIA GPU, or you want the least faff |
| **C — Craig multitrack** | Audio Transcription | Every line, correctly | You play on Discord and want it done properly |

---

<details class="docs-section">
<summary><h2>Workflow A — Paste any transcript (core, no add-on)</h2></summary>
<div class="docs-section-body">


> **Best for**: anyone who already has a transcript from anywhere — a previous Whisper run, a manual notetaker, a NotebookLM export, a Discord chat log. Tomes doesn't care where the text came from.

> ### On an AMD or Intel GPU? Read this before you go hunting
>
> The built-in transcriber only accelerates on NVIDIA. It's natural to assume
> some other Whisper build will use your card — so here's what I found when I
> actually went looking, to save you the same afternoon:
>
> | Project | Prebuilt GPU backends | Verdict |
> |---|---|---|
> | [whisper.cpp](https://github.com/ggml-org/whisper.cpp) | CPU, BLAS *(still CPU)*, CUDA | Its Vulkan backend exists in source but **is not in any release build**. You'd have to compile it yourself with the Vulkan SDK. |
> | [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) | CPU, CUDA | No DirectML build shipped. |
> | [Const-me/Whisper](https://github.com/Const-me/Whisper) | DirectCompute — **any DirectX 11 GPU** | Genuinely works on AMD and Intel. Windows-only, and no release since July 2023. |
>
> So: the only ready-made thing that will actually use an AMD or Intel card is
> Const-me/Whisper, and it's been unmaintained for years. If you're willing to
> accept that, it produces plain text you can paste straight into the Chronicle
> tab via this workflow.
>
> Compiling whisper.cpp with `GGML_VULKAN=1` yourself also works well if you're
> comfortable with a build toolchain.
>
> If neither appeals, **Workflow B** below (record, let YouTube transcribe)
> needs no GPU at all and is the route I'd point most people to.

1. Open the **Chronicle** tab.
2. Paste your transcript into the **Raw transcript** box.
3. Set a campaign name and session number, then **Begin the Chronicle**.

---


</div>
</details>

<details class="docs-section">
<summary><h2>Workflow B — YouTube `.sbv` (core, no add-on)</h2></summary>
<div class="docs-section-body">


> **Best for**: beginners, and anyone without an NVIDIA GPU. No Discord bot to invite, no audio recording setup, no extra software, no Python. YouTube does the transcription on its hardware instead of yours.

The common shape of this workflow: record the session with **OBS Studio** (or
any similar recorder), upload it to YouTube, and let YouTube's automatic
captions do the transcription on Google's hardware instead of yours.

1. Record the session — OBS Studio, or whatever you already use.
2. Upload to YouTube and set visibility to **Unlisted** or **Private**.
3. Wait for automatic captions to finish generating.
4. In **YouTube Studio → your video → Subtitles**, pick either extraction route:
   - **Copy the transcript text.** Open the language's caption track, copy the
     text, and paste it straight into the **Raw transcript** box on the
     Chronicle tab (this is Workflow A from there on). Quickest option.
   - **Download the `.sbv`.** Subtitles → ⋮ → **Download `.sbv`**, then
     **Caption Repair tab** → drop the file → **Repair captions** (the model
     anchors names against your glossary) → **Send to refinement**.
5. Chronicle tab → **Run**.

Both land in the same pipeline. The `.sbv` keeps timestamps, which gives the
chunker better segmentation boundaries; pasting the plain text is faster and
perfectly workable.

This is the **lowest-friction** path, and the right one if Whisper's GPU requirement is a problem — see Workflow C below for the hardware reality. If you already upload your sessions to YouTube, you can have a chronicle inside ten minutes of finishing a session.

> **⚠️ Honest disclaimer — speaker attribution.** This route produces a
> noticeably weaker result than the multi-track Craig workflow, and the gap is
> almost entirely about *who said what*. A YouTube caption file carries **no
> speaker labels whatsoever** — it is one undifferentiated stream of text.
> Tomes reconstructs speakers from context, and to do that the audit phase will
> ask you **a fair number of clarifying questions** before it can attribute
> lines with any confidence. Even after you answer them, some attribution
> remains a best guess. The Craig route hands Whisper one audio file per
> person, so it doesn't have to guess at all.
>
> Pick this route if you want a readable account of the session and can live
> with some fuzziness about who said which line. Pick Workflow C if you want
> the chronicle to reliably name the right character. You can switch between
> them session to session — nothing is locked in.

---


</div>
</details>

<details class="docs-section">
<summary><h2>Workflow C — Craig multitrack (Audio Transcription add-on required)</h2></summary>
<div class="docs-section-body">


> **Best for**: Discord-based games that want the highest-quality chronicle. Per-speaker FLAC tracks mean every line of dialogue in the final write-up is correctly attributed to the right player and character — no more "did the rogue or the bard say that?" arguments. Adds a one-time ~2-minute Craig bot invite step.
>
> **Requires Discord.** Craig is a Discord bot, so this workflow only applies if your group plays over Discord voice and someone has permission to invite a bot to the server. If you play in person, on Roll20 voice, over Zoom, or anywhere else, use Workflow B (record and let YouTube transcribe) or record locally and paste the transcript. Craig itself is free — its own paid tier only extends recording length.
>
> **Prerequisite:** Install the **Audio Transcription** add-on first — **Settings → Add-ons → Install**. Requires Python 3.10–3.12 and downloads the Whisper sidecar (~2 GB). Restart the server once installed; the Upload and Sessions tabs will then appear.

> **⚠️ Hardware reality — Whisper needs an NVIDIA GPU specifically.** Measured on a real
> session (8 players, 3 hours of audio, **NVIDIA RTX 3070 Ti**):
>
> | Stage | Duration | Needs you present? |
> |---|---|---|
> | Local Whisper transcription | 20–30 minutes | No |
> | Six-phase chronicle pipeline | ~30 minutes | No — pause/resume built in |
> | **Total, end to end** | **~1 hour** | Start it and walk away |
>
> Whisper will run on CPU, but *far* slower — on integrated graphics or
> CPU-only, a three-hour session can take several hours rather than half an
> hour, and an AMD or Intel card makes no difference at all — the engine only
> has CUDA and CPU backends. **Without an NVIDIA GPU, use Workflow B (YouTube
> captions) instead** — it offloads transcription to Google's hardware. Read
> the speaker-attribution disclaimer there before you commit to it.

1. Drop one or more [Craig](https://craig.chat) `.zip` files into the **Upload tab**. Either all at once, or staged (commit Part 1, then *Add another batch* for Part 2/3/…, then *All audio uploaded — start transcription*).
2. Edit the speaker mapping table (player + character names per row) while Whisper grinds.
3. Click **Use this transcript for refinement** when the green button appears → Chronicle tab → **Run**.

For the full Craig bot setup walkthrough (~2 minutes, one-time), staged-batch upload flow details, and the speaker-mapping table, see [add-ons/audio-transcription.md](add-ons/audio-transcription.md).

---


</div>
</details>

<details class="docs-section">
<summary><h2>If a run hits a quota mid-pipeline — the rate-limit dialog</h2></summary>
<div class="docs-section-body">


Free-tier LLM keys have per-minute and daily quotas. Long sessions on a free key can hit either one. When that happens, Tomes opens a four-option dialog mid-run so you're never stuck with a half-finished chronicle:

- **Stop and export what we have** — aborts, downloads partial Markdown.
- **Slow down (3× pacing)** — paces calls more conservatively for the rest of the run. Disabled if the quota looks daily — waiting longer doesn't help an empty bucket.
- **Pause and save for later** — writes a full on-disk checkpoint. Close the app, come back tomorrow, click **Resume** on the banner above the Chronicle tab. The pipeline picks up at the exact chunk where it stopped.
- **Switch to paid Gemini key for the rest** — only available when a paid key is configured alongside the free one.

Daily quotas typically reset at midnight UTC; per-minute limits clear in 60 seconds. No work is lost on any path — your grounded transcript, DM answers, and partial chronicle are all kept.

See [walkthrough.md → If it gets stuck](walkthrough.md#-if-it-gets-stuck--the-rate-limit-dialog) for the full step-by-step.


</div>
</details>

<details class="docs-section">
<summary><h2>The closed-loop promise</h2></summary>
<div class="docs-section-body">


Once you've configured the system to your taste — chosen your LLM provider(s), populated the glossary, picked your workflow — the long-run work per session is:

1. Hit a download link or paste a transcript (60 seconds).
2. Click **Run** (zero seconds).
3. Walk away while the pipeline runs (10–20 minutes hands-off with a GPU).
4. Open the finished chronicle when you're back, optionally push to Tusk's Vault.

**Same three clicks per week, forever.** That's the design goal — minimal recurring work, maximum recurring value.


</div>
</details>
