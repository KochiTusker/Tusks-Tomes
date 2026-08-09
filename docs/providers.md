# 🔑 LLM providers — picking one, getting a key, going offline

Tusk's Tomes needs at least one LLM to run the pipeline. There are three routes to that, and you can mix them per phase:

1. **A cloud API key** — Gemini, Claude or OpenAI. Works out of the box; you pay per token.
2. **A subscription you already have** — if the [Claude Code](add-ons/claude-code.md) or [Codex](add-ons/codex.md) CLI is installed and signed in, Tomes can draw on that plan's allowance instead of metered API credit.
3. **Fully local** — Ollama / LM Studio / Unsloth, gated behind the [Local LLMs add-on](add-ons/local-llm.md). No key, no bill, no network.

<details class="docs-section">
<summary><h2>Which provider should I pick?</h2></summary>
<div class="docs-section-body">


> **A note on cost.** Tusk's Tomes itself is free and open source — there's no payment to the project at any point. The only money involved is your chosen LLM provider's API fees. When Tomes first launched, Google's free Gemini tier gave access to Pro-class models, which made a fully free workflow viable. Google has since moved Pro models behind billing, so a paid API key is now required for the main pipeline; the project has been engineered to keep those API costs as low as possible (prefix caching, audit-skip optimisation, per-tier chunk sizing, and Smart Budget routing all exist to shrink your bill).

Short answer:

- **Lore-accurate content** → **Google Gemini**. Stays more faithful to source materials that include swearing, explicit content, and violence (toggleable in settings) where Claude and ChatGPT tend to sanitise content by default.
- **Best narrative prose?** → **Google Gemini Pro** or **Claude Sonnet**. Both produce strong long-form narration; Gemini Pro is cheaper per session.
- **Already have an OpenAI account?** → **OpenAI**. Solid all-rounder.
- **Already pay for Claude or ChatGPT?** → **[Claude Code](add-ons/claude-code.md)** or **[Codex](add-ons/codex.md)**. Routes phases through the signed-in CLI and spends that plan's allowance rather than API credit. Running out mid-session pauses the run instead of failing it.
- **No cloud, no cost, full privacy?** → **Local via Ollama / LM Studio / Unsloth** (requires the [Local LLMs add-on](add-ons/local-llm.md)).

For most groups, **Gemini Flash for cleanup + Claude Sonnet for narrative** is the sweet spot. Per-phase routing makes that one Settings panel away.

### Cost — what you'll actually pay

Honest per-session estimates for a **3-hour Craig recording with full lore documents and DM clarifications** (a realistic upper bound — shorter sessions and lighter lore cost less). Numbers come from many real runs across the providers; rough but landed.

| Provider + model | Approx. per 3hr session | Notes |
|---|---|---|
| **Gemini Pro, paid (default)** | ~£3 | The reference number. No quota interruptions. |
| **Gemini Smart Budget (paid + optional free)** | ~£1.50 | One-click preset in Hybrid Routing. Paid Flash for grounding + audit, Paid Pro for chronicle, Paid Flash-Lite for condense; optionally routes Phase 4 extras to a free-tier key if you've configured one (the only phase that ever uses your free key). |
| **Gemini Flash, paid (Budget mode)** | ~£0.70 | One-click swap in Hybrid Routing. ~76% saving vs Pro paid. Chronicle prose is noticeably weaker. |
| **Claude Sonnet, paid** | ~£2.50–£3.50 | Best narrative prose in side-by-side comparisons. |
| **Claude Haiku, paid (Budget mode)** | ~£0.80 | Cheaper but the chronicle prose loses some richness. |
| **GPT-5, paid** | ~£2 | Solid all-rounder. |
| **GPT-5-mini, paid (Budget mode)** | ~£0.50 | The cheapest paid path. |
| **Claude Code / Codex subscription** | £0 extra | No API spend — the work comes out of the allowance on a Claude or ChatGPT plan you already pay for. Requires the [Claude Code](add-ons/claude-code.md) or [Codex](add-ons/codex.md) add-on and a signed-in CLI. |
| **Local LLMs (Ollama / LM Studio)** | £0 | No API cost. Electricity + the GPU you already own. Requires the [Local LLMs add-on](add-ons/local-llm.md). |

Tomes paces between chunks automatically — it reads each provider's response headers (`anthropic-ratelimit-*`, `x-ratelimit-*`) on every call and waits exactly long enough to stay under the rate limit. Gemini uses a static tier map keyed on which key you populated (paid Pro vs paid Flash — Flash gets the higher-throughput row). Paid users typically see 4–5× faster runs than the prior fixed-65-second-between-chunks pacing.

