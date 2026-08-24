# Per-phase routing

The question this page answers: **can a mix of cheaper models match a single
strong one, and if so, how do you arrange it?**

The short answer is yes for four of the five phases, no for one, and the
biggest single improvement is not a model swap at all.

Read [How each phase works](../chronicling/how-the-phases-work.md) first if you have not — the
recommendations below only make sense against what each phase actually asks
for.

---

## Start here: the change that matters more than model choice

Phases 1 and 3 both ask a model to emit roughly as many tokens as it was given.
At the default chunk sizes that is around **7,500 output tokens for Ground** and
**15,000 for Chronicle**.

Every piece of published work on long-form output fidelity points the same way:
**quality falls off sharply somewhere around 2,000–4,000 output tokens, and this
is true of frontier models too.** A few concrete numbers, all from independent
groups:

| Evidence | Finding |
|---|---|
| LongProc (Princeton), 8K-token tier | Gemini 1.5 Pro **54.0**, GPT-4o **38.1**, Claude 3.5 Sonnet **22.0**, Qwen2.5-72B **20.0** — against 89.2 / 94.8 / 78.4 / 68.7 at the 500-token tier |
| LIFEBench, exact-length control | Average **49.1** across 26 models; past ~4,096 words "no models consistently exceed 40"; "lazy generation" (giving up early) exceeds **10%** at 8,192 words |
| Chroma "Context Rot", pure copy task | Degradation accelerates from ~2,500 words; hallucinated tokens appear from 500–750 words |
| Verbatim transcription study | **Zero perfect runs at 300 items across all 11 models tested** |

Long *input* independently makes it worse: LIFEBench found 21 of 26 models
degraded once input passed ~5,000 words. A 30,000-character chunk is about
5,000 words.

**So the pipeline is currently operating past the fidelity cliff on every
model, including the expensive ones.** Reducing Phase 1 chunk size is therefore
not a concession made for cheap models — it improves Gemini Pro too. It just
improves cheap models more, because they fall off the cliff sooner.

The cost of doing it is modest and quantified: splitting a Phase 1 chunk in two
costs about **$0.0013** extra on Gemini Pro, because Phase 1's cacheable prefix
is small. What it really spends is *request count*, which matters only if you
are on a rate-limited free tier.

**Recommended:** Ground at ~8,000–10,000 characters per chunk rather than
15,000–30,000. Chronicle is a different case — see below.

### Why Chronicle cannot simply follow suit

Phase 3 has a competing constraint: every chunk boundary is a seam in the
narrative, and the 2,000-character prior tail only partly bridges it. There is a
documented floor below which coherence degrades faster than focus improves.

So Chronicle wants a *moderate* reduction, not the aggressive one Ground can
take — and it is the phase where paying for a stronger model is most justified.

---

## What the benchmarks are worth

Worth stating plainly, because it changes how you read model marketing:

| Signal | Predictive value here |
|---|---|
| LongProc, LIFEBench, Context Rot | **High** — these measure long-form output fidelity, which is the thing |
| IFBench (the Copy category especially) | Medium — the only mainstream instruction benchmark with a span-reproduction task |
| RULER / needle-in-a-haystack | **Low** — correlation with long *output* performance is r≈0.51 at 16K. Confirms a model can read your input; says little about whether it will reproduce it |
| IFEval | **Low** — saturated, short outputs, and its length constraints are one-sided ("at least N") where yours is an implicit equality |
| MMLU / GPQA / AIME | **None** — the correct answer to these is a letter or an integer. They cannot measure output fidelity |
| LMArena Elo | **Anti-predictive.** Style-control analysis puts the answer-length coefficient at **0.249**, about 8× any formatting feature. Arena rewards writing *more*; this pipeline needs a model that writes *exactly as much as the input and adds nothing* |

The practical upshot: **a model being "the best conversationally" is close to
irrelevant for Ground, Audit and Extras.** It matters for Chronicle, and even
there the axis is sustained coherent prose rather than chat quality.

There is also a domain-specific warning worth taking seriously. On LibriSpeech,
zero-shot LLM correction of ASR output made word error rate *worse in every
configuration tested* — 2.2% baseline rising to between 8.8% and 32.0%, with
3–12% hallucination rates. The published fix is exactly what this pipeline
already does: correct in segments with context, not the whole document at once,
and keep a specialised narrow task rather than asking for general improvement.

---

## Per-phase recommendations

Evidence quality is flagged throughout. Where nobody publishes the relevant
number, this page says so rather than substituting a related one.

### Phase 1 — Ground

