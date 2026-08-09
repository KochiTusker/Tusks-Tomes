# 📺 YouTube transcript to a lore-grounded chronicle

Upload the session recording to YouTube as unlisted, let Google's automatic
captions transcribe it, and bring the result back as a narrative chronicle
written in your world's own vocabulary. No GPU, no Python, no add-on to install
— the transcription happens on Google's hardware instead of yours.

This is the easiest way to start, and it is the route to use if your graphics
card is not an NVIDIA one. It is also, honestly, not the best output available;
[the audio route](audio-to-chronicle.md) is better, and the gap is entirely
about knowing who said what. That trade-off is explained properly below rather
than buried.

---

## The short version

| | |
|---|---|
| **You start with** | A video or audio recording you can upload to YouTube |
| **You end with** | A narrative chronicle, a condensed version, catch-up bullets, quotes, jests and combat highlights |
| **You need** | Node.js, a YouTube account, and one way to reach an AI model. That is the whole list |
| **Time** | However long YouTube takes to caption, then ~30 minutes unattended |
| **Cost** | Roughly £1–£2 of your own API credit, or £0 fully local |
| **The catch** | Caption files carry no speaker labels at all — see below |

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
else's servers — use [the audio route](audio-to-chronicle.md) instead, or read
[is this safe?](is-this-safe.md) first. It is a real trade and you should make
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
track and choose **Download `.sbv`**. Drop that file into the **Caption Repair**
tab, run **Repair captions**, then **Send to refinement**.

The `.sbv` route keeps the timestamps, which helps the pipeline segment the
session sensibly, and Caption Repair does a grounding pass over the cues before
they reach the chronicle pipeline. Pasting plain text is faster. Either way you
end up in the same six-phase pipeline.

---

## Step 5 — Ground it against your lore

Identical to the audio route, and just as load-bearing here.

Automatic captions have never heard of your setting. Unfamiliar proper nouns
come out phonetically — a homebrew city ends up spelled three ways in one
session, a character's name lands as whatever common word it sounds nearest.
Hand that to a general-purpose model and it will pick a plausible spelling,
commit to it, and stay consistently wrong for the length of the write-up.

Phase 1 corrects the transcript before any prose is written, against a glossary
you maintain in the **Tome of Lore** tab or against an existing vault via the
[Obsidian Vault add-on](add-ons/obsidian-vault.md). Phase 2 then hands you the
things it could not resolve as questions rather than guessing.

Expect more questions on this route than on the audio one. That is the pipeline
doing its job — see the next section for why.

---

## The trade-off, stated plainly

**A YouTube caption file contains no speaker labels whatsoever.** It is one
undifferentiated stream of text. Everything about who said what has to be
reconstructed from context.

Tomes does reconstruct it, and it asks you a fair number of clarifying questions
in order to. Even after you answer them, attribution is a best guess in places —
where the multitrack route simply knows, because each track held one person.

| | YouTube captions | Craig multitrack + Whisper |
|---|---|---|
| Speaker labels in the source | None | One track per person |
| Attribution in the chronicle | Inferred, usually right | Known |
| DM questions to answer | More | Fewer |
| GPU needed | No | NVIDIA, realistically |
| Audio leaves your machine | Yes, to YouTube | No |
| Add-on needed | None | Audio Transcription |

So: if you want the chronicle to reliably say which character did what, record
multitrack. If you mainly want a readable account of the session and can live
with some fuzziness on attribution, this is a perfectly good place to start —
and switching later costs you nothing, because the glossary and lore you build
now carry straight over.

---

## What this costs

Nothing to install and nothing to subscribe to. YouTube's captioning is free.
The only spend is whatever your chosen model provider charges: around £1–£2 per
three-hour session on a paid Gemini key, £0 extra if you route through a Claude
Code or Codex CLI subscription you already pay for, or £0 fully local.

See [what it costs](pricing.md) for the full breakdown, and
[recommended settings](recommended-settings.md) for the routing that gives the
best results per pound.

---

## Next

- [What you'll need first](dependencies.md)
- [Setup guide](../SETUP.md)
- [Caption repair in detail](workflows.md)
- [The audio route](audio-to-chronicle.md) — better output, more setup
