# Reforging a chronicle

Reforge takes a chronicle you've **already** generated and re-runs the downstream
pipeline phases on a provider of your choice (Gemini by default) — without
re-running the whole thing from the transcript. It lives in the **Chronicle**
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
when running on a [Claude Code subscription](../extras/claude-code.md), where a
chunk can be declined or the usage window can run out before the later phases
finish.

## What you can do per run

Reforge is a guided, three-step panel.

1. **Choose a chronicle**: saved, pasted or uploaded.
2. **Choose what to produce**:

   | Option | Choices |
   |---|---|
   | Chronicle | Keep existing, or Rewrite on Gemini (needs the grounded transcript) |
   | Extras | Read from the transcript or from the chronicle |
   | Condensed recap | Tick it and set the length |
   | Voice | Bard, or any persona |

3. **Review and run**: the panel shows what will happen, then a progress bar.

The result is a new entry in Saved Chronicles; your original stays as it was.

You can also paste or upload a chronicle file, optionally with its grounded transcript. The panel shows what the source carries (chronicle, grounded transcript, DM Q&A), which decides what is available. **Rewrite on Gemini** needs the grounded transcript; it regenerates the prose, applies the selected narrator voice, and improves the distinction between a player *describing their character's actions* and the character *speaking in character*. **Keep existing** is the default. For the extras, reading the *grounded transcript* is the most thorough (verbatim table dialogue) at a higher token cost; reading the *chronicle prose* is cheaper but limited to what the narrative preserved. The condensed recap is a tightened retelling plus catch-up bullets, in the selected voice. Any installed [Persona](../extras/personas.md), or the default Bard, supplies the voice for the rewritten chronicle and the condense.

## If a Reforge stops part-way

A Reforge can run for a long time, and it's paid per chunk — so when one stops
late (a provider out of credits on the last chunk, a model that errors, or you
pressing **Cancel**), the work it finished is kept rather than thrown away.

The Reforge panel then shows what stopped it, what was kept, and what a resume will still run — for example *"Kept: Extras chunks 1–5 of 6. Resume runs Extras from chunk 6 and Condense."*

![A Reforge that stops because credits ran out, an error or Cancel keeps the chunks it finished. From there, Resume Reforge carries on where it stopped with the same settings, or Discard throws the kept work away. The list below says what each part of a resumed Reforge does.](../assets/diagrams/reforging-stopped.svg)

**Resume Reforge** carries on from that point; **Discard** throws the kept work away.

- A chronicle rewrite and extras resume from the chunk that stopped. Condense is
  short, so it starts over.
- A resumed Reforge runs on the same settings and models, and its result is saved
  as a new entry, as usual.
- Starting a different Reforge discards the kept work.
- The kept work survives a page reload when the source came from Saved
  Chronicles. A pasted or uploaded source is kept only until the page reloads.
- If a provider ran out of credits, top up before resuming — a resume runs on the
  same models.

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
