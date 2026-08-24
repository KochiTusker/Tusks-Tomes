# Choosing a provider

Tusk's Tomes needs at least one LLM to run the pipeline. There are three routes to that, and you can mix them per phase:

1. **A cloud API key** — Gemini directly, or OpenRouter for roughly 400 models behind a single key. You pay per token.
2. **A subscription you already have** — if the [Claude Code](../extras/claude-code.md) or [Codex](../extras/codex.md) CLI is installed and signed in, Tomes can draw on that plan's allowance instead of metered API credit.
3. **Fully local** — Ollama / LM Studio / Unsloth. No key, no bill, no network.

Everything below lives under **Settings → Providers & models**.

<details class="docs-section">
<summary><h2>Which provider should I pick?</h2></summary>
<div class="docs-section-body">


> [!NOTE]
> **A note on cost.** Tusk's Tomes itself is free and open source — there's no payment to the project at any point. The only money involved is your chosen LLM provider's API fees. When Tomes first launched, Google's free Gemini tier gave access to Pro-class models, which made a fully free workflow viable. Google has since moved Pro models behind billing, so a paid API key is now required for the main pipeline; the project has been engineered to keep those API costs as low as possible (prefix caching, audit-skip optimisation, per-tier chunk sizing, and the guided routing rungs all exist to shrink your bill).

Short answer:

- **Lore-accurate content** → **Google Gemini**. Stays more faithful to source material that includes swearing, explicit content, and violence (toggleable in settings) where other models tend to sanitise by default.
- **Best narrative prose** → **Gemini Pro**, or a strong prose model via OpenRouter. Both produce good long-form narration.
- **Widest choice for one key** → **OpenRouter**. Around 400 models, including every Anthropic and OpenAI model, at pass-through rates. You can also filter the picker to models measured to carry mature content without sanitising it.
- **Already pay for Claude or ChatGPT?** → **[Claude Code](../extras/claude-code.md)** or **[Codex](../extras/codex.md)**. Routes phases through the signed-in CLI and spends that plan's allowance rather than API credit. Running out mid-session pauses the run instead of failing it.
- **No cloud, no cost, full privacy?** → **Local via Ollama / LM Studio / Unsloth**.

For most groups, a cheap model on the mechanical phases plus a strong one on the prose phase is the sweet spot. Per-phase routing makes that one panel away, and the guided rungs below set it up in one click.

### Cost — what you'll actually pay

Rough per-session figures for a 3-hour recording with full lore documents:
roughly $1 to $5 depending on the routing, and $0 on a subscription CLI or a
local runner.

**[Costs](costs.md) owns the numbers** — the per-route breakdown, what drives
them, and how to bring them down. They live in one place so they cannot drift
apart from each other.

Tomes paces between chunks automatically — it reads each provider's response headers on every call and waits exactly long enough to stay under the rate limit. Gemini uses a static tier map keyed on which key you populated. Paid users typically see 4–5x faster runs than the old fixed-65-second-between-chunks pacing.

### Guided routing — pick a rung, not a matrix

Rather than making you assemble a per-phase recipe by hand, Settings offers a
ladder of complete recipes. Each rung is one line, with the reasoning, the
measurements and the caveats behind an information control, and the one
matching your current routing is badged so you can see where you stand.
Whichever rung is recommended is visually distinct — equal-weight cards are not
a recommendation.

Rungs resolve against what you've actually configured: the API-key rungs need
the key, the subscription rungs need a signed-in CLI. Applying a rung only
stages it; the Save button commits it.

> [!WARNING]
> A saving figure is labelled either **measured** or **estimated**, and the
> distinction is deliberate. An extrapolation is never presented as if it were
> a measurement.

### Making it cheaper — ongoing cost-reduction work

Cost-per-session is something the maintainer actively works to bring down. Shipped so far:

- **Prompt caching, extended.** Phase 3 (Chronicle) and Phase 6 (Condense) use the cacheable-prefix split that Phase 1 already had. The system instructions, KB lore, and DM Q&A live in the prefix; the per-chunk transcript and tail live in the user prompt. **Net effect: the lore stops being re-billed on every chunk.** This was the biggest single token-cost driver on long sessions.
- **(provider, model-tier)-keyed chunk sizes.** Fast-tier models run on chunks roughly half the flagship size. They're cheaper per call and degrade less on long inputs, so quality holds at lower token counts.
- **Thinking tokens measured, not guessed.** A controlled A/B on a real session found thinking tokens bill at the *output* rate and made up 55–80% of the chronicle phase's billed output — the single largest line item, and one nobody had measured before. The routing recipes are built from those numbers.