### 💡 Making it cheaper — ongoing cost-reduction work

Cost-per-session is something KochiTusker (the maintainer) actively works to bring down. Two architectural improvements shipped in the current release:

- **Prompt caching, extended.** Phase 3 (Chronicle) and Phase 6 (Condense) now use the cacheable-prefix split that Phase 1 already had. The system instructions, KB lore, and DM Q&A live in the prefix; the per-chunk transcript + tail lives in the user prompt. Claude rebates ~90% on cached input, OpenAI's automatic prefix cache rebates similarly, Gemini's implicit cache rebates ~75%. **Net effect: the lore stops being re-billed on every chunk.** This was the biggest single token-cost driver on long sessions.
- **(provider, model-tier)-keyed chunk sizes.** Fast-tier models (Flash, Haiku, GPT-5-mini/nano) now run on chunks roughly half the flagship size. They're cheaper per call AND degrade less on long inputs, so the quality holds at lower token counts. **Budget mode** is the one-click way to use this — Settings → Hybrid Routing → **Budget mode** swaps every phase to the fast-tier model.

Combined, a 3hr session that cost ~£3 on Pro lands around **~£0.70 on Flash with caching**. Quality caveat: Flash's chronicle prose is noticeably weaker than Pro's — A/B-test a 30-minute slice before committing if quality matters more than cost.

The next two cost levers on the roadmap:

- **Explicit Gemini `cachedContent` wiring** — guaranteed 75% rebate on the prefix (currently we lean on Gemini's implicit cache, which works but doesn't guarantee a hit).
- **Batch API support** — Anthropic and OpenAI both offer ~50% discounts for batched processing. Phase 2 (Audit) and Phase 4 (Extras) are excellent candidates because they're non-interactive.

