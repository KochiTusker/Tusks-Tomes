# Choosing a provider

Tusk's Tomes needs at least one LLM to run the pipeline. There are three routes to that, and you can mix them per phase:

1. **A cloud API key** — Gemini directly, or OpenRouter for roughly 400 models behind a single key. You pay per token.
2. **A subscription you already have** — if the [Claude Code](../extras/claude-code.md) or [Codex](../extras/codex.md) CLI is installed and signed in, Tomes can draw on that plan's allowance instead of metered API credit.
3. **Local models** — Ollama / LM Studio / Unsloth, for Ground, Audit and Extras only. No key, no bill, no network for those phases; the chronicle and Condense still need route 1 or 2.

Everything below lives under **Settings → Providers & models**.

<details class="docs-section">
<summary><h2>Which provider should I pick?</h2></summary>
<div class="docs-section-body">


> [!NOTE]
> **A note on cost.** Tusk's Tomes itself is free and open source — there's no payment to the project at any point. The only money involved is your chosen LLM provider's API fees. When Tomes first launched, Google's free Gemini tier gave access to Pro-class models, which made a fully free workflow viable. Google has since moved Pro models behind billing, so a Gemini route for the main pipeline needs a paid API key (an OpenRouter key, a Claude Code or Codex subscription, or a local runner needs no Gemini key at all); the project has been engineered to keep those API costs as low as possible (prefix caching, audit-skip optimisation, per-tier chunk sizing, and the guided routing rungs all exist to shrink your bill).

Short answer:

![Four wants, each pointing at a route. Already paying for Claude or ChatGPT: use Claude Code or Codex. Wanting the cheapest strong cloud: use Gemini with a paid key. Wanting the widest choice from one key: use OpenRouter, with about 400 models. Wanting Ground, Audit and Extras free: use a local runner for Phases 1, 2 and 4, plus one of the other routes for the chronicle.](../assets/diagrams/which-route-suits-you.svg)

- **Lore-accurate content** → **Google Gemini**. Stays more faithful to source material that includes swearing, explicit content, and violence (toggleable in settings) where other models tend to sanitise by default.
- **Best narrative prose** → **Gemini Pro**, or a strong prose model via OpenRouter. Both produce good long-form narration.
- **OpenRouter** also lets you filter the picker to models measured to carry mature content without sanitising it.
- **[Claude Code](../extras/claude-code.md)** and **[Codex](../extras/codex.md)** route phases through the signed-in CLI and spend that plan's allowance rather than API credit. Running out mid-session pauses the run instead of failing it.
- **Local runners** keep Ground, Audit and Extras free and private; the chronicle still needs a cloud model or a subscription.

For most groups, a cheap model on the mechanical phases plus a strong one on the prose phase is the sweet spot. Per-phase routing makes that one panel away, and the guided rungs below set it up in one click.

### Cost — what you'll actually pay

Per-session cost for a 3-hour recording with full lore documents depends on
the routing: $0 extra on a subscription CLI, a few dollars on the Gemini Pro routes, and more than that on the strongest OpenRouter models (see the costs page for current figures). A local runner can take Ground, Audit and Extras for nothing, but the chronicle and Condense still need one of the others.

**[Costs](costs.md) owns the numbers** — the per-route breakdown, what drives
them, and how to bring them down. They live in one place so they cannot drift
apart from each other.

Tomes paces between chunks automatically, waiting long enough to stay under the provider's limit. Gemini uses a static table keyed on the key tier and the model, and OpenRouter a requests-per-minute figure. Claude Code, Codex and local runners are not paced.

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

- **Prompt caching, extended.** Phase 3 (Chronicle) and Phase 5 (Condense) use the cacheable-prefix split that Phase 1 already had. The system instructions, KB lore, and DM Q&A live in the prefix; the per-chunk transcript and tail live in the user prompt. **Net effect: the lore stops being re-billed on every chunk.** This was the biggest single token-cost driver on long sessions.
- **(provider, model-tier)-keyed chunk sizes.** Fast-tier models run on chunks roughly half the flagship size. They're cheaper per call and degrade less on long inputs, so quality holds at lower token counts.
- **Thinking tokens measured, not guessed.** A controlled A/B on a real session found thinking tokens bill at the *output* rate and made up 55–80% of the chronicle phase's billed output — the single largest line item, and one nobody had measured before. The routing recipes are built from those numbers.

> [!CAUTION]
> **Turning thinking off is not a safe saving.** The same test found that with
> thinking disabled, the fast-tier model misattributed dialogue to the wrong
> character. Thinking stays on everywhere in the shipped recipes. A cheaper
> chronicle that puts words in the wrong character's mouth is not cheaper.

The next cost lever on the roadmap:

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
4. In Tomes: **Settings → Providers & models**, paste under **Paid tier (billing-enabled) — primary key, required**. The keystore encrypts it immediately.

> [!WARNING]
> Gemini 3.x requires billing enabled on the project. Default Tomes models are
> `gemini-2.5-pro` / `gemini-2.5-flash`; override with `VITE_MODEL_PRO` in
> `.env` if you want to pin a specific one.

**Optional second key — a free tier.** If you also have a free-tier Gemini key (without billing), you can paste it under **Free tier (optional)**. A phase's tier setting decides which key it uses:

