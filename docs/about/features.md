# Everything it does

The full list. Most of these exist because something annoyed me once and I
fixed it — which is why the set is a bit lopsided, with a great deal of care
spent on getting names right and comparatively little on, say, theming.

Core features work straight away. Anything needing an optional module is
labelled, and you can ignore those entirely if you only want to paste
transcripts.

<details class="docs-section">
<summary><h2>Core (no add-on needed)</h2></summary>
<div class="docs-section-body">


### Optional modules, only one of which installs
The core app runs without Python or any local LLM runner installed. Seven modules extend it, and exactly one — Audio Transcription — is a real installation, with live install logs streamed over Server-Sent Events and a restart when it finishes. The other six ship with the app and mount unconditionally; whether one is *usable* is a detection question its own status row answers, not an installation question. See [add-ons/](../extras/README.md) for the catalogue.

### YouTube `.sbv` pipeline
Drop a YouTube auto-caption file and the model cleans up hallucinations using your glossary as ground truth. Caption repair lives on the **Chronicle** tab, alongside the transcript input it feeds. The cleaned `.sbv` then goes through the same five-phase pipeline as any other transcript.

### 5-phase LLM pipeline
- **Phase 1 — Cleanup + grounding** (deterministic pre-pass + AI grounding against your glossary).
- **Phase 2 — Audit** (compares raw vs grounded, surfaces DM questions).
- **Phase 3 — Chronicle** (narrative prose in your campaign's voice).
- **Phase 3.5 — Polish** *(the clean-up pass for a locally written chronicle; it runs only when the whole run uses a local provider, which the app does not offer, so it does not run today).*
- **Phase 4 — Extras** (memorable quotes, jests, gore — curated).
- **Phase 5 — Condense** *(optional — shorter narrative + bullet recap for absent players).*

### Pick any cloud LLM, switch live
Gemini directly (with free + paid tier handling), or around 400 models through a single [OpenRouter](../models/choosing-a-provider.md) key — including every Anthropic and OpenAI model at pass-through rates. Hot-swap at any time from Settings; no restart required. Local routing (Ollama / LM Studio / Unsloth) and subscription routing through the [Claude Code](../extras/claude-code.md) or [Codex](../extras/codex.md) CLI are built in.

### Chronicle Reforge
Re-run the later phases of a finished chronicle on a different model without starting over. Keep the chronicle and redo just the extras (quotes / jests / gore) and condensed recap on, say, Gemini — or regenerate the chronicle itself in a chosen persona voice. Extras can be read from the grounded transcript (thorough) or the chronicle prose (cheaper). Saves a new library entry; your original is kept. See [reforge.md](../chronicling/reforging.md).

### Refusal markers + targeted repair
When a provider declines a chunk and the in-run fallback can't recover it, the chunk is marked in the output (visible banner + hidden tag) and recorded. A **Review & Repair Refusals** panel re-processes only the marked chunks on another provider and splices the results back in — no full re-run.

### Adaptive per-provider pacing
Between chunks Tomes waits long enough to stay under the provider's limits. Gemini uses a static table keyed on the key tier (paid or free) and the model (Pro or Flash). OpenRouter is paced on requests per minute: 20 for `:free` models and a nominal 60 for the rest. Claude Code, Codex and local runners are not paced. When OpenRouter answers a 429 with `Retry-After`, Tomes waits exactly that long; Gemini retries on fixed waits.

### Per-provider chunk sizing
Cloud chunks are sized for each provider's throughput budget — Gemini paid runs the largest chunks, since a 1M context absorbs them easily. Fast-tier models run chunks roughly half the flagship size: cheaper per call, and they degrade less on long inputs. Local LLMs use a single conservative table because consumer GPUs lose accuracy on long contexts. Editable in `src/features/pipeline/lib/chunking.ts` if you want to override.

### In-app Help tab
Every doc that lives in the GitHub repo also renders inside the app under a **Help** tab. The landing page is a searchable tile grid; opening a doc gives you a sidebar grouped by folder and the body split into collapsible sections. Module rows link straight to the relevant doc with one click.

### Per-phase model routing
Different phases have different needs — grounding wants determinism, the chronicle wants prose. **Settings → Providers & models** gives each phase one row: the model in effect, what that phase costs on it, and what the phase actually wants from a model. The picker covers every connection you've configured, grouped by how the call is billed rather than by who made the model.

If you'd rather not assemble a recipe by hand, guided routing offers a ladder of complete presets — each one line, with its reasoning and measurements behind an information control, and the rung matching your current routing badged so you can see where you stand.

### Tome of Lore
Campaign PDFs / DOCX / TXT used as in-context grounding for the narrative phases. The model writes in your campaign's voice instead of a generic fantasy tone.

### Glossary + speakers
One-time setup (edited in-app) keeps proper nouns spelled correctly forever. Speaker mappings persist across sessions so player + character names are pre-filled on every upload.

### One-click Tusk's Vault export
Sibling-detect [Tusk's Vault](https://github.com/KochiTusker/Tusks-Vault) install; **Send to Vault** button on every finished chronicle pushes it into the Vault's `Lore/` for `@`-mentionable retrieval.

### In-app updater
**Settings → Maintenance** → *Check for updates* → *Apply update*. Runs a guarded `git pull` and prints the `npm install` command when dependencies changed. Refuses to clobber uncommitted edits.

### Encrypted-at-rest keystore
AES-256-GCM with a machine-bound scrypt key (hostname + username + platform). A copied `providers.enc` does not decrypt on a machine with a different host name or user name. The dashboard never shows raw keys back — only "configured / not configured" indicators.

### Localhost-only by default
Server binds to `127.0.0.1` by default. Other devices on your LAN cannot reach the UI without explicit opt-in (`TUSKS_HOST=0.0.0.0`), and even then they get read-only access unless you also set `TUSKS_LAN_WRITES=1`. Cross-origin POSTs to `/api/*` are rejected by a same-origin middleware so a malicious page can't drive-by-trigger an install.

### Auditable setup scripts
Plain readable shell, no silent system installs. Open `setup.bat` / `setup.sh` in Notepad first if you want — they're ~60 lines.

### Resilient state
All disk writes go through atomic rename-from-tmp. Crashes mid-write leave the old file intact. `localStorage` writes use quota-aware wrappers that surface a UI event on overflow.

---


</div>
</details>

<details class="docs-section">
<summary><h2>Audio Transcription</h2></summary>
<div class="docs-section-body">


The one module that installs. See [add-ons/audio-transcription.md](../extras/audio-transcription.md) for the full deep-dive. The features it adds:

### Multitrack Craig ingest
Drop one or more [Craig](https://craig.chat) zips, or per-speaker WAV / FLAC files. Same speaker across Craig chunks is auto-merged by speaker ID.

### Staged batch uploads
For long or chunked sessions: commit Part 1, then *Add another batch* for Part 2/3/…, then *All audio uploaded — start transcription*. Each batch saves independently and is restartable.

### Offline Whisper
`faster-whisper` runs on the GPU when it can and falls back to the processor; on Windows the installer uses `nvidia-smi` to choose the CUDA build of torch. A three-hour session with five or six speaker tracks takes roughly half an hour on a mid-range NVIDIA card — about 10 minutes per hour of session — and several times longer on CPU. Audio never touches the network.

### Speaker-aware merged SBV
Every Whisper segment from every track is sorted into one chronological transcript with `[Character (Player)]` labels. The pipeline preserves these labels all the way into the final chronicle.

### Sessions history
The Sessions tab lists every upload you've done — re-open old transcripts, re-run with different routing, export to Tusk's Vault, or send back to the Chronicle tab for refinement. Uploading is the first thing on the same tab, because creating a session and listing sessions are one object rather than two.

---


</div>
</details>

<details class="docs-section">
<summary><h2>Local LLMs</h2></summary>
<div class="docs-section-body">


See [add-ons/local-llm.md](../extras/local-llms.md) for the full deep-dive. The features it adds:

### Three local runner integrations
Ollama (default port 11434), LM Studio / any OpenAI-compatible server (1234), Unsloth Studio (8888 with OAuth2 password auth). The panel probes each default port when it opens, and **Detect again** repeats the check and lists available models.

### Runner launch route
The server can spawn the local runner (detached, survives a Tomes restart), launching `ollama serve` with `OLLAMA_FLASH_ATTENTION=1` and `OLLAMA_KV_CACHE_TYPE=q4_0` set. The Local LLMs panel has no button for it, so you start the runner yourself.

### Capability probe
Runs two fixed tests against your selected model, structured JSON and grounding, and reports both scores plus tokens/sec, then marks which of Phases 1, 2 and 4 it qualifies for. Lets you compare models without spending cloud for a real run.

### Per-phase routing
**Settings → Providers & models** assigns each phase to a different target. Local Phase 1 plus cloud Phase 3 is a common pattern — Phase 1 is the chattiest phase and grounding is cheap; Phase 3 wants the best prose model.

### Same-origin proxy
Tomes proxies the browser's calls through `/api/local/*` instead of sending them straight to `localhost:11434`. The proxy only forwards to `localhost` or private-network addresses.


</div>
</details>

<details class="docs-section">
<summary><h2>Claude Code</h2></summary>
<div class="docs-section-body">


See [add-ons/claude-code.md](../extras/claude-code.md) for the full deep-dive. The features it adds:

### Bring-your-own Claude subscription
Power the pipeline with your locally-installed [Claude Code](https://docs.claude.com/en/docs/claude-code) (Pro/Max) plan instead of a per-token API key. The app shells out to the `claude` CLI you've already logged into in headless mode — it never handles your credentials. Tomes has no Anthropic key slot, and it removes any Anthropic key or token left in your shell from the call, so it always resolves to the subscription.

### Per-phase routable
Assign it to individual phases in the routing rows — e.g. Claude Code for grounding and chronicle, something cheaper for the rest.

### Usage-window aware
Subscriptions meter headless use in rolling ~5-hour windows. The pipeline is token-heavy — **in testing, one full session used up to ~60% of the allowance in a window** — so budget one or two sessions per window and pair it with Chronicle Reforge to keep the cheaper phases on another model. Cost shows as **$0**, covered by your plan.


</div>
</details>

<details class="docs-section">
<summary><h2>The remaining modules</h2></summary>
<div class="docs-section-body">


### Codex (your ChatGPT subscription)
The same shape as Claude Code, for an OpenAI plan: phases run through the locally-installed `codex` CLI you've signed into, with no API key. Completely independent of Claude Code — use either, both, or neither. `OPENAI_API_KEY` is stripped from the CLI's environment so you can't be silently switched onto per-token billing. See [add-ons/codex.md](../extras/codex.md).

### whisper.cpp bridge
Transcription on AMD, Intel and Apple GPUs, which the built-in Whisper sidecar can't accelerate — it only has CUDA and CPU backends. You compile the build; Tomes detects it, reads its capability line so it can tell you "this is a CPU-only build" rather than leaving you wondering why it's slow, and falls back to the built-in engine if anything stops checking out. Nothing is downloaded. See [add-ons/whisper-cpp.md](../extras/whisper-cpp.md).

### Chronicle Personas
Swap the narrator out of the default bardic voice. Six presets ship; you can author your own from a template, from scratch, or generated by your active LLM. Personas only override the prose phases (3, 3.5 and 5) — grounding, audit and extras are voice-neutral and untouched. Found under **Settings → Voice & content**. See [add-ons/personas.md](../extras/personas.md).

### Obsidian Vault lore
Ground chronicles against a read-only Obsidian vault instead of the Tusks-Lore folder. The app derives an entity index from your notes' frontmatter aliases and bodies, cached outside the vault. Grounding never writes to the vault; three actions you start yourself (markdown copies of Word and PDF notes, a `CLAUDE.md` guide, a `graphify-out/` map) are its only writes. Stays inert until you pick it as your lore source. See [add-ons/obsidian-vault.md](../extras/obsidian-vault.md).


</div>
</details>
