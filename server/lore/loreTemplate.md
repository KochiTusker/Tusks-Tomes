# ─────────────────────────────────────────────────────────────────────────────
# Tusk's Tomes — Lore Document Template
# ─────────────────────────────────────────────────────────────────────────────
#
# Save this file under your Tusks-Lore folder (e.g. Tusks-Lore/Characters.md).
# The YAML block between the `---` fences below is METADATA — it tells the
# pipeline what entities live in this document, their alternate names, and
# what they're related to. Everything below the closing `---` is PROSE — that's
# what the AI reads when writing your Chronicle.
#
# Files without frontmatter still work — the pipeline falls back to a proper-
# noun regex extractor. But filling this in makes Phase 1 grounding more
# accurate AND lets future Phase 3 retrieval pull only the relevant sections
# of your KB into the prompt (cheaper Chronicle runs at the same quality).
#
# Delete every line starting with `# ` inside the frontmatter block before
# saving — those are explanatory comments and are ignored by the parser, but
# removing them keeps the file tidy.
# ─────────────────────────────────────────────────────────────────────────────
---
schema: 1

# docType identifies what kind of document this is. Pick ONE.
# Valid options:
#   characters   — file containing one or more named characters / NPCs
#   countries    — file containing one or more nations / city-states
#   deities      — file containing one or more gods / pantheon members
#   factions     — file containing one or more organisations / guilds / cults
#   patrons      — file containing one or more warlock patrons / minor powers
#   locations    — file containing places that aren't full countries
#   other        — anything else (timelines, world overviews, session notes)
docType: characters

# `entities` lists every named thing in this document. Each entity becomes
# a record in the alias index. Add as many as you need (one document can
# contain many entities — e.g. Characters.md has 19 characters in one file).
entities:
  # ─── Example 1: a character with aliases and affiliations ──────────────
  - name: Durgin Ironheart
    # type options: character | country | deity | faction | patron | location | other
    type: character
    # Alternate names that speakers might use in your session. Comma-separated
    # inside [square brackets]. Includes titles, nicknames, byname, "Empress",
    # "The Granite Vanguard", etc.
    aliases: [Durgin Stonecrown, The Granite Vanguard]
    # Other entities this entity is associated with. The pipeline uses these
    # for 1-hop retrieval expansion — if your session mentions Durgin, related
    # entities like Manus Titanum and Ferrum Regnum get pulled in too.
    affiliations: [Manus Titanum, Ferrum Regnum, Stonecrown]
    # The H1 heading text (`# Durgin Ironheart`) below in this file. Used as
    # the retrieval anchor — exact match against the prose heading.
    section: "Durgin Ironheart"

  # ─── Example 2: a faction with a single short alias ─────────────────────
  - name: The Cinderpall Brotherhood
    type: faction
    aliases: [The Brotherhood]
    affiliations: [The Badlands, Porta Fortuna]
    section: "The Cinderpall Brotherhood"

  # ─── Example 3: a country with no aliases ───────────────────────────────
  - name: Lex Veritas
    type: country
    aliases: []
    affiliations: [Iusticar, Samvrit, Varnesh, Ishvarael]
    section: "Lex Veritas"

  # ─── Example 4: a deity with the "title" form alias ─────────────────────
  - name: Samvrit
    type: deity
    aliases: [The Cosmic Judge]
    affiliations: [Lex Veritas, Triad of Balance]
    section: "Samvrit"

  # ─── Add your own entities below ────────────────────────────────────────
  # - name: Your Entity Name
  #   type: character
  #   aliases: []
  #   affiliations: []
  #   section: "Your Entity Name"
---

# Durgin Ironheart

Write the entity's prose here. This is what the AI reads when chronicling
your session. Treat it like a wiki entry — flowing text, broken into clear
sections, with structured key:value lines where they help readers.

Race: Dwarf
Era: c. 1600 – 1300 BCE
Place of Origin: Lex Veritas

## Background

Known as the Granite Vanguard, Durgin Ironheart was the founder of Manus
Titanum and the progenitor of the Stonecrown line. Use H2 (`##`) headings
for sub-sections within an entity — the AI sees the whole H1 block as one
unit, but H2 sub-sections help YOU navigate the file.

## Legacy

Durgin's legacy is complex. Add as much or as little as your campaign
needs — there's no required length.

---

# The Cinderpall Brotherhood

Each entity gets its own H1 heading block. The pipeline's retrieval
algorithm matches aliases against your transcript, then pulls in this
entity's H1 section as grounding for the AI.

Theme: Crime Syndicate
Primary Base: The Badlands
Notable Methods: Hit-and-run raids, desecration of tombs, ambushes

## Origins

Emerged after the fall of Manus Titanum, when deserters and criminals
banded together for survival.

---

# Lex Veritas

Lex Veritas is a country devoted to religion. It is a holy land for many
people and several faiths have communities here. The vast majority of the
population follow the Triad of Balance (Samvrit, Varnesh or Ishvarael).

Capital: Iusticar
Location: Eastern Coast of Caelovar

## Culture

The Triad of Balance are revered here not simply as gods but as the living
embodiment of law itself.

## History

- 2000 BCE: Clerics of Samvrit establish Iusticar
- 1500 BCE: Durgin Ironheart is exiled

---

# Samvrit

Alias: The Cosmic Judge
Domain: Justice, Death, Balance
Alignment: Lawful Neutral
Symbol: A wheel encircled by a sword and flame

## Mythology

God of justice and balance, standing at the threshold to ensure every soul
meets its rightful fate. Neither cruel nor merciful, but resolute and
unyielding, piercing through deception and weighing all actions.

## Clergy & Practices

His faith is strongest in Lex Veritas, where judges, monks, and clerics
invoke his name in trials, oaths, and executions.
