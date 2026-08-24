# Your first chronicle

A complete first-time walkthrough from "I have a session to chronicle" through "I have a polished chronicle saved to disk", including what to do if you hit a rate limit halfway through.

> **Just want the speedrun?** Five bullets: paste transcript → add an API key → click **Run** → answer DM clarifications when prompted → done. Read the rest if any of those steps surprise you.

---

## Step 1 — Drop a transcript or recording

Three workflow paths. Pick the one that matches what you have:

### I have any text transcript

The Chronicle tab accepts free-form text. Came from NotebookLM? A previous Whisper run? A manual notetaker? Doesn't matter — Tomes doesn't care where the words came from.

**How:** Chronicle tab → paste in the input box → next step.

### I have a YouTube auto-caption file

If you already upload sessions to YouTube (public, private, or unlisted), the auto-caption `.sbv` works directly.

**How:** YouTube Studio → your video → Subtitles → ⋮ → Download `.sbv`. Then in Tomes: **Caption Repair** tab → drop the `.sbv` → **Repair captions** → **Send to refinement**.

### I have a Craig multitrack recording (best result)

Per-speaker audio tracks survive end-to-end into the chronicle, so every line of dialogue is attributed to the right character. Requires the **Audio Transcription** add-on.

**How:** **Settings → Transcription → Install** (one-time setup that downloads the Whisper sidecar — **5-15 minutes** depending on your connection, since `torch` and CUDA wheels are around 1.5 GB). Restart the server when prompted. Then the **Sessions** tab → drop the Craig `.zip` → edit speaker mappings while Whisper grinds → **Use this transcript for refinement**.

