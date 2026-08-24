<div align="center">

# Tusk's Tomes

### Turn any D&D, Pathfinder, or TTRPG session recording into a polished AI narrative chronicle, session recap, and summary — automatically, overnight, on your own machine.

**Local-first AI session chronicler. Open source. MIT-licensed. Free forever.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node 20+](https://img.shields.io/badge/Node-20%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Whisper add-on](https://img.shields.io/badge/Audio-add--on-7c3aed.svg)](docs/extras/audio-transcription.md)
[![GitHub last commit](https://img.shields.io/github/last-commit/KochiTusker/Tusks-Tomes?color=8B6F2C)](https://github.com/KochiTusker/Tusks-Tomes/commits/main)

*Like a personal scribe for your D&D table — paste a transcript or drop a Craig recording, walk away, wake up to a chronicle.*

**[Read the full documentation →](https://kochitusker.github.io/Tusks-Tomes/)**
&nbsp;·&nbsp;
[Session audio → chronicle](https://kochitusker.github.io/Tusks-Tomes/docs/audio-to-chronicle/)
&nbsp;·&nbsp;
[YouTube transcript → chronicle](https://kochitusker.github.io/Tusks-Tomes/docs/youtube-transcript-to-chronicle/)
&nbsp;·&nbsp;
[Sample output](https://kochitusker.github.io/Tusks-Tomes/#examples)

<p>
  <a href="https://docs.google.com/forms/d/e/1FAIpQLSdxdqOhb1SQvI3fs50gMJv_Cesh2MuxUm95QO2iZia5sFhyyQ/viewform?usp=header" target="_blank"><img src="https://img.shields.io/badge/Share_Feedback-Google_Form-4285F4?style=for-the-badge&logo=googleforms&logoColor=white" alt="Share feedback via Google Form" height="50" /></a>
  &nbsp;
  <a href="https://buymeacoffee.com/kochitusker" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-violet.png" alt="Buy Me a Coffee" height="50" /></a>
</p>

</div>

## Why this exists

I wanted a record of my campaign. Not minutes — the actual story. The bit where
the plan fell apart in an interesting way, the joke that had everyone crying,
the line the DM delivered that made the table go quiet for a second.

Everyone at every table says they'll write it up. Almost nobody does. I managed
it once.

The obvious tools didn't fit. Meeting transcribers are built for standups: you
get a transcript and some bullet points about what was "discussed", for $15 a
month, forever, processed in someone else's cloud. And none of them have the
faintest idea who your characters are — they hear an invented fantasy name,
guess a spelling, and then use that guess with total confidence for four hours
straight.

So I wrote this instead. It's a **self-hosted, open-source AI session
chronicler for D&D, Pathfinder and any other tabletop RPG**: it turns a session
recording or transcript into a narrative chronicle, a session summary you can paste
into Discord, and a list of the lines worth remembering — grounded in *your*
glossary of names and lore rather than the model's generic fantasy filler.

It works with cloud LLMs (Gemini direct, or ~400 models through OpenRouter), a Claude Code or Codex
subscription you already pay for, or fully offline via local models (Ollama, LM
Studio, Unsloth). Feed it pasted text, YouTube `.sbv` captions, Zoom or phone
audio, or a [Craig](https://craig.chat) Discord recording via the Whisper
add-on.

It's a niche tool for a niche group of people, and I'm fine with that. If
you're one of them, hello.

### You'll probably get on with this if…

- You're a **GM or DM** with a backlog of un-written-up sessions you've stopped mentioning out loud.
- Your group plays over **Discord with [Craig](https://craig.chat)**, and you want per-speaker, per-character attribution that survives all the way to the finished text.
- You **play solo** and record your own narration — same pipeline, and the prompts don't assume a party.
- You make **actual-play content** — a podcast, a Twitch or YouTube stream — and want episode recaps, show notes and quote pulls without re-watching a four-hour VOD. Streamers get a session summary per episode without paying an editor to listen back.
- You archive campaigns on **Roll20, Foundry or Fantasy Grounds** — paste the chat log, no audio needed.
- You're **not comfortable uploading your friends' voices** to a SaaS. Entirely fair. Nothing here leaves your machine except the text you choose to send to a model.
- You'd **rather own the tool than rent it** — a dollar or two of your own API credit per session, or nothing at all on a local model, and no account that can be closed.
- You play **anything at all**: D&D 5e, Pathfinder 1e/2e, Call of Cthulhu, Blades in the Dark, Vampire, Daggerheart, Fabula Ultima, OSR retroclones, homebrew. Nothing in the pipeline assumes a rules set.

**A fair warning before you get excited:** this is one person's project, tested
on one Windows PC, and it currently expects you to be comfortable installing
Node.js and running a `.bat` file. [How safe is this?](docs/security/what-it-installs.md)
lays out exactly what it installs, what it changes, and what could go wrong.

---

## See it in action — from setup to chronicle in four steps

The whole journey, from a fresh install to a saved `.docx` chronicle:

**1. Configure once — paste a Gemini or OpenRouter API key.** One paid API key
gets you running: Gemini directly, or OpenRouter for around 400 models behind a
single key. Keys are AES-256-GCM encrypted at rest and machine-bound via scrypt,
so they cannot be moved off your computer even if the file is copied. The
free-tier Gemini slot is optional and only ever drives the Smart Budget extras
phase.

**2. Drop in a Craig multitrack Discord recording, or any audio file.** Craig
gives you per-speaker FLAC files; Tomes feeds each track to a local Whisper
sidecar so every line in the chronicle is attributed to the right player. No
audio ever leaves your machine. Zoom recordings, phone audio and loose
`.flac` / `.wav` / `.mp3` files work too.

**3. Map Discord usernames to characters and players.** This is the bit general
transcription tools have no way of doing — per-speaker, per-character
attribution that survives all the way to the finished text. Set it once at the
start of a campaign and it persists.

**4. Watch the six-phase pipeline run.** Walk away. Come back to a `.docx`
chronicle, a recap for Discord, and the quotes worth keeping. On a real 3-hour
session the pipeline takes about half an hour, plus 20–30 minutes before that if
Whisper is transcribing the audio too.

> [!NOTE]
> **Screenshots are being retaken.** The previous ones showed an older layout
> that has since been rebuilt, and a stale screenshot is worse than none — it
> teaches you to look for a button that is no longer there.

*A full walkthrough video is on the [roadmap](docs/about/roadmap.md); for now, a step-by-step text walkthrough lives at [docs/walkthrough.md](docs/getting-started/quickstart.md).*

---

## What Tusk's Tomes does

Tusk's Tomes is a **locally-hosted AI session chronicler for tabletop RPGs** — a desktop app that turns a D&D, Pathfinder, or any-TTRPG session transcript into a polished narrative recap grounded in *your* glossary and *your* campaign lore — not the model's generic fantasy hallucinations. Plug in any cloud LLM (Gemini direct, or ~400 models via a single OpenRouter key), point it at a transcript, get back a chronicle plus a curated list of quotes, jests, and gore.

**Input options:** pasted transcript text · YouTube `.sbv` captions · `.docx` / `.pdf` notes · Discord voice recordings via [Craig](https://craig.chat) (multi-track FLAC zip — Audio Transcription add-on) · raw `.flac` / `.wav` / `.mp3` files.

**Output:** a saved `.docx` chronicle + an in-app browser view + the source transcript (cleaned, ground-truth speakers + names corrected) + optional bullet condensation + extracted quotes / jests / gore lists.

**How the pipeline works (6 phases, one click):**

```
Transcript ──► Phase 1 ──► Phase 2 ──► Phase 3 ──► Phase 4 ──► Phase 5 ──► Phase 6 ──► Chronicle
              Ground       Audit       Chronicle    Extras      Polish      Condense    (.docx
              (speakers    (DM         (narrative   (quotes,    (local-     (optional   + .md
              + lore)      questions)  prose)       jests,      LLM only)   shorter      + on-screen)
                                                    gore)                   recap)
```

**One key, around 400 models.** A single OpenRouter key fills the picker with
most of the commercial model landscape — every Anthropic and OpenAI model at
pass-through rates, and a great many others besides. There is no per-vendor
account to open, no second or third key to manage, and no adapter waiting to
be written before a new model becomes usable: it simply appears in the list.
Pair it with a direct Gemini key if you want Gemini at its cheapest, and that
is the whole of the setup.

**Pick a model per phase, with the evidence in front of you.** Advanced routing
gives each phase one row: the model in effect, what that phase costs on it, and
what the phase actually wants from a model. The picker covers every configured
connection — your Gemini key, a Claude Code or Codex subscription, ~400 models
via OpenRouter, and any local runner — grouped by *how the call is billed*
rather than by who made the model. Filter to models graded on real session
material, or to those measured to carry mature content without sanitising it.

**Mix models, and recover when one underperforms.** Assign different phases to different connections, and when a finished chronicle's extras or recap come out weak — or a provider declined the spicier moments — use **Chronicle Reforge** to re-run just the later phases on a different model (e.g. let one model write the prose, then redo quotes/jests/gore and the condensed recap on another). If a provider declines individual chunks, they're flagged in the output and a one-click **repair** re-processes only those on another provider. See [docs/reforge.md](docs/chronicling/reforging.md).

**The three convictions this project is built on:**

1. **Local-first beats someone else's server.** Your decades-long homebrew should never disappear because a startup pivoted, and your table's audio should not sit on a machine you cannot see. Your lore, your keys, your hardware, your rules.
2. **AI should empower creativity, not replace it.** Tomes is a *scribe*, not a co-DM — it writes down what your players said, not what it thinks they should have said.
3. **Tools for tables.** Built for kitchen-table games and small Discord servers. MIT-licensed, so it can be read, changed and forked. No account, no telemetry, no rug-pull risk.

---

## How Tusk's Tomes compares

### Against other tools built for tabletop

There is a real category here now — Tabletop Scribe, DnD Scrybe, DM Scribe,
Kazkar, SessionKeeper, Saga20, Loreify, GM Assistant, The DM's ARK and more
arriving. They're built by people who play, several handle speaker attribution
well, and if one of them suits your table then genuinely use it. Some are
subscriptions and some sell credit by the session, so being free was never the
interesting difference.

The differences that are real are narrower than a feature list — and one of
them goes against us:

| | Tusk's Tomes | Purpose-built TTRPG services |
|---|---|---|
| **Where your session audio goes** | Stays on your machine | Uploaded to their servers |
| **How lines get attributed** | Known — each player is a separate Craig track, transcribed on its own | Usually inferred from one mixed recording |
| **Which model writes it** | Yours to choose: Gemini, ~400 via OpenRouter, a Claude Code or Codex subscription, or fully offline | Whichever the service runs |
| **Changing how it writes** | Prompts, personas and per-phase routing are all yours; MIT, so fork it | Whatever the product exposes |
| **Getting started** | Install Node, add Craig to your Discord, ideally a GPU | Sign up and upload a file |

That last row is the honest cost of the second one. No software can attribute
dialogue to the right player unless it is fed something that already knows who
was speaking — so the only way to *know* rather than infer is to record each
person separately in the first place, and that means Discord, Craig and a bit
of setup. If you'd rather upload one file and get something back, one of the
services above will serve you better, and that is a real recommendation rather
than false modesty.

### Against meeting transcribers and general AI

| | Tusk's Tomes | Otter.ai / Read.ai | Descript | NotebookLM | ChatGPT-only |
|---|---|---|---|---|---|
| **Cost** | Free & open-source software; pay only for your chosen LLM API (~$1–$5/session) | $15+/month subscription | $15+/month | Free tier (Google account) | $20/month |
| **Privacy** | Local-first, your machine | SaaS, audio uploaded | SaaS, audio uploaded | Google servers | OpenAI servers |
| **TTRPG-aware** | Yes — glossary, speaker names, lore grounding | No — generic meeting transcripts | No — generic video editing | Generic notebook tool | Generic chat |
| **Per-speaker attribution** | Yes via Craig multi-track | Voice diarisation (often wrong) | Manual labelling | No | No |
| **Narrative chronicle output** | Yes — `.docx` + on-screen prose | Bullet meeting notes only | Edit-the-audio focus | Q&A over notes | Whatever you prompt |
| **Multi-LLM** | Gemini + ~400 via OpenRouter + local | Single proprietary model | Single proprietary model | Gemini only | OpenAI only |
| **Resumable** | Yes — pause & resume across days | No | No | No | No |
| **Open source** | MIT | Closed | Closed | Closed | Closed |
| **Offline mode** | Yes — Ollama / LM Studio | No | No | No | No |

If you want **a meeting transcript**, Otter is great. If you want **a narrative recap of your session, written by a scribe who knows your party and never sees your audio**, that's specifically what Tomes is for.

---

## Prerequisites

- **Node.js 20+** — [download from nodejs.org](https://nodejs.org/)
- **Git** — [download from git-scm.com](https://git-scm.com/)

That's it for the core install. Only one optional module installs anything: Audio Transcription needs Python 3.10–3.12 on your PATH. Everything else ships with the app — see [AddOns.md](docs/extras/README.md).

## Quick start — install Tusk's Tomes

```sh
git clone https://github.com/KochiTusker/Tusks-Tomes.git
cd Tusks-Tomes
```

Then double-click `setup.bat` (Windows) or run `bash setup.sh` (macOS / Linux). The setup script handles `npm install` and `.env` scaffolding. Open <http://localhost:5173>.

Add at least one LLM API key in **Settings → Providers & models** (Gemini or OpenRouter) — encrypted at rest, machine-bound, never sent anywhere except to the provider.

 **First time setting up?** Glance at the [security quick reference](docs/security/overview.md) — short, plain English, takes one minute. Covers what's safe by default, what you can change that might be less safe, and the residual risks we can't fix in code.

 **Full setup walkthrough, troubleshooting, and updating instructions:** [SETUP.md](docs/getting-started/installation.md)

---

## Cost

**Tusk's Tomes is free.** MIT-licensed, no subscription, no account, no telemetry, no paywall.

Tusk's Tomes itself is free and open-source — there's no payment to the project. The only money involved is your chosen **LLM API key**:

- **Gemini** — a paid (billing-enabled) Google API key is required for the main pipeline. Roughly $1–$5 for a three-hour session depending on which routing you pick. An optional free-tier Gemini key can be configured as a Smart Budget secondary that handles Phase 4 extras only. See [what it costs](docs/models/costs.md).
- **OpenRouter** — one key, around 400 models, including every Anthropic and OpenAI model at pass-through rates. Cost depends entirely on which models you route to. See [what it costs](docs/models/costs.md) for the current per-routing figures, priced against the live catalogue.
- **Local LLMs** — zero cost. Built in; you supply the runner. See [AddOns.md](docs/extras/README.md#local-llms).
- **Claude Code subscription** — no API key; uses your own Claude Pro/Max plan. See [the Claude Code guide](docs/extras/claude-code.md). No per-session cost, but it draws on your plan's rolling usage limits — **in testing, one full session used up to ~60% of a 5-hour usage window**, so plan for roughly one or two sessions per window, or hand the cheaper phases to another model via per-phase routing or Reforge.

> [!WARNING]
> **Why a paid key is required.** When Tomes first launched, Google's free tier gave access to Pro-class Gemini models, which made a fully free workflow viable. Google has since moved Pro models behind billing, and free Flash on its own is too rate-limited to carry a 3-hour session's main pipeline. The project has been engineered to keep API costs as low as possible (prompt caching, audit-skip, per-tier chunk sizing, Smart Budget routing) — see [docs/providers.md → Making it cheaper](docs/models/choosing-a-provider.md#making-it-cheaper--ongoing-cost-reduction-work) for the architectural details.

> [!NOTE]
> **Got a free-tier Gemini key?** Save it for [**Tusk's Vault**](https://github.com/KochiTusker/Tusks-Vault) — the upcoming AI-chatbot companion that lets you ask questions of your campaign lore in natural language. Vault's per-query token use is much lower than Tomes' six-phase pipeline, so a free quota fits its workload comfortably. Vault is due to release soon; if you're picking up a Google Gemini key primarily for the free tier, Vault is where it earns its keep.

---

## Optional modules

The core install handles paste-a-transcript chronicling against any cloud LLM. Seven modules extend it.

> [!TIP]
> **Only one of them installs anything.** The other six ship with the app and
> are always available — no Install button, no progress log, no server
> restart. Whether one is *usable* (a CLI on your PATH, a runner that's
> actually running, a vault path you've set) is something each module detects
> and tells you.

- **Audio Transcription** *(installs — Python environment, ~1.5 GB)* — Whisper sidecar + [Craig](https://craig.chat) multitrack ingest + direct audio drop-in. **Per-speaker attribution end-to-end** — every line in the chronicle is correctly assigned to the right player and character. Much better than YouTube `.sbv` workflows.
- **whisper.cpp bridge** — the route for AMD, Intel and Apple GPUs, which the Whisper sidecar above can't accelerate. You compile the build; Tomes detects it, checks what it can actually do, and falls back to the built-in engine rather than failing your run.
- **Local LLMs** — route any phase through Ollama / LM Studio / Unsloth. Fully offline if you want it; mix-and-match per phase if you want the cheap-and-good sweet spot.
- **Chronicle Personas** — swap the locked bardic narrator voice for one of six presets (Arnold, Homer, Peter, Gandalf, Mike Tyson, Donkey) or your own.
- **Claude Code (your subscription)** — power the pipeline with your own Claude Code (Pro/Max) plan instead of an API key.
- **Codex (your ChatGPT subscription)** — the same idea for an OpenAI subscription: run phases through a locally-installed Codex CLI with no API key. Completely independent of Claude Code — use either, both, or neither.
- **Obsidian Vault lore** — ground chronicles against an existing Obsidian vault instead of the Tusks-Lore folder. Read-only: the app reads your notes' frontmatter aliases and bodies, and never writes into the vault.

> [!CAUTION]
> **Subscription routing is token-heavy.** In testing, one full session used up
> to ~60% of a rolling 5-hour Claude usage window. Pair it with Reforge (below)
> to keep the cheaper phases on another model.

If a subscription hits its usage window mid-run, the run pauses itself and resumes at the exact chunk it stopped on — nothing is lost.

**Full module guide:** [AddOns.md](docs/extras/README.md)

---

## Walkthrough

The fastest way to understand what running Tomes feels like: read [docs/walkthrough.md](docs/getting-started/quickstart.md) — a step-by-step first-session guide from "I have a transcript" through "I have a finished chronicle saved to disk", including what happens if you hit a free-tier rate limit mid-run (you can pause now and resume tomorrow when the quota resets).

---

## The Tusk's trio — Tomes, Vault, and Lore

Tusk's Tomes has two siblings, both auto-detected when they're dropped next to it on disk:

| Tusk's Tomes (this repo) | Tusk's Vault (coming soon) | Tusk's Lore |
|---|---|---|
| Records → transcribes → chronicles each session | Indexes the whole campaign and answers questions about it in Discord — releasing soon | Shared on-disk archive of finished chronicles + lore documents |
| Use case: "Write me a recap of Session 17" | Use case: "`@Tusk` who is Vellichor the Pale?" | Use case: "Save chronicles as `.docx` for both projects to read" |
| [github.com/KochiTusker/Tusks-Tomes](https://github.com/KochiTusker/Tusks-Tomes) | [github.com/KochiTusker/Tusks-Vault](https://github.com/KochiTusker/Tusks-Vault) (publishing imminently) | A folder Tomes creates for you — no separate repo |

Drop all three side-by-side on disk (e.g. `Documents/Tusks-Tomes/`, `Documents/Tusks-Vault/`, `Documents/Tusks-Lore/`) and they find each other automatically.

> ** Got a free-tier Gemini key?** Vault is the better home for it. Vault is a single retrieval-augmented query per turn — orders of magnitude lower token use than Tomes' six-phase generation pipeline — so a free Gemini quota carries Vault's workload comfortably. Tomes itself requires a paid key for the main pipeline (see [docs/providers.md](docs/models/choosing-a-provider.md)); a free key, if you have one, is optional in Tomes (Smart Budget extras only) and far more valuable on Vault.

 **Setup details:** [docs/vault.md](docs/extras/tusks-vault.md)

---

## Documentation

The full docs live under [`docs/`](docs/) so this page stays readable. Headline destinations:

| Getting started | Using it | Reference |
|---|---|---|
| [Setup walkthrough](docs/getting-started/installation.md) | [First-session walkthrough](docs/getting-started/quickstart.md) | [Architecture](docs/about/how-its-built.md) |
| [Beginner's guide](docs/getting-started/without-a-terminal.md) | [Workflows](docs/importing/README.md) | [Configuration & disk layout](docs/settings/configuration.md) |
| [Dependencies](docs/getting-started/requirements.md) | [Features](docs/about/features.md) | [Privacy & security](docs/security/overview.md) |
| [LLM providers](docs/models/choosing-a-provider.md) | [Use cases](docs/about/who-its-for.md) | [Pricing](docs/models/costs.md) |
| [Modules](docs/extras/README.md) | [Comparison to alternatives](docs/about/comparison.md) | [Tusk's Vault pairing](docs/extras/tusks-vault.md) |
| [Audio Transcription](docs/extras/audio-transcription.md) | [FAQ](docs/troubleshooting/faq.md) | [Security](.github/SECURITY.md) |
| [whisper.cpp bridge](docs/extras/whisper-cpp.md) | [Chronicle Reforge](docs/chronicling/reforging.md) | [Model routing](docs/models/per-phase-routing.md) |
| [Local LLMs](docs/extras/local-llms.md) | [Recommended settings](docs/chronicling/recommended-settings.md) | [Known bugs](docs/troubleshooting/known-issues.md) |
| [Chronicle Personas](docs/extras/personas.md) | | |
| [Claude Code](docs/extras/claude-code.md) · [Codex](docs/extras/codex.md) | | |
| [Obsidian Vault lore](docs/extras/obsidian-vault.md) | | |

Project meta: [Roadmap](docs/about/roadmap.md) · [Contributing](CONTRIBUTING.md) · [License](LICENSE)

---

## Community & feedback

<a href="https://docs.google.com/forms/d/e/1FAIpQLSdxdqOhb1SQvI3fs50gMJv_Cesh2MuxUm95QO2iZia5sFhyyQ/viewform?usp=header" target="_blank"><img src="https://img.shields.io/badge/Share_Feedback-Google_Form-4285F4?style=for-the-badge&logo=googleforms&logoColor=white" alt="Share feedback via Google Form" height="56" /></a>

A dedicated **Discord community** for Tusk's Tomes and [Tusk's Vault](https://github.com/KochiTusker/Tusks-Vault) is on the [roadmap](docs/about/roadmap.md) — if there's enough interest, a server will be spun up for setup help, feature ideas, chronicle showcases, and dev talk. For now, the **feedback form above** is the fastest way to ask a question, request a feature, share a chronicle, or signal that you'd like to see a community Discord exist.

> ** Early days.** The feedback collected now genuinely shapes what Tusk's Tomes becomes — and how big the community channel needs to be when it launches.

[** Share feedback →**](https://docs.google.com/forms/d/e/1FAIpQLSdxdqOhb1SQvI3fs50gMJv_Cesh2MuxUm95QO2iZia5sFhyyQ/viewform?usp=header)

---

## Tech stack

TypeScript + a small Python sidecar (for the optional Audio Transcription add-on). Node 20+ runtime. Express + Vite middleware sharing one port. React 19 + Tailwind on the frontend. `@anthropic-ai/sdk` / `openai` / `@google/genai` for cloud LLMs, with adaptive per-provider pacing read from response headers. AES-256-GCM (machine-bound scrypt key) for the keystore.

 **Full architectural breakdown:** [architecture.md](docs/about/how-its-built.md)

---

## Support the project

**Free (30 seconds):** [Star the repo](https://github.com/KochiTusker/Tusks-Tomes) · [Share feedback](https://docs.google.com/forms/d/e/1FAIpQLSdxdqOhb1SQvI3fs50gMJv_Cesh2MuxUm95QO2iZia5sFhyyQ/viewform?usp=header) · tell another DM · paste a chronicle into the form's "share a chronicle" question.

**Free (a bit more):** file bug reports · send PRs · vote on roadmap items.

**With money:** [Buy me a coffee](https://buymeacoffee.com/kochitusker) · [Support Craig](https://craig.chat) (the Audio Transcription add-on literally doesn't exist without them).

Tusk's Tomes is MIT-licensed and free forever. **Nothing here is paywalled, ever.**

---

## Frequently asked questions

<details>
<summary><strong>How do I automatically generate a D&D session recap from a recording?</strong></summary>

Install Audio Transcription from **Settings → Transcription** (one click — bootstraps a local Whisper sidecar). Drop your Craig multi-track zip or a single `.flac` / `.wav` / `.mp3` onto the **Sessions** tab, where uploading is the first thing on the page. Tomes transcribes per speaker, runs the 6-phase pipeline (grounding → audit → chronicle → extras → polish → optional condense), and saves a `.docx` to your Tusks-Lore folder. End-to-end on a 3-hour session: ~12 minutes on a modern NVIDIA GPU, ~90 minutes on CPU.

</details>

<details>
<summary><strong>Does Tusk's Tomes upload my recordings or transcripts anywhere?</strong></summary>

No. The transcription (Whisper) runs entirely on your machine. The chronicle-generation phases send the transcript to the LLM provider you configured (Gemini, or OpenRouter), which is the only network hop. Use the Local LLMs add-on for fully offline operation with no network at all.

</details>

<details>
<summary><strong>What's the difference between Tusk's Tomes and Otter.ai, Descript, or Read.ai?</strong></summary>

Those tools produce meeting transcripts and bullet summaries — useful for business meetings, weak for TTRPG sessions. Tomes is TTRPG-aware: it grounds speaker names against your roster, applies your campaign glossary (so the cleric's name isn't spelled three different ways), writes a *narrative chronicle* (not bullets), and extracts memorable quotes / jests / gore as separate lists. It also runs locally instead of as a SaaS, and it costs API credits (roughly $0–$5 per session) rather than a $15+/month subscription. See the comparison table above.

</details>

<details>
<summary><strong>Can I use Tusk's Tomes with Pathfinder, Call of Cthulhu, Daggerheart, Vampire: The Masquerade, etc.?</strong></summary>

Yes. The chronicler is system-agnostic — it works from a transcript and a glossary, both of which you define. The default prompts use D&D-flavoured language ("the party", "the session") but the lore grounding works for any system. The Tome of Lore tab is where you tell Tomes your campaign's canonical names, places, deities, and house terms.

</details>

<details>
<summary><strong>Do I need a beefy GPU?</strong></summary>

No for cloud LLM mode — anything that runs Node 20 is fine, including most laptops. The Audio Transcription add-on benefits hugely from an NVIDIA GPU (RTX 3060+ recommended for fast transcription; CPU also works but a 3-hour session takes ~90 min instead of ~12). The Local LLMs add-on benefits from a GPU with ≥8 GB VRAM; without one, route only Phases 1 / 4 (the small ones) to local models and Phases 2 / 3 to cloud.

</details>

<details>
<summary><strong>What about my Craig recordings — can Tomes import them directly?</strong></summary>

Yes. Drop the Craig multi-track `.zip` file onto the **Sessions** tab. Tomes extracts each speaker's FLAC track, runs Whisper per-speaker (so attribution is perfect), and stitches the result into a single transcript with timestamps. Multi-part recordings (Craig splits long sessions into 1-hour chunks) are handled — drop all parts, they'll be ordered correctly.

</details>

<details>
<summary><strong>Is this safe to run on my Windows PC?</strong></summary>

Yes. The default install binds to `127.0.0.1` (only your machine reaches it), API keys are AES-256-GCM encrypted with a machine-bound key, and the server has no exposed write surface to the LAN unless you explicitly set `TUSKS_HOST=0.0.0.0` plus `TUSKS_LAN_WRITES=1`. See [docs/security-quickref.md](docs/security/overview.md) for the plain-English security model.

</details>

<details>
<summary><strong>How do I use Tusk's Tomes from my tablet, phone, or another laptop on the same Wi-Fi?</strong></summary>

Two environment variables let you opt into cross-device access — independent toggles, the second only matters if the first is set:

- **`TUSKS_HOST=0.0.0.0`** — listen on every network interface. Other devices on the same Wi-Fi can now open `http://<host-machine-IP>:5173` and **READ** everything: browse the session list, read chronicles, view transcripts, watch live transcription progress. They cannot upload, save, or modify anything.
- **`TUSKS_HOST=0.0.0.0` + `TUSKS_LAN_WRITES=1`** — also allow writes from LAN devices: upload audio, save chronicles, edit glossary, run the pipeline. Your API keys, the "Test connection" button, the updater, and the local-LLM launcher stay loopback-only **always** — even with full write access, LAN devices can't spend your money or modify your host machine's state.

**When to turn this on:** Tomes machine in another room, home server setup, recording on one machine + chronicling on another, players who want to view transcripts in real time. **When NOT to:** any network you don't fully control (hotel, café, conference, apartment shared Wi-Fi, dorm), or if you have IoT devices you wouldn't want browsing your chronicle. The default is safe; you can flip it on later.

**Threat model:** you trust every device on your Wi-Fi. Smart TV, smart speakers, kid's tablet, visiting friend's laptop, every IoT thing — all of them can read everything (and modify everything if `TUSKS_LAN_WRITES=1`). Your API keys stay encrypted and loopback-gated regardless.

Full walkthrough with PowerShell / bash commands and the complete can/can't table: [docs/security-quickref.md → Cross-device LAN access](docs/security/overview.md#cross-device-lan-access-tusks_host--tusks_lan_writes--i-want-to-use-tomes-from-my-tablet--phone--laptop-on-the-same-wi-fi) and [SETUP.md → Cross-device use](docs/getting-started/installation.md).

</details>

<details>
<summary><strong>How much does it cost to run one session through Tomes?</strong></summary>

Depends on the routing you pick — roughly $1–$5 for a three-hour session on a paid Gemini key, about a dollar through OpenRouter, and $0 on a subscription CLI or a local model. Tomes itself is free and open-source; those are the API spend only. [What it costs](docs/models/costs.md) carries the current figure for every routing, priced against the live catalogue on each publish.

</details>

<details>
<summary><strong>Can I contribute?</strong></summary>

Yes — issues and PRs welcome on [GitHub](https://github.com/KochiTusker/Tusks-Tomes/issues). A community Discord is on the [roadmap](docs/about/roadmap.md); until it launches, the [feedback form](https://docs.google.com/forms/d/e/1FAIpQLSdxdqOhb1SQvI3fs50gMJv_Cesh2MuxUm95QO2iZia5sFhyyQ/viewform?usp=header) is the best out-of-band channel for design questions. See [CONTRIBUTING.md](CONTRIBUTING.md) for the dev workflow.

</details>

---

## License

[**MIT**](LICENSE) — fully open source, [OSI-approved](https://opensource.org/license/mit/). Use it, fork it, modify it, redistribute it, ship it inside your own product, sell support around it. The only requirement is that the original copyright notice and licence text travel with the code.

Just don't blame us if your party's worst quotes make it into the chronicle.

---

<div align="center">

**What problems does this solve?** "How do I automate my D&D session notes" · "How do I turn a Craig recording into a story" · "How to write a session recap automatically" · "Open-source alternative to Otter.ai for tabletop" · "Self-hosted Descript alternative for D&D" · "Free AI tool to summarise a TTRPG session" · "Best Whisper workflow for Discord voice campaigns" · "Local-first AI scribe for Dungeons and Dragons" · "How to transcribe Craig multi-track FLAC for D&D" · "Per-speaker attribution Whisper TTRPG" · "AI Dungeon Master journal" · "Automatic chronicle for tabletop campaigns"

**Keywords**: D&D session transcript tool · Dungeons and Dragons AI chronicler · TTRPG session recap generator · D&D campaign journal automation · local Whisper Discord transcription · Craig bot multitrack transcription pipeline · self-hosted D&D recap · open-source Pathfinder session notes · Call of Cthulhu session log automation · Blades in the Dark session log · Vampire: the Masquerade chronicle generator · Daggerheart session recap · Fabula Ultima chronicler · Mothership session log · Old-School Renaissance OSR session notes · Shadowrun campaign chronicler · free alternative to Otter.ai for D&D · free alternative to Descript for tabletop · NotebookLM for D&D recaps · self-hosted alternative to Read.ai for TTRPG · self-hosted alternative to Recall.ai for D&D · self-hosted alternative to Fireflies.ai for tabletop · Foundry VTT companion transcription tool · Roll20 session recap automation · Owlbear Rodeo session log · YouTube SBV cleanup for TTRPG · run-your-own AI for tabletop campaigns · AI Dungeon Master assistant · AI Game Master scribe · Discord voice recording transcription · faster-whisper TTRPG · Whisper.cpp D&D · OpenAI Whisper Discord recording · Gemini D&D recap · Claude D&D chronicler · Anthropic Claude TTRPG · OpenAI GPT D&D session notes · Ollama local LLM TTRPG · LM Studio D&D · Unsloth TTRPG · local AI TTRPG tool · modular AI scribe · opt-in add-on architecture · anti-subscription D&D transcription · private campaign recording · privacy-first TTRPG tool · MIT-licensed TTRPG chronicler · best free D&D transcription tool · how to automate D&D session notes · how to transcribe a Discord D&D session · how to recap a tabletop session with AI · per-speaker diarisation TTRPG · per-character attribution session log · Critical Role-style recap generator · narrative chronicle from transcript · narrative session log AI

</div>
