# What it costs

Nothing goes to me. This is MIT-licensed and it always will be — there's no
paid tier, no upsell, and no feature behind a paywall. The Buy Me a Coffee link
exists if you're feeling generous, and that's the extent of it.

The only money involved is whatever your chosen AI provider charges for the
tokens. You pay only on the weeks you actually play, and there are two ways to
get it to zero: run a local model, or draw on a Claude Code or ChatGPT
subscription you already pay for.

## What a session costs

<!-- COSTS:START -->
| Routing | Per session | What it is |
|---|---|---|
| **Subscription everywhere** | $0.00 | Every phase on a Claude Code or Codex plan you already pay for. |
| **OpenRouter prose + subscription grounding** | $0.42 | A Claude Code plan on the mechanical phases, OpenRouter on the prose. |
| **OpenRouter everywhere** | $0.44 | Every phase on OpenRouter, chosen for cost against measured quality. |
| **Gemini measured hybrid** | $0.78 | Derived from a controlled A/B on a real session rather than from guesswork. |
| **Gemini Flash everywhere** | $0.98 | The cheapest all-Gemini route. Prose is noticeably less polished than Pro. |
| **Gemini Smart Budget** | $2.77 | Pro for the chronicle, Flash for the mechanical phases, Flash-Lite to condense. |
| **Gemini Pro prose + subscription grounding** | $3.60 | A Claude Code plan carries the mechanical phases; Gemini writes the prose. |
| **Gemini Pro everywhere** | $4.85 | The reference number. Every phase on the strongest Gemini model. |
| **OpenRouter, strongest models** | $10.39 | The same catalogue, routed for quality rather than for price. |

Figures are USD for a 3-hour session — about 190k characters of transcript with a furnished campaign’s lore in context.

Priced on **2026-08-24** against the live OpenRouter catalogue (411 models), and regenerated every time the site is published.
<!-- COSTS:END -->

> [!NOTE]
> These numbers are generated, not typed. Every time the site is published, the
> build prices each routing against the live OpenRouter catalogue using the
> same estimator the app shows you before a run — so a model getting cheaper
> shows up here without anyone editing this page.

> [!WARNING]
> An estimate is an estimate. It assumes a three-hour session and a furnished
> campaign's lore in context; a shorter session with a thin glossary costs
> less, a marathon with a large lore folder costs more. The **Run** button
> shows the estimate for *your* transcript and *your* routing, which is the
> number to trust before committing to a long run.

## Where the money actually goes

Thinking tokens, mostly. They bill at the **output** rate, and on the chronicle
phase they run at close to the model's ceiling on every call — on a
reconciliation against two real bills they accounted for the large majority of
the spend.

> [!CAUTION]
> **Turning thinking off is not the saving it looks like.** With it disabled, a
> fast-tier model misattributed dialogue to the wrong character. A cheaper
> chronicle that puts words in the wrong character's mouth is not cheaper, so
> thinking stays on in every shipped routing.

The levers that do work, and are already applied:

- **Prompt caching.** System instructions, lore, and DM answers sit in a
  cacheable prefix, so the lore is not re-billed on every chunk. This was the
  single largest cost driver before it landed.
- **Chunk sizes keyed to the model tier.** A fast-tier model runs chunks about
  half the flagship size: cheaper per call, and it degrades less on long input,
  so quality holds at the lower token count.
- **Routing the mechanical phases somewhere cheap.** Grounding, audit and
  extras do not need a flagship. Putting them on a cheap model, a subscription
  CLI, or a local runner is where most of the difference between the rows above
  comes from.

## Getting it to zero

| Route | Cost | Trade-off |
|---|---|---|
| **A subscription you already pay for** — [Claude Code](../extras/claude-code.md) or [Codex](../extras/codex.md) | No API spend | Metered in rolling windows rather than per token. One session can use a large share of a five-hour window, so budget one or two per window. Exhausting it pauses the run rather than failing it. |
| **A local model** — [Ollama, LM Studio or Unsloth](../extras/local-llms.md) | Electricity only | Prose quality below roughly 15B parameters is noticeably weaker. Mixing — local for the mechanical phases, cloud for the prose — is usually better than going fully local on modest hardware. |

## What is never paywalled

Every feature, forever. There is no pro tier, no seat count, no export limit,
and no account to create. If a future version adds something, it will be in the
same MIT-licensed repository as everything else.

## Next

- [Choosing a provider](choosing-a-provider.md) — which connection to set up
- [Per-phase routing](per-phase-routing.md) — how to build a cheaper recipe by hand
- [Recommended settings](../chronicling/recommended-settings.md) — sensible defaults to start from
