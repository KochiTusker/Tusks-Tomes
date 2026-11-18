# Obsidian vault lore

Plenty of GMs already keep their campaign in Obsidian — characters, factions,
locations, the lot — and asking them to duplicate all of that into a separate
folder just to get names spelled right was never going to fly. I keep mine
there too, which is how this add-on came about.

Point it at your vault and it reads the notes you've already written. The
folder is **only ever read** during a chronicle run; the three writes it
can do are each started by you and listed in
[How safe is this?](../security/what-it-installs.md).

The index it builds from your notes is cached in the app's own cache directory,
never written back into the vault.

## How it works

![A drawing of what Tusk's Tomes does with an Obsidian vault. At the top right is Tusk's Tomes; at the top left is a disk labelled index cache, outside the vault, and an arrow from Tomes says it keeps its index there. A second arrow from Tomes, labelled reads, points into a dashed box for your Obsidian vault. Inside the box, under Read, always, are two boxes: names and aliases, which become the entity index for Phase 1, and note bodies, which become lore for the chronicle. Under Written, only when you ask, are three gold boxes: Word and PDF notes get a .md copy beside each, Build graphify map writes a graphify-out folder, and Generate CLAUDE.md writes a file at the vault root.](../assets/diagrams/what-tomes-does-in-your-vault.svg)

The entity index (canonical names and aliases) fixes mis-transcribed names in Phase 1, for example "Merr" → "Eamon Corvel". It prefers a curated `_system/entity-index.json` if your vault has one; otherwise it reads each note's frontmatter.

Once a valid vault path is set and selected as the lore source, the `/api/lore` endpoints
serve vault-derived data transparently; the rest of the pipeline is unchanged.
When it's off, Tusk's Tomes uses the Tusks-Lore folder exactly as before.

> Chronicles are still saved to the Tusks-Lore `Sessions/` folder — the vault
> stays read-only.

## Switching sources & the Tome of Lore tab

The **Tome of Lore** tab shows a **Lore Source** card at the top. It tells you
which source is grounding your chronicles right now and — when the Obsidian
vault path is set — lets you switch between **Tusks-Lore folder** and
**Obsidian vault** in one click. (The detailed vault config — path, readiness,
Mode-B, graphify — sits just below it, in the same **Lore source** section.)

While the Obsidian vault is the active source, the Tusks-Lore Knowledge Base
manager is **replaced by a read-only vault summary**, so it's unmistakable that
the Tusks-Lore folder is on standby and not used for grounding or processing.
Edit your lore in Obsidian; switch back to Tusks-Lore anytime from the same card.

> [!NOTE]
> The **Glossary** and **Speaker mappings** apply to *every* lore source,
> including the vault — they run before AI grounding regardless of which source
> is active, so they stay visible and editable in both modes.

## Setup

1. Open the **Tome of Lore** tab and find the **Obsidian Vault Lore** card under **Lore source**. There is nothing to install and no
   restart — it ships with the app and stays inert until you pick it as your
   lore source.
2. Click **Browse…** to pick your vault
   with the native folder dialog, or paste the path (e.g. `D:\Obsidian` or
   `~/Vault`). On a headless/remote setup the dialog is unavailable —
   just paste the path.
3. Check the **Vault readiness** row — it reads your vault's enabled-plugins
   list and shows which recommended plugins are present, whether an
   `_system/entity-index.json` exists, and whether the `graphify` CLI is
   installed.
4. Tick **Use this vault as the lore source** and **Save**. You'll be asked to
   confirm replacing Tusks-Lore for grounding (Tusks-Lore stays on disk,
   untouched — you can switch back anytime). It stays off until you do this.
5. Optionally tick **Relationship enrichment (Mode-B)** to prepend each note
   with a one-line summary of its frontmatter relationships (affiliations,
   related, patron, allies/enemies) for richer chronicle context.
6. Use **Reindex vault** after you make substantial edits to your notes, to refresh the cached index and the entity count shown in settings.

