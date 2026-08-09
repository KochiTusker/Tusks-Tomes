# 🧩 Add-ons — optional capabilities you can install in one click

The core app does one thing: you give it a transcript, it gives you a chronicle.
Everything heavier — transcribing audio, running local models, changing the
narrator's voice, reading your Obsidian vault — is an add-on you install only if
you actually want it.

This wasn't an architectural preference so much as a reaction to being on the
other end of it. I've installed plenty of tools that dragged in a couple of
gigabytes of machine-learning dependencies I never used, for a feature I didn't
want, on a first run. If you only ever paste transcripts, you should never need
Python, never sit through a 2 GB download, and never see a GPU detection script.
So you don't.

Nothing here is a paid tier or a feature gate. It's all MIT-licensed and it's
all in the repo already — the only thing an add-on costs you is disk space and
a bit of setup time, and only when you ask for it.

---

## 🪄 How install / uninstall works

1. **Settings → Add-ons** in the running app. Each add-on has a card showing install status + a one-line description.
2. Click **Install**. The install log streams live in the UI (Whisper takes a few minutes; Local LLMs is instant; Personas is instant).
3. **Restart the dev server when prompted.** Add-on routes only mount at server boot, so the new tabs / features don't appear until the next restart.
4. To remove: same card, **Uninstall** button — removes the prerequisites and unmounts the routes.
5. To temporarily disable without uninstalling: the **toggle** on the same card keeps prerequisites on disk but skips loading the add-on at next boot.

