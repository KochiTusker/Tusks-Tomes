# 🎬 Who this is actually for

I built this because I wanted a record of my own campaign and couldn't find
anything that did the job. So the honest answer to "who is this for" is: people
with the same problem I had.

That problem, specifically. You finish a four-hour session at eleven on a
Sunday. Something genuinely brilliant happened around hour two — the sort of
thing the table will still be quoting in a year — and you know full well that
by Wednesday you'll remember roughly half of it, and by next month you'll
remember that it was funny without remembering why.

Everyone says they'll write it up. Almost nobody does. Twice.

<details class="docs-section">
<summary><h2>You'll probably get on with this if…</h2></summary>
<div class="docs-section-body">


| | |
|---|---|
| 🎲 **You're a GM with a backlog you've stopped mentioning** | Point it at old recordings and go to bed. It works through them unattended. Nobody needs to know how many sessions were in the backlog. |
| 📝 **You took notes for exactly one session** | A noble effort. It happens to everyone. Let something else do it and post the recap on Monday. |
| 📜 **Your campaign has been running for years** | It deserves better than a half-abandoned wiki and "I *think* Vellichor the Pale showed up around session nine?". |
| 🛡️ **You're not sending your friends' voices to a cloud service** | Entirely fair. Whisper runs on your own machine and the audio never leaves it. |
| 🎥 **You make actual-play content** | Recaps, show notes and pull-quotes without re-watching a four-hour VOD hunting for one line. |
| 🧙 **You tried Otter or NotebookLM and hit the wall** | The wall being: it's clearly capable, and it has no idea who any of these people are. That's the specific thing this fixes. |
| 🛠️ **You'd rather fork it than file a feature request** | MIT licensed, no obfuscation, no telemetry. Have at it. |

Never opened a terminal? That's fine, and it's not a silly question — the
[beginner's guide](beginner-guide.md) assumes nothing. If you get stuck,
the [feedback form](https://docs.google.com/forms/d/e/1FAIpQLSdxdqOhb1SQvI3fs50gMJv_Cesh2MuxUm95QO2iZia5sFhyyQ/viewform?usp=header)
comes straight to me.


</div>
</details>

<details class="docs-section">
<summary><h2>The bits I actually enjoy</h2></summary>
<div class="docs-section-body">


Some of this genuinely surprised me once it was working, so at the risk of
sounding pleased with myself:

**The quotes list.** This is the one. It pulls out exchanges rather than single
lines, because table humour almost never lands as one sentence — it's the
setup, the terrible response, and the pause afterwards. Getting a list of those
back at the end of a run, weeks after you'd forgotten them, is worth the whole
exercise on its own.

**Backfilling a campaign in one night.** Feed it a stack of old recordings and
leave it running. Waking up to years of sessions written up properly is
ridiculous in the best way.

**Names that stay spelled correctly.** Sounds trivial. It isn't. Every general
transcription tool will hear an invented fantasy name, guess a spelling, and
then commit to that guess with total confidence for four hours. Grounding
against your own glossary fixes it *before* anything gets written, which is why
the prose reads like it was written by someone who was actually there.

**Settling arguments.** A speaker-tagged transcript ends "I definitely never
agreed to that" in about ten seconds. Use responsibly.


</div>
</details>

<details class="docs-section">
<summary><h2>Concrete scenarios</h2></summary>
<div class="docs-section-body">


| You have… | You get… |
|---|---|
| A four-hour session recorded on Sunday night | A finished chronicle to send the party on Tuesday |
| Three weeks of arguing about what someone said in session 12 | A speaker-tagged transcript, searchable by name |
| Thirty sessions of backlog | Thirty chronicles by morning, via staged batch upload |
| Fifty archived YouTube sessions | Cleaned transcripts and chronicles for the wiki |
| A group that won't touch cloud transcription | Whisper on your own GPU; audio never leaves the machine |
| A finished chronicle you want searchable | One click to send it to Tusk's Vault |


</div>
</details>

<details class="docs-section">
<summary><h2>Depending on where you sit at the table</h2></summary>
<div class="docs-section-body">


- 🎭 **GMs** — Recover what was said when everyone's memory has quietly diverged. Backfill years of notes from old recordings. Send a recap to whoever missed last week. Stop being the person who has to write it all up on a Sunday night.
- 🛡️ **Players** — Win the "I said X / no you said Y" exchange decisively. Remember what your character swore three sessions ago and has been conveniently ignoring since. Keep a personal record of your own good bits.
- 🎥 **Streamers** — Turn long VODs into a searchable archive without editing anything by hand.
- 🎙️ **Actual-play podcasters** — Write-ups in the time it used to take to transcribe the cold open.


</div>
</details>

<details class="docs-section">
<summary><h2>What you bring, what it handles</h2></summary>
<div class="docs-section-body">


| You bring | It handles |
|---|---|
| A recording — Craig multitrack zip, per-speaker WAVs, or a YouTube `.sbv` | Transcription, speaker labelling, grounding against your glossary |
| A glossary of your campaign's proper nouns (set up once, edited in-app) | Cleaning, narrating, and pulling out the quotes, jests and grislier moments |
| One API key, **or** a local model via the [Local LLMs add-on](add-ons/local-llm.md) | Encrypted key storage, per-phase routing, sensible fallbacks |
| Optionally, your lore documents | Extracting the text and using it as grounding |
| Optionally, a GPU | Using it if it's there, falling back to the processor if not — though see [the honest timings](workflows.md) before relying on CPU |


</div>
</details>