Wants: long output without drift, no moderation filter, no reasoning written
into the reply, and ideally non-thinking (deliberation is wasted on a mechanical
transformation, and long chains of thought are documented to *reduce*
constraint adherence).

**Avoid for this phase:**

- **Models that write reasoning into the reply body.** Measured directly against
  the live API: two models emitted 12× the expected output because their
  chain-of-thought landed in the response. Neither `reasoning: {exclude: true}`
  nor a lower effort setting reliably suppressed it, and the built-in stripper
  only removes *tagged* blocks. The picker flags these.
- **Model families with documented character drift.** Both the GLM and DeepSeek
  families have vendor-acknowledged issues with non-Latin characters appearing
  in long English output — DeepSeek shipped an entire release to reduce it, and
  one report describes it appearing specifically "when it was just repeating
  back input", which is this phase exactly. Reports concentrate on quantised
  third-party hosting.
- **Models optimised for brevity.** At least one very cheap model is explicitly
  trained toward "shortest correct response", which is the opposite of what this
  phase needs.

**Reasonable choices:** the Qwen 2507 instruct line is non-thinking by
construction and publishes the strongest instruction-following numbers in the
cheap tier (though see the caveat about IFEval above). DeepSeek V4 Flash is
strong at this input size and is not mandatory-reasoning — but pair it with a
character check. Among free models, the Nemotron Ultra and Super variants
passed a live grounding probe cleanly.

### Phase 2 — Audit

The easiest phase to serve. Needs reliable structured output and nothing else;
the output is a few hundred tokens.

Put the cheapest model that emits clean JSON here. Verify it actually does —
some otherwise-capable free models cannot, including the largest free one.

### Phase 3 — Chronicle

**This is the phase where a strong model earns its cost**, and the one where
"comparable output for cheaper" is hardest to achieve honestly.

Needs: sustained coherent prose over a long output, no moderation filter, and
narrative continuity across seams. No published benchmark measures the
combination well. Long-form writing benchmarks measure whether a model *can*
produce length; they use an LLM judge for quality, which a fluent summary can
satisfy while failing the actual requirement.

Moderation is the hard constraint. All Anthropic and most current OpenAI models
carry a prompt-level filter, and this phase routinely handles violence and
profanity. Google, DeepSeek, NVIDIA, Z-AI, Moonshot and xAI models generally do
not.

**Recommendation: keep a strong model here.** If you are optimising, optimise
Phases 1, 2, 4 and 6 and leave this one alone. The measured saving from moving
Ground to a cheap model is about 37% of the run; moving Chronicle as well saves
another 33% but is where quality risk concentrates.

### Phase 4 — Extras

Needs structured output **and** no moderation filter, because it is extracting
gore into a JSON field. That intersection is narrower than it looks and rules
out most Anthropic and OpenAI options.

Watch chunk boundaries here: the unit of capture is a multi-speaker exchange,
and one split across a boundary is lost from both sides.

### Phase 6 — Condense

Context window is the binding constraint, not quality. With the full vault
attached this phase needs roughly 560,000 tokens of context; with retrieval on
it needs about 70,000, which nearly everything can serve.

Turn retrieval on and the model choice opens up enormously. Leave it off and
you are restricted to million-token-context models regardless of budget.

---

## Making cheap models safe: verify, then escalate

The most useful structural idea here is that **Phase 1's output is mechanically
checkable**. It should be roughly the same length as its input, contain the
glossary terms, and consist of the same speaker turns. So you do not have to
*trust* a cheap model — you can check it, cheaply, and only pay for a better one
where it failed.

A verification gate on Ground would test:

| Check | Catches |
|---|---|
| Output/input length ratio within band | summarising, early stopping, truncation |
| No characters outside the expected script | the documented character-drift failures |
| Glossary terms present in output | failure to apply the knowledge base |
| Speaker-marker count preserved | dropped lines |
| No untagged reasoning preamble | chain-of-thought written into the reply |

Fail → retry once → escalate that chunk alone to a stronger model. Because a
typical session is a couple of dozen chunks and failures are per-chunk, the
escalation cost is small even at a fairly high failure rate.

This is what "giving cheap models the best chance" looks like in practice: not
hoping, and not levelling anything down, but making failure cheap to detect and
cheap to recover from.

> **Status:** the verification gate is described here as a design, not as
> shipped behaviour. The checks are all straightforward, but nothing in the
> pipeline performs them today.

---

## Request settings that materially change cheap-model quality

These matter more than they sound, and several are the difference between a
model working and not.