The architectural details (registry, isReady probes, configEnabled flag, route mounting) live in [architecture.md §15](architecture.md#15-add-on-system).

---

## The add-ons

### 🎙️ Audio Transcription

**The premium path.** Lets you drop a [Craig](https://craig.chat) Discord recording zip directly into Tomes; the Whisper sidecar transcribes it offline; the resulting transcript carries per-speaker attribution end-to-end into the chronicle.

**Why it beats the YouTube `.sbv` workflow:** YouTube's auto-captions are single-track. They give you all the words, but they have no idea which player or character said what. Craig records every speaker as a separate FLAC stream, so when the chronicle finishes, every line in the prose is attributed to the right character. No more "wait, did the rogue or the bard say that?" arguments.

**What it unlocks:**
- **Upload** tab — Craig multitrack zip ingest, loose-file audio drop, staged-batch uploads
- **Sessions** tab — your transcribed sessions, replay/export/delete affordances
- **Whisper sidecar** — offline transcription via `faster-whisper` large-v3 (CUDA auto-detected; CPU fallback works)
- **Speaker mapping editor** — pre-populated from filenames, editable before transcription kicks off

**Cost:** ~2 GB on disk (Python venv + torch + model weights). Python 3.10–3.12 required. An **NVIDIA** GPU cuts a 4-hour session from ~90 min on CPU to ~12 min on a 4070.

> **On AMD or Intel?** This engine won't use your card — it only has CUDA and CPU backends. See the **whisper.cpp bridge** below, or the [YouTube route](docs/workflows.md), which needs no GPU at all.

**Deep dive:** [docs/add-ons/audio-transcription.md](docs/add-ons/audio-transcription.md)

---

### 🔧 whisper.cpp bridge (bring your own build)

**The route for AMD, Intel and Apple GPUs.** The Audio Transcription add-on above only accelerates on NVIDIA, because `faster-whisper` has just two backends: CUDA and CPU. This add-on bridges to a [whisper.cpp](https://github.com/ggml-org/whisper.cpp) build that you compile, which can use whatever card you have.

**Why you have to build it yourself:** I went looking for a ready-made binary that would use non-NVIDIA GPUs and there isn't a good one. whisper.cpp's own releases ship CPU, BLAS (still CPU) and CUDA — its Vulkan backend exists in source but is in no release asset. sherpa-onnx ships CPU and CUDA only. Const-me/Whisper does genuinely use any DirectX 11 GPU, but hasn't had a release since July 2023. Rather than compile and sign binaries I can't test on hardware I don't own, this add-on takes the same shape as the Claude Code and Codex ones: you own the tool, I own the integration.

**What it does:**
- **Detects and checks your build** — including reading its capability line, so it can tell you "this is a CPU-only build and won't use your graphics card" instead of leaving you to wonder why it's slow
- **Transcribes through it**, producing exactly the same output as the built-in engine — the Upload tab, Sessions tab and speaker mapping all work unchanged
- **Falls back automatically** to the built-in engine if anything stops checking out, rather than failing your run

**Cost:** nothing on disk from us. The add-on downloads and installs **nothing** — it writes one marker file. Your whisper.cpp build and model are yours; uninstalling never touches them. You supply a build (a compile) and a GGML model (~3 GB for large-v3).

**Deep dive:** [docs/add-ons/whisper-cpp.md](docs/add-ons/whisper-cpp.md) — build instructions for Windows, Linux and macOS.

---

### 🦙 Local LLMs

**The fully-offline path.** Routes any phase of the pipeline (or the whole thing) through a local model running on your hardware. The chronicle never touches a cloud API.

**Why you might want this:** privacy (sensitive transcripts stay on the host), cost (zero dollars per session), or just preference (you already run Ollama and want to use it). The hybrid-routing UI lets you mix and match — e.g. Gemini Flash for cheap phases, your local 27B model for the long-form chronicle phase.

**What it unlocks:**
- **Local LLM** panel in Settings — detect + probe Ollama / LM Studio / Unsloth on their default ports
- **Hybrid Routing** editor — assign each pipeline phase to a specific local model independently
- **Capability probe** — a 2-test mini-probe (structured JSON adherence + grounding fidelity) flags which phases each local model is qualified for, so the routing UI shows green / red badges
- **Hardware advisories** — VRAM / RAM checks for the model you've picked, so a 32B model on 8 GB doesn't silently OOM

**Cost:** zero on the Tomes side. The add-on is a feature flag plus a same-origin proxy. You install [Ollama](https://ollama.com), [LM Studio](https://lmstudio.ai), or Unsloth separately — those are the heavy downloads. Quality caveat: local models under ~15B parameters produce noticeably weaker prose than Claude / GPT-4 / Gemini Pro; mix-and-match per phase is the sweet spot.

**Deep dive:** [docs/add-ons/local-llm.md](docs/add-ons/local-llm.md)

---

### 🎭 Chronicle Personas

**Swap the narrator's voice.** The default chronicle voice is a polished bardic tone — appropriate for most groups. Personas lets you replace it with one of six character presets, or write your own.

**The six presets:** Arnold Schwarzenegger, Homer Simpson, Peter Griffin, Gandalf, Mike Tyson, Donkey (from Shrek). All affect phases 3 (Chronicle), 5 (Polish, local-only), and 6 (Condense) — the prose-generation phases. Phases 1 (Ground), 2 (Audit), and 4 (Extras) are voice-neutral and untouched.

**Authoring your own:**
- Clone a preset and tweak
- Start from the locked bard template
- Write from scratch
- Describe a narrator in one sentence and let your active LLM draft all the prompts for review

**Cost:** marker file only. No download, no dependencies. Uninstalling returns the pipeline to the original bardic voice byte-for-byte.

**Deep dive:** [docs/add-ons/personas.md](docs/add-ons/personas.md)

---

### 🤖 Claude Code (your subscription)

**Bring your own Claude subscription.** Instead of a per-token API key, route the pipeline through the [Claude Code](https://docs.claude.com/en/docs/claude-code) CLI you've already installed and logged into — generation is billed against *your* Pro / Max plan, with **no API key required**. The app never handles your login; it only invokes the `claude` binary you authenticated yourself.

**Why you might want this:** you already pay for a Claude plan and would rather spend that than top up API credit. Set it as your active provider, or assign it to individual phases in **Hybrid Routing**.

**⚠️ Watch your usage window.** Subscriptions meter headless use in rolling ~5-hour windows. The pipeline is token-heavy — **in testing, one full session used up to ~60% of the allowance in a 5-hour window**, so budget for roughly one or two sessions per window. A good pattern is to let Claude Code do the grounding + chronicle, then [**Reforge**](docs/reforge.md) the extras and condensed recap on Gemini to spare your Claude allowance.

**What it unlocks:**
- **Claude Code** panel in Settings — detects whether the CLI is installed and logged in
- **Claude Code (your subscription)** as a selectable provider, per-phase routable like any other

**Cost:** no download. Requires Claude Code installed + `claude login` with a Pro/Max plan. Generation counts against that subscription's usage limits, not a dollar-per-token meter.

**Deep dive:** [docs/add-ons/claude-code.md](docs/add-ons/claude-code.md)

---

### 🧠 Codex (your ChatGPT subscription)

**Bring your own ChatGPT subscription.** The same idea as the Claude Code add-on, for an OpenAI plan: route phases through the [Codex](https://github.com/openai/codex) CLI you've installed and logged into, billed against *your* Plus / Pro plan with **no API key required**.

The two subscription add-ons are completely independent — install either, both, or neither. Neither one's presence changes the other's behaviour, and if you have both, Hybrid Routing lets you pick which CLI carries the free phases.

**⚠️ Watch your usage window.** As with Claude Code, ChatGPT plans meter headless use in rolling windows. If a run exhausts the window mid-session it **pauses itself and saves a checkpoint** — resume from the banner once the window resets and it continues at the exact chunk it stopped on.

**What it unlocks:**
- **Codex** as a selectable provider, per-phase routable like any other
- The **Free** routing preset — every phase on a subscription CLI, no API keys at all

**Cost:** no download. Requires Codex installed (`npm i -g @openai/codex`) + `codex login`. Make sure `OPENAI_API_KEY` is **not** set in your environment — the add-on strips it from the CLI's environment so you can't be silently switched onto per-token billing.

**Deep dive:** [docs/add-ons/codex.md](docs/add-ons/codex.md)

---

### 🗂️ Obsidian Vault lore

**Ground chronicles against an Obsidian vault** instead of the Tusks-Lore folder. Point it at a vault and the app reads your notes' frontmatter aliases and bodies to build the grounding index — so the names, places and factions in your chronicle match the canon you already maintain.

**Strictly read-only.** The app never writes into your vault; the single exception is the explicit "Build graphify map" button, which you press yourself.

**What it unlocks:**
- **Obsidian Vault Lore** panel — vault path, readiness checks, entity-index status
- Alias-aware grounding from your existing frontmatter, with no duplication of lore into a second folder

**Cost:** free. Requires an Obsidian vault on the same machine.

**Deep dive:** [docs/add-ons/obsidian-vault.md](docs/add-ons/obsidian-vault.md)

---

## 🔮 Future add-ons

The registry is open. Candidates already on the [roadmap](ROADMAP.md):

- **Whisper diarisation** for single-track audio — recover speaker labels when you don't have per-speaker source files (e.g. a podcast VOD, a Zoom recording).
- **SRT / VTT parsers** — sister formats to `.sbv` with the same caption-repair pipeline.
- **In-PDF image OCR** — handle scanned session notes and handwritten lore documents.

Vote on the order via the [feedback form](https://docs.google.com/forms/d/e/1FAIpQLSdxdqOhb1SQvI3fs50gMJv_Cesh2MuxUm95QO2iZia5sFhyyQ/viewform?usp=header), or [open a GitHub issue](https://github.com/KochiTusker/Tusks-Tomes/issues/new/choose). A community Discord with a `#feature-ideas` channel is on the [roadmap](ROADMAP.md) and will replace the form once it launches.

---

## 📚 Related reading

- [README](README.md) — what Tusk's Tomes is
- [SETUP](SETUP.md) — getting the core install running
- [docs/walkthrough.md](docs/walkthrough.md) — your first session, end to end
- [architecture.md §15](architecture.md#15-add-on-system) — registry + loader implementation
- [docs/comparison.md](docs/comparison.md) — how Tomes (with and without add-ons) compares to Otter / Descript / NotebookLM / hiring a transcriber
