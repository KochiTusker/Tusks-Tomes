# Requirements

Read this before you clone anything. It's the page I wish I'd written first —
three tiers, so you can see at a glance what's genuinely required versus what
just makes things better.

**The short version:** you need **Node.js**, **Git** and **one way to talk to an AI
model**. Everything else on this page is optional, and you can add any of it
later without reinstalling.

| Tier | Meaning |
|---|---|
| **Critical** | Nothing works without these. |
| **Advised** | Not required, but the output is meaningfully better with them. |
| **Nice to have** | Quality-of-life. Skip freely. |

---

<details class="docs-section" open>
<summary><h2>Critical — nothing runs without these</h2></summary>
<div class="docs-section-body">


| What | Version | Why | Check it with |
|---|---|---|---|
| **[Node.js](https://nodejs.org/)** | 22 or newer (LTS) | The app is a Node program. Node 22 applies from version 2.7.0; earlier releases run on Node 20. Setup refuses an older Node; an existing install on an older Node still starts, but warns every time until you upgrade. | `node -v` |
| **npm** | comes with Node | Installs the libraries. You don't install this separately. | `npm -v` |
| **[Git](https://git-scm.com/downloads)** | any recent | How you download the project, and how the in-app updater fetches new versions. Setup checks for it and stops if it is missing, so a ZIP download needs Git installed too. Without a clone you'd be re-downloading a ZIP by hand every release. | `git --version` |
| **A way to reach an AI model** | — | Pick **one** of the three options below. The pipeline has nothing to run on otherwise. | — |

### The model — pick one of these three

You need exactly one. They're interchangeable and you can switch later.

| Option | Cost | Best for |
|---|---|---|
| **A paid API key** — [Gemini](https://aistudio.google.com/apikey) direct, or [OpenRouter](https://openrouter.ai/keys) for around 400 models on one key | [Roughly $1–$5 a session](../models/costs.md) | Most people. Gemini is the best value for this particular workload. |
| **A subscription you already pay for** — Claude Code or the Codex CLI | $0 extra | Anyone already paying for Claude or ChatGPT. See [Claude Code](../extras/claude-code.md) / [Codex](../extras/codex.md). |
| **A local model** — Ollama, LM Studio or Unsloth | $0 | For Ground, Audit and Extras only, with no network. The chronicle and Condense still need one of the options above. Read the [quality caveats](../extras/local-llms.md) first. |

**You do NOT need Visual Studio Build Tools**, whatever older guides say.
Nothing in the dependency tree compiles native code.


</div>
</details>

<details class="docs-section">
<summary><h2>Advised — for a noticeably better result</h2></summary>
<div class="docs-section-body">


None of this is needed to get a chronicle. All of it improves what you get.

| What | Why you'd want it | Without it |
|---|---|---|
| **[Python 3.10–3.12](https://python.org)** | Runs Whisper, which transcribes your recordings locally. On Windows, tick **"Add python.exe to PATH"** during install. | You supply a transcript another way — pasted text or [YouTube captions](../importing/README.md). |
| **An NVIDIA GPU specifically** | Transcribing a 3-hour session with five or six speaker tracks takes roughly half an hour on a mid-range card — about 10 minutes per hour of session — rather than *several hours* on the processor. Detected automatically via `nvidia-smi`. Read the note below before assuming your card counts. | Whisper still works, on your processor, slowly. Or use the YouTube route. |
| **[Discord](https://discord.com) + [Craig](https://craig.chat)** | Craig is a Discord bot that records **one audio track per person**, which is what makes speaker attribution reliable end to end. Craig's free tier is enough. | Single-stream audio, so the AI has to guess who said what — and it will ask you a lot of questions. |

> ### On GPUs — it really is NVIDIA or nothing, and that's worth spelling out
>
> "I've got a dedicated graphics card, I'll be fine" is a completely reasonable
> assumption and an expensive one to get wrong, so here are the actual facts.
>
> Transcription uses [`faster-whisper`](https://github.com/SYSTRAN/faster-whisper),
> which is built on CTranslate2. That library implements exactly **two** compute
> devices: `cuda` and `cpu`.
>
> ![A flowchart for each track Whisper transcribes. First question: is whisper.cpp set up? If yes, your own whisper.cpp build transcribes, and it uses the GPU only if you built it with Vulkan, CUDA or Metal. If no, the built-in engine, faster-whisper, tries the GPU. If an NVIDIA GPU works, it runs on the GPU. If not, it is tried twice and then runs on the CPU until you restart Tomes.](../assets/diagrams/which-engine-transcribes.svg)
>
> So with the built-in engine, an **AMD Radeon, an Intel Arc, or the GPU in an Apple Silicon Mac is not
> used at all**: the card sits idle and everything runs on your processor, at the
> same speed as a machine with no graphics card.
>
> That isn't a preference for NVIDIA on my part; it's the only GPU backend the
> engine has. And before you go looking for a Whisper build that *does* use
> your card — I did, and here's what's actually out there:
>
> | Project | Prebuilt GPU backends | Verdict |
> |---|---|---|
> | [whisper.cpp](https://github.com/ggml-org/whisper.cpp) | CPU, BLAS *(still CPU)*, CUDA | Has a Vulkan backend **in source only** — it isn't in any release build. Compiling it yourself works. |
> | [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) | CPU, CUDA | No DirectML build shipped. |
> | [Const-me/Whisper](https://github.com/Const-me/Whisper) | DirectCompute — **any DirectX 11 GPU** | Actually works on AMD and Intel. Windows-only, no release since July 2023. |
>
> So the honest summary: **there is no maintained, ready-made Whisper build
> that will use an AMD or Intel GPU.** Const-me/Whisper does, and has been
> unmaintained for years. Everything else prebuilt is CPU or CUDA.
>
> Which leaves you four practical options:
>
> 1. **[The YouTube route](../importing/README.md)** — Google's hardware does the
>    transcribing, no GPU of any kind needed. This is what I'd suggest.
> 2. **CPU transcription.** Slow, but it works if you set it going and walk
>    away.
> 3. **Transcribe elsewhere and paste it in** — [Route A](../importing/README.md)
>    accepts a transcript from any source, so a self-compiled whisper.cpp or
>    Const-me output drops straight in.
> 4. **The [whisper.cpp bridge](../extras/whisper-cpp.md).** Compile whisper.cpp
>    with Vulkan (or Metal on a Mac) yourself, point Tomes at the build and a
>    model file, and transcription runs through it on your card.
>
> Apple Silicon is at least the best case for the CPU path — those cores are
> quick enough that CPU-only transcription hurts far less than it does on an
> older x86 laptop.

> **Python 3.13+ is untested.** PyTorch's 3.13 builds start at 2.6, which this
> project's requirements permit, but nobody has verified the whole stack on
> 3.13 here. `npm run setup` warns about it. The in-app Install check accepts
> only 3.10–3.12 and stops before the download starts; `npm run whisper:setup`
> run by hand does not check the version, so you can try 3.13 that way and
> report what happens. To use 3.12 instead, install it, make sure `python`
> (Windows) or `python3` (macOS and Linux) on your PATH runs it, and delete
> `vendor/python-venv/` if it was built with another version.

Everything Python-related lives inside `vendor/python-venv/`, a self-contained
environment. Uninstalling deletes that folder; your system Python is
never touched.


</div>
</details>

<details class="docs-section">
<summary><h2>Nice to have — quality of life</h2></summary>
<div class="docs-section-body">


Genuinely optional. Add them if they appeal.

| What | What it gets you |
|---|---|
| **[Obsidian](https://obsidian.md/download)** | Somewhere pleasant to keep campaign lore. The [vault module](../extras/obsidian-vault.md) reads your notes to get names right — though **any folder of markdown works**, so this is about your comfort, not a requirement. |
| **[Claude Code](https://docs.claude.com/en/docs/claude-code) or the Codex CLI** | If you already pay for Claude or ChatGPT, routes the mechanical phases through that allowance instead of API credit. Roughly 85% cheaper than the baseline. |
| **[Ollama](https://ollama.com) / [LM Studio](https://lmstudio.ai)** | Run Ground, Audit and Extras on your own hardware. The chronicle itself stays on a cloud model or a subscription CLI. |
| **A second, free-tier Gemini key** | A spare for quota trouble: when the paid key reports no quota, a run on the automatic setting switches to the free key for the rest of that run. Free-tier limits are far lower, so it keeps a run going rather than making it cheaper. |
| **Windows Terminal** | The launcher opens in a tidy tab instead of a bare console window if it's installed. Purely cosmetic. |
| **[Tusk's Vault](https://github.com/KochiTusker/Tusks-Vault)** | The sibling project — ask questions of your finished chronicles in Discord. See [vault.md](../extras/tusks-vault.md). |


</div>
</details>

<details class="docs-section">
<summary><h2>Bundled — you don't install these</h2></summary>
<div class="docs-section-body">


| What | Note |
|---|---|
| **ffmpeg** | Comes with the `ffmpeg-static` package. No separate install on any normal setup. |
| **PDF and DOCX readers** | Pure JavaScript, installed with everything else. |
| **The Whisper model** | Downloaded by `faster-whisper` the first time you transcribe (about 3 GB for `large-v3`), into the Hugging Face cache in your user profile, not when you install the add-on. |


</div>
</details>

<details class="docs-section">
<summary><h2>What gets created on your disk</h2></summary>
<div class="docs-section-body">


None of this is in the repo — it's all made at runtime.

![Three places Tusk's Tomes keeps files. The program folder holds the program code and is replaced by an update, but your Sessions folder and .env file inside it are left alone. Your profile, outside the program folder, holds settings, keys, recordings and saved chronicles, and survives an update. Next to the program folder, Tusks-Lore holds lore notes and .docx exports, and also survives an update.](../assets/diagrams/where-files-live.svg)

| Path | What | Created by |
|---|---|---|
| `node_modules/` | The JavaScript libraries (several hundred MB) | `npm install` |
| `.env` | Per-machine settings | `setup.bat` / `setup.sh` |
| `vendor/python-venv/` | Whisper (about 1.5–2.5 GB) | The audio add-on, if you install it |
| `Sessions/<campaign>/*.md` | Your finished chronicles | The app, when you save one |
| `%APPDATA%\tusks-tomes` | Settings, glossary, encrypted API key, paused-run checkpoints | Saving anything in Settings, or pausing a run |
| `%LOCALAPPDATA%\tusks-tomes` | Recordings, transcripts, saved-chronicle library | Uploading audio, or finishing a run |
| `%USERPROFILE%\.cache\huggingface\hub` | Whisper model weights (about 3 GB) | The first transcription |

A fresh clone contains **no personal state at all** — source, scripts and
templates only. For the full account of what's written where and what could go
wrong, see [How safe is this?](../security/what-it-installs.md).


</div>
</details>

---

Ready? [The setup guide](installation.md) walks through it, or the
[beginner's guide](without-a-terminal.md) assumes no terminal experience at all.
