# How it compares

I tried most of the meeting tools before writing my own, so that part is a fair
account rather than a sales pitch. They're genuinely good software, just built
for meetings, and a session isn't a meeting.

The tabletop-native tools are a different matter and deserve saying plainly:
there is a real category of them now, several arrived after this project
started, and I have not sat down with all of them. What's below is what they
are built to do, not a ranking of how well they do it.

| Tool | Built for TTRPG? | Audio stays local? | Recap quality | Cost |
| --- | --- | --- | --- | --- |
| **Tusk's Tomes** | Yes — speaker-aware, glossary-grounded, written as prose | Yes, once Audio Transcription is installed | Narrative, six-phase pipeline | Free (MIT) + your own API usage |
| Writing it up yourself | n/a | Yes | However good you are at 11pm | Free, plus your Sunday evening |
| [Otter.ai](https://otter.ai) | No — meeting transcription | No | Fine for meetings, poor on invented names | Subscription |
| [Descript](https://www.descript.com) | No — podcast editing | No | It's an editor, not a chronicler | Subscription |
| [NotebookLM](https://notebooklm.google.com) | No — research tool | No | Genuinely good, if you feed it well | Free tier |
| [Read.ai](https://read.ai) / [Recall.ai](https://www.recall.ai) | No — meeting bots | No | Built for Zoom standups | Subscription |
| Purpose-built tabletop services *(Tabletop Scribe, DnD Scrybe, DM Scribe, Kazkar, SessionKeeper, Saga20, Loreify, GM Assistant, The DM's ARK…)* | Yes — that's exactly what they're for | No — uploaded to their servers | Built for this; several do it well | Subscription or credits, depending which |
| [Craig](https://craig.chat) | Yes — but it only records | Yes | n/a — it doesn't transcribe | Free |
| A human transcriber | n/a | Depends | Best there is | $50–$200 a session |

## Being fair about it

**The tabletop-native services** are the comparison that actually matters, and
being vague about them would be a way of avoiding it. They're built by people
who play. Several advertise speaker attribution and mean it. Most will take a
recording and give you a recap without asking you to install anything, which is
a genuine advantage over this project and not a small one.

Two things separate them from what's here, and neither is about quality.

The first is where your session goes. They are services, so the audio of your
friends talking for four hours is uploaded and processed on hardware you don't
control. That may be completely fine with you — but it's a decision worth
making deliberately rather than by default, and it's the one thing none of them
can offer differently, because being a service is what they are.

The second is how a line ends up attached to a player. No software can
attribute dialogue accurately unless it's fed something that already knows who
was speaking. Hand over a single mixed recording — an mp3 off a phone in the
middle of the table, or a bounce out of OBS — and every name on every line is
an inference. Modern diarisation is good, and on a clean recording with
distinct voices it's often right. It is still a guess, it degrades exactly when
your table is at its best (everyone talking at once), and it cannot know that
the voice it's tracking is the one playing the paladin.

Tomes sidesteps that rather than solving it: Craig records each player to their
own file, each file is transcribed separately, and attribution arrives with the
recording instead of being reconstructed afterwards. The cost is that you have
to be playing on Discord with Craig in the server. **On its own YouTube path,
Tomes has exactly the same limitation as everything else in this table** — one
mixed recording in, guesswork out. That path exists because not everyone has a
GPU, not because it solves anything.

**Otter and Read.ai** do what they set out to do perfectly well. Point them at
a standup and you'll get a tidy transcript and sensible action items. Point
them at a session and you get a transcript with the names spelled wrong and a
summary that says the group "discussed next steps". Not their fault — nobody
built them for this.

**NotebookLM** is the closest thing to real competition, and I'd say so even
though it's not what I use. Feed it a clean transcript and the output is
strong. What it won't do is transcribe your Discord recording per-speaker,
correct names against a glossary you maintain, keep character attribution
through to the finished text, or run without uploading anything. If you're
happy doing the front half by hand and you don't mind the upload, it's a
perfectly reasonable option.

**A human transcriber** produces the best result available, by a distance. It
also costs more per session than a year of API credit. If you can afford it,
genuinely, do that instead.

**Craig** isn't a competitor at all — it's the other half. It records
beautifully and does nothing else, which is exactly right. This project is the
part that was missing after it.

## So what's actually different here

Narrowly, three things. Note that "it knows your characters' names" is no
longer one of them — the tabletop-native services ground against your lore too,
and claiming that as a differentiator would be dishonest.

1. **It runs on your machine.** The audio never leaves it, and with a local
   model nothing leaves it at all. This is the only row in the table where
   nothing else comes close, and it's the reason to pick this over a service
   that is easier to start using.
2. **Attribution is known, not inferred.** Per-speaker Craig tracks are
   transcribed separately, so who said what is an input rather than a
   conclusion. Everything downstream — quotes, jests, the chronicle — inherits
   that instead of re-deriving it.
3. **You decide how it comes out.** Which model writes each phase, what the
   narrator sounds like, what the prompts say, how long the recap runs. It's
   MIT, so if the answer you want isn't in the settings it's in the source.

If none of those matter to you, one of the tools above will serve you better
and cost you less effort. That's a genuine recommendation, not false modesty.
The version of this project that tells you it wins on every axis is one you
should trust less, not more.

<details class="docs-section">
<summary><h2>With and without Tusk's Vault</h2></summary>
<div class="docs-section-body">


On its own this is a chronicler: recording in, finished write-up out. Pair it
with **[Tusk's Vault](https://github.com/KochiTusker/Tusks-Vault)** and you can
ask questions of the archive afterwards.

| | Tomes alone | Tomes + Vault |
|---|---|---|
| **Each week** | Transcript → run → save | Transcript → run → send to Vault |
| **"What happened in session 11?"** | Open the file, Ctrl-F | Ask it in Discord and get an answer with citations |
| **Across sessions** | You scroll through seventeen files | It retrieves across all of them |
| **Extra setup** | None | Clone Vault alongside, give it a bot token |
| **Disk** | The chronicles | Plus a small index |

Without Vault this still works completely fine — you just go back to searching
your own files when someone asks who Vellichor the Pale was again. Pairing
details are in [vault.md](../extras/tusks-vault.md).


</div>
</details>
