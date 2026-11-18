# Bringing a session in

The hard part was never writing the chronicle. It's getting four hours of six
people talking over each other into text at all. There are three routes, and
which one suits you depends mostly on how you record and what hardware you have
lying about.

## The short version

**C gives the best result, and A is the easiest.** If you're not sure, start
with A or B and move up later. Nothing is locked in — you can use a different
route every week if you like.

![Two questions pick the route, and the routes are lettered top to bottom. Already have a transcript? Then A: paste it in, with nothing to install; it is the easiest. If not: do you play on Discord and want every line attributed? If not, B: YouTube captions, with nothing to install but no speaker labels at all. If so, C: a Craig multitrack recording, which needs the audio module and gives the best result, every line attached to its speaker. All three routes join one line down the right edge into the same five-phase pipeline.](../assets/diagrams/ways-in.svg)

| Route | Needs installing | Who said what? | Suits you if… |
|---|---|---|---|
| **[A — Paste a transcript](a-transcript.md)** | Nothing | Whatever's already in the text | You've got a transcript from somewhere already |
| **[B — Record, let YouTube transcribe](youtube-captions.md)** | Nothing | **None at all** — see the disclaimer on that page | You've no NVIDIA GPU, or you want the least faff |
| **[C — Craig multitrack](session-audio.md)** | Audio Transcription | Every line, correctly | You play on Discord and want it done properly |

## What the routes have in common

Whichever way the text gets in, everything downstream is identical: the same
five-phase pipeline, the same grounding against your glossary and lore, the same
outputs. The route only decides how good the speaker attribution is before the
pipeline starts.

> [!TIP]
> **You are not choosing once.** The route is per session, not per campaign.
> Paste a transcript this week, drop a Craig recording next week — the
> chronicle library treats them the same.

## If a run hits a quota mid-pipeline

Long sessions on a rate-limited key can exhaust a per-minute or daily quota
part-way through. Tomes opens a dialog rather than failing the run, and no work
is lost on any of the paths it offers — your grounded transcript, DM answers and
partial chronicle are all kept.

The full step-by-step is in
[the quickstart](../getting-started/quickstart.md#if-it-gets-stuck--the-rate-limit-dialog).

## The closed-loop promise

Once you've configured the system to your taste — chosen your provider,
populated the glossary, picked your route — the recurring work per session is:

1. Hit a download link or paste a transcript (60 seconds).
2. Click **Run** (zero seconds).
3. Walk away while the pipeline runs; each phase shows its own ETA.
4. Open the finished chronicle when you're back.

**Same three clicks per week, forever.** That's the design goal — minimal
recurring work, maximum recurring value.

## Next

- [Import a transcript](a-transcript.md) — the easiest route
- [Import YouTube captions](youtube-captions.md) — no GPU needed
- [Import session audio](session-audio.md) — the best attribution
- [Recommended settings](../chronicling/recommended-settings.md) — what to run once you're in
