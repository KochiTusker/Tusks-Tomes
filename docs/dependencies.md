# 📦 What you need installed

Read this before you clone anything. It's the page I wish I'd written first —
three tiers, so you can see at a glance what's genuinely required versus what
just makes things better.

**The short version:** you need **Node.js** and **one way to talk to an AI
model**. Everything else on this page is optional, and you can add any of it
later without reinstalling.

| Tier | Meaning |
|---|---|
| 🔴 **Critical** | Nothing works without these. |
| 🟠 **Advised** | Not required, but the output is meaningfully better with them. |
| 🟢 **Nice to have** | Quality-of-life. Skip freely. |

---

<details class="docs-section" open>
<summary><h2>🔴 Critical — nothing runs without these</h2></summary>
<div class="docs-section-body">


| What | Version | Why | Check it with |
|---|---|---|---|
| **[Node.js](https://nodejs.org/)** | 20 or newer (LTS) | The app is a Node program. This is the one hard prerequisite. | `node -v` |
| **npm** | comes with Node | Installs the libraries. You don't install this separately. | `npm -v` |
| **[Git](https://git-scm.com/downloads)** | any recent | How you download the project, and how the in-app updater fetches new versions. Without it you'd be re-downloading a ZIP by hand every release. | `git --version` |
| **A way to reach an AI model** | — | Pick **one** of the three options below. The pipeline has nothing to run on otherwise. | — |

### The model — pick one of these three

You need exactly one. They're interchangeable and you can switch later.

| Option | Cost | Best for |
|---|---|---|
| **A paid API key** — [Gemini](https://aistudio.google.com/apikey), [Claude](https://console.anthropic.com) or [OpenAI](https://platform.openai.com/api-keys) | ~£1–£2 per session | Most people. Gemini is the best value for this particular workload. |
| **A subscription you already pay for** — Claude Code or the Codex CLI | £0 extra | Anyone already paying for Claude or ChatGPT. See [Claude Code](add-ons/claude-code.md) / [Codex](add-ons/codex.md). |
| **A local model** — Ollama, LM Studio or Unsloth | £0 | Total privacy, no network. Read the [quality caveats](add-ons/local-llm.md) first — below ~15–20B the prose gets noticeably worse. |

**You do NOT need Visual Studio Build Tools**, whatever older guides say.
Nothing in the dependency tree compiles native code.


</div>
</details>

<details class="docs-section">
<summary><h2>🟠 Advised — for a noticeably better result</h2></summary>
<div class="docs-section-body">


None of this is needed to get a chronicle. All of it improves what you get.

| What | Why you'd want it | Without it |
|---|---|---|
| **[Python 3.10–3.12](https://python.org)** | Runs Whisper, which transcribes your recordings locally. On Windows, tick **"Add python.exe to PATH"** during install. | You supply a transcript another way — pasted text or [YouTube captions](workflows.md). |
| **An NVIDIA GPU specifically** | Transcribing a 3-hour session drops from *several hours* to 20–30 minutes. Detected automatically via `nvidia-smi`. Read the note below before assuming your card counts. | Whisper still works, on your processor, slowly. Or use the YouTube route. |
| **[Discord](https://discord.com) + [Craig](https://craig.chat)** | Craig is a Discord bot that records **one audio track per person**, which is what makes speaker attribution reliable end to end. Craig's free tier is enough. | Single-stream audio, so the AI has to guess who said what — and it will ask you a lot of questions. |

> ### ⚠️ On GPUs — it really is NVIDIA or nothing, and that's worth spelling out
>
> "I've got a dedicated graphics card, I'll be fine" is a completely reasonable
> assumption and an expensive one to get wrong, so here are the actual facts.
>
> Transcription uses [`faster-whisper`](https://github.com/SYSTRAN/faster-whisper),
> which is built on CTranslate2. That library implements exactly **two** compute
> devices: `cuda` and `cpu`. There is no ROCm backend, no Metal backend, no
> Intel Arc backend, no DirectML backend.
>
> So an **AMD Radeon, an Intel Arc, or the GPU in an Apple Silicon Mac is not
> used at all.** This isn't "slower but works" — the card sits idle and
> everything runs on your processor. A £900 AMD card gets you exactly the same
> transcription speed as no graphics card whatsoever.
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
> Which leaves you three practical options:
>
> 1. **[The YouTube route](workflows.md)** — Google's hardware does the
>    transcribing, no GPU of any kind needed. This is what I'd suggest.
> 2. **CPU transcription.** Slow, but it works if you set it going and walk
>    away.
> 3. **Transcribe elsewhere and paste it in** — [Workflow A](workflows.md)
>    accepts a transcript from any source, so a self-compiled whisper.cpp or
>    Const-me output drops straight in.
>
> Apple Silicon is at least the best case for the CPU path — those cores are
> quick enough that CPU-only transcription hurts far less than it does on an
> older x86 laptop.

> **Python 3.13+ is untested, not broken.** The restriction originally existed
> because PyTorch shipped no 3.13 builds at all. Upstream has since released
> them and this project's requirements permit them — but nobody has verified
> the whole stack on 3.13 here, so setup warns rather than blocks. Try it if
> you like, and please report what happens. If it fails, install 3.12 alongside
> and the Whisper setup picks it up automatically.

Everything Python-related lives inside `vendor/python-venv/`, a self-contained
environment. Removing the add-on deletes that folder; your system Python is
never touched.


</div>
</details>

<details class="docs-section">
<summary><h2>🟢 Nice to have — quality of life</h2></summary>
<div class="docs-section-body">


Genuinely optional. Add them if they appeal.

| What | What it gets you |
|---|---|
| **[Obsidian](https://obsidian.md/download)** | Somewhere pleasant to keep campaign lore. The [vault add-on](add-ons/obsidian-vault.md) reads your notes to get names right — though **any folder of markdown works**, so this is about your comfort, not a requirement. |
| **[Claude Code](https://docs.claude.com/en/docs/claude-code) or the Codex CLI** | If you already pay for Claude or ChatGPT, routes the mechanical phases through that allowance instead of API credit. Roughly 85% cheaper than the baseline. |
| **[Ollama](https://ollama.com) / [LM Studio](https://lmstudio.ai)** | Run some or all phases offline. Good for the cheap mechanical phases even if you keep the chronicle itself on a cloud model. |
| **A second, free-tier Gemini key** | Used only for one small phase under the Smart Budget preset. Shaves a little off the bill. |
| **Windows Terminal** | The launcher opens in a tidy tab instead of a bare console window if it's installed. Purely cosmetic. |
| **[Tusk's Vault](https://github.com/KochiTusker/Tusks-Vault)** | The sibling project — ask questions of your finished chronicles in Discord. See [vault.md](vault.md). |


</div>
</details>

<details class="docs-section">
<summary><h2>Bundled — you don't install these</h2></summary>
<div class="docs-section-body">


| What | Note |
|---|---|
| **ffmpeg** | Comes with the `ffmpeg-static` package. No separate install on any normal setup. |
| **PDF and DOCX readers** | Pure JavaScript, installed with everything else. |
| **The Whisper model** | Downloaded by the audio add-on when you install it, into `vendor/python-venv/`. |


</div>
</details>

<details class="docs-section">
<summary><h2>What gets created on your disk</h2></summary>
<div class="docs-section-body">


None of this is in the repo — it's all made at runtime.

| Path | What | Created by |
|---|---|---|
| `node_modules/` | The JavaScript libraries (~360 MB) | `npm install` |
| `.env` | Per-machine settings | `setup.bat` / `setup.sh` |
| `vendor/python-venv/` | Whisper (1.5–2.5 GB) | The audio add-on, if you install it |
| `Sessions/<campaign>/*.md` | Your finished chronicles | The app, when you save one |
| `%APPDATA%\tusks-tomes` | Settings, glossary, encrypted API key | Saving anything in Settings |
| `%LOCALAPPDATA%\tusks-tomes` | Recordings, transcripts, run checkpoints | Uploading audio or pausing a run |

A fresh clone contains **no personal state at all** — source, scripts and
templates only. For the full account of what's written where and what could go
wrong, see [How safe is this?](is-this-safe.md).


</div>
</details>

---

Ready? [The setup guide](setup.md) walks through it, or the
[beginner's guide](beginner-guide.md) assumes no terminal experience at all.