### Optional: build a graphify map

If the `graphify` CLI is installed (`pip install graphifyy`), **Build graphify
map** runs it against your vault to derive a richer mapping. Note: this is one of
three actions that **write into your vault** — graphify creates a `graphify-out/`
folder there (it's excluded from grounding). If you sync your vault, add
`graphify-out/` to your `.gitignore` / Obsidian exclusions.

## Pairing with Claude Code: generate a CLAUDE.md

If you also use **Claude Code**, the read-only vault summary (Tome of
Lore tab) offers **Generate CLAUDE.md for your vault**. One click writes a
`CLAUDE.md` navigation guide into your vault root, derived from your vault's
actual structure:

- the folders present, with note counts;
- the entity types and how many of each;
- the frontmatter keys you use and your `aliases:` coverage;
- a short note that Tusk's Tomes reads the vault strictly read-only.

The guide documents *structure only* — folder and field names, never your note
bodies — so it can't leak private campaign detail. Its purpose is to help your
own Claude Code sessions (or any AI tool you open in the vault) navigate your
lore efficiently. Tusk's Tomes itself still reads the vault directly; it does
**not** point Claude Code at your vault.

This is one of the three sanctioned vault writes. It's opt-in, and if a `CLAUDE.md`
already exists you're shown a preview and asked to confirm before it's replaced.
The button appears on the vault summary once your vault path is set. No CLAUDE.md is required to use the vault as a lore source — the
integration is fully agnostic to it.

### Optional: feed CLAUDE.md back into grounding

Off by default. In the **Obsidian Vault Lore** card (**Tome of Lore → Lore source**), *Use the vault's CLAUDE.md
as grounding context* injects your vault's `CLAUDE.md` (bounded to a short
preview) as an extra context block, so grounding/chronicle phases see the
vault's own description of how its lore is organised. It changes grounding
output, so it ships off — turn it on only once you've tuned a CLAUDE.md you're
happy with. It has no effect until a `CLAUDE.md` exists in the vault.

Everything outside the three explicit, opt-in writes (the graphify map, the CLAUDE.md guide and the Word/PDF conversion) is strictly read-only.

## Getting the most out of your vault

The integration rewards a lightly-structured vault. None of this is required —
the adapter degrades gracefully — but each item improves grounding accuracy:

- **`aliases:` is the highest-value field.** List nicknames and alternate
  spellings in each note's frontmatter so grounding can map spoken/heard forms
  to the canonical name. This is the single biggest lever on accuracy.
- **One note per entity**, with a `type:` (`npc`, `pc`, `location`, `faction`,
  `deity`, `patron`, …). Unrecognised types are still indexed.
- **Relationship fields** (`affiliations`, `related`, `patron`, `allied-with`,
  `enemies-with`) feed Mode-B enrichment.

### Recommended Obsidian community plugins

- **Linter** — normalises YAML frontmatter so the adapter parses cleanly.
- **Templater** (or core Templates) — keeps new entity notes on a consistent
  frontmatter schema.
- **Dataview** — handy for maintaining an entity index / map-of-content.
- **Local REST API** — optional; enables connecting an Obsidian MCP server for
  interactive, on-demand note lookups (separate from this batch integration).

## What is *not* read or written

- Grounding never writes to your vault. The only writes are the three opt-in actions in the drawing above, and the `.md` conversion is a step in Recommended Setup where you tick the files to convert. The conversion never overwrites an existing `.md` and never touches the original.
- Meta folders are skipped from the index and Knowledge Base: `_system/`,
  `Templates/`, `.obsidian/`, `.trash/`, `_MOCs/`, `13 - Planning/`,
  `14 - Ideas/`, `graphify-out/`.
- Dev/scaffolding files at the vault root are skipped too, so a generated (or
  hand-written) `CLAUDE.md`, `README`, `LICENSE`, `CONTRIBUTING`, and dotfiles
  are never indexed as lore entities.
