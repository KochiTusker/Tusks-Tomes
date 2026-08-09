# 🆚 How this compares to the alternatives

I tried most of these before writing my own, so this is a fair account rather
than a sales pitch. Several of them are genuinely good software. They're just
built for meetings, and a D&D session isn't a meeting.

| Tool | Built for TTRPG? | Audio stays local? | Recap quality | Cost |
| --- | --- | --- | --- | --- |
| **Tusk's Tomes** | Yes — speaker-aware, glossary-grounded, written as prose | Yes, via the audio add-on | Narrative, six-phase pipeline | Free (MIT) + your own API usage |
| Writing it up yourself | n/a | Yes | However good you are at 11pm | Free, plus your Sunday evening |
| [Otter.ai](https://otter.ai) | No — meeting transcription | No | Fine for meetings, poor on invented names | Subscription |
| [Descript](https://www.descript.com) | No — podcast editing | No | It's an editor, not a chronicler | Subscription |
| [NotebookLM](https://notebooklm.google.com) | No — research tool | No | Genuinely good, if you feed it well | Free tier |
| [Read.ai](https://read.ai) / [Recall.ai](https://www.recall.ai) | No — meeting bots | No | Built for Zoom standups | Subscription |
| [Craig](https://craig.chat) | Yes — but it only records | Yes | n/a — it doesn't transcribe | Free |
| A human transcriber | n/a | Depends | Best there is | £40–£150 a session |

## Being fair about it

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

Narrowly, three things:

1. **It knows who your characters are.** Grounding happens before any prose is
   written, so the chronicle uses your spellings rather than a model's guess.
   This is the whole reason it exists.
2. **It writes prose, not minutes.** Continuous narrative you'd want to read
   back, rather than bullet points about what was "discussed".
3. **It runs on your machine.** Audio never leaves it, and with a local model
   nothing leaves it at all.

If none of those matter to you, one of the tools above will serve you better
and cost you less effort. That's a genuine recommendation, not false modesty.

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
details are in [vault.md](vault.md).


</div>
</details>
