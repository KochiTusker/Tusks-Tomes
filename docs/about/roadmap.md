# Roadmap

A running list of what's shipped, what's coming next, what the community
has suggested, and what's been considered and declined. Updated as the
Tusker community grows.

> **Want a feature?** Drop it in the [feedback form](https://docs.google.com/forms/d/e/1FAIpQLSdxdqOhb1SQvI3fs50gMJv_Cesh2MuxUm95QO2iZia5sFhyyQ/viewform?usp=header)
> or [open a feature request](https://github.com/KochiTusker/Tusks-Tomes/issues/new/choose)
> — see [How to suggest a feature](#how-to-suggest-a-feature) below for
> what makes a great suggestion. Every idea gets read; the most-upvoted
> ones move up this list.

---

<details class="docs-section">
<summary><h2>Contents</h2></summary>
<div class="docs-section-body">


- [What's coming next](#whats-coming-next) — actively prioritised backlog
- [Community-suggested features](#community-suggested-features) — ideas from the feedback form and GitHub
- [How to suggest a feature](#how-to-suggest-a-feature)
- [Recently shipped](#recently-shipped)
- [Won't do (Player)](#wont-do-and-why) — politely declined, with reasoning
- [Developer notes](#developer-notes) — decision log, security audit, QoL backlog, theming + animation specs

---


</div>
</details>

<details class="docs-section">
<summary><h2>What's coming next</h2></summary>
<div class="docs-section-body">


The active backlog — items on deck for the next handful of releases.
Order is loose; community demand can promote things.

- [ ] **Community Discord server** — a shared home for Tusk's Tomes and [Tusk's Vault](https://github.com/KochiTusker/Tusks-Vault). Setup help, feature-idea voting, chronicle showcase, dev talk. Will spin up once there's enough signalled interest via the [feedback form](https://docs.google.com/forms/d/e/1FAIpQLSdxdqOhb1SQvI3fs50gMJv_Cesh2MuxUm95QO2iZia5sFhyyQ/viewform?usp=header) — the form has a "would you join a community Discord?" question, and a yes there is the trigger.
- [ ] **GPU transcription for non-NVIDIA cards** — currently impossible to ship as a one-click add-on, and worth recording why so it isn't re-investigated from scratch. `faster-whisper` (CTranslate2) implements only CUDA and CPU, so AMD, Intel Arc and Apple GPUs go unused. A survey of the alternatives in August 2026 found: **whisper.cpp** ships CPU, BLAS (still CPU) and CUDA builds — its Vulkan backend exists in source but is in *no* release asset; **sherpa-onnx** ships CPU and CUDA only, no DirectML; **Const-me/Whisper** genuinely does use any DirectX 11 GPU via DirectCompute and ships a 0.4 MB CLI, but has had no release since July 2023. So the only ready-made vendor-agnostic option is unmaintained. Re-open if any of these ships a Vulkan or DirectML release asset, or if hosting a self-built, signed Vulkan binary becomes worth the publisher burden. Note that whisper.cpp would still be attractive purely for dropping the Python 3.10–3.12 requirement and the ~2 GB PyTorch install — the sidecar already sits behind a stable JSON contract (`{segments, durationMs, language}`, see `server/whisper/invoke.ts`), so a second engine is a bootstrap + invoke path rather than a rewrite.
- [ ] **More provider options — Kimi, DeepSeek and Grok** — add these alongside the existing Gemini / Claude / OpenAI cloud keys. DeepSeek and Kimi are attractive on price-per-token for the mechanical phases; Grok is being looked at for the narrative phase. Each needs the usual work: a provider adapter, chunk-size row, rate-limit handling, and a probe target list.
- [ ] **YouTube SRT/VTT parser** — sister formats to `.sbv`, same caption-repair pipeline
- [ ] **Whisper diarisation for single-track audio** — recover speaker labels via pyannote when there's no per-speaker source
- [ ] **In-PDF image OCR** — handle scanned session notes and handwritten lore
- [ ] **Tusk's Tomes Launcher** — standalone Electron version manager (separate from the app); lets non-technical users download, install, switch versions, repair, and clean-reinstall from a desktop GUI; Windows installer via Inno Setup; distributed as a $1 Patreon convenience item (core app stays MIT/free on GitHub); Mac/Linux parity is a follow-on roadmap item
- [ ] **In-browser audio trim** — clip out pre-game small-talk before transcription
- [ ] **Live push-to-Vault on chronicle finalise** — today's flow is filesystem-based; make it event-driven
- [ ] **Retrieval instead of whole-KB concat, for very large lore archives** — today every chunk's prompt carries the entire knowledge base. With a 100k-character KB and 13 transcript chunks per phase that is ~1.3M characters of input per phase, which works but is wasteful. Embedding the KB once and retrieving the top-K relevant passages per chunk makes the cost constant regardless of archive size. Deferred because most lore archives sit comfortably under 200k characters and Gemini's context caching already captures most of the saving without an embedding pipeline. When it does land, retrieval has to run locally — a bundled embedding model or an in-context scheme — because an embedding API we pay for would break the no-hosted-services rule. Re-open when someone turns up with a KB that genuinely does not fit in context.
- [ ] **Verified Linux and macOS support** — the stack (Node, Vite, Express, React) is cross-platform and the POSIX launcher scripts exist, but neither OS has actually been run end to end here, so the docs say "untested" rather than "supported". Closing this means a real run on each: launcher, Whisper setup, config paths, and the add-on install flow. No per-OS forks — one codebase or it does not ship.

The accessibility goal stays paramount: **every "installer" / "launcher" / "in-app" item above is in service of making Tusk's Tomes usable by people who have never cloned a Git repository.**

---


</div>
</details>

<details class="docs-section">
<summary><h2>Community-suggested features</h2></summary>
<div class="docs-section-body">


Ideas raised via the [feedback form](https://docs.google.com/forms/d/e/1FAIpQLSdxdqOhb1SQvI3fs50gMJv_Cesh2MuxUm95QO2iZia5sFhyyQ/viewform?usp=header),
GitHub issues, or 1:1 with users. Status tags indicate where each one
sits today.

## In progress

### Cloud transcription via OpenRouter

Transcribe uploaded audio through a hosted speech-to-text model instead of the
local Whisper sidecar, removing the NVIDIA-GPU requirement for AMD, Intel,
Apple and no-GPU users.

**Measured on real session audio.** 90 seconds transcribed in under four; about
**about $0.20 for a 3-hour, five-speaker session**.

**The model choice is forced, not open.** Of the nineteen speech-to-text models
on the platform, **only the two Whisper variants return word timestamps**. The
caption writer derives each segment's bounds from the first and last word of its
span, so a transcript without word timings cannot produce captions at all.
Nineteen candidates reduce to two, and `openai/whisper-large-v3-turbo` is the
cheaper of them.

**Three constraints shape the build:**

- Segments come back **empty even on Whisper** — only the word array is
  populated — so segments must be reconstructed from word timings rather than
  trusted from the response.
- A three-hour track is roughly **44 MB against a 25 MB upload cap**, so
  splitting is mandatory rather than an optimisation. `ffmpeg-static` is
  already a dependency and already used for duration probing.
- The add-on will be **gated on a valid OpenRouter key**: `isReady()` returns
  false without one and the add-on never mounts, which is the same mechanism
  every other add-on already uses for its prerequisites.

**Open decision.** Whether to transcribe each Craig speaker track separately —
preserving exact who-said-what, which everything downstream depends on — or mix
down and rely on diarisation. Per-track is more calls and the current
assumption.

---

## Recently shipped

### OpenRouter replaces the direct Anthropic and OpenAI keys

**What you get.** One key, and the model picker fills with roughly **400
models** — every Anthropic and OpenAI model among them, at pass-through rates,
plus a great many you would otherwise never have had an account for. Any of
them can be assigned to any phase. Setup is one paste into
**Settings → Providers & models**, and the catalogue is public, so the picker
is populated before you have entered anything at all.

**What changed.** That panel now offers **Gemini** and **OpenRouter**. The
separate Anthropic and OpenAI key slots are gone.

**Why.** OpenRouter fronts both vendors at pass-through rates — the same models,
the same prices, reached with one key. Three keys bought nothing over two except
more to configure, two more adapters to keep current as vendor SDKs move, and
two more rate-limit header formats to parse. It also opens the other ~400
models on the platform, several of which measured better than the models they
replaced on specific phases.

**Why Gemini stays separate.** It is measurably cheaper direct — the same Pro
model is listed roughly a fifth dearer through OpenRouter — and the only
generation that collapsed into a repetition loop during the whole comparison
was Gemini routed through OpenRouter, while the same model on the direct key
was clean on identical input. The reason is *not* content filtering: sending a
deliberately graphic passage three ways (direct with safety thresholds
released, direct without, and via OpenRouter) produced identical uncensored
output on all three.

**The subscription CLIs are unaffected.** Claude Code and Codex bill against a
subscription rather than an API key and carry the mechanical phases in every
hybrid preset. They are not the retired pair.

**Nothing on disk breaks.** Routing that names a retired provider is rewritten
on read to the same model in the OpenRouter namespace — matched by model, never
swapped for something cheaper — and the change is logged rather than made
silently.

### Per-phase routing, rebuilt

**One row per phase.** The editor used to ask the same question twice — a
"Model Profiles" grid set the active provider's default and a second grid set
per-phase overrides, with different model lists, and only the lower one could
reach OpenRouter. Each phase is now a single row stating the model actually in
effect, whether that was inherited or overridden, what the phase costs on it,
and what the phase *wants* from a model.

**Grouped by connection, not by vendor.** The picker's top level is the key or
subscription that carries the call — Gemini API key, Claude Code, Codex,
OpenRouter, Local — with vendor folders kept only inside OpenRouter. Grouping by
vendor had filed "Gemini on your Google key" and "Gemini through OpenRouter"
together, which share a vendor and nothing else that matters: different price,
different reliability, measurably different output.

**Three orderings, because they disagree.** Performance ranks by measured grade.
Cost ranks by what *that phase* would spend, since Chronicle emits output at
nine tenths of its input while Audit emits a fiftieth. Developer's picks is an
ordered opinion that weighs speed and reliability, which no grade encodes.

**Two filters.** *Tested only* narrows to models graded on real session material
— on any phase, since a model measured elsewhere is a known quantity in a way an
untouched catalogue entry is not. *Handles mature content* narrows to models
measured carrying graphic violence and crude dialogue without softening it.

### The explicit-content failsafe is no longer Gemini-only

When the subscription CLI refuses a chunk, the repair model is now a choice,
restricted to models measured carrying explicit content. Previously it was
Gemini, hardcoded — so a user without a Gemini key got no repair at all and the
refusal became a permanent hole in the chronicle.

### Extras tells NPC dialogue from narration

The extras prompt had no rule for DM speech, so scene description narrated by
the DM was routinely captured as though a character had said it aloud. The rule
defaults to **keeping** the quote: an earlier version defaulted to excluding and
deleted a five-turn conversation with a named NPC because it could not tell who
was speaking. Losing a real line costs far more than keeping a stray piece of
narration, and nothing downstream recovers it.

### Two OpenRouter routing presets

**All OpenRouter** runs every phase on one key. **OpenRouter hybrid** keeps the
mechanical phases on a subscription CLI and — the part that was previously
impossible — repairs refused chunks on OpenRouter too. Both failsafes used to
name Gemini directly, so a user without a Gemini key got no repair at all and
the refusal became a permanent hole in the chronicle.

### Extras now tells NPC dialogue from narration

The extras prompt had no rule for DM speech, so scene description narrated by
the DM was routinely captured as though a character had said it aloud. The rule
that fixes it defaults to **keeping** the quote: an earlier version defaulted to
excluding, and deleted a five-turn conversation with a named butler because it
could not tell which NPC was speaking. Losing a real line costs far more than
keeping a stray piece of narration, and nothing downstream can recover it.

---

> **Note**: this section is where suggestions are logged as they
> suggestions as they come in. If a suggestion is missing, the
> [feedback form](https://docs.google.com/forms/d/e/1FAIpQLSdxdqOhb1SQvI3fs50gMJv_Cesh2MuxUm95QO2iZia5sFhyyQ/viewform?usp=header)
> is the fastest way to surface it — it probably just hasn't been
> logged yet. A "researching" tag isn't a deferral; most items sit
> there while scope and fit get worked out.

### Under active consideration

<!-- Add new items here. Format:
- **<Feature name>** — <one-sentence pitch>. <Who suggested it / where>. <Current thinking>.
-->

- **Provider pinning as a routing option** — let a phase pin which upstream
  serves a model, not just which model. Measured on an identical request:
  one provider honoured a reasoning cap and returned in 110 seconds for $0.055;
  another ignored the same cap, reasoned past fifteen thousand tokens, took ten
  minutes and cost five times as much — and sometimes returned nothing at all.
  The app currently has no way to express the difference.

### Researching — needs scoping

<!-- Items wanted but not yet sized. -->

_(Empty for now.)_

### Parked — waiting on something

<!-- Items blocked on an upstream dep, a missing user, or a still-undecided architectural choice. -->

_(Empty for now.)_

---


</div>
</details>

<details class="docs-section">
<summary><h2>How to suggest a feature</h2></summary>
<div class="docs-section-body">


Three paths, all good — pick whichever feels lighter:

1. **[Feedback form](https://docs.google.com/forms/d/e/1FAIpQLSdxdqOhb1SQvI3fs50gMJv_Cesh2MuxUm95QO2iZia5sFhyyQ/viewform?usp=header)** — fastest, lowest friction. Half-formed ideas welcome. (A community Discord is on the roadmap; until then, this is the out-of-band channel.)
2. **[Open a feature request](https://github.com/KochiTusker/Tusks-Tomes/issues/new/choose)** — best for ideas that need a paper trail or that you want others to upvote.
3. **Open a PR** — if you've already built it. For larger changes, sketch the design in the feedback form first to avoid wasted work.

**What makes a great suggestion:**

- **The use case in your own words.** "As a DM running long sessions, I want to…" beats "we should add X".
- **Why the existing flow doesn't already cover it.** (Sometimes it does and the feature is just hard to find — that's good info too.)
- **A rough sketch of the UX.** Even one sentence on where it'd live (which tab, what the button says).
- **Whether you'd help build it.** Not required, but if you would, say so.

**Heuristics for what fits:**

- Things that strengthen the **local-first, no-account, no-telemetry** stance
- Things that make Tusk's Tomes **easier for non-developers** to install / use
- Things that **integrate with tools DMs already use** (VTTs, lore wikis, recording bots)
- Things that **improve chronicle quality** without burning more LLM tokens
- Things that require a cloud account
- Things that require telemetry or phone-home
- Things that lock features behind a paywall

If your idea doesn't pass the heuristics but you think it should, **say so** — these aren't laws, they're priors. Community feedback shifts them.

---


</div>
</details>

<details class="docs-section">
<summary><h2>Recently shipped</h2></summary>
<div class="docs-section-body">


The headline ship-it items, newest first. For the full code-level
history see `git log`.

- **Codex add-on** — route phases through a signed-in OpenAI Codex CLI and draw on that plan's allowance instead of metered API credit. Mirrors the Claude Code add-on and is fully independent of it; exhausting the allowance pauses the run rather than failing it.
- **Guided routing presets** — a preset ladder (maximum quality → balanced → measured hybrid → free) with measured cost savings shown against the Pro-tier baseline, behind an "Advanced routing" toggle for anyone who wants the per-phase controls directly.
- **Cross-provider routing within one run** — previously listed as won't-do. Per-phase routing now carries an explicit (provider, tier, model) tuple, so Claude can run phase 1 while Gemini runs phase 3 and OpenAI runs phase 4.
- **Obsidian Vault lore source** — point Tomes at an existing Obsidian vault and ground chronicles against those notes, read-only. Includes a vault CLAUDE.md generator; the context toggle is off by default.
- **Claude Code add-on** — same idea as the Codex add-on, against a signed-in Claude Code CLI.
- **Chronicle Reforge** — re-run a finished chronicle through a different model or persona without re-running the whole pipeline.
- **Dynamic model dropdowns for every provider** — "Probe models" now covers Gemini Paid, Gemini Free, Claude and OpenAI, and local backends list their own models. Dropdowns mark each entry verified or unverified based on what the key can actually call.
- **Settings + Tome of Lore reorganisation** — collapsible sections with persisted state, a sticky section rail, and inline help popovers.
- **Cost optimisation pass** — Budget mode preset in Hybrid Routing + Phase 3/6 prompt-cache extension + (provider, model-tier)-keyed chunk sizes + Flash rate-limit tier wiring. A 3-hour session on Pro lands around a fifth of the cost on Flash with caching.
- **Free-tier resilience** — rate-limit dialog (stop / slow-down 3× / pause-and-save / fallback) + on-disk run checkpoints (`/api/runs/*`) + Resume banner above the Chronicle tab. Partial Markdown export at any pipeline phase. Hitting a free-tier daily quota mid-3hr-session is now a non-event.
- **Whisper opt-in install** — Whisper is no longer in the default `npm run setup` path. Audio Transcription is opt-in via Settings → Add-ons. Users who only paste transcripts no longer need Python.
- **Chronicle Personas add-on** — six character preset narrators + an editor for your own. Phases 1/2/4 stay neutral; persona affects only the prose phases.
- **In-app self-updater** — Settings → Updates → Apply
- **Tusk's Vault pairing** — auto-detect sibling install + one-click Send-to-Vault
- **GUI overhaul** — deep void violet arcane theme with dramatic animations
- **Chronicle auto-save** — every finished chronicle lands at `Sessions/<campaign>/<file>.md`
- **Multitrack upload pipeline** — Craig zip ingest, chunked auto-stitching, staged batch uploads
- **Live Discord transcription via faster-whisper** — sidecar with CUDA auto-detection
- **Six-phase pipeline** — cleanup → ground → narrate → curate (+ optional polish + condense)
- **Encrypted-at-rest keystore** — AES-256-GCM, machine-bound scrypt key
- **Multi-provider LLM abstraction** — Claude / OpenAI / Gemini / Claude Code / Codex / Ollama / LM Studio / Unsloth, with Hybrid Mode
- **Cross-platform first-time-setup script** — `setup.bat` / `setup.sh` with dependency checks
- **Vestigial Discord-bot code removal** — the in-app voice-channel bot path is gone (Craig handles recording externally). Old `BotPanel.tsx`, `server/bot/`, and `DISCORD_SETUP.md` retired.

---


</div>
</details>

<details class="docs-section">
<summary><h2>Won't do (and why)</h2></summary>
<div class="docs-section-body">


These were proposed (some publicly, some internally) and considered.
Each was declined for a specific reason; **re-open the discussion if
your situation invalidates the reasoning** — these aren't permanent.

- **Two-pass chronicle (structured extraction → narrative).** The existing `phase3Chronicle` with `priorTail` continuity already produces NotebookLM-grade output without the round-trip cost.
- **Dedicated humor-extraction pass.** `phase4Extras` already extracts jests, gore, and quotes with kind classification.
- **Lore → structured glossary compilation via one-time cloud Tier-3 call.** The existing KB concat works for all frontier providers; the extra cost isn't justified.
- **9-test capability probe for local models.** Replaced with a 2-test mini-probe (structured JSON + grounding fidelity). The longer probe was slower without producing better routing decisions.
- **NVIDIA Parakeet / Canary-Qwen as alternative transcription engines.** `faster-whisper` large-v3 with `int8_float16` was chosen for better community support, faster install, and fewer GPU memory edge cases. Worth noting what that comparison did *not* cover: whisper.cpp was never evaluated, and `faster-whisper`'s CUDA-only backend is the reason AMD and Intel GPUs get no acceleration at all. That gap is now a backlog item rather than a settled decision.
- **Live streaming transcription from a bot in voice channels.** The in-app bot path is retired; Craig handles recording. Post-session batch transcription is more accurate and simpler.
- **Fully lazy add-ons (code only downloaded on Install click).** Considered an architecture where add-on source — server modules and React UI alike — lived outside the public clone and downloaded on Install via sha256-verified tarballs from GitHub Releases, with the SPA loading add-on UI as separate Vite chunks. Goal: a fresh clone ships zero add-on code, single source of truth stays in the canonical repo. Spiked the colocation pass (all three add-ons reorganised under `server/addons/<name>/` + `src/components/addons/<name>/` + `src/lib/addons/<name>/`, tests green) and then declined the rest. The Python venv — the only large disk footprint at ~1.5 GB — is *already* lazy via the Whisper opt-in card; the remaining JS/TS savings would be ~120 KB built + ~5,500 LOC source, which doesn't justify the architectural surface (Vite library-mode chunks, importmap for externalised React, dynamic SPA loader, tarball pipeline, sha256 verification, postinstall sandbox, release-script exclusion logic). Re-open if a future add-on with substantial native deps changes the disk-footprint calculus.
- **API keys stored in `.env` for end-user distribution.** Keys go into an encrypted file managed via GUI — `.env` is a developer convenience only.
- **Cloud account / sign-in.** Tusk's Tomes is local-first by design. No accounts, ever.
- **Telemetry / usage analytics.** None, ever. Usage is learned about via the feedback form (and, once it exists, the community Discord), not phone-home.
- **Subscription / paid tier for the chronicler.** MIT-licensed and free forever. Buy Me a Coffee exists for supporters, but no feature is paywalled. Note: a convenience installer distributed via Patreon (the Tusk's Tomes Launcher) is not a paywall — it is a paid shortcut to something anyone can do for free from the GitHub repo.

---


</div>
</details>

<details class="docs-section">
<summary><h2>Developer notes</h2></summary>
<div class="docs-section-body">


The rest of this document is the technical decision log — security
audit findings, QoL backlog with file references, theming + animation
specs, project conventions, and a glossary of pipeline terms. Useful
if you're contributing code; safe to skip otherwise.

### Original roadmap history

The original 16 numbered steps shipped. For the current shape of the
system, read [architecture.md](how-its-built.md). The remainder of this
file is a **decision log + binding conventions + prioritised backlog**.

Since the original roadmap was written:

- The in-app **Discord voice-channel bot is retired**. Recording happens
  externally (Craig Bot is the recommended recorder); the app is a pure
  post-processor that consumes multi-track zips / loose WAVs. The
  defunct bot UI + server code is still in the repo but no longer
  rendered (`server/bot/client.ts`, `voiceCapture.ts`, `commands.ts`,
  `BotPanel.tsx`, `src/lib/bot.ts`, the `/api/bot/*` routes); see
  §"Code cleanup" below for the removal plan.
- The **Phase 5 (Polish, local-only)** and **Phase 6 (Condense)** passes
  shipped.
- Finished chronicles **auto-save** to
  `<repo>/Sessions/<campaign>/Silence Beyond the Sea - <campaign> - Session <n>.md`
  via `POST /api/chronicle/save`.
- The five-step provider abstraction matured to support **Gemini Paid /
  Free tier escalation** at run start.

### Binding engineering principles

Folded in from the old `milestones.md`, which was retired once most of
what it planned had shipped. Two of its seven milestones are still live
and now sit in the backlog above (retrieval, and verified Linux/macOS
support); the rest were either delivered or abandoned. The abandoned one
is worth naming explicitly: that file described the goal as a
**one-time-purchase desktop tool** with offline licence-key enforcement.
That is not the project. Tusk's Tomes is MIT-licensed and free, and the
"Won't do" section above records that decision.

These constraints still bind, whatever you are working on:

1. **Provider isolation.** Anything provider-specific stays inside its
   own module under `src/lib/providers/`. The pipeline only ever calls
   `generate(req, opts)` through the `LLMProvider` interface. Do not
   sprinkle a vendor's SDK types across the pipeline.

2. **Tier-based model selection.** Phases declare a tier; the provider
   resolves it to a concrete model ID. Never hardcode a model ID in the
   pipeline, and keep model lists dynamic or config-driven — when the
   next model generation ships, a user should pick it from a dropdown
   rather than wait for a release.

3. **No services we host.** localStorage, the config directory, and the
   local Express server are the entire persistence story. No database we
   run, no API we pay for per user, no phone-home. This is what makes
   the free-forever position sustainable rather than a promise that
   quietly expires.

4. **Do not outgrow the laptop.** Every stage must run on a moderate
   consumer machine. If the knowledge base grows past what fits, that is
   what retrieval is for; output length is already handled by chunking.

5. **Mature content stays.** These are adult tabletop sessions. Safety
   thresholds stay permissive wherever a provider allows it, and where
   one cannot be tuned that way, say so plainly in the provider docs
   rather than quietly sanitising someone's game.


</div>
</details>

<details class="docs-section">
<summary><h2>Completed work</h2></summary>
<div class="docs-section-body">


The shipped surface delivers:

1. A **multi-track upload pipeline** that ingests Craig zips / loose
   audio, lays the session out per speaker, and transcribes it offline
   with `faster-whisper`. Result: a speaker-tagged SBV one click away
   from refinement.
2. A **persistence layer + GUI editor** for the glossary and speaker
   mappings.
3. A **multi-provider abstraction** (Gemini / Claude / OpenAI / local)
   with per-provider model profiles and **single-active-provider**
   selection at run start.
4. An **encrypted local key store** with a GUI for entering and
   managing API keys.
5. **Hybrid Mode** that detects local LLMs (Ollama / LM Studio /
   llama-server / Unsloth) and routes individual phases to them based
   on a 2-test capability probe.
6. **Six-phase pipeline** (1 ground → 2 audit → DM clarifications → 3
   chronicle → 5 polish [local only] → 4 extras → 6 condense).
7. **Chronicle auto-save** to disk as Markdown in a repo-relative,
   git-ignored `Sessions/` tree.

---


</div>
</details>

<details class="docs-section">
<summary><h2>What this roadmap explicitly does NOT include</h2></summary>
<div class="docs-section-body">


These were proposed in an external `discord_transcriber_roadmap_v2_3.md`
draft and rejected after analysis. Re-justify against this list before
re-opening any of them:

- **Two-pass chronicle (structured extraction → narrative).** Existing
  `phase3Chronicle` with `priorTail` continuity already produces
  NotebookLM-grade output.
- **Dedicated humor extraction pass.** `phase4Extras` already extracts
  jests, gore, and quotes with kind classification.
- **Lore → structured glossary compilation via a one-time cloud Tier-3
  call.** The existing KB concat works for all frontier providers.
- **9-test capability probe for local models.** Replaced with a 2-test
  mini-probe (structured JSON + grounding fidelity).
- **NVIDIA Parakeet / Canary-Qwen as alternative transcription
  engines.** `faster-whisper` large-v3 with `int8_float16` is the
  single chosen engine.
- **Live streaming transcription from a bot in voice channels.** The
  bot path is retired; Craig handles recording. Post-session batch
  transcription is more accurate and simpler.
- ~~**Cross-provider routing within one run**~~ — **decision reversed, and
  shipped.** Per-phase routing now carries an explicit (provider, tier, model)
  tuple, so Claude can run Phase 1 while Gemini runs Phase 3. Kept here as a
  record that the original call was wrong. See `src/lib/routing.ts`.
- **Python-style `src/` tree with `providers/`, `router/`, etc.** This
  project is TypeScript. The Python sidecar is scoped to
  `faster-whisper` invocation only.
- **API keys in `.env` for end-user distribution.** Keys go into an
  encrypted file managed via GUI. (See P1-3 below about removing the
  `PAID_` Vite env prefix for the same reason.)

---


</div>
</details>


<details class="docs-section">
<summary><h2>Quality-of-life backlog</h2></summary>
<div class="docs-section-body">


Concrete items found while auditing the current code. Each is a
specific change at a specific surface.

### QoL-1 — Upload-state persistence across tab switches  *(user-flagged)*

**Symptom:** the user uploads a Craig zip in the Bot tab, sees the
speaker-assignment table, switches to another tab to check the KB or
Settings, then switches back — and the entire upload preview is gone.
They have to drag the file in again.

**Root cause:** `UploadPanel`'s state (`phase`, `entries`, `extracted`,
`uploadFraction`, …) lives in component-local `useState`. Radix Tabs
unmounts inactive `<TabsContent>` by default, so the entire component
is destroyed on every tab switch. The `App.tsx:48` comment already
acknowledges this exact behaviour for `RefinementTool`.

**Two viable fixes:**
- **(a) `forceMount` on Bot / Sessions tabs.** Pass `forceMount` to
  Radix's `<Tabs.Content>` for the surfaces that hold long-lived work.
  Cheapest fix — keeps the React state alive because the panel stays in
  the DOM (hidden via `data-state` + CSS). Drawback: no localStorage
  durability across reloads.
- **(b) Lift in-flight upload state to a context provider** at
  `App.tsx` and rehydrate from `/api/sessions/:id/live` on mount. More
  refactor but survives a hard reload mid-transcription.

Recommendation: **(a) immediately**, **(b) as a follow-up** once we
know the user reaches for it after refreshes too. The `File` objects
in `entries` can't be re-hydrated from disk, so (b) only covers the
post-upload `transcribing` / `ready` phases.

### QoL-2 — Merge Sessions into the Bot tab  *(user-flagged)*

The Bot tab is currently the *upload* surface and the Sessions tab is
the *historical session list*. They're the same conceptual workflow,
split awkwardly across two tabs:

- Bot → "I'm starting a new session"
- Sessions → "I'm continuing/reviewing an existing session"

Proposed layout:

```
Bot tab → renamed to "Sessions"
  ├─ New session card (the current UploadPanel)
  └─ Past sessions list (the current SessionsList)
```

The list of past sessions sits below the upload card; clicking one
expands the same `LiveTranscript` view the post-upload flow already
uses. A subtle visual divider (use the existing `.ornament` class)
separates "new" from "past". Drop the standalone Sessions tab from
`App.tsx`.

### QoL-3 — Rename the Bot tab

Even without QoL-2, "Bot" is a misleading label now that the upload
panel sits there. Rename to **Sessions** (preferred — sets up QoL-2)
or **Recordings**. Update `App.tsx:92-94`.

### QoL-4 — Remove vestigial Discord bot code *(shipped)*

Now done. The bot code, `DISCORD_SETUP.md`, and the dependency cleanup
all landed. Kept for historical reference of what was removed:

- `server/bot/client.ts`, `commands.ts`, `consent.ts`,
  `voiceCapture.ts`, `speakerDiscovery.ts`.
- `server/api/bot.ts` + the `app.use('/api/bot', botRouter())` line in
  `server/index.ts`.
- `src/components/BotPanel.tsx`, `src/lib/bot.ts`.
- `DISCORD_SETUP.md`.
- The `discord` slot in the keystore schema
  (`server/crypto/keyStore.ts`).
- The `discord.js`, `@discordjs/voice`, `@discordjs/opus`,
  `prism-media`, `@stablelib/xchacha20poly1305`, `@noble/ciphers`
  dependencies in `package.json`.

**Keep**: `server/bot/sessionManifest.ts` (the upload pipeline uses it
as the manifest schema owner) — rename to `server/sessions/manifest.ts`
in the same change, fix imports.

This is mostly tree-shake; the win is reduced attack surface (six fewer
dependencies, fewer endpoints) and clearer architecture.

### QoL-5 — Kill the `state.campaign` / `state.sessionNumber` zombie fields

`useRefinementState` exposes `setCampaign` / `setSessionNumber` actions
that nothing in the UI ever calls; `state.campaign` is always `''` and
`state.sessionNumber` is always `1`. The chronicle-save wiring already
read directly from the Header's `LS_CAMPAIGN` / `LS_SESSION`. Drop the
dead fields from `RefinementState` and the matching actions; the
ChronicleView, Phase 6 prompt, and download filename then have a
single source of truth.

### QoL-6 — README + DISCORD_SETUP cleanup *(shipped)*

`DISCORD_SETUP.md` is gone. The README no longer walks through any bot
setup; the Craig path lives in [AddOns.md](../extras/README.md) +
[docs/add-ons/audio-transcription.md](../extras/audio-transcription.md).

### QoL-7 — Surface the chronicle save path in the success toast

The chronicle save toast already shows the relative path; clicking it
should open the containing folder via a tiny `/api/chronicle/open`
endpoint that uses `child_process.exec('explorer / open / xdg-open',
absPath)`. Quality-of-life equivalent of "Show in Finder" on Mac.

### QoL-8 — Top-bar "Active session" indicator

When a session is mid-transcription (live queue is draining), surface
that in the Header — a small pulsing rune + "Whisper · 47 / 132
utterances". One click jumps to the new Sessions tab and scrolls to the
in-flight session. Reuses the existing `/api/sessions/:id/live` poll.

### QoL-9 — Phase-by-phase replay from the Sessions list

Every Sessions row should expose **Send to Refinement**, **Re-run
Phase 6 only**, and **Open chronicle .md** actions. Right now the
"send to refinement" affordance only lives inside the LiveTranscript
component; surface it as a row-level button so the user doesn't have
to expand the session first.

### QoL-10 — Cost dashboard

`Usage` is already returned by every cloud provider call. Aggregate
across runs into `{cacheDir}/usage.json` and surface a simple per-month
total in Settings → Providers. Mentioned in the legacy Future Work
list; promoting it because the data is already there.

### QoL-11 — Drag-and-reorder the upload chunk list

`UploadPanel.tsx:158` moves chunks one row at a time via up/down
arrows. For 4× hour-long Craig zips this is fine; for >6 chunks it's
tedious. Add HTML5 drag-and-drop reorder.

### QoL-12 — DM-question rich text

The DMQuestionsModal currently expects single-line text answers. Some
clarifications need paragraphs ("In Session 12 Az actually used the
Cloak before the trap, here's the full beat: …"). Swap the input for a
small textarea.

---


</div>
</details>

<details class="docs-section">
<summary><h2>UI direction — fantasy / D&D theming</h2></summary>
<div class="docs-section-body">


The brand already commits to a chronicler-with-gold-accents tone
(Cinzel display, Fondamento script, brass + tide colour palette,
parchment cream foreground on abyssal navy). The polish below extends
that without rewriting the design system.

### T-1 — Illuminated capitals on the chronicle

The first letter of each Phase 3 paragraph should render as a Cinzel
2.5em drop cap with a soft gold radial behind it — the look of an
illuminated manuscript. CSS-only via `.chronicle-prose p:first-letter`.

### T-2 — Parchment background option

Add a togglable "parchment" theme variant: replace the abyssal navy
with an aged-paper texture (subtle paper-fibre SVG) and shift the
foreground to a warm sepia. Toggle lives in Settings → Display.
Defaults to the existing dark theme.

### T-3 — Ornamental section dividers

The existing `.ornament` class draws a brass line with a centred gap;
replace the gap with a small heraldic glyph (a tusk + open book,
matching the existing `TuskLogo` SVG) sized to ~14px. Use it between
"Chronicle" / "Jests" / "Gore" / "Quotes" sections in the chronicle
view.

### T-4 — Phase glyphs

Replace the generic `Loader2` spinner per phase with a phase-specific
icon:

| Phase | Glyph                                 |
|-------|---------------------------------------|
| 1     | A quill nib drawing a circle         |
| 2     | A magnifier over runes                |
| 3     | An open tome with a flame             |
| 5     | A polishing cloth over a sigil        |
| 4     | Three coins (jests / gore / quotes)   |
| 6     | A scroll with a tied ribbon           |

Render as inline SVG so the gold colour pulls from `var(--color-gold)`.

### T-5 — Tab pill style

The current TabsList is a flat muted rectangle. Replace with **engraved
brass plates** — each pill gets a 1px inset gold ridge, the active pill
gets a soft inner glow. Pure CSS via the existing `.arcane-card` /
inset shadow pattern.

### T-6 — Header rework

Re-render the Header as a **banner across the top** — left edge: the
tusk sigil inside an embossed roundel; centre: the wordmark; right
edge: a small wax-seal motif holding the active campaign + session
number. Currently it's three loose elements separated by flex gaps.

### T-7 — Sigil watermark in the background

A very faint (~3% opacity) tusk-and-book sigil tiled in the body
background at low contrast, similar to a printed letterhead. CSS
`background-image: url(/sigil.svg); background-size: 240px; opacity:
0.03`.

### T-8 — Chronicle title rendered as a hand-lettered banner

When the chronicle finishes, render
`{campaign} — Session {n}` in Fondamento with a subtle gold underline
flourish (an SVG that draws under the text). Live preview of how a
title page would look.

### T-9 — Dice-themed loader

Replace the generic spinner during long phases with a **rolling d20**
SVG. Cycles through faces every 60ms, matches the Cinzel + gold tone,
reads as flavour rather than chrome.

---


</div>
</details>

<details class="docs-section">
<summary><h2>Animation ideas</h2></summary>
<div class="docs-section-body">


CSS-first wherever possible; reach for Framer Motion only when state
transitions need orchestration. All animations honour
`prefers-reduced-motion` (already wired in `src/index.css`).

### A-1 — Page-turn between major phases

When the pipeline transitions idle → in-progress → done, wrap the
top-level branch in `AnimatePresence` with a horizontal 3D rotateY
that suggests a manuscript page turning. ~400ms, ease-in-out. Already
have `motion` in deps.

### A-2 — Ink-bleed reveal for chronicle text

When the chronicle lands, the prose fades in with a soft left-to-right
mask — like ink soaking into paper. `mask-image` with a moving
gradient + `animation: 1.2s ease-out`.

### A-3 — Quill-write title

The chronicle title types itself in a hand-lettered Fondamento, one
character every ~40ms, capped at 1.5s total. Skip on
`prefers-reduced-motion`.

### A-4 — Stagger-fade for jests / gore / quotes

When the Extras tab opens, its list items cascade in 60ms apart,
0px → 0px + 4px upward translate. Already have `motion` —
`<motion.li initial={{...}} transition={{ delay: i*0.06 }}>`.

### A-5 — Phase-progress rune pulse

The spinner during a phase pulses a faint gold halo behind the phase
glyph (from T-4) on a 1.6s sine — slow enough to read as "alive", not
"alert". Pure CSS: `@keyframes rune-pulse { 50% { box-shadow: 0 0 24px
gold/0.4 } }`.

### A-6 — Sigil flourish on chronicle save

When `/api/chronicle/save` returns success, the success toast's icon
is the tusk sigil drawing itself via SVG stroke-dashoffset animation
(0.8s). Sells the "tome was written" beat.

### A-7 — Upload drop-zone shimmer

When the user drags files over the upload zone, the dashed border
animates as a moving brass-gradient (CSS `background-position`).
Currently it just changes colour.

### A-8 — DM-question card flip

The DMQuestionsModal's per-question card flips with a Y-axis rotate
(160ms) when answered — visual confirmation that the answer landed
before the next card slides in.

### A-9 — Tab indicator slide

A 1px gold underline slides between active tab triggers via
`layoutId="tab-indicator"` in Framer Motion. Currently the active tab
state is purely a colour change.

### A-10 — Toast brass slide-in

The sonner toast already slides; replace the slide with an "unfurl"
keyframe that scales the toast x-axis from 0 → 1 (350ms, ease-out),
suggesting a small scroll unrolling.

---


</div>
</details>

<details class="docs-section">
<summary><h2>Project conventions (binding for future work)</h2></summary>
<div class="docs-section-body">


- **Language:** TypeScript everywhere except the Whisper sidecar
  (Python). No Python in `src/` or `server/`.
- **Indentation:** match surrounding code (2 spaces).
- **Paths:** use absolute imports via the `@/` alias configured in
  `tsconfig.json` and `vite.config.ts`.
- **No new top-level frameworks.** Stick with React 19, Express 4,
  Vite 6. No Next, no Redux, no Zustand.
- **Persistent state goes to disk, not localStorage.** localStorage is
  reserved for ephemeral UI state. Disk state lives in the platform
  app-data directory (see below).
- **Express routes for new persistent state.** The React app talks to
  disk through the Express API, not by reaching into the filesystem
  from the browser.
- **One cloud provider per pipeline run.** If the user has multiple
  API keys configured, the `ProviderSelectModal` at run start forces
  selection.
- **No emojis in code or docs unless explicitly requested.**
- **Don't add error handling for impossible cases.** Validate at
  boundaries (user input, file IO, network), trust internal types.
- **No comments that explain what code does** — only why, and only
  when non-obvious.
- **Animations honour `prefers-reduced-motion`.** Every new keyframe
  added under `@layer components` in `src/index.css` is silenced by
  the existing media query.

### App data directory

Cross-platform paths via the `env-paths` npm package:

```ts
import envPaths from 'env-paths'
const paths = envPaths('tusks-tomes', { suffix: '' })
// paths.config — settings, glossary, speakers, profiles, routing, providers.enc
// paths.data   — recordings, transcripts
// paths.cache  — capability probe results
```

Resolves to:
- Windows: `%APPDATA%\tusks-tomes\`
- macOS: `~/Library/Application Support/tusks-tomes/`
- Linux: `~/.config/tusks-tomes/`

All persistent files live under these roots. `server/appData.ts`
exposes the canonical accessor functions.

The project was previously named "Silence Beyond the Sea" and used the
env-paths key `silence-beyond-the-sea`. `migrateLegacyAppData()` runs
at server boot and moves any pre-rename trees into the new locations
exactly once.

---


</div>
</details>

<details class="docs-section">
<summary><h2>Glossary of terms</h2></summary>
<div class="docs-section-body">


- **Phase 1 / 2 / 3 / 4 / 5 / 6** — pipeline stages defined in
  `src/lib/pipeline.ts`. Don't renumber.
- **Grounding** — Phase 1; correcting transcript text against the KB
  and the glossary.
- **Audit** — Phase 2; surfacing DM clarification questions.
- **Chronicle** — the Phase 3 output: narrative prose of the session.
- **Polish** — Phase 5; local-only smoothing of the chronicle. Cloud
  providers skip this phase (pass-through).
- **Extras** — the Phase 4 output: jests, gore, quotes.
- **Condense** — Phase 6 (optional, user-triggered): tightened
  retelling + 10–15 catch-up bullets.
- **Glossary** — the structured corrections data
  (`safeReplacements` + `contextualHints`) in
  `{configDir}/glossary.json`.
- **Speakers** — the persistent mapping of
  `discordUserId → playerName → characterName` in
  `{configDir}/speakers.json`. The `discordUserId` is a Craig-derived
  identifier — usually the Discord user ID Craig embedded in the
  filename, or a stable hash of the filename for non-Craig sources.
- **Provider** — a cloud LLM (`gemini` | `claude` | `openai`) or a
  local LLM backend (`local`).
- **Profile** — per-provider configuration: which model to use for
  which phase.
- **Routing** — for a given pipeline run, which provider/profile
  handles which phase. With Hybrid Mode, may mix local + cloud.
- **Mini-probe** — the 2-test local-LLM capability check (structured
  JSON + grounding fidelity).
- **Session** — one recorded D&D session, identified by `sessionId`
  (UUID). Source is a Craig zip or loose audio uploaded via the
  Sessions / Bot tab.
- **Utterance** — a single audio file (one speaker, one continuous
  stretch). For Craig uploads, the whole per-speaker track becomes one
  long "utterance" before the live queue splits it on word-gaps.
- **Chunk (upload)** — one Craig zip's worth of tracks. Sequential
  chunks stitch end-to-end into one session.

---


</div>
</details>

<details class="docs-section">
<summary><h2>Future work (speculative — not authorised for autonomous pickup)</h2></summary>
<div class="docs-section-body">


Deferred until there's user feedback to ground them. Mostly carried
over from the previous roadmap with a couple of additions; items
already promoted into the Quality-of-life backlog above are removed.

- **Batch API support.** Anthropic and OpenAI both offer ~50%
  discounts for batched processing with delayed delivery. Phases 2 and
  4 are excellent candidates. Adds latency, fine for non-interactive
  runs.
- **Glossary update proposals.** After each chronicle, a Tier-1 pass
  surfaces newly-introduced names for user review.
- **Continuous quality sampling for local LLMs.** Re-route 5–10% of
  local outputs through the cloud as a verifier; flag drift early.
- **Multi-language support.** Whisper handles it; the pipeline
  doesn't. Would touch every prompt.
- **Concurrent sessions.** One session at a time is enough for now.
  Concurrency means GPU scheduling, queue management, etc.
- **App packaging (Electron / Tauri).** Promoted to active roadmap as the Tusk's Tomes Launcher — see "What's coming next".
- **Embedded Python distribution.** Bundling a `python-embed` build so
  the user doesn't need a system Python install. ~150 MB per platform.
- **Per-phase quality eval to validate the default model assignments.**
  Today's defaults (Sonnet for prose, Haiku for JSON) are intuition,
  not measured.
- **Phase 3 prompt for local providers at higher capability tiers.**
  The mini-probe currently hard-codes `phase3: false` for local
  models. A richer probe could validate prose quality and unlock local
  Phase 3.
- **PWA / installable webapp.** Service worker for offline asset
  caching once the local-LLM path is reliable enough that the user
  could genuinely run offline end-to-end.
- **Player-share mode.** Read-only export of the chronicle as a static
  HTML page (no API keys, no toolbar) for sharing in a campaign
  Discord. Renders the same prose + extras the user sees.

---


</div>
</details>

