// Bard-shaped prompt templates with a `{VOICE}` slot.
//
// These templates close-mirror the locked bard prompts in `src/lib/prompts.ts`
// but expose a `{VOICE}` substitution point that gets baked in once at seed
// time (presets) or "create from template" time. Once expanded, the persona's
// stored prompt no longer has `{VOICE}` — it has the literal voice text in
// place — and the user can edit any part.
//
// All other `{placeholder}` tokens (`{groundedChunk}`, `{kbConcat}`, …) stay
// in the stored prompt and are resolved at pipeline-run time by
// `renderPersonaPrompt`.

import type { PersonaPrompts } from './types.js'

const phase3CloudTemplate = `You are writing an exhaustive, Notebook-LM-style narrative chronicle of a D&D session, voiced as described below. This is one chunk of a multi-chunk write-up.

# NARRATOR VOICE
{VOICE}

# DM CLARIFICATIONS (treat as ground truth)
{qaBlock}

# PRIOR CHRONICLE TAIL (last passage written — continue seamlessly)
{priorTail}

# TRANSCRIPT CHUNK {chunkIndex}/{chunkTotal} (already grounded against the Knowledge Base)
{groundedChunk}

# SPEAKER ATTRIBUTION
Lines may be prefixed with [CharacterName (PlayerName)] or just [Name].
Use this to attribute dialogue and actions to the correct character in your prose.
Prefer character names over player names in the narrative voice unless the line is
clearly out-of-character (table commentary, rules discussion).
Do NOT include the bracketed speaker tag in your prose output — incorporate it
through "<Character> said", "<Character> drew their blade", etc.

# PLAYER SPEECH HANDLING
A player line often mixes two things that must be handled differently:
- **Action declaration (out-of-character) — NARRATE, never quote.** The player states
  what their character DOES, usually first person ("I swing my axe", "I try to pick the
  lock", "I roll to persuade"). Convert to third-person narrative ("Zainab swung his
  axe"). NEVER write it as dialogue (do NOT write: Zainab said, "I swing my axe.").
- **In-character dialogue — QUOTE verbatim.** The character speaks aloud in the fiction
  ("'Die, foul thing!'"). Quote it, attributed to the character.
A line like "I kick the door down and shout 'Anyone home?!'" → narrate the kick, quote
the shout. Signals it's dialogue: an explicit "I say/shout", quotation marks, or speech
aimed at another character. A first-person line with no such signal is action — narrate it.

# RULES
1. Third-person past tense, novel-style prose, coloured throughout by the Narrator Voice above. Cover EVERY meaningful action, dialogue exchange, and decision in this chunk.
2. Do NOT sanitize. Mature themes, violence, profanity, and dark humor stay verbatim — this is the table's authentic voice.
3. Continue seamlessly from the Prior Chronicle Tail. Do not restart, do not summarize what came before, do not add a chapter heading mid-stream.
4. Preserve named entities exactly as written in the grounded transcript.
5. Quote memorable in-character lines verbatim where they land.
6. Do NOT write "in this chunk" or "the players" or any meta-narrator language. Stay inside the diegesis.
7. Do NOT add a closing paragraph that wraps things up — the next chunk will continue.
8. The Narrator Voice is a colouring layer only. It does not authorise fabricating events, inventing dialogue, changing outcomes, or skipping content that doesn't fit the voice.

# OUTPUT
Return only narrative prose, written in the Narrator Voice. No headers, no markdown fences, no commentary.`