**Pin the provider.** The same model ID on OpenRouter is served by many hosts
with wildly different output ceilings — one model ranges from 7,168 to 1,048,576
tokens depending on who answers. Routing is price-weighted, so it *prefers* the
cheapest host, which is often the most aggressively quantised one. Character
corruption and repetition loops are both reported far more on low-bit
quantisation.

**Set `max_tokens` explicitly.** Besides bounding output, it restricts routing to
providers that support that length — which is a free way to avoid the 7,168-token
host above.

**Require the parameters you depend on.** OpenRouter passes structured-output
requests upstream rather than enforcing them, and its own documentation notes
some providers "treat it as a strong hint" rather than a guarantee. For the JSON
phases, require the parameter so routing only considers hosts that honour it.

**Decide the reasoning setting deliberately.** Defaults vary and none of them are
chosen for this pipeline. Some models reason by default at high effort; a few
cannot be stopped at all. Reasoning tokens bill as output and count against the
budget before your actual text starts. For mechanical phases, off is usually
right — but note that on at least one family, disabling it also substantially
reduces long-context accuracy, so it is a real trade rather than a free win.

**Validate JSON and retry.** No vendor publishes a JSON-reliability benchmark for
any of the candidate models. Assume one-shot reliability is not guaranteed.

---

## Does a mix actually beat one good model?

On cost, comfortably. On quality, it depends entirely on which phase you move.

For a three-hour session:

| Arrangement | Cost | Where the risk sits |
|---|---|---|
| Strong model everywhere | ~$1.70 | none |
| Cheap on Ground/Audit/Extras/Condense, strong on Chronicle | ~$0.57 | Ground, and it is checkable |
| Cheap everywhere | ~$0.05 | Chronicle, and it is not checkable |

The middle row is the interesting one. It removes about two-thirds of the cost
while leaving the phase that most determines how the chronicle *reads* on a
model you trust — and the phase it does move is the one whose output can be
verified automatically.

Going further and moving Chronicle too takes cost to almost nothing, but that is
where the honest answer is: **no published evidence supports the claim that a
cheap model matches a frontier one at exhaustive long-form narrative prose, and
the benchmarks people usually cite for it do not measure the right thing.** If
you want to try it, A/B the same session and read both.

---

## What is not known

Stated plainly, because a lot of confident-sounding material on this topic is
not well founded:

- **No vendor publishes instruction-following or long-output-fidelity numbers
  for most of the candidate models.** Every model card in this space optimises
  for agentic coding benchmarks. The axis this pipeline loads is unmeasured.
- **The long-output benchmark ecosystem is roughly a year behind the models.**
  The leaderboards that do measure the right thing contain none of the current
  candidates.
- **Refusal behaviour on fictional violence is untested** for essentially every
  candidate. The moderation flag tells you a platform filter exists; it does not
  tell you what the model itself does with a gore-heavy scene.
- Several benchmark figures circulating for these models could not be traced to
  any vendor source and appear to be fabricated by aggregator sites.

Given that, the highest-value thing you can do is not read more benchmarks. It
is to run one real transcript chunk through three candidates and compare the
outputs against the source directly — length ratio, glossary-term retention,
and a read-through. That will out-predict every leaderboard mentioned here.

---

## Where the savings actually are

Worth being precise, because "cost" and "call count" point at different phases
and the free tier rations the second one.

One three-hour session on a single Pro-tier model:

| Phase | Calls | Input tokens | Output tokens | Cost | Share of cost |
|---|---|---|---|---|---|
| 1 Ground | 8 | 69,000 | 55,000 | $0.63 | **37%** |
| 2 Audit | 8 | **114,000** | 1,104 | $0.15 | 9% |
| 3 Chronicle | 4 | 57,000 | 49,500 | $0.56 | **33%** |
| 4 Extras | 4 | 57,000 | 2,752 | $0.10 | 6% |
| 6 Condense | 2 | 75,500 | 14,850 | $0.23 | 14% |

Two readings, both true:

- **By money, the answer is Phases 1 and 3** — 70% between them. Output tokens
  cost several times what input tokens do, and those are the two phases that
  emit output on the scale of their input.
- **By calls, the answer is Phases 1 and 2** — 16 of 26. That matters because
  the free tier rations *requests*, not tokens. If you are trying to fit a
  session inside 50 requests a day, Phase 2 is as expensive as Phase 1.

**Audit has by far the worst shape in the pipeline: 114,000 input tokens to
produce about 1,100 output tokens, and most chunks correctly return an empty
list.** It is 31% of all input in the run for 1% of all output. It is cheap in
money only because its output is tiny.

