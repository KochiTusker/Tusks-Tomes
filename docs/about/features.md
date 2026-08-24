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
Drop a YouTube auto-caption file and the model cleans up hallucinations using your glossary as ground truth. Caption repair lives on the **Chronicle** tab, alongside the transcript input it feeds. The cleaned `.sbv` then goes through the same six-phase pipeline as any other transcript.

### 6-phase LLM pipeline
- **Phase 1 — Cleanup + grounding** (deterministic pre-pass + AI grounding against your glossary).
- **Phase 2 — Audit** (compares raw vs grounded, surfaces DM questions).
- **Phase 3 — Chronicle** (narrative prose in your campaign's voice).
- **Phase 4 — Extras** (memorable quotes, jests, gore — curated).
- **Phase 5 — Polish** *(local LLMs only — final review pass).*
- **Phase 6 — Condense** *(optional — shorter narrative + bullet recap for absent players).*

### Pick any cloud LLM, switch live
Gemini directly (with free + paid tier handling), or around 400 models through a single [OpenRouter](../models/choosing-a-provider.md) key — including every Anthropic and OpenAI model at pass-through rates. Hot-swap at any time from Settings; no restart required. Local routing (Ollama / LM Studio / Unsloth) and subscription routing through the [Claude Code](../extras/claude-code.md) or [Codex](../extras/codex.md) CLI are built in.

### Chronicle Reforge
Re-run the later phases of a finished chronicle on a different model without starting over. Keep the chronicle and redo just the extras (quotes / jests / gore) and condensed recap on, say, Gemini — or regenerate the chronicle itself in a chosen persona voice. Extras can be read from the grounded transcript (thorough) or the chronicle prose (cheaper). Saves a new library entry; your original is kept. See [reforge.md](../chronicling/reforging.md).

### Refusal markers + targeted repair
When a provider declines a chunk and the in-run fallback can't recover it, the chunk is marked in the output (visible banner + hidden tag) and recorded. A **Review & Repair Refusals** panel re-processes only the marked chunks on another provider and splices the results back in — no full re-run.

### Adaptive per-provider pacing
Every cloud call reads the provider's rate-limit response headers (`anthropic-ratelimit-*`, `x-ratelimit-*`) and paces the next chunk accordingly. Gemini uses a static tier map keyed on which key you populated (paid vs free). 429 `Retry-After` is honoured precisely. Paid users routinely see 4–5× faster runs than the prior fixed-65s-between-chunks pacing.

### Per-provider chunk sizing
Cloud chunks are sized for each provider's throughput budget — Gemini paid runs the largest chunks, since a 1M context absorbs them easily. Fast-tier models run chunks roughly half the flagship size: cheaper per call, and they degrade less on long inputs. Local LLMs use a single conservative table because consumer GPUs lose accuracy on long contexts. Editable in `src/lib/chunking.ts` if you want to override.

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
**Settings → Maintenance** → *Check for updates* → *Apply update*. Runs a guarded `git pull` + `npm install`. Refuses to clobber uncommitted edits.

### Encrypted-at-rest keystore
AES-256-GCM with a machine-bound scrypt key (hostname + username + platform). Even if `providers.enc` leaked, the keys are useless on another machine. The dashboard never shows raw keys back — only "configured / not configured" indicators.

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
`faster-whisper` auto-detects CUDA via `nvidia-smi`. 4-hour session: ~12 min on a 4070, ~90 min on CPU. Audio never touches the network.

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
Ollama (default port 11434), LM Studio / any OpenAI-compatible server (1234), Unsloth Studio (8888 with OAuth2 password auth). Each runner has a Detect button that probes the default port and lists available models.

### One-click runner launch
Tomes can spawn the local runner for you (detached, survives a Tomes restart). `ollama serve` is launched with `OLLAMA_FLASH_ATTENTION=1` + `OLLAMA_KV_CACHE_TYPE=q4_0` baked in for ~2× speedup.

### Capability probe
Runs a fixed Phase 1 + Phase 4 fixture against your selected model and reports a structured-JSON score + tokens/sec. Lets you compare models without spending cloud for a real run.

### Per-phase routing
**Settings → Providers & models** assigns each phase to a different target. Local Phase 1 plus cloud Phase 3 is a common pattern — Phase 1 is the chattiest phase and grounding is cheap; Phase 3 wants the best prose model.

### Same-origin proxy
The browser can't reach `localhost:11434` directly — a different port is a different origin — so Tomes proxies via `/api/local/*`. The proxy validates that target URLs are localhost / RFC1918 only and never acts as an open proxy.


</div>
</details>

<details class="docs-section">
<summary><h2>Claude Code</h2></summary>
<div class="docs-section-body">


See [add-ons/claude-code.md](../extras/claude-code.md) for the full deep-dive. The features it adds:

### Bring-your-own Claude subscription
Power the pipeline with your locally-installed [Claude Code](https://docs.claude.com/en/docs/claude-code) (Pro/Max) plan instead of a per-token API key. The app shells out to the `claude` CLI you've already logged into in headless mode — it never handles your credentials, and strips `ANTHROPIC_API_KEY` from the call so it always resolves to the subscription.

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
Swap the narrator out of the default bardic voice. Six presets ship; you can author your own from a template, from scratch, or generated by your active LLM. Personas only override the prose phases (3, 5 and 6) — grounding, audit and extras are voice-neutral and untouched. Found under **Settings → Voice & content**. See [add-ons/personas.md](../extras/personas.md).

### Obsidian Vault lore
Ground chronicles against a read-only Obsidian vault instead of the Tusks-Lore folder. The app derives an entity index from your notes' frontmatter aliases and bodies, cached outside the vault — the vault itself is never written to. Stays inert until you pick it as your lore source. See [add-ons/obsidian-vault.md](../extras/obsidian-vault.md).


</div>
</details>
