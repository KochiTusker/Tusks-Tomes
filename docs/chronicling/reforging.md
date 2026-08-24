# Reforging a chronicle

Reforge takes a chronicle you've **already** generated and re-runs the downstream
pipeline phases on a provider of your choice (Gemini by default) — without
re-running the whole thing from the transcript. It lives in the **Tome of Lore**
tab, under **Saved Chronicles**.

## Why it exists

This one came out of a specific annoyance. A run would produce a genuinely good
chronicle — the prose was right, the names were right, the whole thing read
well — and then the quotes list would come back half-empty because the model
had quietly declined to repeat anything rude. Which, at a table where the
funniest line of the night is rarely printable, meant losing the best bits.

Re-running the entire pipeline to fix the last phase is a waste of forty
minutes and a chunk of API credit, so Reforge keeps the part that worked and
redoes the rest somewhere more suitable:

- Run the grounding + chronicle on whichever model writes the best prose.
- Then **reforge** the quotes / jests / gore and the condensed recap on a model
  that's better at picking out memorable, in-character, and dark lines.

It's also the recovery tool when the later phases failed outright — for example
when running on a [Claude Code subscription](../extras/claude-code.md), where the
audit and extras phases are the most likely to be declined or to exhaust your
usage window.

## What you can do per run

Reforge is a guided, three-step panel:

1. **Choose a chronicle** — pick one from your Saved Chronicles library, or
   paste / upload a chronicle file (optionally with its grounded transcript).
   The panel shows what the source carries (chronicle, grounded transcript, DM
   Q&A), which determines what's available below.
2. **Choose what to produce:**
   - **Chronicle** — *Keep existing* (default) or *Rewrite on Gemini*. Rewriting
     needs the grounded transcript; it regenerates the prose, applies the
     selected narrator voice, and improves the distinction between a player
     *describing their character's actions* and the character *speaking in
     character*.
   - **Extras** (quotes / jests / gore) — and where to read them from:
     - *Grounded transcript* — most thorough (verbatim table dialogue), higher
       token cost.
     - *Chronicle prose* — cheaper, but limited to what the narrative preserved.
   - **Condensed recap** — a tightened retelling plus catch-up bullets, in the
     selected voice.
   - **Voice** — any installed [Persona](../extras/personas.md) (or the default
     Bard) for the rewritten chronicle and condense.
3. **Review & run** — a plain-language summary of exactly what will happen, then
   a progress bar. The result is **saved as a new entry** in Saved Chronicles —
   your original is never overwritten, so you can compare or keep both.

## Companion: refusal markers + targeted repair

When a run is on a provider that declines a chunk and the in-run fallback can't
recover it, that chunk is **marked in the output** (a visible banner + a hidden
tag) and recorded. A **Review & Repair Refusals** panel on the finished
chronicle lets you re-process just those marked chunks on another provider and
splice the results back in — no full re-run needed. Reforge handles "redo a whole
phase elsewhere"; repair handles "fix the specific chunks that were declined".

## Tips

- **Cost:** extracting extras from the grounded transcript reads far more text
  than reading the chronicle prose. If you're cost-sensitive, use the chronicle
  source; if you want every verbatim line, use the transcript.
- **Quotes / jests / gore favour quality over quantity** — a few sharp entries,
  and dark / edgy / explicit lines are kept (that's the table's authentic voice),
  not padded lists.
- Reforge from the library is the lowest-friction path, since the grounded
  transcript and DM Q&A are stored alongside each saved chronicle.