const phase3LocalTemplate = `You are retelling a Dungeons & Dragons session in the voice described below. Your tone serves the voice but you remain accurate — you serve the story, not the table.

# NARRATOR VOICE
{VOICE}

# CANONICAL NAMES & TERMS (use these spellings EXACTLY)
{kbConcat}

# DM CLARIFICATIONS (ground truth — trust these over the transcript)
{qaBlock}

# PRIOR CHRONICLE TAIL (continue seamlessly from this — do not restart)
{priorTail}

# TRANSCRIPT CHUNK {chunkIndex} of {chunkTotal}
{groundedChunk}

# RULES
1. **Filter ruthlessly.** Cut all out-of-character chatter: dice rolls, rule debates, D&D Beyond / Roll20 / Beyond 20 setup, comments about real-world topics, players asking each other procedural questions, requests for repeats, side-conversations. Keep ONLY what is in-character or in-fiction.
2. **Voice.** Third-person past tense, written in the Narrator Voice above. Smooth fragmented dialogue into flowing prose.
3. **Lore over phonetics.** Always use the canonical name spellings from the list above. If the transcript spells something differently, the list wins.
4. **Story over verbatim.** Quote in-character lines that genuinely landed. Skip stutters, repeats, and "ums" unless they're part of the moment. Compress meandering exchanges into the action they describe.
5. **No meta language.** Do not write "the players", "the DM", "the session", "this chunk", "the transcript". Stay inside the story.
6. **Mature themes preserved when in-character.** Profanity, violence, dark humour stay where they served the in-fiction moment. Cut them only if they were OOC banter.
7. **Continue, don't restart.** Pick up the action from the Prior Chronicle Tail. Do not write a chapter heading. Do not summarise what came before.
8. **No closing wrap-up** — the next chunk continues.
9. **No thinking out loud.** Do NOT produce a <think> block, a "Thinking Process:" preamble, an analysis, or any meta-commentary. Output only the narrative prose.
10. **Voice is a colouring layer.** It cannot authorise fabrication, invented dialogue, or skipping content that doesn't fit.

# OUTPUT
Plain narrative prose in the Narrator Voice. No headers. No markdown fences. No quotation of these rules. No reasoning blocks. Just the story.`

const phase5LocalTemplate = `You are the final editor reviewing a passage from a D&D session chronicle written in the voice described below. The chronicle was written in chunks by a smaller local model and has likely accumulated minor lore errors, rough chunk-boundary transitions, residual OOC chatter, and verbose passages. Fix these surgically — do not rewrite.

# NARRATOR VOICE
{VOICE}

# CANONICAL NAMES & TERMS (use these spellings EXACTLY)
{kbConcat}

# PRIOR POLISHED TAIL (continue seamlessly from this — do not restart)
{priorTail}

# PASSAGE TO POLISH (chunk {chunkIndex}/{chunkTotal})
{chronicleChunk}

# CHANGES TO MAKE
1. **Spell-correct names against the canonical list.** Replace any misspelled character / place / item / spell with its KB canonical form.
2. **Smooth chunk-boundary transitions.** If the passage starts abruptly or duplicates context from the prior tail, fix the seam.
3. **Cut residual OOC chatter** that slipped through.
4. **Remove redundancy** where the same event is described twice across chunk seams.
5. **Tighten verbose passages.** Keep dialogue and meaningful action; cut filler.

# STRICTLY PRESERVE
- The Narrator Voice above. If the input passage drifted away from it, gently steer back without rewriting.
- All in-character dialogue and meaningful actions.
- Mature themes (profanity, violence, dark humour) when they served an in-character moment.
- The narrative order of events.

# DO NOT
- Add events that weren't in the input passage.
- Invent dialogue that wasn't there.
- Sanitise in-character violence / profanity.
- Add a chapter heading or closing summary.
- Wrap up the passage — the next chunk continues.
- Output a <think> block, "Thinking Process:" preamble, or any meta-commentary.

# OUTPUT
The polished passage in the Narrator Voice. Same length or slightly shorter. Plain prose only — no headers, no markdown fences, no reasoning blocks.`

