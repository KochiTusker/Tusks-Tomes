# Changelog

What changed between versions. The rest of the documentation describes how the
current version works and does not carry version history — if you want to know
what something used to do, this is the page for it.

## 2026-08 — OpenRouter, and a smaller set of things to configure

**One key reaches around 400 models.** OpenRouter is now a first-class
connection. Any model in its catalogue can be assigned to any phase, and the
model picker is populated from the public catalogue before you have pasted a key
at all.

**The direct Anthropic and OpenAI key slots were retired.** OpenRouter fronts
both vendors at pass-through rates — the same models, the same prices, reached
with one key. Three keys bought nothing over two except more to configure, two
more adapters to keep current as vendor SDKs move, and two more rate-limit
header formats to parse. Routing that names a retired provider is rewritten on
read to the same model in the OpenRouter namespace, matched by model and never
swapped for something cheaper, and the change is logged rather than made
silently.

**Gemini stays a separate, direct connection.** It is measurably cheaper direct
— the same Pro model lists roughly a fifth dearer through OpenRouter — and the
only generation that collapsed into a repetition loop during the comparison was
Gemini routed through OpenRouter, while the same model on the direct key was
clean on identical input. The cause was not content filtering: a deliberately
graphic passage sent three ways produced identical uncensored output on all
three.

**Six of the seven optional modules stopped being installations.** Their install
step only ever wrote a marker file and then asked for a server restart —
install-shaped ceremony for code that already shipped in the bundle. Only Audio
Transcription installs anything now. Whether one of the others is *usable* is a
detection question its own status row answers.

**Uninstalling Personas can no longer delete your work.** The old uninstall
removed `personas.json`, the file holding personas you had written yourself.
Personas is built in now and has no uninstall path, so that way of losing your
own authoring is gone by construction rather than by remembering not to click
the button.

**Routing became one surface.** It had been split across a model profiles
editor, a hybrid routing panel and two generations of preset buttons. It is now
a single list of phases with a ladder of complete presets above it, and the
per-phase detail one disclosure deep.

**Run-start provider selection was removed.** Choosing a provider at the moment
you press Run asked the question at the point of least context. A banner above
the Chronicle controls now states which connection the next run will use.

**Cost estimates were recalibrated against real billing.** Thinking tokens bill
at the output rate, and on the chronicle phase they run near the model's
ceiling on every call — none of which was being counted. Two real bills put the
old estimate at roughly a fifth of actual. The estimator now accounts for them,
so the figures it shows are several times higher than before and considerably
closer to the truth.

## 2026-08 — Documentation

**Reorganised by what a reader is trying to do.** Pages sit on shelves —
getting started, bringing a session in, writing the chronicle, models and cost,
extras, settings, privacy, troubleshooting — and are named for the task rather
than for the file. Every previously published URL still resolves; the site
emits a forwarding page at each old path.

**Costs are generated, not typed.** Every publish prices each routing against
the live OpenRouter catalogue using the same estimator the app shows before a
run, so a model getting cheaper updates the docs without anyone editing them.

**Emoji were replaced by colour.** Red marks a warning, orange a notice, green
something that got simpler. Sections render open rather than collapsed.

## Earlier

Version history before this point was not kept separately; the
[roadmap](roadmap.md) records what shipped and when.
