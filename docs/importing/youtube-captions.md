# Import YouTube captions

Upload the session recording to YouTube as unlisted, let Google's automatic
captions transcribe it, and bring the result back as a narrative chronicle
written in your world's own vocabulary. No GPU, no Python, no add-on to install
— the transcription happens on Google's hardware instead of yours.

This is the easiest way to start, and it is the route to use if your graphics
card is not an NVIDIA one. It is also, honestly, not the best output available;
[the audio route](session-audio.md) is better, and the gap is entirely
about knowing who said what. That trade-off is explained properly below rather
than buried.

---

## The short version

| | |
|---|---|
| **You start with** | A video or audio recording you can upload to YouTube |
| **You end with** | A narrative chronicle, a condensed version, catch-up bullets, quotes, jests and combat highlights |
| **You need** | Node.js (to run Tusk's Tomes), a YouTube account, and one way to reach an AI model. That is the whole list |
| **Time** | However long YouTube takes to caption, then the pipeline runs unattended |
| **Cost** | [Your own API credit, by routing](../models/costs.md), or $0 extra on a subscription CLI |
| **The catch** | Caption files carry no speaker labels at all — see below |

![The round trip in two lanes, left to right. On your machine: 1, record the session. An orange arrow marked 'the audio leaves here' carries it to YouTube: 2, upload it, unlisted. 3, automatic captions, which take an hour or two. Back on your machine there are two ways in: download the .sbv and run it through Caption Repair, which is optional, or copy the text. Either way it lands in 4, the raw transcript, and goes on to 5, grounding the names.](../assets/diagrams/youtube-trip.svg)

---

## Step 1 — Record the session

Anything that produces a file YouTube will accept. [OBS Studio](https://obsproject.com)
is free and records a Discord call and your desktop together; a Zoom recording
or a phone on the table works too. Video is not needed for anything — audio with
a still image uploads fine.

---

## Step 2 — Upload it as unlisted or private

In YouTube Studio, upload the file and set visibility to **Unlisted** or
**Private**. Unlisted means it is not indexed, not searchable and not shown on
your channel; only someone holding the link can open it. Private restricts it
further, to you and to accounts you name.

Worth being deliberate here. This route means your session audio reaches Google,
which is exactly what the local Whisper route avoids. If that matters to you —
if your table talks about things it would rather not have sitting on someone
else's servers — use [the audio route](session-audio.md) instead, or read
[is this safe?](../security/what-it-installs.md) first. It is a real trade and you should make
it on purpose.

---

## Step 3 — Wait for automatic captions

YouTube generates them on its own schedule. A three-hour upload is typically
ready within an hour or two of finishing processing; there is no way to hurry
it. The captions appear under **Subtitles** in YouTube Studio once done.

---

## Step 4 — Get the transcript out

Two ways, and they land in the same place.

**Copy the text.** Open the caption track, copy the transcript, and paste it
straight into the **Raw transcript** box on the Chronicle tab. Quickest.

**Download the `.sbv`.** In **Subtitles**, use the **⋮** menu on the caption
track and choose **Download `.sbv`**. Open **Repair a caption file** on the
**Chronicle** tab, choose that file, run **Repair captions**, then **Download corrected .sbv**.
You can also load the `.sbv` straight into the **Raw transcript** box.

The `.sbv` route keeps the timestamps, which helps the pipeline segment the
session sensibly, and Caption Repair does a grounding pass over the cues before
they reach the chronicle pipeline. Pasting plain text is faster. Either way you
end up in the same five-phase pipeline.

---

## Step 5 — Ground it against your lore

Identical to the audio route, and just as load-bearing here.

Automatic captions have never heard of your setting, so unfamiliar names come out phonetically. Hand that to a general-purpose model and it will pick a plausible spelling and stay consistently wrong for the length of the write-up.

![A transcript has two lines, "We reach hollow mirror" after a Music marker and "then Hollow Mear gate" after a Laughter marker. Before any model runs, with no AI and no cost, the markers are stripped and names are swapped using your glossary. Then a model pass, Phase 1, reads your lore, from the Tome of Lore or a vault, and corrects the names, so both misheard spellings become Hollowmere in the grounded transcript. The Audit, Phase 2, turns whatever it cannot settle into questions for you.](../assets/diagrams/how-names-get-corrected.svg)

Phase 1 corrects the transcript before any prose is written, against the **Tome of Lore** tab or an existing vault via the [Obsidian Vault lore](../extras/obsidian-vault.md). Phase 2 hands you what it could not resolve as questions.

Expect more questions on this route than on the audio one. That is the pipeline
doing its job — see the next section for why.

---

## The trade-off, stated plainly

![Two panels with the same layout. In the first, three players talk into one microphone and the result is a single mixed file; every line in its transcript is tagged with a question mark, because who said it is guessed. In the second, each player has a headset and their own track, so every line is tagged with whoever recorded it, the Rogue or the DM, because who said it is known.](../assets/diagrams/one-mic-or-one-track.svg)

**A YouTube caption file contains no speaker labels whatsoever.** Tomes reconstructs who said what from context, and asks you a fair number of clarifying questions to do it. Even after you answer them, attribution is a best guess in places.

> [!WARNING]
> **YouTube censors swearing, and the censorship is in the file.** Automatic
> captions replace profanity with `[ __ ]`, so the transcript you download has
> already lost it. Nothing downstream can put it back — the chronicle is written
> from what the captions say, not from the audio. If your table swears, and the
> way people actually talk is part of what you want recorded, that is a real
> loss rather than a cosmetic one. Whisper transcribes what was said.

| | YouTube captions | Craig multitrack + Whisper |
|---|---|---|
| Speaker labels in the source | None | One track per person |
| Swearing and mature language | Censored to `[ __ ]` | Kept verbatim |
| Attribution in the chronicle | Inferred, usually right | Known |
| DM questions to answer | More | Fewer |
| GPU needed | No | NVIDIA, realistically |
| Audio leaves your machine | Yes, to YouTube | No |
| Needs installing | No add-on | Audio Transcription |

So: if you want the chronicle to reliably say which character did what, record
multitrack. If you mainly want a readable account of the session and can live
with some fuzziness on attribution, this is a perfectly good place to start —
and switching later costs you nothing, because the glossary and lore you build
now carry straight over.

---

## What this costs

No add-on to install and nothing to subscribe to. YouTube's captioning is free.
The only spend is whatever your chosen model provider charges, which depends on
routing, or $0 extra through a Claude Code or Codex subscription you already pay
for. [What it costs](../models/costs.md) has the current figure for each routing.

See [what it costs](../models/costs.md) for the full breakdown, and
[recommended settings](../chronicling/recommended-settings.md) for the routing that gives the
best results per dollar.

---

## Next

- [What you'll need first](../getting-started/requirements.md)
- [Setup guide](../getting-started/installation.md)
- [Caption repair in detail](README.md)
- [The audio route](session-audio.md) — better output, more setup
