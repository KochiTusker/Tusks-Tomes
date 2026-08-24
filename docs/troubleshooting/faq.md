# Questions I get asked

Most of these came up either from someone trying it or from me staring at
something at midnight wondering why it wasn't working. If your question isn't
here, the [feedback form](https://docs.google.com/forms/d/e/1FAIpQLSdxdqOhb1SQvI3fs50gMJv_Cesh2MuxUm95QO2iZia5sFhyyQ/viewform?usp=header)
comes straight to me and "this bit of the docs made no sense" is a perfectly
good message to send.

## What running one session actually looks like

Start to finish, so you know what's normal and what isn't. If you want the
click-by-click version, that's [walkthrough.md](../getting-started/quickstart.md) — this is the
"what's happening, how long will it take, should I be worried yet" companion.
Skip past it for the individual questions.

**1. First launch.** Start the app and open `http://127.0.0.1:5173/` in your browser. You'll see the **Chronicle** tab selected, with a top banner reading *"No cloud API key configured. Add one in Settings to start running the pipeline."* That's expected on a fresh install. The Begin button is disabled until you've added a key and pasted a transcript.

**2. Add a provider key (one-time).** Go to **Settings** → **API Keys**. Pick a provider (Google Gemini Paid is the easiest start; see [pricing.md](../models/costs.md) for what to expect), paste your key, click **Test connection**. A green OK badge means the key works; an error message tells you what to fix. Your key is encrypted on disk at `%APPDATA%\tusks-tomes\Config\providers.enc` and is *machine-bound* — copying that file to another computer won't decrypt. Recommended starter combo: **Google Gemini — Paid** for everything (see [recommended-settings.md](../chronicling/recommended-settings.md)).

**3. Get a transcript into the app.** Three workflows, pick whichever fits your group:
- *Paste text.* Copy any session transcript and paste it into the **Raw transcript** box.
- *Load a YouTube `.sbv` file.* Click **Load .txt / .sbv** and pick the auto-caption file you downloaded from YouTube Studio. Tomes parses the timestamps and detaches them.
- *Upload audio.* (Requires the Audio Transcription add-on installed via Settings.) Go to the **Upload** tab, drag in your `.mp3`/`.wav`/Craig zip. Whisper transcribes locally on CPU or GPU, then a "Send to Chronicle" button appears on the **Sessions** tab.

For best results, drop your campaign's lore PDFs and the canonical glossary into the **Tome of Lore** tab first — phase-1 grounding uses both.

**4. Set campaign + session number, click Begin.** Type a campaign name (e.g. "Curse of Strahd") and a session number into the header. Click **Begin the Chronicle**. The disabled-state vanishes when both the transcript and a configured key are in place. The cost estimator shows a rough total before you commit.

**5. Phase 1 — Grounding (~2-10 min).** Tomes splits the transcript into chunks and asks the LLM to correct Whisper's phonetic errors. Names like "Cassiel" no longer come back as "Castiel"; "Underdark Crusade" no longer comes back as "Underdog Crusade". Live progress shows *chunk N of M* and the cost-meter ticks up. This phase costs the most because it processes the full transcript at flagship-model quality.

**6. Phase 2 — Audit (~30s).** The pipeline compares the raw vs grounded transcripts and produces a JSON list of DM questions — short, specific clarifications you might want to answer offline ("Did the cleric cast Bless on round 2 or 3?"). These appear in a card you can copy to a notes app. The chronicle doesn't wait for your answers; this is reference output for you.

**7. Phase 3 — Chronicle (~5-15 min).** The main story prose lands here. This phase is intentionally **exhaustive** — it's the canonical long-form record. Expect roughly the same level of detail as the source transcript, not a summary. NPC dialogue is quoted; DM out-of-character speech is re-narrated as scene description (not quoted as dialogue). You'll see the prose stream in chunk by chunk.

**8. Phase 4 — Extras (~1-3 min).** Memorable quotes (with speaker attribution), comedic moments ("jests"), and combat highlights ("gore"). All extracted as structured lists and rendered as cards. Cheap phase, fast.

**9. Phase 5 — Polish (cloud: skipped).** A final pass that runs only when the active provider is a local model. Cloud providers (Gemini/Claude/OpenAI) skip this phase by design — the cloud chronicle is already at flagship quality. If you see "Phase 5 skipped" in the run log, that's intentional.

**10. Phase 6 — Condense (~1-2 min).** A tight recap, length set by the **Condense Slider** on the Output Picker (0-100% in 5% steps, default 20% — about 2,800 words on a typical 14,000-word session). The slider previews the projected word count as you drag; Phase 6 then instructs the model to aim within ±10% of that target. This is the version to share in your Discord recap channel; the full chronicle is the version to keep in your campaign vault. Both are produced; the chronicle is **not** shortened to make this — it's a separate output.

**11. Review + export.** The full chronicle, the condensed recap, and the extras render side-by-side on screen. Click **Export → .docx** for a Word document or **Export → .md** for a Markdown file. The exported file lives in your platform-standard Downloads folder by default. If you have a [Tusk's Vault](../extras/tusks-vault.md) pair configured, the chronicle also lands automatically in your campaign archive.

**12. Pause and resume.** If you need to walk away mid-pipeline — daily Gemini quota hit, want to free up your GPU, or just want a break — click **Halt** at any time. A checkpoint is written to disk under `%APPDATA%\tusks-tomes\Config\runs\`. Closing and reopening the app shows a **Resume** banner above the Chronicle card; clicking it picks up at the exact chunk you stopped on. The fingerprint check ensures you didn't change the input — edit the glossary or the transcript mid-pause and the resume option becomes "Start over" so you don't get a half-grounded mess.

**What to do if something hangs.** The pipeline self-paces between chunks based on the provider's rate-limit headers; long pauses between phase-progress events are normal. If you don't see any progress for more than 5 minutes, click **Halt** to safely save a checkpoint, then check the `.diagnose/latest.md` file (auto-written on hard errors) or the **Help → Diagnose** card for context. The Resume flow lets you pick up from there once the underlying issue is resolved.

---

<details class="docs-section">
<summary><h2>What is Tusk's Tomes, in one sentence?</h2></summary>
<div class="docs-section-body">


A free, open-source, local-first AI session chronicler for D&D and other tabletop RPGs: it transcribes your session recording offline with Whisper (optional add-on), then runs a 6-phase LLM pipeline to produce a polished narrative recap grounded in your campaign's own glossary and lore.


</div>
</details>

<details class="docs-section">
<summary><h2>Is Tusk's Tomes free?</h2></summary>
<div class="docs-section-body">


Yes. The software itself is MIT-licensed and free forever — no subscription, no account, no telemetry, no paywall. The only money you might spend is on a cloud LLM API key — Gemini and OpenRouter are both pay-as-you-go, and Tomes is engineered to keep that bill small (prefix caching, per-tier chunk sizing, guided routing recipes). A three-hour session lands somewhere around $1–$5 depending on the routing you pick; [what it costs](../models/costs.md) has the current figure for each one, priced against the live catalogue. If you already pay for Claude or ChatGPT, the Claude Code and Codex CLIs spend that allowance instead of API credit. You can also run fully offline with [Ollama](https://ollama.com), [LM Studio](https://lmstudio.ai), or Unsloth — in which case it costs nothing to run. See [pricing.md](../models/costs.md).


</div>
</details>

<details class="docs-section">
<summary><h2>Can I use my Claude Pro/Max subscription instead of an API key?</h2></summary>
<div class="docs-section-body">


Yes — install the [Claude Code add-on](../extras/claude-code.md). It runs the pipeline through the `claude` CLI you've already logged into, billed against your plan with **no API key**. One caveat: subscriptions meter headless use in rolling ~5-hour windows, and the pipeline is token-heavy — **in testing, one full session used up to ~60% of the allowance in a 5-hour window**. Budget for roughly one or two sessions per window, and consider letting Claude Code do the grounding + chronicle while [Chronicle Reforge](../chronicling/reforging.md) handles the cheaper extras + recap on Gemini.


</div>
</details>

<details class="docs-section">
<summary><h2>The extras or recap came out weak — do I have to re-run everything?</h2></summary>
<div class="docs-section-body">


No. **[Chronicle Reforge](../chronicling/reforging.md)** (Tome of Lore → Saved Chronicles) re-runs just the later phases of a finished chronicle on a different model — keep the chronicle and redo the quotes / jests / gore and condensed recap on, say, Gemini, or regenerate the chronicle itself in a persona voice. It saves a new entry, so your original stays put. And if a provider *declined* specific chunks, those are flagged in the output and a one-click **Review & Repair Refusals** panel re-processes only those on another provider.


</div>
</details>

<details class="docs-section">
<summary><h2>Does my session audio get uploaded anywhere?</h2></summary>
<div class="docs-section-body">


**No.** Audio transcription happens locally, on your CPU or GPU, using [`faster-whisper`](https://github.com/SYSTRAN/faster-whisper) (via the [Audio Transcription add-on](../extras/audio-transcription.md)). The raw audio never touches the network. Only the resulting **text transcript** + prompt scaffolding is sent to the LLM provider you've configured — and only when you click Run. If you install the [Local LLMs add-on](../extras/local-llms.md) and route through Ollama / LM Studio / Unsloth, even the text stays on your machine. See [privacy.md](../security/overview.md) for the full trust model.


</div>
</details>

<details class="docs-section">
<summary><h2>Do I need a GPU?</h2></summary>
<div class="docs-section-body">


No, but it helps a lot — and it only matters if you're using the Audio Transcription add-on. Worth being precise, though: it has to be an **NVIDIA** card. Transcription runs on `faster-whisper`, whose backend (CTranslate2) implements only two devices, `cuda` and `cpu`. There's no ROCm, Metal or Intel Arc backend, so an **AMD, Intel or Apple GPU isn't used at all** — you get processor speed, same as a machine with no graphics card. That's the engine's limitation, not a preference. With an NVIDIA card, a 4-hour session drops from roughly 90 minutes on CPU to about 12. When installing it (Settings → Transcription), it auto-detects your GPU via `nvidia-smi` and installs the matching torch wheel; if no GPU is present, it falls back to CPU automatically.


</div>
</details>

<details class="docs-section">
<summary><h2>Which LLM provider should I use?</h2></summary>
<div class="docs-section-body">


Short answer: **Google Gemini (paid)** for the cheapest cloud option overall, **OpenRouter** if you want the widest choice from one key (around 400 models, including every Anthropic and OpenAI model at pass-through rates), a **subscription you already pay for** via the Claude Code or Codex CLI, or a **local model via Ollama** if you want to spend nothing and keep everything offline. You can mix and match per pipeline phase in **Settings → Providers & models**, where each phase gets one row. For most groups, a cheap model on the mechanical phases plus a strong one on the prose phase is the sweet spot. See [providers.md](../models/choosing-a-provider.md).


</div>
</details>

<details class="docs-section">
<summary><h2>Does Tusk's Tomes work with systems other than D&D?</h2></summary>
<div class="docs-section-body">


Yes. Pathfinder, Call of Cthulhu, Blades in the Dark, Vampire: the Masquerade, Daggerheart, Fabula Ultima, homebrew systems — anything you'd record as a Discord session or upload to YouTube. The chronicler doesn't know or care about the system; it grounds itself in *your* glossary and *your* lore PDFs, which is where system-specific terminology lives.


</div>
</details>

<details class="docs-section">
<summary><h2>How is this different from Otter.ai, NotebookLM, or the tabletop services?</h2></summary>
<div class="docs-section-body">


Two different answers, because they're two different categories.

**Otter, Descript and NotebookLM** have no concept of "this is a TTRPG session" — they'll mis-transcribe every fantasy proper noun and they upload your audio to their cloud. NotebookLM is closest in spirit, but it's a generic research tool: you'd upload a transcript by hand, prompt it by hand, and get generic prose rather than a chronicle.

**The services built for tabletop** — Tabletop Scribe, DnD Scrybe, Kazkar, SessionKeeper, Saga20 and others — are a fairer comparison, and several are good. They ground names against your lore too, so that isn't the difference. Three things are. Your audio never leaves your machine, because Whisper runs locally rather than on someone's server. Attribution is known rather than inferred, because Craig hands over one track per player instead of one mixed recording. And you choose the model, the narrator and the prompts, because it's MIT-licensed.

The cost of the middle one is real: they work from a browser and this doesn't. See [comparison.md](../about/comparison.md) for the full breakdown, including when to pick one of them instead.


</div>
</details>

<details class="docs-section">
<summary><h2>Do I need Craig?</h2></summary>
<div class="docs-section-body">


No — Craig is one workflow, not a requirement. The lowest-friction path is the **YouTube `.sbv` workflow** (works without any add-on): if you already upload sessions to YouTube (public, private, or unlisted), download the auto-caption file from YouTube Studio and drop it in. Craig gives you per-speaker attribution throughout the chronicle, which is great if you want it, but it's optional. See [workflows.md](../importing/README.md).


</div>
</details>

<details class="docs-section">
<summary><h2>What's an "add-on"?</h2></summary>
<div class="docs-section-body">


An optional capability the core app doesn't need. The core program does paste-a-transcript chronicling with cloud LLMs on its own.

There are seven, and the useful distinction between them is whether turning one on puts bytes on your disk. **Audio Transcription** does — it downloads a Python environment — so it has an Install button, a live log and a restart. The other six (whisper.cpp bridge, Local LLMs, Chronicle Personas, Claude Code, Codex, Obsidian Vault lore) ship with the app and are always available; whether one is *usable* is a detection question, not an installation question.

See [add-ons/README.md](../extras/README.md).


</div>
</details>

<details class="docs-section">
<summary><h2>Can I run Tusk's Tomes without GitHub or the terminal?</h2></summary>
<div class="docs-section-body">


Almost. You need to install Node.js (GUI installer from nodejs.org), and you need to either clone the repo or [download the ZIP](https://github.com/KochiTusker/Tusks-Tomes/archive/refs/heads/main.zip). After that, it's double-click `setup.bat` (Windows) and then double-click `Start_Tusks_Tomes.bat`. Python is only required if you want audio transcription — and even then, you can skip it on first install and add it from **Settings → Transcription** later. The full beginner walkthrough is in [beginner-guide.md](../getting-started/without-a-terminal.md). A signed Windows installer that bundles everything is on the [roadmap](../about/roadmap.md).


</div>
</details>

<details class="docs-section">
<summary><h2>How long does it take to chronicle a 4-hour session?</h2></summary>
<div class="docs-section-body">


Roughly 15–20 minutes end-to-end with a GPU: ~12 minutes for Whisper transcription (with the Audio Transcription add-on), ~3–5 minutes for the LLM pipeline (Gemini Flash is faster than Claude Sonnet here). On CPU, the transcription step balloons to ~90 minutes but the LLM step is unchanged. The dashboard shows live progress and ETAs.


</div>
</details>

<details class="docs-section">
<summary><h2>What happens if I update — do I lose my chronicles or settings?</h2></summary>
<div class="docs-section-body">


No. Your chronicles (`Sessions/<campaign>/...`), encrypted keystore, glossary, speaker mappings, routing, personas, and uploaded session audio all live **outside the repo** in your platform-standard config and data directories. The in-app updater (Settings → Maintenance) does a guarded `git pull` + `npm install` and refuses to clobber uncommitted edits. See [configuration.md](../settings/configuration.md) for exactly where things live on disk.


</div>
</details>

<details class="docs-section">
<summary><h2>What happens if I hit a rate limit halfway through a 3-hour session?</h2></summary>
<div class="docs-section-body">


You're covered. When the LLM provider returns a 429 (quota exhausted), Tomes opens a four-option dialog mid-pipeline:

- **Stop and export what we have** — aborts the run; downloads whatever the pipeline produced so far as Markdown.
- **Slow down (3× longer between calls)** — keeps the same key but paces calls more conservatively for the rest of the run. Disabled if the quota looks daily (waiting longer doesn't help an empty bucket).
- **Pause and save for later** — writes a full on-disk checkpoint. Close the app, come back tomorrow when the daily quota refills, click **Resume** on the banner above the Chronicle card. The pipeline picks up at the exact chunk it stopped on.
- **Switch keys for the rest** — only available when you've configured a fallback key. Most commonly used in Smart Budget mode for Phase 4 extras: if your optional free-tier Gemini key stalls, this jumps the rest of Phase 4 to your paid key.

Daily quotas typically reset at midnight UTC; per-minute limits clear in 60 seconds. None of your work is lost regardless of which option you pick.


</div>
</details>

<details class="docs-section">
<summary><h2>How can I keep costs low?</h2></summary>
<div class="docs-section-body">


Three levers, in roughly the order most users reach for them:

1. **Pick a cheaper rung in guided routing.** Settings → Providers & models offers a ladder of complete per-phase recipes, from maximum quality down to free. Moving off the flagship-everywhere rung cuts the cost several times over. Quality on the long-form chronicle phase is noticeably weaker on fast-tier models — A/B-test a 30-minute slice before committing if quality matters.
2. **Use Smart Budget instead.** Same UI; a different preset. Paid Flash for grounding + audit, Paid Pro for the chronicle (the quality phase), Paid Flash-Lite for condense. If you've also configured an optional free-tier Gemini key, Smart Budget routes Phase 4 extras to it (the only phase that ever uses your free key). Roughly half the cost of Pro-everywhere, with the chronicle quality preserved. [What it costs](../models/costs.md) has the current figure.
3. **Mix-and-match per phase manually.** Same panel, one row per phase. Use the cheap model on Phase 1 (Grounding) and Phase 4 (Extras) where prose quality barely matters, and keep the strong model on Phase 3 (Chronicle) where it does.

See [providers.md](../models/choosing-a-provider.md) for honest per-provider cost estimates and the architectural cost-reduction work shipping in the current release.

> ** If you also have a free-tier Gemini key, the better home for it is [Tusk's Vault](https://github.com/KochiTusker/Tusks-Vault)** — the upcoming AI-chatbot companion that lets you ask questions of your campaign lore. Vault is a single retrieval-augmented query per turn, far lower token use than Tomes' six-phase pipeline, so a free quota carries Vault's workload comfortably. Vault is due to release soon.


</div>
</details>

<details class="docs-section">
<summary><h2>Is there a Discord community?</h2></summary>
<div class="docs-section-body">


Not yet — it's a [roadmap](../about/roadmap.md) item. A shared community Discord for Tusk's Tomes and the companion project [Tusk's Vault](https://github.com/KochiTusker/Tusks-Vault) (`#support`, `#feature-ideas`, `#showcase`, `#dev-talk`) will be spun up once there's enough signalled interest.

In the meantime, the **[feedback form](https://docs.google.com/forms/d/e/1FAIpQLSdxdqOhb1SQvI3fs50gMJv_Cesh2MuxUm95QO2iZia5sFhyyQ/viewform?usp=header)** is where to drop setup questions, feature ideas, chronicles you want to share, and — most importantly — a "yes" to the "would you join a community Discord?" question. That signal is what triggers the launch.


</div>
</details>

<details class="docs-section">
<summary><h2>Can I use this commercially? (e.g. an actual-play podcast)</h2></summary>
<div class="docs-section-body">


Yes. Tusk's Tomes is [MIT-licensed](../../LICENSE) — you can use it personally, commercially, modify it, ship it inside your own product, sell support around it, anything. The only requirement is that the MIT copyright notice travels with the code. We'd love to hear about commercial uses via the [feedback form](https://docs.google.com/forms/d/e/1FAIpQLSdxdqOhb1SQvI3fs50gMJv_Cesh2MuxUm95QO2iZia5sFhyyQ/viewform?usp=header), but you don't owe us anything.


</div>
</details>

<details class="docs-section">
<summary><h2>How do I contribute or report a bug?</h2></summary>
<div class="docs-section-body">


[Open an issue](https://github.com/KochiTusker/Tusks-Tomes/issues/new/choose) (there are guided templates for bug reports and feature requests), or send a PR straight from your fork. For larger changes, sketch the idea via the [feedback form](https://docs.google.com/forms/d/e/1FAIpQLSdxdqOhb1SQvI3fs50gMJv_Cesh2MuxUm95QO2iZia5sFhyyQ/viewform?usp=header) first (a community Discord with a `#dev-talk` channel is on the [roadmap](../about/roadmap.md)). The full contributor guide is [CONTRIBUTING.md](../../CONTRIBUTING.md), and the community standards are in the [Code of Conduct](../../.github/CODE_OF_CONDUCT.md).


</div>
</details>
