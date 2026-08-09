# ✨ Everything it does

The full list. Most of these exist because something annoyed me once and I
fixed it — which is why the set is a bit lopsided, with a great deal of care
spent on getting names right and comparatively little on, say, theming.

Core features work straight away. Anything needing an add-on is labelled, and
you can ignore those entirely if you only want to paste transcripts.

<details class="docs-section">
<summary><h2>Core (no add-on needed)</h2></summary>
<div class="docs-section-body">


### 🧩 Opt-in add-on system
Optional capabilities install in one click from **Settings → Add-ons**. Each add-on shows live install logs (Server-Sent Events), an **enable/disable toggle** (flip without uninstalling), and a "Restart required" pill when state diverges from what the running process has loaded. The core app runs without Python or any local LLM runner installed; advanced features appear only when their add-on is enabled. See [add-ons/](add-ons/README.md) for the full architecture pitch and the current add-on catalogue.

### 📺 YouTube `.sbv` pipeline
Drop a YouTube auto-caption file and the model cleans up hallucinations using your glossary as ground truth. The cleaned `.sbv` can then go through the 4-phase pipeline like any other transcript.

### 📖 6-phase LLM pipeline
- **Phase 1 — Cleanup + grounding** (deterministic pre-pass + AI grounding against your glossary).
- **Phase 2 — Audit** (compares raw vs grounded, surfaces DM questions).
- **Phase 3 — Chronicle** (narrative prose in your campaign's voice).
- **Phase 4 — Extras** (memorable quotes, jests, gore — curated).
- **Phase 5 — Polish** *(local LLMs only — final review pass).*
- **Phase 6 — Condense** *(optional — shorter narrative + bullet recap for absent players).*

### 🔌 Pick any cloud LLM, switch live
Claude, OpenAI, Gemini (with Free + Paid tier handling). Hot-swap at any time from Settings; no restart required. Local LLM routing (Ollama / LM Studio / Unsloth) is available via the [Local LLMs add-on](add-ons/local-llm.md), and your own Claude Pro/Max plan via the [Claude Code add-on](add-ons/claude-code.md).

### 🪄 Chronicle Reforge
Re-run the later phases of a finished chronicle on a different model without starting over. Keep the chronicle and redo just the extras (quotes / jests / gore) and condensed recap on, say, Gemini — or regenerate the chronicle itself in a chosen persona voice. Extras can be read from the grounded transcript (thorough) or the chronicle prose (cheaper). Saves a new library entry; your original is kept. See [reforge.md](reforge.md).

### 🩹 Refusal markers + targeted repair
When a provider declines a chunk and the in-run fallback can't recover it, the chunk is marked in the output (visible banner + hidden tag) and recorded. A **Review & Repair Refusals** panel re-processes only the marked chunks on another provider and splices the results back in — no full re-run.

### ⚡ Adaptive per-provider pacing
Every cloud call reads the provider's rate-limit response headers (`anthropic-ratelimit-*`, `x-ratelimit-*`) and paces the next chunk accordingly. Gemini uses a static tier map keyed on which key you populated (paid vs free). 429 `Retry-After` is honoured precisely. Paid users routinely see 4–5× faster runs than the prior fixed-65s-between-chunks pacing.

### 📐 Per-provider chunk sizing
Cloud chunks are sized for each provider's TPM budget — Gemini paid runs 30k–100k char chunks (1M context absorbs them easily), Claude/OpenAI stay near 20k–40k chars. Local LLMs use a single conservative table because consumer GPUs lose accuracy on long contexts. Editable in `src/lib/chunking.ts` if you want to override.

### 📖 In-app Help tab
Every doc that lives in the GitHub repo also renders inside the app under a **Help** tab. Sidebar groups docs by folder, content renders via `react-markdown` + `remark-gfm`. Add-on cards link straight to the relevant doc with one click.

### 🎚️ Per-phase model routing
Different phases have different needs (cleanup wants determinism, narrate wants prose). Settings → Model Profiles assigns a model per phase. **Sweet spot:** Gemini Flash for the cheap phases + Claude Sonnet for the prose phase.

### 📚 Tome of Lore
Campaign PDFs / DOCX / TXT used as in-context grounding for the narrative phases. The model writes in your campaign's voice instead of a generic fantasy tone.

### 🗂️ Glossary + speakers
One-time setup (edited in-app) keeps proper nouns spelled correctly forever. Speaker mappings persist across sessions so player + character names are pre-filled on every upload.

### 🤝 One-click Tusk's Vault export
Sibling-detect [Tusk's Vault](https://github.com/KochiTusker/Tusks-Vault) install; **Send to Vault** button on every finished chronicle pushes it into the Vault's `Lore/` for `@`-mentionable retrieval.

### 🔄 In-app updater
Settings → Updates → *Check for updates* → *Apply update*. Runs a guarded `git pull` + `npm install`. Refuses to clobber uncommitted edits.

### 🔐 Encrypted-at-rest keystore
AES-256-GCM with a machine-bound scrypt key (hostname + username + platform). Even if `providers.enc` leaked, the keys are useless on another machine. The dashboard never shows raw keys back — only "configured / not configured" indicators.

### 🌐 Localhost-only by default
Server binds to `127.0.0.1` by default. Other devices on your LAN cannot reach the UI without explicit opt-in (`TUSKS_HOST=0.0.0.0`). Cross-origin POSTs to `/api/*` are rejected by a same-origin middleware so a malicious page can't drive-by-trigger an add-on install.

### 🛠️ Auditable setup scripts
Plain readable shell, no silent system installs. Open `setup.bat` / `setup.sh` in Notepad first if you want — they're ~60 lines.

### 💾 Resilient state
All disk writes go through atomic rename-from-tmp. Crashes mid-write leave the old file intact. `localStorage` writes use quota-aware wrappers that surface a UI event on overflow.

---


</div>
</details>

<details class="docs-section">
<summary><h2>Audio Transcription add-on</h2></summary>
<div class="docs-section-body">


See [add-ons/audio-transcription.md](add-ons/audio-transcription.md) for the full deep-dive. The features it adds:

### 🎙️ Multitrack Craig ingest
Drop one or more [Craig](https://craig.chat) zips, or per-speaker WAV / FLAC files. Same speaker across Craig chunks is auto-merged by speaker ID.

### 🔁 Staged batch uploads
For long or chunked sessions: commit Part 1, then *Add another batch* for Part 2/3/…, then *All audio uploaded — start transcription*. Each batch saves independently and is restartable.

### 🧠 Offline Whisper
`faster-whisper` auto-detects CUDA via `nvidia-smi`. 4-hour session: ~12 min on a 4070, ~90 min on CPU. Audio never touches the network.

### 🪡 Speaker-aware merged SBV
Every Whisper segment from every track is sorted into one chronological transcript with `[Character (Player)]` labels. The 4-phase pipeline preserves these labels into the final chronicle.

### 📋 Sessions history
The Sessions tab lists every upload you've done — re-open old transcripts, re-run pipelines with different model profiles, export to Tusk's Vault, or send back to the Chronicle tab for refinement.

---


</div>
</details>

<details class="docs-section">
<summary><h2>Local LLMs add-on</h2></summary>
<div class="docs-section-body">


See [add-ons/local-llm.md](add-ons/local-llm.md) for the full deep-dive. The features it adds:

### 🦙 Three local runner integrations
Ollama (default port 11434), LM Studio / any OpenAI-compatible server (1234), Unsloth Studio (8888 with OAuth2 password auth). Each runner has a Detect button that probes the default port and lists available models.

### 🚀 One-click runner launch
Tomes can spawn the local runner for you (detached, survives a Tomes restart). `ollama serve` is launched with `OLLAMA_FLASH_ATTENTION=1` + `OLLAMA_KV_CACHE_TYPE=q4_0` baked in for ~2× speedup.

### 🧪 Capability probe
Runs a fixed Phase 1 + Phase 4 fixture against your selected model and reports a structured-JSON score + tokens/sec. Lets you compare models without spending cloud for a real run.

### 🎚️ Hybrid per-phase routing
Settings → Hybrid Routing assigns each phase to a different target. Local Phase 1 + cloud Phase 3 is a common pattern — Phase 1 is the chattiest phase and grounding is cheap; Phase 3 wants the best prose model.

### 🛡️ Same-origin proxy
The browser can't reach `localhost:11434` (CORS), so Tomes proxies via `/api/local/*`. The proxy validates that target URLs are localhost / RFC1918 only and never acts as an open proxy. Only mounted when the add-on is loaded.


</div>
</details>

<details class="docs-section">
<summary><h2>Claude Code add-on</h2></summary>
<div class="docs-section-body">


See [add-ons/claude-code.md](add-ons/claude-code.md) for the full deep-dive. The features it adds:

### 🤖 Bring-your-own Claude subscription
Power the pipeline with your locally-installed [Claude Code](https://docs.claude.com/en/docs/claude-code) (Pro/Max) plan instead of a per-token API key. The app shells out to the `claude` CLI you've already logged into in headless mode — it never handles your credentials, and strips `ANTHROPIC_API_KEY` from the call so it always resolves to the subscription.

### 🎚️ Per-phase routable
Set it as the active provider, or assign it to individual phases in Hybrid Routing — e.g. Claude Code for grounding + chronicle, Gemini for the rest.

### ⚠️ Usage-window aware
Subscriptions meter headless use in rolling ~5-hour windows. The pipeline is token-heavy — **in testing, one full session used up to ~60% of the allowance in a window** — so the docs recommend budgeting one or two sessions per window and pairing with Chronicle Reforge to keep the cheaper phases on another model. Cost shows as **$0** (covered by your plan).


</div>
</details>