> [!CAUTION]
> **Turning thinking off is not a safe saving.** The same test found that with
> thinking disabled, the fast-tier model misattributed dialogue to the wrong
> character. Thinking stays on everywhere in the shipped recipes. A cheaper
> chronicle that puts words in the wrong character's mouth is not cheaper.

The next cost levers on the roadmap:

- **Explicit Gemini `cachedContent` wiring** — a guaranteed 75% rebate on the prefix, rather than leaning on Gemini's implicit cache, which works but doesn't guarantee a hit.
- **Batch API support** — roughly 50% discounts for batched processing. Phase 2 (Audit) and Phase 4 (Extras) are excellent candidates because they're non-interactive.

Track progress in [ROADMAP.md](../about/roadmap.md) and vote on priorities via the [feedback form](https://docs.google.com/forms/d/e/1FAIpQLSdxdqOhb1SQvI3fs50gMJv_Cesh2MuxUm95QO2iZia5sFhyyQ/viewform?usp=header).


</div>
</details>

<details class="docs-section">
<summary><h2>Google Gemini — paid key required</h2></summary>
<div class="docs-section-body">


Best price/quality for this workload — typically the cheapest of the cloud options.

> [!CAUTION]
> **A billing-enabled (paid) Google API key is required** for the main
> pipeline. When Tomes first shipped, Google's free tier gave access to
> Pro-class models. Google has since moved those behind billing, and free Flash
> on its own is too rate-limited (roughly 2 RPM on Pro, 10 RPM on Flash) to
> carry a 3-hour session in a sensible runtime.

1. Open <https://aistudio.google.com/apikey> and sign in with a Google account.
2. Click **Create API key**. If asked, pick or create a Google Cloud project; ensure billing is enabled on it (Google Cloud Console → Billing).
3. Copy the key (starts with `AIza...`).
4. In Tomes: **Settings → Providers & models**, paste under **Paid tier (billing-enabled) — primary key**. The keystore encrypts it immediately.

> [!WARNING]
> Gemini 3.x requires billing enabled on the project. Default Tomes models are
> `gemini-2.5-pro` / `gemini-2.5-flash`; override with `VITE_MODEL_PRO` in
> `.env` if you want to pin a specific one.

**Optional second key — for Smart Budget extras only.** If you also have a free-tier Gemini key (without billing), you can paste it under **Free tier (optional)**. Tomes uses it for **Phase 4 extras only**, and only when Smart Budget routing is selected. Every other phase always uses your paid key. The free-tier escalation safety net (Free → Paid retry on refused content or transient 5xx) covers Phase 4 if the free quota stalls.

You can probe either key to check which models it can actually call — the button next to each slot runs a live check and consumes a small amount of quota.

> [!NOTE]
> **Got a free-tier Gemini key?** Consider saving it for [Tusk's Vault](https://github.com/KochiTusker/Tusks-Vault), the AI-chatbot companion that lets you query your campaign lore in natural language. Vault's per-query token use is far lower than Tomes' six-phase pipeline, so a free-tier quota carries its workload comfortably. Pasting your free key into Tomes is fine — it'll only ever drive Phase 4 extras — but the higher-leverage use is over there.


</div>
</details>

<details class="docs-section">
<summary><h2>OpenRouter — one key, around 400 models</h2></summary>
<div class="docs-section-body">


One key reaches most of the commercial model landscape, including every Anthropic and OpenAI model, at pass-through rates. This is the route to those models now that the direct integrations have been retired.

1. Open <https://openrouter.ai/keys> and sign in.
2. Add credit, then create a key (starts with `sk-or-...`).
3. In Tomes: **Settings → Providers & models**, paste under **OpenRouter → API key**.

The catalogue is public and needs no key to browse, so the model picker is populated before you've pasted anything. Once a key is in, the picker fetches the live catalogue.

**Two filters worth knowing about**, because they encode work you'd otherwise have to do yourself:

- **Graded on real session material** — models the maintainer has actually run against real transcripts, rather than the whole catalogue.
- **Measured to carry mature content** — models tested to relay swearing, violence and explicit content faithfully instead of sanitising it. For a chronicle of what your table actually said, this matters more than benchmark scores.

Models are grouped by **how the call is billed** rather than by who made the model, because that is the axis that determines what a run costs you.

> [!WARNING]
> Cost varies enormously across the catalogue — measured routings for a 3-hour
> session range from well under a dollar to over ten. The cost estimate on the Run
> button reflects the models you have actually selected, so check it before a
> long run rather than assuming a rung's headline figure applies.


</div>
</details>

<details class="docs-section">
<summary><h2>Claude Code — your own subscription, no API key</h2></summary>
<div class="docs-section-body">


Power the pipeline with your locally-installed [Claude Code](https://docs.claude.com/en/docs/claude-code) (Pro/Max) plan instead of a per-token API key. Tomes shells out to the `claude` CLI you've already logged into; it never handles your credentials.

1. **Install Claude Code** and run `claude login`, choosing your Pro/Max plan. Make sure `claude` is on your `PATH` and `ANTHROPIC_API_KEY` is unset.
2. In Tomes: **Settings → Providers & models**. The Claude Code row detects the CLI and its login state on its own — there is nothing to install and no restart.
3. Assign it per phase in the routing rows, or pick a subscription rung in guided routing.

> [!CAUTION]
> **Usage limits.** Subscriptions meter headless use in rolling ~5-hour
> windows, not per token. The pipeline is token-heavy — in testing, one full
> session used up to **~60% of the allowance in a single 5-hour window** — so
> budget for roughly one or two sessions per window. If a run hits the limit,
> wait for the reset or route the rest elsewhere. A cost-effective pattern:
> Claude Code for grounding and chronicle, then [Reforge](../chronicling/reforging.md) the
> extras and condensed recap on a cheaper model. Cost shows as **$0**, covered
> by your plan.


</div>
</details>

<details class="docs-section">
<summary><h2>Running fully offline with Ollama / LM Studio / Unsloth</h2></summary>
<div class="docs-section-body">


> [!NOTE]
> Nothing to install on the Tomes side. Install a runner, start it, and hit
> **Detect**.

1. Install **[Ollama](https://ollama.com)** (easiest) and pull a model: `ollama pull gemma3:27b`. Or run **[LM Studio](https://lmstudio.ai)** / **[Unsloth](https://github.com/unslothai/unsloth)** on their default ports.
2. In Tomes: **Settings → Providers & models** → **Detect**. Tomes probes localhost on the default ports for each backend.
3. Assign the detected model per phase in the routing rows.

A capability probe runs two tests — structured JSON adherence and grounding fidelity — so the routing rows can tell you which phases a given local model is actually qualified for, rather than letting you discover it mid-run. Hardware advisories check VRAM and RAM for the model you picked, so a 32B model on 8 GB doesn't silently fall over.

> [!WARNING]
> **Quality caveat.** Local models under roughly 15B parameters produce
> noticeably weaker prose than the cloud flagships. A 4070 with `gemma3:27b`
> produces a perfectly serviceable chronicle; smaller models struggle on the
> narrative phase. Mixing per phase is the sweet spot — a cheap cloud model for
> cleanup and grounding, something strong for narrative, local for the rest.


</div>
</details>

<details class="docs-section">
<summary><h2>Why the local-LLM proxy exists</h2></summary>
<div class="docs-section-body">


The browser can't reach Ollama (`localhost:11434`) or LM Studio (`localhost:1234`) directly: a different port is a different origin, so the request is blocked. Tomes mounts an Express proxy at `/api/local/list-models`, `/api/local/generate`, and `/api/local/launch` that is same-origin with the page. The proxy:

- Validates that target URLs are `localhost` or private LAN only.
- Never acts as an open proxy.
- Supports bearer-token, OAuth2 password flow (cached 30-minute JWTs), and HTTP Basic auth for backends that need it.

See [the local LLM guide](../extras/local-llms.md) for setup details and [`architecture.md`](../about/how-its-built.md) for the implementation.


</div>
</details>
