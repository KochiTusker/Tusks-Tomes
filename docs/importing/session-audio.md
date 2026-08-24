# Import session audio

Start with a recording of your game — a Discord multitrack, a Zoom export, a
phone on the table — and end with a narrative account of the session written in
your world's own vocabulary. This page follows that one journey end to end: what
happens at each stage, what it costs, how long it takes, and where it is weakest.

If you have no way to record, or no GPU to transcribe with, the
[YouTube transcript route](youtube-captions.md) reaches the same
chronicle by a different road. If you already have a transcript from somewhere
and just want to know which import to use, [Getting a session in](README.md)
is the mechanical version of this page.

---

## The short version

| | |
|---|---|
| **You start with** | An audio recording of one session |
| **You end with** | A narrative chronicle, a condensed version, catch-up bullets, quotes, jests and combat highlights |
| **Time** | About an hour for a three-hour session, unattended |
| **Cost** | [Roughly $1–$5 of your own API credit](../models/costs.md), or $0 fully local |
| **Uploaded anywhere?** | The audio never leaves your machine. Only text reaches a model, and only if you choose a cloud one |

---

## Stage 1 — Record the session

Any recording works. The one that works *best* records each player to their own
track, because that removes the hardest problem in the whole pipeline before it
starts.

**Multitrack, via Discord.** [Craig](https://craig.chat) is a Discord bot that
records every participant to a separate file. Its free tier is enough for this.
When each track contains exactly one person, every line in the finished
chronicle is attributable to the right character without anything having to
guess.

**Single track.** A Zoom recording, an OBS capture, a phone on the table — all
fine, and all land in the same pipeline. You lose per-speaker separation, which
means attribution becomes inference rather than fact. The chronicle will still
read well; it will occasionally put a line in the wrong character's mouth.

There is no minimum quality bar worth stating. Sessions recorded on a laptop
microphone across a kitchen table produce usable chronicles. Crosstalk hurts far
more than bitrate does.

---

> [!TIP]
> **Whisper keeps the swearing.** It transcribes what was said, including
> profanity and crude dialogue. YouTube's automatic captions replace those with
> `[ __ ]` before you ever see the file, and nothing downstream can recover
> them. If the way your table actually talks matters to the record, this route
> is the one that keeps it.

## Stage 2 — Transcribe it, on your own machine

[Audio Transcription](../extras/audio-transcription.md) installs a local Whisper
sidecar. Drop the recording — or the whole Craig zip — into the **Upload** tab
and it transcribes each track separately, then interleaves them into one
timestamped transcript with speakers already attached.

**This is the stage that wants an NVIDIA GPU**, and the word is doing real work.
The engine underneath is `faster-whisper`, whose backend implements exactly two
devices: CUDA and CPU. There is no AMD, Intel Arc or Apple GPU backend, so those
cards are not used at all — a machine with a Radeon in it transcribes at exactly
the same speed as a machine with no graphics card.

| Hardware | Three hours of audio takes |
|---|---|
| NVIDIA GPU | 20–30 minutes |
| Anything else | Several hours |

Either way it runs unattended. If "several hours" is not acceptable, the
[YouTube route](youtube-captions.md) does the transcribing on
Google's hardware instead of yours and needs no GPU, no Python and nothing installed.

Nothing is uploaded at this stage under any configuration. Whisper runs as a
local process against a local file.

---

## Stage 3 — Ground the names against your lore

This is the stage the whole project exists for, and it is worth understanding
before you judge the output.

Speech-to-text has never heard of your setting. It renders unfamiliar proper
nouns phonetically — a homebrew city becomes three different spellings in one
session, a character's name lands as whatever common word it sounds nearest. If
you hand that transcript straight to a general-purpose model and ask for prose,
the model picks a plausible spelling, commits to it, and stays consistently
wrong for forty pages. Consistency reads as confidence, which makes it worse,
not better.

So Phase 1 corrects the transcript *before* any narrative is written:

1. A deterministic pass strips `[Music]` and `[Laughter]` markers and normalises
   whitespace.
2. A second deterministic pass applies your glossary's safe replacements and a
   general D&D dictionary.
3. Only then does a model pass over it, resolving the rest against your lore.

Your lore can come from either of two places. The **Tome of Lore** tab holds
documents and a glossary you maintain in-app. The
[Obsidian Vault lore](../extras/obsidian-vault.md) instead reads an existing
vault, read-only, and grounds against that — which in head-to-head testing
grounded names more reliably, mostly because a vault someone actually maintains
is richer than a glossary they had to remember to fill in.

A large library is not expensive. Up to roughly 100,000 words of lore made no
noticeable difference to the bill.

Phase 2 then compares the raw and corrected transcripts and hands you a list of
what it could not resolve — as questions, rather than as a guess buried in
prose. Answering them takes a few minutes and improves everything downstream.

---

## Stage 4 — Write it up

Phase 3 turns the grounded transcript into continuous narrative. Phase 4 pulls
the quotes, jests and combat highlights out as structured lists. Phase 6
optionally condenses the chronicle to whatever length you set with a slider.

A three-hour session lands at roughly 16,000–18,000 words in full. At the
default condense setting it comes back nearer 3,000.

Everything is editable before you export, and every output is optional. Export
is `.docx` or Markdown.

---

## What the output actually reads like

Continuous prose in a consistent voice, not minutes with bullet points. Player
dialogue is kept where it carries the scene; the DM's narration comes back as
narration rather than as quoted lines attributed to a person called "the Dungeon
Master". [What it does](../about/features.md) covers each of the five outputs, and the
project's home page carries sample extracts from a real session.

---

## What this costs

| Route | Per three-hour session |
|---|---|
| Paid Gemini key | [~$1–$5, by routing](../models/costs.md) |
| Claude Code or Codex CLI subscription | $0 extra — draws on an allowance you already pay for |
| Fully local (Ollama, LM Studio, Unsloth) | $0 |
| Mixed — mechanical phases local, chronicle to cloud | Pennies |

The honest caveat on fully local: below roughly 15–20B parameters the chronicle
phase tends to read like a log rather than a story, and grounding is less
reliable too. Running the mechanical phases locally and sending only Phase 3 to
a cloud model keeps most of the saving and all of the prose quality.

See [what it costs](../models/costs.md) for the full breakdown.

---

## Where this route is weak

- **Crosstalk.** Multitrack solves attribution, not people talking over each
  other. Heavy overlap degrades the transcript itself.
- **Non-NVIDIA hardware.** Not slow — unaccelerated. Plan around it.
- **Out-of-character tangents.** Twenty minutes of pizza logistics is
  transcribed as faithfully as the boss fight. The chronicle handles it better
  than you would expect, but it is not magic.
- **Platform maturity.** Windows is the tested platform. Linux and macOS are
  expected to work and have not been through a real session here.

---

## Next

- [What you'll need first](../getting-started/requirements.md) — including how to check what you
  already have
- [Setup guide](../getting-started/installation.md)
- [Recommended settings](../chronicling/recommended-settings.md) — the routing that produced
  the samples
- [The YouTube transcript route](youtube-captions.md) — no GPU,
  nothing to install