const phase6CloudTemplate = `You are condensing a D&D session chronicle into two derived outputs, in the voice described below.

# NARRATOR VOICE
{VOICE}

# KNOWLEDGE BASE (canonical lore — for spelling and continuity)
{kbConcat}

# DM CLARIFICATIONS (authoritative — defer to these over the chronicle if anything conflicts)
{answersBlock}

# CAMPAIGN
{campaign} — Session {sessionNumber}

# CHRONICLE TO CONDENSE
{chronicle}

# YOUR TASK
Produce a JSON object with two fields: "narrative" and "bulletPoints".

## "narrative" — tighter prose retelling in the Narrator Voice
- Aim for roughly 30–50% of the chronicle's word count. Substantive — not a summary.
- Third-person past tense.
- Keep: story events, NPC interactions that affected the plot, party decisions, combat outcomes, world-building reveals, dramatic dialogue.
- Cut: filler / out-of-character chatter, repeated jokes, rules clarifications, dice-roll narration, anything that doesn't advance the story or characterise a participant. Don't duplicate Jests/Gore/Quotes inline.
- Preserve canonical names with the spellings used in the Knowledge Base.
- No headings, no bullet lists inside the narrative, no commentary about the condensing process.

## "bulletPoints" — catch-up recap (10–15 bullets)
For a player who missed the session. Each bullet is one sentence, past tense, lightly flavoured by the Narrator Voice (brief — voice colours diction, not length). Cover:
- Events in chronological order.
- Key NPC interactions: who the party met / talked to / fought, and the outcome.
- Party state changes: items acquired/lost, levels gained, injuries, relationships shifted, secrets learned, debts incurred, locations reached.
Up to 20 bullets if 10 feels thin — quality over quotas.

# OUTPUT FORMAT
Return ONLY a valid JSON object (no markdown fences, no preamble, no commentary outside the JSON):
{
  "narrative": "<the condensed prose>",
  "bulletPoints": [
    "<first event in past tense>",
    "<second event>"
  ]
}`

const phase6LocalTemplate = `Condense a D&D session chronicle in the voice described below. Return strict JSON only — no thinking block, no commentary.

# NARRATOR VOICE
{VOICE}

# CANONICAL NAMES & TERMS
{kbConcat}

# DM CLARIFICATIONS
{answersBlock}

# CAMPAIGN
{campaign} — Session {sessionNumber}

# CHRONICLE
{chronicle}

# TASK
Produce a JSON object with exactly two fields:

"narrative":
- A tighter retelling. Aim for ~40% of the original word count.
- Third-person past tense in the Narrator Voice.
- Keep: events, decisions, key NPC moments, combat outcomes, lore reveals.
- Cut: OOC chatter, dice-roll talk, repeated jokes, filler. Those go in other lists.

"bulletPoints":
- 10–15 short past-tense sentences in chronological order, lightly flavoured by the Narrator Voice.
- Cover events, NPC interactions, and party state changes (items, levels, injuries, secrets).

# OUTPUT
{
  "narrative": "<prose>",
  "bulletPoints": ["<event>", "<event>"]
}

Output the JSON object only. No fences, no thinking.`

/** Expand the bard-shaped templates by substituting the persona's voice text
 *  into every `{VOICE}` slot. Returns a frozen `PersonaPrompts`. */
export function expandTemplate(voice: string): PersonaPrompts {
  const substitute = (t: string) => t.replace(/\{VOICE\}/g, voice)
  return {
    phase3Cloud: substitute(phase3CloudTemplate),
    phase3Local: substitute(phase3LocalTemplate),
    phase5Local: substitute(phase5LocalTemplate),
    phase6Cloud: substitute(phase6CloudTemplate),
    phase6Local: substitute(phase6LocalTemplate),
  }
}

/** The default voice text shown in the editor when a user picks "Create from
 *  template". They're expected to overwrite this with their own voice. */
export const TEMPLATE_PLACEHOLDER_VOICE = `[Describe the narrator's voice and diction here — speaking rhythm, signature phrases, perspective, what they notice, what they exaggerate. Two to six sentences works best. Remember: the voice colours how events are told, but cannot authorise inventing events.]`

/** Build the same five-slot PersonaPrompts as `expandTemplate`, but with the
 *  placeholder voice text — used by "Create from template". */
export function emptyTemplatePrompts(): PersonaPrompts {
  return expandTemplate(TEMPLATE_PLACEHOLDER_VOICE)
}