Track progress in [ROADMAP.md](../ROADMAP.md) and vote on priorities via the [feedback form](https://docs.google.com/forms/d/e/1FAIpQLSdxdqOhb1SQvI3fs50gMJv_Cesh2MuxUm95QO2iZia5sFhyyQ/viewform?usp=header). A community Discord with a `#feature-ideas` channel is on the roadmap.


</div>
</details>

<details class="docs-section">
<summary><h2>Google Gemini — paid key required 💎</h2></summary>
<div class="docs-section-body">


Best price/quality for this workload — typically the cheapest of the cloud options. **A billing-enabled (paid) Google Cloud API key is required** to use Tomes' main pipeline.

> **Why paid?** When Tomes first shipped, Google's free Gemini tier gave access to Pro-class models, which made a fully free workflow viable. Google has since moved Pro models behind billing (the `gemini-2.5-pro` and `gemini-3.x` families), and free Flash on its own is too slow (≈2 RPM on Pro, ≈10 RPM on Flash) to carry a 3-hour session's main pipeline within a sensible runtime. Tomes is engineered to minimise API spend (prefix caching, audit-skip, per-tier chunk sizing), but a paid key is now the entry point.

1. Open <https://aistudio.google.com/apikey> and sign in with a Google account.
2. Click **Create API key**. If asked, pick or create a Google Cloud project; ensure billing is enabled on it (Google Cloud Console → Billing).
3. Copy the key (starts with `AIza...`).
4. In Tomes: Settings → API Keys → paste under **Gemini (paid, primary)**. The keystore encrypts it immediately.

> Gemini 3.x requires billing enabled on the project (same key, same encryption). Default Tomes models are `gemini-2.5-pro` / `gemini-2.5-flash`; override with `VITE_MODEL_PRO=gemini-2.5-pro` in `.env` if you want to stay on 2.5.

**Optional second key — for Smart Budget extras only.** If you also have a free-tier Gemini key (without billing), you can paste it under **Gemini (free, optional secondary)**. Tomes will use it for **Phase 4 extras only**, and only when Smart Budget routing is selected. Every other phase always uses your paid key. The free-tier escalation safety net (Free → Paid retry on PROHIBITED_CONTENT or transient 5xx) covers Phase 4 if the free quota stalls.

> **💡 Got a free-tier Gemini key? Consider saving it for [Tusk's Vault](https://github.com/KochiTusker/Tusks-Vault)** (the upcoming AI-chatbot companion that lets you query your campaign lore in natural language — coming soon). Vault's per-query token use is far lower than Tomes' six-phase pipeline (a single retrieval-augmented answer over a few KB of indexed lore, vs Tomes processing a 3-hour transcript end-to-end), so a free-tier quota carries Vault's workload comfortably. Pasting your free key into Tomes is fine — it'll only ever drive Phase 4 extras — but the higher-leverage use is over there.


</div>
</details>

<details class="docs-section">
<summary><h2>Anthropic Claude — pay-as-you-go 💎</h2></summary>
<div class="docs-section-body">


Best prose quality in our testing for the narrative phase.

1. Open the [Anthropic Console](https://console.anthropic.com/) and sign up.
2. Add a payment method under **Plans**.
3. Go to **API Keys** in the sidebar, click **Create Key**, give it a name.
4. Copy the key (starts with `sk-ant-...`) — it's shown only once.
5. In Tomes: Settings → API Keys → paste under **Claude**.


</div>
</details>

<details class="docs-section">
<summary><h2>OpenAI — pay-as-you-go 💎</h2></summary>
<div class="docs-section-body">


Solid all-rounder. Similar pricing to Anthropic.

1. Open <https://platform.openai.com/api-keys>.
2. Add a payment method under [Billing](https://platform.openai.com/account/billing).
3. Click **Create new secret key**, name it, copy the key (starts with `sk-...`).
4. In Tomes: Settings → API Keys → paste under **OpenAI**.


</div>
</details>

<details class="docs-section">
<summary><h2>Claude Code — your own subscription, no API key 🤖</h2></summary>
<div class="docs-section-body">


Power the pipeline with your locally-installed [Claude Code](https://docs.claude.com/en/docs/claude-code) (Pro/Max) plan instead of a per-token API key, via the [Claude Code add-on](add-ons/claude-code.md). Tomes shells out to the `claude` CLI you've already logged into; it never handles your credentials.

1. **Install Claude Code** and run `claude login`, choosing your Pro/Max plan. Make sure `claude` is on your `PATH` and `ANTHROPIC_API_KEY` is unset.
2. **Settings → Add-ons → Claude Code → Install**, then restart `npm run dev`.
3. Pick **Claude Code (your subscription)** as the active provider, or assign it per-phase in Hybrid Routing.

> ⚠️ **Usage limits.** Subscriptions meter headless use in rolling ~5-hour windows, not per token. The pipeline is token-heavy — **in testing, one full session used up to ~60% of the allowance in a 5-hour window** — so budget for roughly one or two sessions per window. If a run hits the limit, wait for the reset or route the rest to another provider. A cost-effective pattern: Claude Code for grounding + chronicle, then [Reforge](reforge.md) the extras + condensed recap on Gemini. Cost shows as **$0** (covered by your plan).


</div>
</details>

<details class="docs-section">
<summary><h2>Running fully offline with Ollama / LM Studio / Unsloth</h2></summary>
<div class="docs-section-body">


Local LLM routing lives in the [Local LLMs add-on](add-ons/local-llm.md). Default installs are cloud-only.

1. **Settings → Add-ons → Local LLMs → Install.** No download — the add-on is a feature flag plus a same-origin proxy. Restart `npm run dev` after install.
2. Install **[Ollama](https://ollama.com)** (recommended for ease) and pull a model: `ollama pull gemma3:27b`. Or run **[LM Studio](https://lmstudio.ai)** / **[Unsloth](https://github.com/unslothai/unsloth)** on their default ports.
3. In Tomes: Settings → Local LLM → **Detect**. Tomes probes localhost on the default ports for each backend.
4. Assign the detected model per phase under Settings → Hybrid Routing.

⚠️ **Quality caveat**: local models under ~15B parameters produce noticeably weaker prose than Claude / GPT-4 / Gemini Pro. A 4070 + `gemma3:27b` produces a perfectly serviceable chronicle; smaller models will struggle on the narrative phase. **Mix-and-match per phase is the sweet spot** — Gemini Flash for cleanup + grounding, Claude Sonnet for narrative, local for the cheap stuff.


</div>
</details>

<details class="docs-section">
<summary><h2>Why the local-LLM proxy exists</h2></summary>
<div class="docs-section-body">


The browser can't reach Ollama (`localhost:11434`) or LM Studio (`localhost:1234`) due to CORS (different port = different origin). The Local LLMs add-on mounts an Express proxy at `/api/local/list-models`, `/api/local/generate`, and `/api/local/launch` that's same-origin with the SPA. The proxy:

- Validates that target URLs are `localhost`/private LAN only.
- Never acts as an open proxy.
- Supports bearer-token, OAuth2 password flow (cached 30-min JWTs), and HTTP Basic auth for backends that need it.
- Is **only mounted when the add-on is loaded** — default installs return 404 on these endpoints.

See [the add-on docs](add-ons/local-llm.md) for setup details and [`architecture.md`](../architecture.md) for the registry/loader implementation.


</div>
</details>
