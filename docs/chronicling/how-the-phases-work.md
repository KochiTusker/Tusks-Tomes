# How the phases work

A transparent, phase-by-phase account of what Tusk's Tomes actually sends to a
model, what it asks for, and what comes back. If you are choosing models — and
especially if you are trying to use cheap ones well — this is the page that
tells you what each phase is really asking of them.

Two things are worth knowing before the detail:

- **The phases are not equally hard.** Two of them ask a model to emit roughly
  as many tokens as it was given, which is among the hardest things you can ask
  a language model to do reliably. Two others ask for a few hundred tokens of
  JSON, which almost anything can manage.
- **They do not all get the knowledge base.** This surprises people. Only two
  phases see your lore at all, and only one sees all of it.

---

## The shape of a run

```
raw transcript
   │
   ├─ cleanupTranscript()   strip [Music], [Laughter], normalise whitespace
   ├─ preGround()           apply glossary safe-replacements + D&D dictionary
   ├─ detachSpeakers()      «1» markers replace [Character (Player)] tags
   │
   ▼
 Phase 1  Ground      ── AI ──▶  grounded transcript   (output ≈ input length)
   │
   ├──────────────▶ Phase 2  Audit    ── AI ──▶  DM questions (JSON, usually [])
   │                                                │
   │                            your answers ◀──────┘
   ▼
 Phase 3  Chronicle   ── AI ──▶  long-form narrative prose
   │
   ├──────────────▶ Phase 4  Extras   ── AI ──▶  quotes / jests / gore (JSON)
   │
   ▼
 Phase 5  Polish      ── local models only; cloud passes straight through
   │
   ▼
 Phase 6  Condense    ── AI ──▶  short narrative + bullet points   (optional)
```

Phases 3 and 4 both read the **grounded transcript**, independently of each
other. Phase 6 reads the **chronicle**, not the transcript.

---

## Before any model is called

Three deterministic passes run first. They are free, they are not AI, and they
do a surprising amount of the work.

| Pass | What it does |
|---|---|
| `cleanupTranscript()` | Removes `[Music]`, `[Laughter]` and similar caption artefacts; normalises whitespace. |
| `preGround()` | Applies your glossary's **safe replacements** — exact string swaps you have declared always correct — plus a built-in D&D dictionary. Anything fixable without judgement is fixed here, for nothing. |
| `detachSpeakers()` | Replaces `[Kaziel (Player)]` speaker tags with compact `«1»` markers, re-attached afterwards. Saves roughly 25–30 characters per utterance in every chunk of every phase. |

**Practical consequence:** the more you put in the glossary as a safe
replacement, the less Phase 1 has to reason about, and the better a cheap model
will do. This is the cheapest quality lever in the whole system.

---

## Phase 1 — Ground

**What it is for.** Speech-to-text mishears proper nouns. "Kaziel" becomes
"Cassiel", "Crimson Cathedral" becomes "crims and cathedral". Phase 1 hands the
model a chunk of transcript plus a compact glossary and asks for the same text
back with those errors corrected.

| | |
|---|---|
| Input | The full transcript, in chunks |
| Knowledge base | **Compact glossary** — top ~200 proper nouns with a one-line context each, roughly 10–20 KB. Sits in the cacheable prefix. |
| Output | **A near 1:1 corrected copy.** Same length, same wording, same speaker markers. |
| Output/input ratio | **~1.0** |
| Emits JSON | No |
| Prompt scaffolding | ~1,870 characters |
| Cacheable prefix | Yes — glossary and rules are byte-identical across chunks |

**Why this phase is hard.** Asking for output as long as the input is the
single most demanding thing in the pipeline. Published work on long-form output
fidelity is consistent about this: quality degrades as output length grows, and
degradation sets in well before the numbers most people expect. Beyond roughly
4,000 tokens of required output, models start summarising, drifting, or simply
stopping — and this is true of expensive models as well as cheap ones.

**The failure modes to watch for**, in rough order of how often they bite:

1. **Summarising instead of reproducing.** The model helpfully condenses. This
   is a trained-in bias, not a prompt failure — instruction tuning rewards
   being concise.
2. **Stopping early.** Output ends mid-scene with a normal stop reason, not a
   truncation error. Raising the token limit does not fix it.
3. **Over-correction.** Supplying a glossary can cause a model to insert those
   names where nobody said them, or to tidy up spoken grammar — which destroys
   the verbatim character of dialogue.
4. **Character drift.** Some model families are documented to inject
   non-Latin characters into long English output, more often on quantised
   third-party hosting and more often the longer the passage.

All four are **mechanically detectable**, which is what makes this phase a good
place to use a cheap model deliberately rather than hopefully. Compare output
length against input length, check the glossary terms survived, and reject
output containing characters outside the expected script.

**Choosing a model for it.** Wants: long output without drift, no prompt-level
moderation (raw table dialogue contains what it contains), and no tendency to
write its reasoning into the reply. Does **not** especially want: reasoning
ability, world knowledge, or creative quality. This is a transcription-clerk
job, not an authorial one.

---

## Phase 2 — Audit

**What it is for.** Comparing the raw and grounded text and asking whether
anything needs a human decision — a name that could plausibly be two different
NPCs, an action whose actor was lost to cross-talk, a dice outcome that is
genuinely unclear.

| | |
|---|---|
| Input | **Both** the raw chunk and the grounded chunk, in the same prompt |
| Knowledge base | **None.** This phase receives no lore at all. |
| Output | A JSON array of questions. Most chunks correctly return `[]`. |
| Output/input ratio | ~0.02 |
| Emits JSON | **Yes** — needs structured-output support |
| Prompt scaffolding | ~2,220 characters |
| Cacheable prefix | **None** — so its prompt is billed in full on every chunk |

**Worth knowing:** because it sends two copies of the chunk, this phase's input
is roughly **double** what its chunk size suggests. It is also the cheapest
phase to serve well, since the output is tiny. If you are economising, this is
the phase to put the cheapest capable model on.

**Choosing a model for it.** The only real requirement is reliable structured
output. A model that cannot emit clean JSON will fail here regardless of how
clever it is — and not every cheap model can, including some otherwise
excellent free ones.

---

## Phase 3 — Chronicle

**What it is for.** Turning the grounded transcript into readable third-person
past-tense narrative. This is the phase that produces the thing you actually
keep.

| | |
|---|---|
| Input | The full grounded transcript, in chunks, plus a 2,000-character tail of the previous chunk's prose for continuity |
| Knowledge base | **None on cloud providers.** Phase 1 already fixed the names, so the lore has done its job. |
| Output | Continuous narrative prose |
| Output/input ratio | **~0.9 — this is not a summary** |
| Emits JSON | No |
| Prompt scaffolding | ~8,030 characters — the largest of any phase |
| Cacheable prefix | Yes — rules, speech-handling policy and your Phase 2 answers |

**The instruction that governs everything here** is explicit in the prompt:

> Be exhaustive. This is the canonical long-form record of the session. Do NOT
> compress to save space — length comes from preserving the source's scope. A
> faithful chronicle should read at roughly the same level of detail as the
> transcript itself, not as a summary of it.

So this phase, like Phase 1, asks for output on the same scale as its input —
with the added difficulty that it must read as continuous prose across chunk
boundaries.

**Why chunk size behaves differently here.** For Phase 1, smaller chunks are
almost pure gain. For Phase 3 they are a trade: every boundary is a seam where
the narrative can restart or repeat, and the prior-tail mechanism only partly
covers it. There is a documented floor below which shrinking chunks costs more
in coherence than it buys in focus.

**Mature content is a functional requirement, not a preference.** Real table
dialogue contains violence, profanity and dark humour, and the prompt
explicitly instructs the model not to sanitise. A model with a prompt-level
moderation filter may refuse a chunk outright, which costs the whole chunk. The
model picker flags this.

**Choosing a model for it.** This is where quality money is well spent. Wants:
sustained coherent prose, no moderation filter, a large output ceiling.

