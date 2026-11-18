<div align="center">

# Tusk's Tomes

### Turn a recording of your D&D, Pathfinder or any other tabletop session into a chronicle that reads like a chapter of a book.

**A local-first session chronicler. Open source, MIT-licensed.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node 22+](https://img.shields.io/badge/Node-22%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![GitHub last commit](https://img.shields.io/github/last-commit/KochiTusker/Tusks-Tomes?color=8B6F2C)](https://github.com/KochiTusker/Tusks-Tomes/commits/main)

*Paste a transcript or drop a Craig recording, walk away, come back to a chronicle.*

**[Documentation](https://kochitusker.github.io/Tusks-Tomes/docs/)**
&nbsp;·&nbsp;
[Sample chronicles](https://kochitusker.github.io/Tusks-Tomes/examples/)
&nbsp;·&nbsp;
[Installation](https://kochitusker.github.io/Tusks-Tomes/docs/getting-started/installation/)

<p>
  <a href="https://docs.google.com/forms/d/e/1FAIpQLSdxdqOhb1SQvI3fs50gMJv_Cesh2MuxUm95QO2iZia5sFhyyQ/viewform?usp=header" target="_blank"><img src="https://img.shields.io/badge/Share_Feedback-Google_Form-4285F4?style=for-the-badge&logo=googleforms&logoColor=white" alt="Share feedback via Google Form" height="50" /></a>
  &nbsp;
  <a href="https://buymeacoffee.com/kochitusker" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-violet.png" alt="Buy Me a Coffee" height="50" /></a>
</p>

</div>

## Why I built this

I wanted a record of my campaign. Not minutes, the actual story: the bit where
the plan fell apart in an interesting way, the joke that had everyone crying,
the line the DM delivered that made the table go quiet for a second.

Everyone at every table says they'll write it up. Almost nobody does. I managed
it once.

The obvious tools didn't fit. Meeting transcribers are built for standups: you
get a transcript and some bullet points about what was "discussed", processed
on someone else's server. None of them have the faintest idea who your
characters are. They hear an invented fantasy name, guess a spelling, and use
that guess with total confidence for four hours straight.

So I built Tusk's Tomes. It takes a session recording or transcript and writes
it up three ways: a chronicle you'll want to reread, a recap you can paste into
Discord, and a list of the lines worth remembering. It checks names and places
against your own campaign glossary, so the cleric's name comes out spelled the
same way every time.

It's for anyone at the table: the DM with a backlog of sessions nobody wrote
up, the player who wants to remember what their character actually said, the
solo player recording their own narration, the group that streams its games.
It doesn't care what system you play. [Who it's for](https://kochitusker.github.io/Tusks-Tomes/docs/about/who-its-for/)
goes into more detail.

You stay in control of all of it. Your recordings never leave your machine,
because transcription runs locally; the only thing that goes out is the text
you send to the model you picked. You choose that model: Gemini, around 400
models through one OpenRouter key, a Claude Code or Codex subscription you
already have, or a local model, in which case nothing leaves at all. There's no
account and no telemetry, and it's MIT-licensed, so the prompts, the narrator's
voice and which model runs each phase are yours to change.

It's a niche tool for a niche group of people, and I'm fine with that. If
you're one of them, hello.

**A fair warning before you get excited:** this is one person's project, tested
on one Windows PC, and it expects you to be comfortable installing Node.js and
running a `.bat` file. [What it installs](https://kochitusker.github.io/Tusks-Tomes/docs/security/what-it-installs/)
lays out exactly what it installs, what it changes, and what could go wrong.

## Quick start

You need:

- **Node.js 22+** — [download from nodejs.org](https://nodejs.org/). Node 22 applies from version 2.7.0; earlier releases run on Node 20.
- **Git** — [download from git-scm.com](https://git-scm.com/)
- **A model to run on:** a Gemini or OpenRouter API key, a Claude Code or Codex
  subscription, or a local runner such as Ollama or LM Studio.

Audio transcription is optional, and it's the only part that installs anything
extra (it needs Python 3.10–3.12). The [requirements page](https://kochitusker.github.io/Tusks-Tomes/docs/getting-started/requirements/)
has the full list.

```sh
git clone https://github.com/KochiTusker/Tusks-Tomes.git
cd Tusks-Tomes
```

| Platform | First time | After that |
|---|---|---|
| **Windows** | Double-click `setup.bat` | Double-click `Start_Tusks_Tomes.bat` |
| **macOS / Linux** | `bash setup.sh` | `bash start.sh` |

The launcher opens <http://localhost:5173> once the app is ready. Add a key in
**Settings → Providers & models**, paste a transcript into the **Chronicle**
tab, and run it.

[Your first chronicle](https://kochitusker.github.io/Tusks-Tomes/docs/getting-started/quickstart/)
walks through a whole first session. [Installation](https://kochitusker.github.io/Tusks-Tomes/docs/getting-started/installation/)
covers updating, uninstalling and what to do when setup fails, and
[Without a terminal](https://kochitusker.github.io/Tusks-Tomes/docs/getting-started/without-a-terminal/)
is for anyone who has never installed software this way.

## How it works

A run goes through five phases. It grounds names and speakers against your
glossary, asks you about anything it can't work out, writes the chronicle, pulls
out quotes, jests and gore, and can condense the result into a shorter recap. A three-hour session takes about
half an hour.

The detail is on the documentation site:

- [How the phases work](https://kochitusker.github.io/Tusks-Tomes/docs/chronicling/how-the-phases-work/): what each phase does and what it costs.
- [Bringing a session in](https://kochitusker.github.io/Tusks-Tomes/docs/importing/): pasted text, YouTube captions, Craig recordings and other audio.
- [Audio transcription](https://kochitusker.github.io/Tusks-Tomes/docs/extras/audio-transcription/): local Whisper, one track per speaker, so every line goes to the right character.
- [Choosing a provider](https://kochitusker.github.io/Tusks-Tomes/docs/models/choosing-a-provider/) and [per-phase routing](https://kochitusker.github.io/Tusks-Tomes/docs/models/per-phase-routing/): which model runs which phase.
- [What it costs](https://kochitusker.github.io/Tusks-Tomes/docs/models/costs/): the per-session figure for each setup, from a paid key down to nothing.
- [Reforging a chronicle](https://kochitusker.github.io/Tusks-Tomes/docs/chronicling/reforging/): rerun the later phases on a different model.
- [Extras and integrations](https://kochitusker.github.io/Tusks-Tomes/docs/extras/): local models, subscriptions, narrator personas, Obsidian and whisper.cpp.
- [Security and privacy](https://kochitusker.github.io/Tusks-Tomes/docs/security/overview/): what's protected by default, and what changes if you open it to your network.
- [How it compares](https://kochitusker.github.io/Tusks-Tomes/docs/about/comparison/): against other tabletop tools and meeting transcribers.
- [Questions I get asked](https://kochitusker.github.io/Tusks-Tomes/docs/troubleshooting/faq/) and [known issues](https://kochitusker.github.io/Tusks-Tomes/docs/troubleshooting/known-issues/).
- [Changelog](https://kochitusker.github.io/Tusks-Tomes/docs/about/changelog/) and [roadmap](https://kochitusker.github.io/Tusks-Tomes/docs/about/roadmap/).

A companion project, [Tusk's Vault](https://github.com/KochiTusker/Tusks-Vault),
is on the way. It will answer questions about your campaign in Discord, drawing on
your chronicles and lore. [Tusk's Vault and Tomes](https://kochitusker.github.io/Tusks-Tomes/docs/extras/tusks-vault/)
explains how the two fit together.

## Feedback and support

The [feedback form](https://docs.google.com/forms/d/e/1FAIpQLSdxdqOhb1SQvI3fs50gMJv_Cesh2MuxUm95QO2iZia5sFhyyQ/viewform?usp=header)
is the quickest way to reach me with a question, a feature request or a
chronicle you want to show off. Bug reports and pull requests are welcome too;
[CONTRIBUTING.md](CONTRIBUTING.md) has the dev workflow.

If you'd like to chip in, [buy me a coffee](https://buymeacoffee.com/kochitusker)
or [support Craig](https://craig.chat). The audio transcription module wouldn't
exist without them.

## License

[MIT](LICENSE). Use it, fork it, change it. Just don't blame me if your party's
worst quotes make it into the chronicle.
