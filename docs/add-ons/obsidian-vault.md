# Obsidian Vault Lore (read-only)

Plenty of GMs already keep their campaign in Obsidian — characters, factions,
locations, the lot — and asking them to duplicate all of that into a separate
folder just to get names spelled right was never going to fly. I keep mine
there too, which is how this add-on came about.

Point it at your vault and it reads the notes you've already written. The
folder is **only ever read** during a chronicle run; the handful of writes it
can do are all behind explicit buttons and listed in
[How safe is this?](../is-this-safe.md).

The index it builds from your notes is cached in the app's own cache directory,
never written back into the vault.

## How it works

Tusk's Tomes reads two things from your vault:

1. **An entity index** — canonical names + aliases, used by Phase 1 grounding to
   fix mis-transcribed names (e.g. "Merr" → "Seoyeon Corvel"). It prefers a
   curated `_system/entity-index.json` if your vault has one; otherwise it walks
   your notes and reads each note's frontmatter.
2. **The note bodies** — used as the Knowledge Base for the chronicle phases.

When the add-on is enabled with a valid vault path, the `/api/lore` endpoints
serve vault-derived data transparently; the rest of the pipeline is unchanged.
When it's off, Tusk's Tomes uses the Tusks-Lore folder exactly as before.

> Chronicles are still saved to the Tusks-Lore `Sessions/` folder — the vault
> stays read-only.

## Switching sources & the Tome of Lore tab

The **Tome of Lore** tab shows a **Lore Source** card at the top. It tells you
which source is grounding your chronicles right now and — when the Obsidian
add-on is installed — lets you switch between **Tusks-Lore folder** and
**Obsidian vault** in one click. (The detailed vault config — path, readiness,
Mode-B, graphify — lives in Settings; the card and Settings stay in sync.)

While the Obsidian vault is the active source, the Tusks-Lore Knowledge Base
manager is **replaced by a read-only vault summary**, so it's unmistakable that
the Tusks-Lore folder is on standby and not used for grounding or processing.
Edit your lore in Obsidian; switch back to Tusks-Lore anytime from the same card.

> The **Glossary** and **Speaker mappings** apply to *every* lore source,
> including the vault — they run before AI grounding regardless of which source
> is active, so they stay visible and editable in both modes.

## Setup

1. Install the add-on (Settings → Add-ons), then restart `npm run dev`.
2. In **Settings → Obsidian Vault Lore**, click **Browse…** to pick your vault
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
6. Use **Reindex vault** after you make substantial edits to your notes.

### Optional: build a graphify map

If the `graphify` CLI is installed (`pip install graphifyy`), **Build graphify
map** runs it against your vault to derive a richer mapping. Note: this is one of
two actions that **writes into your vault** — graphify creates a `graphify-out/`
folder there (it's excluded from grounding). If you sync your vault, add
`graphify-out/` to your `.gitignore` / Obsidian exclusions.

## Pairing with Claude Code: generate a CLAUDE.md

If you also run the **Claude Code** add-on, the read-only vault summary (Tome of
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

This is the second sanctioned vault write. It's opt-in, and if a `CLAUDE.md`
already exists you're shown a preview and asked to confirm before it's replaced.
The button appears only when both the Obsidian and Claude Code add-ons are
enabled. No CLAUDE.md is required to use the vault as a lore source — the
integration is fully agnostic to it.

### Optional: feed CLAUDE.md back into grounding

Off by default. In **Settings → Obsidian Vault Lore**, *Use the vault's CLAUDE.md
as grounding context* injects your vault's `CLAUDE.md` (bounded to a short
preview) as an extra context block, so grounding/chronicle phases see the
vault's own description of how its lore is organised. It changes grounding
output, so it ships off — turn it on only once you've tuned a CLAUDE.md you're
happy with. It has no effect until a `CLAUDE.md` exists in the vault.

Everything outside these two explicit, opt-in writes is strictly read-only.

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

- Grounding never writes to your vault. The only writes are the two explicit,
  opt-in actions above: **Build graphify map** (`graphify-out/`) and **Generate
  CLAUDE.md** (`CLAUDE.md`). The derived entity index is cached in the app's own
  cache directory, never in your vault.
- Meta folders are skipped from the index and Knowledge Base: `_system/`,
  `Templates/`, `.obsidian/`, `.trash/`, `_MOCs/`, `13 - Planning/`,
  `14 - Ideas/`, `graphify-out/`.
- Dev/scaffolding files at the vault root are skipped too, so a generated (or
  hand-written) `CLAUDE.md`, `README`, `LICENSE`, `CONTRIBUTING`, and dotfiles
  are never indexed as lore entities.