Deep dive: [AddOns.md → Audio Transcription](../extras/README.md#audio-transcription--the-only-one-that-installs).

---

## Step 2 — Configure once

You only do this for the first session; after that it sticks.

### Add an LLM API key (required)

**Settings → Providers & models** → paste at least one. Paid Google Gemini is the easiest start ([sign-up walkthrough](../models/choosing-a-provider.md#google-gemini--paid-key-required)). OpenRouter is the other route — one key, around 400 models including every Anthropic and OpenAI model.

Keys are encrypted at rest. The keystore is machine-bound and the GUI is the only way to manage them — they never appear in `.env`, never appear in logs, and never leave the host except when calling the provider itself.

### Upload your campaign lore (optional but huge upgrade)

**Tome of Lore** tab → drop your campaign's PDFs, DOCX files, plain text. Tomes extracts the text and uses it to ground the chronicle — proper nouns get spelled correctly, and the narrative voice picks up your world's tone.

Without lore: the chronicle is still good but uses generic fantasy phrasings. With lore: the model writes in your campaign's actual voice.

### Set character + player names (optional)

**Tome of Lore → Speakers** → map each speaker ID to a player and character name. Persists across sessions, so you set it once and forget. The chronicle then writes "Vellichor drew his sword" instead of "Speaker 3 drew his sword".

---

## Step 3 — Click Run

The pipeline runs through six phases. Each one has a progress card with an ETA.

| # | Phase | What it does | Roughly how long |
|---|---|---|---|
| 1 | **Ground** | Cleans up `[Music]`/`[Laughter]` markers, applies your glossary, runs an LLM pass to fix misheard names against the KB. | ~3-5 min on cloud |
| 2 | **Audit** | Looks for ambiguous moments and surfaces clarification questions for you to answer. Most chunks return zero questions. | ~1-2 min |
| — | **DM clarifications** | The app pauses. A dialog shows the questions; answer what you can, skip what you can't. | 0–5 min (you) |
| 3 | **Chronicle** | The big one — turns the grounded transcript into novel-style prose, attributing dialogue to characters. | ~5-10 min |
| 5 | **Polish** | Local-only smoothing pass. Skipped for cloud providers (their Phase 3 output doesn't need it). | ~2 min, local-only |
| 4 | **Extras** | Extracts jests, gore, and memorable quotes (tagged funny / stupid / dark; single lines or multi-speaker exchanges). | ~1-2 min |
| 6 | **Condense** | Tightened prose + 10-15 catch-up bullets for someone who missed the session. Length controlled by the **Condense Slider** on the Output Picker (default 20%). Runs automatically when "Condensed" is checked at run start. | ~2 min |

Total wall-clock for a 3-hour session: roughly **10–15 minutes** on cloud providers, longer on local LLMs depending on hardware.

The page shows a live progress card during each phase, and you can scroll down to see the partial output as it lands.

---

## Step 4 — Review the chronicle

When Phase 4 finishes the page switches to the **Chronicle view** with tabs across the top:

- **Chronicle** — the main narrative prose.
- **Condensed** — appears after you run Phase 6 (one click from the same view). A shorter retelling.
- **Recap** — 10-15 bullet points; what to send the player who missed the session.
- **Jests / Gore / Quotes** — the standout moments from Phase 4. Quotes are tagged Funny / Stupid / Dark. A quote can be a single line or a short back-and-forth: when the joke is the volley rather than any one line, the whole exchange is kept together and shown with each speaker's turn in order.

If anything feels off, you can re-run the whole pipeline from the same transcript — your glossary edits will be picked up automatically.

---

## Step 5 — Save and share

### Auto-save to disk

Tomes writes the chronicle to `<repo>/Sessions/<campaign>/Tusk's Tomes - <campaign> - Session <n>.md` the moment Phase 4 (and again Phase 6) lands. The folder is gitignored — you decide whether to commit individual chronicles.

### Save to Tusk's Lore (`.docx`)

If you've created a sibling `Tusks-Lore/` folder (Settings → Create Tusk's Lore), every chronicle gets **Save full .docx** + **Save condensed .docx** buttons. Output lands at `<Tusks-Lore>/Sessions/<campaign>/Session-NN-<date>-<full|condensed>.docx`.

### Send to Tusk's Vault

If you've also installed [Tusk's Vault](https://github.com/KochiTusker/Tusks-Vault) as a sibling, a **Send to Vault** button pushes a markdown copy into Vault's `Lore/Tomes/` tree. Vault then makes the chronicle searchable via `@`-mention in Discord. See [docs/vault.md](../extras/tusks-vault.md).

---

## If it gets stuck — the rate-limit dialog

Every LLM provider rate-limits API calls — paid keys have generous limits but they're not unlimited, and an optional free-tier Gemini key (configured as a Smart Budget secondary) has tighter per-minute and per-day quotas that a long Phase 4 can trip. When the provider returns a 429, Tomes opens a four-option dialog:

- **Stop and export what we have** — aborts the run, downloads whatever the pipeline produced so far as Markdown. Use this when you've decided to call it a night.
- **Slow down (3× longer between calls)** — keeps the same key but paces calls more conservatively. Useful when you're hitting per-minute limits and just need to back off.
- **Pause and save for later** — writes a full on-disk checkpoint. Close the app, come back tomorrow when the daily quota refills, click **Resume** in the banner that appears above the Chronicle card. The pipeline picks up at the exact chunk it stopped on — none of the previous work is lost.
- **Switch keys for the rest** — only available when you've configured a fallback. Most commonly used in Smart Budget mode for Phase 4 extras: if your optional free-tier Gemini key stalls, this jumps the rest of Phase 4 onto your paid key.

Daily quota exhausted? The dialog tells you so and **disables the slow-down option** (waiting longer won't help an empty bucket). Pause + resume tomorrow is usually the right call.

---

## The closed-loop pitch

Once you've set up Tomes the way you like it, the recurring per-week work is:

1. Drop a transcript / recording (60 seconds)
2. Click **Run** (zero seconds)
3. Walk away for ~15 minutes
4. Open the finished chronicle when you're back

**Same three clicks per week, forever.** That's the design goal — minimal recurring effort, maximum recurring value.

---

## Next steps

- [Features](../about/features.md) — the full feature list, organised by tab.
- [Workflows](../importing/README.md) — the three workflow paths in more depth.
- [Providers](../models/choosing-a-provider.md) — picking an LLM, getting an API key, the cost story.
- [AddOns](../extras/README.md) — the three optional add-ons.
- [Architecture](../about/how-its-built.md) — what happens under the hood, phase by phase.