---

## Phase 4 — Extras

**What it is for.** Pulling out the memorable bits: quotable exchanges, jokes,
and the gore list.

| | |
|---|---|
| Input | The full grounded transcript — **independently of Phase 3** |
| Knowledge base | **None** |
| Output | JSON: `{ quotes, jests, gore }` |
| Output/input ratio | ~0.05 |
| Emits JSON | **Yes** |
| Prompt scaffolding | ~5,140 characters |
| Cacheable prefix | **None** |

**The subtlety here** is that the unit of capture for a quote is a
multi-speaker **exchange**, not a single line — a back-and-forth that only
works as a volley. That has a consequence for chunking: an exchange straddling
a chunk boundary is lost from both sides. It is a reason not to shrink this
phase's chunks casually.

**Choosing a model for it.** Needs both structured output *and* no moderation
filter — it is being asked to extract gore into a JSON field. That combination
is narrower than it sounds, and rules out several otherwise-obvious choices.

---

## Phase 5 — Polish

**Local models only.** On any cloud provider this phase returns the chronicle
unchanged and makes **no API call at all**. It exists because smaller local
models benefit from a review pass that frontier cloud models do not need.

If you are costing a cloud run, Phase 5 is zero.

---

## Phase 6 — Condense

**What it is for.** An optional shorter retelling — a condensed narrative plus
bullet points, for a recap or a session-notes entry.

| | |
|---|---|
| Input | **The chronicle**, not the transcript |
| Knowledge base | **The entire vault** — this is the only cloud phase that gets it |
| Output | Short narrative + bullets, ~30% of the chronicle |
| Output/input ratio | ~0.3 of the chronicle |
| Emits JSON | No |
| Prompt scaffolding | ~3,790 characters |
| Cacheable prefix | Yes — and it is enormous, because the vault is in it |

**This is the phase with the unusual cost shape.** On a large Obsidian vault,
the knowledge base alone is around 557,000 tokens attached to every call. A
measured 6% of it is ever referenced by the chronicle being condensed.

Two consequences:

- **On a model with less than about a million tokens of context, the full vault
  simply does not fit.** Not "is expensive" — does not fit. Selective retrieval
  narrows it by around 92% while keeping the notes the chronicle actually
  mentions, and turns itself on automatically when the vault will not fit.
- **Chunking Phase 6 harder makes this worse, not better.** The chronicle is
  what gets chunked; the vault rides along with every chunk. Four chunks means
  the vault is sent four times.

Prompt caching helps with the cost of that repetition, but it is worth being
precise about what caching does: it avoids re-uploading the prefix and
discounts those tokens heavily. It does **not** reduce how much of the context
window they occupy. A cheaper call is not a smaller one — so caching can never
rescue a model whose window is too small. Only sending less can.

---

## Summary table

| Phase | Reads | Gets lore? | Emits JSON | Output vs input | Cacheable prefix |
|---|---|---|---|---|---|
| 1 Ground | transcript | compact glossary | no | **~1.0** | yes |
| 2 Audit | raw **+** grounded | none | **yes** | ~0.02 | no |
| 3 Chronicle | grounded transcript | none | no | **~0.9** | yes |
| 4 Extras | grounded transcript | none | **yes** | ~0.05 | no |
| 5 Polish | chronicle | — | — | — | local only |
| 6 Condense | **chronicle** | **whole vault** | no | ~0.3 | yes (large) |

## Where the money goes

For a three-hour session on a single flagship model, roughly:

| Phase | Share of run cost |
|---|---|
| 1 Ground | ~37% |
| 3 Chronicle | ~33% |
| 6 Condense | ~14% |
| 2 Audit | ~10% |
| 4 Extras | ~6% |

Phases 1 and 3 are about 70% of the bill between them, for the same reason they
are the hardest: they are the two that produce output on the scale of their
input, and output tokens cost several times what input tokens do.

That is also why they are the two worth thinking hardest about when choosing
models — see [Choosing models per phase](../models/per-phase-routing.md).