So the instinct that Phases 1 and 2 are where the grunt work is, and that a
cheaper non-prose model belongs there, is right — but the reason is the call
count and the input volume, not the bill.

## Splitting Audit in two

Audit currently does two jobs in one call: it compares the raw and grounded text
*and* it composes questions for the game master. That is why it ships both
copies of the chunk, and why its input is double everything else.

Separating them is worth doing:

**A deterministic diff first.** Comparing raw against grounded is a string
operation, not a judgement. Most chunks differ only by the proper-noun
substitutions Phase 1 was asked to make, which are already known — they came
from the glossary. A chunk whose only differences are expected substitutions
has nothing to ask about, and needs no model call at all.

**Then a question pass, only on chunks that survive.** Those are the chunks
where something unexpected changed, or where the grounded text still contains
an unresolved candidate. Far fewer calls, each carrying one chunk rather than
two.

The gain is mostly in calls rather than money — perhaps $0.10 of a $1.70 run,
but potentially 5 or 6 of 26 requests, which on a 50-request daily allowance is
the difference between one session and two. It also removes the need for the
audit model to reason at all on most chunks, which suits exactly the cheap
non-prose models this page has been pointing at.

It has a second benefit worth naming: a chunk can be assessed *before* being
sent. If a chunk is going to trip a moderation filter, knowing that from the
diff stage means routing it elsewhere rather than losing the call to a refusal.

> **Status:** proposed, not built. The pipeline currently runs Audit as a single
> combined pass.

## Which models suit Ground and Audit

These two phases want the opposite of a good conversationalist. They want
faithful transformation, stable output length, no editorialising, and no
deliberation in the reply. Prose ability is close to irrelevant.

That is a real opening for the models usually described as data-transformation
rather than writing models, and the evidence for them on this specific axis is
better than it is for the prose phases:

- **The Qwen 2507 instruct line** is the strongest documented fit. It is
  non-thinking *by construction* — the model cards state plainly that it does
  not emit thinking blocks, so there is nothing to strip and no reasoning
  tokens to pay for. It publishes the highest instruction-following scores in
  the cheap tier and long-context retrieval in the mid-80s. One caveat from
  Qwen's own card: do not raise `presence_penalty`, which it links to language
  mixing.
- **Kimi K2.6** carries the strongest evidence of sustained long output of any
  candidate — its own evaluations ran to 98,304 tokens. Thinking must be turned
  off explicitly, which also sidesteps a reported repetition loop that only
  occurs while reasoning. Pin the provider: one host caps its output at 16,384.
- **DeepSeek V4 Flash** is strong at the input size these phases actually use.
  Thinking is on by default at high effort and should be disabled. Pair it with
  a character check — the family has a vendor-acknowledged issue with non-Latin
  characters in long English output, and one report describes it occurring
  specifically while reproducing input, which is what Ground does.

For the prose phases the ordering is different and the evidence is thinner. The
providers usually named as the best conversationalists probably are, and none of
the research contradicts that. What it does establish is that the gap is not
uniform across phases: on Extras and Condense a Flash-tier model is already
near-parity with Pro, so the premium is only clearly worth paying on the
chronicle.

## Testing plan for the prose phases

The grades in the picker will stay blank for the prose phases until something is
actually run, and the useful question is not "which model is best" but which of
three buckets each model falls into:

| Bucket | What it means | How to tell |
|---|---|---|
| **Surpasses** | Better than the reference on this phase | Read both. A judge model will not reliably see this. |
| **Comparable, cheaper** | Same standard, less money | Side-by-side read plus cost |
| **Close enough** | Visibly weaker, acceptable for the price | Side-by-side read |
| **Not viable** | Would change what the chronicle is | Any of: refusals, drift, summarising |

For each candidate: same session, same routing except the phase under test,
reference model on everything else. Then compare on named-entity fidelity,
absence of refusal artefacts, continuity across chunk boundaries, whether
Phase 3 stayed exhaustive rather than summarising, and — for Extras — whether
the "funny" list is actually funny, which is the one dimension where a
first-hand read has already found a clear difference between providers.

---

## Hybrid combinations, priced

Reference workload throughout: one three-hour session with 10,000 words of lore,
at the conservative chunk sizes the OpenRouter provider falls back to (15 calls
on Ground, 8 on Chronicle). Gemini rates are the direct-API ones.

**Cost per phase:**

