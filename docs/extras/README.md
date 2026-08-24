# Extras & integrations

The core app does one thing: you give it a transcript, it gives you a chronicle.
Everything heavier — transcribing audio, running local models, changing the
narrator's voice, reading your Obsidian vault — is optional, and you only deal
with it if you actually want it.

This wasn't an architectural preference so much as a reaction to being on the
other end of it. I've installed plenty of tools that dragged in a couple of
gigabytes of machine-learning dependencies I never used, for a feature I didn't
want, on a first run. If you only ever paste transcripts, you should never need
Python, never sit through a large download, and never see a GPU detection
script. So you don't.

Nothing here is a paid tier or a feature gate. It's all MIT-licensed and it's
all in the repo already.

---

## One question decides how a module behaves

The question is: **does turning this on put bytes on your disk that weren't
there before?**

| | What it means | How you turn it on |
|---|---|---|
| **Installs** | A real installation with real prerequisites. Today there is exactly one: Audio Transcription, which downloads a Python environment. | **Settings → Transcription**, then Install. The log streams live; you restart the server once when it finishes. |
| **Built in** | Ships with the app and is always mounted. Nothing to download, nothing to restart. | Nothing to turn on. Whether it's *usable* — a CLI on your PATH, a runner that's actually running, a vault path you've set — is something each module detects and tells you. |

So for six of the seven modules below, there is no install step and no restart.
You point them at something (a CLI, a local runner, a vault folder), and the
app checks whether it's there.

> [!NOTE]
> A built-in module has no uninstall path, so turning one off cannot remove
> anything you have authored. Personas you write yourself are safe by
> construction rather than by care.

The architectural details (registry, the `builtin` / `install` union, route
mounting) live in [architecture.md](../about/how-its-built.md).

---

## The modules

### Audio Transcription — the only one that installs