| Mode | Tries first | Falls back to |
|---|---|---|
| `auto` (the default) | The paid key | The free key for the rest of the run, when the paid key reports a quota of zero or two quota errors in a row |
| `paid` | The paid key only | Nothing: the free key is never used |
| `free` | The free key only | Nothing, except that a phase whose model is on the paid-only list uses the paid key |

Tomes sends a phase to the free key only when you point that phase's routing row at **Gemini Free**; the Smart Budget recipe in [Recommended settings](../chronicling/recommended-settings.md) does this for Phase 4 extras. The free-tier escalation safety net (Free → Paid retry on refused content or transient 5xx) covers a phase you have pointed at the free key if its quota stalls.

You can probe either key to check which models it can actually call — the button next to each slot runs a live check and consumes a small amount of quota. **Customise phases** shows when each key was last checked, with a button to check it again.

> [!NOTE]
> **Got a free-tier Gemini key?** Consider saving it for [Tusk's Vault](https://github.com/KochiTusker/Tusks-Vault), the AI-chatbot companion that lets you query your campaign lore in natural language. Vault's per-query token use is far lower than Tomes' five-phase pipeline, so a free-tier quota carries its workload comfortably. Pasting your free key into Tomes is fine — it'll only ever drive Phase 4 extras — but the higher-leverage use is over there.


</div>
</details>

<details class="docs-section">
<summary><h2>OpenRouter — one key, around 400 models</h2></summary>
<div class="docs-section-body">


One key reaches most of the commercial model landscape, including every Anthropic and OpenAI model, at pass-through rates. This is the route to those models now that the direct integrations have been retired.

1. Open <https://openrouter.ai/keys> and sign in.
2. Add credit, then create a key (starts with `sk-or-...`).
3. In Tomes: **Settings → Providers & models**, paste under **OpenRouter → API key**.

The catalogue is public and needs no key to browse, so the model picker is populated before you've pasted anything. Once a key is in, the picker fetches the live catalogue. Claude Code's model list is drawn from the same catalogue, so re-checking it under **Customise phases** refreshes both.

**Two filters worth knowing about**, because they encode work you'd otherwise have to do yourself:

- **Tested only** — models the maintainer has actually run and graded on real session material, rather than the whole catalogue.
- **Handles mature content** — models measured relaying swearing, violence and explicit content faithfully instead of sanitising it. For a chronicle of what your table actually said, this matters more than benchmark scores.

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

1. **Install Claude Code** and run `claude login`, choosing your Pro/Max plan. Make sure `claude` is on your `PATH`. Tomes has no Anthropic key slot, and it removes any Anthropic key left in your shell from the call, so the run always bills your subscription.
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
<summary><h2>Running the mechanical phases on Ollama / LM Studio / Unsloth</h2></summary>
<div class="docs-section-body">


> [!NOTE]
> Nothing to install on the Tomes side. Install a runner, start it, and let
> the panel detect it (**Detect again** repeats the check).

1. Install **[Ollama](https://ollama.com)** (easiest) and pull a model: `ollama pull gemma3:27b`. Or run **[LM Studio](https://lmstudio.ai)** / **[Unsloth](https://github.com/unslothai/unsloth)** on their default ports.
2. In Tomes: **Settings → Providers & models**. The Local LLMs panel probes localhost on the default port of each backend (Ollama, LM Studio, llama.cpp and Unsloth) when it opens; **Detect again** repeats the check. Run a probe on the model, then assign it in the routing rows:

![A path in four steps. Start a runner yourself: Ollama, LM Studio or Unsloth. Tomes finds it on its port, and Detect again repeats the check. Run a probe on a model, which has two tests. Test 1, five JSON prompts, passes at 0.8 and makes the model eligible for Phases 2 and 4. Test 2, fixing five misheard names, passes at 0.7 and makes it eligible for Phase 1. Phases 3 and 5 are never offered. Finally, assign the model to those phases in the routing rows.](../assets/diagrams/local-model-setup.svg)

Hardware advisories check VRAM and RAM for the model you picked, so a 32B model on 8 GB doesn't silently fall over.

> [!WARNING]
> **Quality caveat.** Smaller local models drift more on grounding and audit
> than the cloud flagships, and the routing rows offer a local model only for
> Phases 1, 2 and 4, where its probe passes. The chronicle and Condense go to a
> cloud model or a subscription CLI. Mixing per phase is the sweet spot — local
> for grounding, audit and extras, something strong for the narrative.


</div>
</details>

<details class="docs-section">
<summary><h2>Why the local-LLM proxy exists</h2></summary>
<div class="docs-section-body">


Tomes mounts an Express proxy at `/api/local/generate` and `/api/local/launch` that is same-origin with the page (model detection goes through `/api/local-llm/detect`). The browser can't reach Ollama (`localhost:11434`) or LM Studio (`localhost:1234`) directly, because a different port is a different origin. The browser talks to Tomes' own server instead, and the proxy only forwards to `localhost` or private-network addresses.

The proxy supports bearer-token, OAuth2 password flow (cached 30-minute JWTs), and HTTP Basic auth for backends that need it.

See [the local LLM guide](../extras/local-llms.md) for setup details and [`architecture.md`](../about/how-its-built.md) for the implementation.


</div>
</details>