| Model | in/out per M | Ground | Audit | Chronicle | Extras | Condense | Total |
|---|---|---|---|---|---|---|---|
| gemini-pro (direct) | 1.25 / 10.00 | $0.698 | $0.159 | $0.584 | $0.109 | $0.288 | **$1.84** |
| gemini-2.5-flash | 0.30 / 2.50 | $0.173 | $0.038 | $0.145 | $0.026 | $0.071 | $0.45 |
| grok-4.20 | 1.25 / 2.50 | $0.285 | $0.151 | $0.213 | $0.088 | $0.176 | $0.91 |
| grok-4.6 | 2.00 / 6.00 | $0.567 | $0.243 | $0.439 | $0.147 | $0.312 | $1.71 |
| kimi-k2.6 | 0.56 / 2.36 | $0.196 | $0.069 | $0.157 | $0.043 | $0.097 | $0.56 |
| **kimi-k3** | **3.00 / 15.00** | $1.180 | $0.372 | $0.956 | $0.237 | $0.557 | **$3.30** |
| qwen3-235b-2507 | 0.09 / 0.55 | $0.041 | $0.011 | $0.034 | $0.007 | $0.018 | $0.11 |
| deepseek-v4-flash | 0.083 / 0.165 | $0.019 | $0.010 | $0.014 | $0.006 | $0.012 | $0.06 |
| gpt-oss-120b | 0.03 / 0.17 | $0.013 | $0.004 | $0.011 | $0.002 | $0.006 | $0.04 |
| claude-sonnet-4.5 | 3.00 / 15.00 | $1.180 | $0.372 | $0.956 | $0.237 | $0.557 | $3.30 |

**Kimi K3 is not a cheap option.** At $3.00/$15.00 it is the joint most
expensive model here, level with Claude Sonnet and nearly twice Gemini Pro. If
you want Kimi, K2.6 is the one — a fifth of the price and the family's strongest
published evidence for sustained long output.

**Combinations**, split by how much lands on the Google bill:

| Combination | Google | Elsewhere | Total |
|---|---|---|---|
| All Gemini Pro | $1.84 | — | $1.84 |
| **Current balanced** — Claude Code 1–2, Pro 3, Flash 4/6 | **$0.68** | $0.00 | **$0.68** |
| Qwen 1–2, Pro 3, Flash 4/6 (no subscription needed) | $0.68 | $0.05 | $0.73 |
| DeepSeek 1–2, Pro 3, Flash 4/6 | $0.68 | $0.03 | $0.71 |
| Kimi K2.6 1–2, Pro 3, Flash 4/6 | $0.68 | $0.26 | $0.95 |
| Qwen 1–2, Pro 3, Flash 4, **Grok 6** | $0.61 | $0.23 | $0.84 |
| **Qwen 1–2, Grok 3, Flash 4, Grok 6** | **$0.03** | $0.44 | **$0.47** |
| Cheapest viable everywhere | — | $0.04 | $0.04 |

Three things fall out of this.

**Dropping Claude Code costs almost nothing.** Swapping it for Qwen on Ground
and Audit takes the total from $0.68 to $0.73 — five pence. The subscription is
buying convenience, not a meaningful saving, and a run that no longer depends on
it is one fewer thing to have configured.

**Every penny of the current preset is a Google bill.** Claude Code contributes
nothing to it because it bills against a subscription, so the $0.68 is entirely
Pro on Chronicle plus Flash on Extras and Condense. Moving the mechanical phases
around cannot reduce it, because they are already free. **Only Chronicle and
Condense can.**

**Chronicle is where the Google bill lives.** At $0.584 it is 86% of the
preset's cost. Grok 4.20 does the same phase for $0.213 — 2.7× less — with 2M
of context, no moderation filter, and reasoning that can be left off. Whether
its prose stands up is the open question, and the one worth testing first.

Condense is the easier win: Grok 4.20 at $0.176 against Pro's $0.288, on a
phase where Flash is already near-parity, so the quality bar is lower.

## What to test first, in order

1. **Grok 4.20 on Chronicle.** Biggest single saving available and the whole
   argument turns on it. Unmoderated and cheap on output, which is what this
   phase spends. If its prose holds, the Google bill drops by about 85%.
2. **Grok 4.20 on Condense.** Lower bar, decent saving, and Flash already
   proves this phase does not need Pro.
3. **Qwen 2507 on Ground and Audit**, as the no-subscription path. Cost is
   already known to be negligible; what needs checking is whether it grounds as
   cleanly as Claude Code.
4. **Kimi K2.6 on Chronicle**, as the fallback if Grok disappoints — it has the
   best documented long-output behaviour of the cheap models, at $0.157.

Do not start with Kimi K3. It costs more than the model it would replace.
