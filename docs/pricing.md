# 💸 What it costs to run

Nothing goes to me. This is MIT-licensed and it always will be — there's no
paid tier, no upsell, and no feature behind a paywall. The Buy Me a Coffee link
exists if you're feeling generous, and that's the extent of it.

The only money involved is whatever your chosen AI provider charges for the
tokens. Realistically that's **£1–£2 for a three-hour session**, which was the
number I was aiming for: cheaper per session than the monthly subscriptions I'd
been looking at, and you only pay on the weeks you actually play.

There are two ways to get it to zero — run a local model, or draw on a Claude
Code or ChatGPT subscription you're already paying for. Both are below.

> **Why a paid key is required for cloud providers.** Tomes first shipped when Google's free Gemini tier still gave access to Pro-class models, and a fully free workflow was viable. Google has since moved Pro models behind billing, and free Flash on its own is too rate-limited to carry a 3-hour session's main pipeline. The project has been engineered to minimise the API spend that remains (prefix caching, audit-skip, per-tier chunk sizing, Smart Budget routing) — see "Making it cheaper" in [providers.md](providers.md) for the architectural details. The one exception: a free-tier Gemini key, if you have one, is used by the Smart Budget preset for **Phase 4 extras only** (the smallest JSON-shaped phase, where Free Flash's quota is comfortable). Every other phase always uses your paid key.

> **💡 Tip: a free-tier Gemini key is a much better fit for [Tusk's Vault](https://github.com/KochiTusker/Tusks-Vault)**, the upcoming AI-chatbot companion that lets you ask questions of your campaign lore in natural language. Vault is a single retrieval-augmented query per turn — orders of magnitude less token use than Tomes' six-phase generation pipeline — so a free quota carries Vault's workload comfortably. If you're picking up a Google Gemini key primarily for the free tier, Vault is the project where it earns its keep.

| Provider | Paid required? | Notes |
|---|---|---|
| **Google Gemini** | ✅ Paid key required | Best price/quality for this workload. Roughly £1.50–£3 per 3-hour session depending on the routing preset. Free-tier key optional as a Smart-Budget secondary for Phase 4 extras only. |
| **Anthropic Claude** | ✅ Pay-as-you-go | Best prose quality in side-by-side testing for the narrative phase. ~$0.05–$0.15 per session on Sonnet (with prefix caching reducing repeat-call cost). |
| **OpenAI** | ✅ Pay-as-you-go | Solid all-rounder. Similar pricing to Anthropic. |
| **Claude Code / Codex subscription** *(requires the [Claude Code](add-ons/claude-code.md) or [Codex](add-ons/codex.md) add-on)* | ❌ No API spend | If the CLI is installed and signed in, Tomes runs phases against that session and draws on the allowance of a Claude or ChatGPT plan you already pay for. API keys are stripped from the call, so the work cannot land on a metered bill. Exhausting the allowance mid-run pauses the pipeline rather than failing it; resume once it resets. |
| **Ollama / LM Studio / Unsloth (local)** *(requires the [Local LLMs add-on](add-ons/local-llm.md))* | ❌ Free forever | Runs entirely on your GPU. Quality is noticeably weaker than cloud unless you've got 30B+ models, but a 4070 + `gemma3:27b` produces a perfectly serviceable chronicle. |

<details class="docs-section">
<summary><h2>Mix-and-match per phase</h2></summary>
<div class="docs-section-body">


Settings → Model Profiles lets you assign a different model to each pipeline phase. The two best-value setups for high-quality chronicles are:

**Gemini Smart Budget (one-click in Hybrid Routing).** Requires a paid Gemini key; uses a free-tier key as an optional secondary for Phase 4 only.

- **Phase 1 (grounding)** — Paid Gemini Flash
- **Phase 2 (audit)** — Paid Gemini Flash
- **Phase 3 (chronicle)** — Paid Gemini Pro (the load-bearing quality phase)
- **Phase 4 (extras)** — Free Gemini Flash if a free-tier key is configured, else Paid Flash-Lite
- **Phase 5 (polish)** — local-only review pass; skipped when using cloud providers, runs when [Local LLMs add-on](add-ons/local-llm.md) is the active provider
- **Phase 6 (condense)** — Paid Gemini Flash-Lite

A 3-hour session at Smart Budget typically costs **~£1.50 in LLM API calls** — roughly half of All-Pro Gemini, with chronicle quality preserved.

**Gemini + Claude hybrid.** Pick this when you want Claude's narrative voice on the chronicle phase specifically.

- **Phase 1 (grounding)** — Paid Gemini Flash (~£0.10)
- **Phase 2 (audit)** — Paid Gemini Flash (~£0.01)
- **Phase 3 (chronicle)** — Claude Sonnet (~$0.05–$0.15)
- **Phase 4 (extras)** — Paid Gemini Flash (~£0.02)
- **Phase 6 (condense)** — Paid Gemini Flash-Lite (~£0.02)

Adaptive per-provider pacing (reads `anthropic-ratelimit-*` / `x-ratelimit-*` headers each call) keeps you at the maximum safe rate for your actual tier, so paid Gemini users see 4–5× faster runs than the legacy fixed pacing.


</div>
</details>

<details class="docs-section">
<summary><h2>Audio Transcription add-on costs</h2></summary>
<div class="docs-section-body">


The [Audio Transcription add-on](add-ons/audio-transcription.md) is also free — it downloads `faster-whisper` + `torch` and runs them on your hardware. The only "cost" is:

- ~2 GB of disk for the Whisper venv + torch wheels.
- ~3 GB of disk for the Whisper model weights (first transcription only).
- Your electricity. A 4-hour transcription takes ~12 minutes on an NVIDIA 4070, or ~90 minutes on a processor. Note that AMD and Intel GPUs fall into the CPU column — the engine has no backend for them.


</div>
</details>

<details class="docs-section">
<summary><h2>What's NEVER paywalled</h2></summary>
<div class="docs-section-body">


- Updates
- Bug fixes
- New features and pipeline phases
- New add-ons
- Community access (today: feedback form; once interest signals it, a community Discord — see the [roadmap](../ROADMAP.md))
- The Tusk's Vault companion project

Tusk's Tomes is MIT-licensed and free forever. If you'd like to support the maintainer, [buy them a coffee](https://buymeacoffee.com/kochitusker) — purely optional, never required.


</div>
</details>