**The premium path.** Lets you drop a [Craig](https://craig.chat) Discord recording zip directly into Tomes; the Whisper sidecar transcribes it offline; the resulting transcript carries per-speaker attribution end-to-end into the chronicle.

**Why it beats the YouTube `.sbv` workflow:** YouTube's auto-captions are single-track. They give you all the words, but they have no idea which player or character said what. Craig records every speaker as a separate FLAC stream, so when the chronicle finishes, every line in the prose is attributed to the right character. No more "wait, did the rogue or the bard say that?" arguments.

**What it unlocks:**
- **Sessions** tab — appears once the module is installed. Uploading is the first thing on it: Craig multitrack zip ingest, loose-file audio drop, staged-batch uploads. Your transcribed sessions list below, with replay / export / delete.
- **Whisper sidecar** — offline transcription via `faster-whisper` large-v3 (CUDA auto-detected; CPU fallback works)
- **Speaker mapping editor** — pre-populated from filenames, editable before transcription kicks off

**Cost:** a Python virtual environment of roughly 1.5 GB, plus model weights. Python 3.10–3.12 required on your PATH. An **NVIDIA** GPU cuts a 3-hour session from hours on CPU to minutes.

> [!WARNING]
> **On AMD or Intel?** This engine won't use your card — `faster-whisper` only
> has CUDA and CPU backends. See the **whisper.cpp bridge** below, or the
> [YouTube route](../importing/README.md), which needs no GPU at all.

**Deep dive:** [docs/add-ons/audio-transcription.md](audio-transcription.md)

---

### whisper.cpp bridge (bring your own build)

**The route for AMD, Intel and Apple GPUs.** The Audio Transcription module above only accelerates on NVIDIA, because `faster-whisper` has just two backends: CUDA and CPU. This one bridges to a [whisper.cpp](https://github.com/ggml-org/whisper.cpp) build that you compile, which can use whatever card you have.

**Why you have to build it yourself:** I went looking for a ready-made binary that would use non-NVIDIA GPUs and there isn't a good one. whisper.cpp's own releases ship CPU, BLAS (still CPU) and CUDA — its Vulkan backend exists in source but is in no release asset. sherpa-onnx ships CPU and CUDA only. Const-me/Whisper does genuinely use any DirectX 11 GPU, but hasn't had a release since July 2023. Rather than compile and sign binaries I can't test on hardware I don't own, this takes the same shape as the Claude Code and Codex modules: you own the tool, I own the integration.

**What it does:**
- **Detects and checks your build** — including reading its capability line, so it can tell you "this is a CPU-only build and won't use your graphics card" instead of leaving you to wonder why it's slow
- **Transcribes through it**, producing exactly the same output as the built-in engine — the Sessions tab and speaker mapping all work unchanged
- **Falls back automatically** to the built-in engine if anything stops checking out, rather than failing your run

**Cost:** nothing on disk from us — nothing is downloaded and nothing is written. Your whisper.cpp build and model are yours and are never touched. You supply a build (a compile) and a GGML model (~3 GB for large-v3).

**Deep dive:** [docs/add-ons/whisper-cpp.md](whisper-cpp.md) — build instructions for Windows, Linux and macOS.

---

### Local LLMs

**The fully-offline path.** Routes any phase of the pipeline (or the whole thing) through a local model running on your hardware. The chronicle never touches a cloud API.

**Why you might want this:** privacy (sensitive transcripts stay on the host), cost (zero per session), or just preference (you already run Ollama and want to use it). Per-phase routing lets you mix and match — e.g. a cheap cloud model for grounding, your local 27B for the long-form chronicle phase.

**What it unlocks:**
- **Local runner detection** in **Settings → Providers & models** — detect and probe Ollama / LM Studio / Unsloth on their default ports. Start a runner and its models appear in the routing rows.
- **Per-phase routing** — assign each pipeline phase to a specific local model independently
- **Capability probe** — a 2-test mini-probe (structured JSON adherence + grounding fidelity) flags which phases each local model is qualified for, so the routing rows show which ones it can carry
- **Hardware advisories** — VRAM / RAM checks for the model you've picked, so a 32B model on 8 GB doesn't silently OOM

**Cost:** nothing from Tomes — it is a same-origin proxy and a detector. You install [Ollama](https://ollama.com), [LM Studio](https://lmstudio.ai), or Unsloth separately; those are the heavy downloads.

> [!WARNING]
> Local models under roughly 15B parameters produce noticeably weaker prose
> than the cloud flagships. Mixing per phase — local for the mechanical
> phases, cloud for the prose — is the sweet spot rather than going fully
> local on modest hardware.

**Deep dive:** [docs/add-ons/local-llm.md](local-llms.md)

---

### Chronicle Personas

**Swap the narrator's voice.** The default chronicle voice is a polished bardic tone — appropriate for most groups. Personas lets you replace it with one of six character presets, or write your own.

**The six presets:** Arnold Schwarzenegger, Homer Simpson, Peter Griffin, Gandalf, Mike Tyson, Donkey (from Shrek). All affect phases 3 (Chronicle), 5 (Polish, local-only), and 6 (Condense) — the prose-generation phases. Phases 1 (Ground), 2 (Audit), and 4 (Extras) are voice-neutral and untouched.

**Authoring your own:**
- Clone a preset and tweak
- Start from the locked bard template
- Write from scratch
- Describe a narrator in one sentence and let your active LLM draft all the prompts for review

**Cost:** none. Nothing is downloaded and there are no dependencies. The six presets are seeded the first time the personas list is read, so `personas.json` never has to exist — and nothing deletes it.

Found under **Settings → Voice & content**.

**Deep dive:** [docs/add-ons/personas.md](personas.md)

---

### Claude Code (your subscription)

**Bring your own Claude subscription.** Instead of a per-token API key, route the pipeline through the [Claude Code](https://docs.claude.com/en/docs/claude-code) CLI you've already installed and logged into — generation is billed against *your* Pro / Max plan, with **no API key required**. The app never handles your login; it only invokes the `claude` binary you authenticated yourself.

**Why you might want this:** you already pay for a Claude plan and would rather spend that than top up API credit. Assign it to individual phases in per-phase routing, or to all of them.

> [!CAUTION]
> **Watch your usage window.** Subscriptions meter headless use in rolling
> ~5-hour windows, and the pipeline is token-heavy — in testing, one full
> session used up to **~60% of the allowance in a single 5-hour window**. Budget
> for roughly one or two sessions per window. A good pattern is to let Claude
> Code do the grounding and chronicle, then [Reforge](../chronicling/reforging.md) the
> extras and condensed recap on a cheaper model to spare your allowance.

**What it unlocks:**
- A **Claude Code** connection row in **Settings → Providers & models** — detects whether the CLI is installed and logged in
- **Claude Code (your subscription)** as a routing target, per-phase like any other

**Cost:** nothing to download from us. Requires Claude Code installed and `claude login` with a Pro/Max plan. Generation counts against that subscription's usage limits, not a per-token meter.

**Deep dive:** [docs/add-ons/claude-code.md](claude-code.md)

---

### Codex (your ChatGPT subscription)

**Bring your own ChatGPT subscription.** The same idea as Claude Code, for an OpenAI plan: route phases through the [Codex](https://github.com/openai/codex) CLI you've installed and logged into, billed against *your* Plus / Pro plan with **no API key required**.

The two subscription modules are completely independent — use either, both, or neither. Neither one's presence changes the other's behaviour, and if you have both, per-phase routing lets you pick which CLI carries which phases.

> [!WARNING]
> **Watch your usage window.** As with Claude Code, ChatGPT plans meter
> headless use in rolling windows. If a run exhausts the window mid-session it
> **pauses itself and saves a checkpoint** — resume from the banner once the
> window resets and it continues at the exact chunk it stopped on.

**What it unlocks:**
- **Codex** as a routing target, per-phase like any other
- The **"everywhere" subscription rung** in guided routing — every phase on a subscription CLI, no API keys at all

**Cost:** nothing to download from us. Requires Codex installed (`npm i -g @openai/codex`) and `codex login`.

> [!CAUTION]
> Make sure `OPENAI_API_KEY` is **not** set in your environment. The module
> strips it from the CLI's environment specifically so you can't be silently
> switched onto per-token billing without noticing.

**Deep dive:** [docs/add-ons/codex.md](codex.md)

---

### Obsidian Vault lore

**Ground chronicles against an Obsidian vault** instead of the Tusks-Lore folder. Point it at a vault and the app reads your notes' frontmatter aliases and bodies to build the grounding index — so the names, places and factions in your chronicle match the canon you already maintain.

**Strictly read-only.** The app never writes into your vault; the single exception is the explicit "Build graphify map" button, which you press yourself. The derived entity index is cached outside the vault.

**What it unlocks:**
- An **Obsidian Vault Lore** panel under **Settings** — vault path, readiness checks, entity-index status
- Alias-aware grounding from your existing frontmatter, with no duplication of lore into a second folder

**Cost:** free. Requires an Obsidian vault on the same machine. Stays inert until you choose it as your lore source under **Tome of Lore → Lore source**.

**Deep dive:** [docs/add-ons/obsidian-vault.md](obsidian-vault.md)

---

## Future modules

The registry is open. Candidates already on the [roadmap](../about/roadmap.md):

- **Whisper diarisation** for single-track audio — recover speaker labels when you don't have per-speaker source files (e.g. a podcast VOD, a Zoom recording).
- **SRT / VTT parsers** — sister formats to `.sbv` with the same caption-repair pipeline.
- **In-PDF image OCR** — handle scanned session notes and handwritten lore documents.

Vote on the order via the [feedback form](https://docs.google.com/forms/d/e/1FAIpQLSdxdqOhb1SQvI3fs50gMJv_Cesh2MuxUm95QO2iZia5sFhyyQ/viewform?usp=header), or [open a GitHub issue](https://github.com/KochiTusker/Tusks-Tomes/issues/new/choose). A community Discord with a `#feature-ideas` channel is on the [roadmap](../about/roadmap.md) and will replace the form once it launches.

---

## Related reading

- [README](../../README.md) — what Tusk's Tomes is
- [SETUP](../getting-started/installation.md) — getting the core install running
- [docs/walkthrough.md](../getting-started/quickstart.md) — your first session, end to end
- [architecture.md](../about/how-its-built.md) — registry + loader implementation
- [docs/comparison.md](../about/comparison.md) — how Tomes compares to Otter / Descript / NotebookLM / hiring a transcriber
