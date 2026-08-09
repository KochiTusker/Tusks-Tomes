// Embedded copies of phase2Audit() + phase4Extras() from src/lib/prompts.ts.
// The safety probe lives outside server/'s rootDir AND outside src/'s
// browser bundle, so a direct ts-import path doesn't exist. The drift-guard
// test in prompts.test.mjs asserts these copies produce identical output
// to the canonical builders for the same inputs.
//
// IF YOU EDIT THIS FILE: also edit src/lib/prompts.ts (or vice-versa). The
// drift-guard test catches divergence; the comment here is the second
// line of defence.

/** Phase 2 (audit) cloud prompt. Verbatim from src/lib/prompts.ts:phase2Audit. */
export function phase2Audit(args) {
  const { rawChunk, groundedChunk, index, total } = args
  return `You are auditing a D&D session transcript chunk. Most chunks should produce ZERO clarification questions. The DM's time is valuable — only surface a question when you genuinely cannot proceed without their input.

# RAW TRANSCRIPT CHUNK ${index + 1}/${total}
${rawChunk}

# GROUNDED (corrected) TRANSCRIPT CHUNK
${groundedChunk}

# WHEN TO ASK A QUESTION
Ask ONLY when one of the following is true and the answer is genuinely necessary for accurate downstream chronicling:

1. **Phonetic ambiguity with multiple plausible KB matches.** A misheard name could plausibly resolve to two or more different entities in the Knowledge Base AND you cannot pick one with confidence from surrounding context.
2. **Action attribution is genuinely unrecoverable.** Cross-talk has destroyed the link between an action and its actor, and downstream context does not clarify it.
3. **Outcome of a consequential moment is unclear.** A combat resolution, dice result, or critical decision had a real impact on the story but the transcript does not record what actually happened.
4. **Direct contradiction with established canon.** The transcript states something that contradicts the Knowledge Base in a way that could be either a mistake or an intentional retcon — the DM must clarify which.

# WHEN NOT TO ASK
Do NOT ask about:
- Dice rolls without explicit context (most don't matter for the chronicle).
- Generic cross-talk or background noise where no consequential action was lost.
- In-character vs out-of-character moments you can infer from tone or content.
- Names you can confidently resolve from context, even if the raw transcript is garbled.
- Anything you can fairly guess at — the chronicle phase will write around minor uncertainty.

If you can write a faithful chronicle paragraph for this chunk without asking the DM anything, return an empty array.

# OUTPUT FORMAT
Return ONLY a valid JSON array (no markdown fences, no commentary). Each item:
{
  "id": "q-${index + 1}-N",          // N = 1-based index within this chunk
  "question": "<a single concrete question the DM can answer in one or two sentences>",
  "context": "<a short verbatim quote from the transcript that prompted this question>"
}

If no question genuinely meets the criteria above, return [].`
}

/** Phase 1 (ground) cloud prompt. Verbatim from src/lib/prompts.ts:phase1Ground.
 *  Used by hybrid-validate for full-pipeline runs. The drift-guard test in
 *  prompts.test.mjs asserts byte-identical output to the canonical version. */
export function phase1Ground(args) {
  const { chunk, kbConcat, index, total, contextualHintsBlock, stripped } = args
  const hintsSection = contextualHintsBlock ? `${contextualHintsBlock}\n\n` : ''
  const speakerRule = stripped
    ? '7. Each line is prefixed with «N» where N is a positive integer (e.g. «1», «42»). Preserve EVERY marker exactly at the start of its line. Do not invent new markers, renumber existing ones, or drop any. If you must split a line, keep the marker on the first fragment and leave subsequent fragments unmarkered — they will be re-attached automatically.'
    : '7. Speaker tags formatted as [CharacterName (PlayerName)] or [Name] at the start of a line are part of the transcript structure — preserve them exactly, do not edit them.'
  const cacheablePrefix = `You are an authoritative D&D session transcript editor. Your sole job is to faithfully correct a raw transcript chunk so it perfectly matches the canonical lore in the Knowledge Base provided below.

# KNOWLEDGE BASE (canonical lore — names, places, deities, NPCs, items)
${kbConcat || '(no Knowledge Base provided)'}

# RULES
1. Correct phonetic misspellings of deity names, place names, character names, monsters, spells, and items so they match the Knowledge Base EXACTLY (including capitalization).
2. Restore expletives that auto-captioning likely censored (e.g. "f***", "bleep", "[__]" → the actual word in context). Mature tabletop language is expected and must be preserved.
3. Preserve speaker turns, line breaks, and the original chronological flow.
4. Do NOT summarize, shorten, paraphrase, or reorder. Output a near 1:1 corrected version.
5. Do NOT add commentary, headers, "[Corrected]" tags, markdown fences, or any meta text.
6. If the chunk references something not in the Knowledge Base AND not covered by a contextual correction above, leave it untouched rather than guessing.
${speakerRule}
8. Inline annotations of the form \`[≈Canonical Name? NN%]\` are algorithmic phonetic-similarity hints from your lore alias index. Treat them as suggestions, NOT instructions: accept the canonical when surrounding context fits ("more than vain" near a mention of a hunted target is almost certainly "Morvan Vayne"), ignore when context contradicts (a player named Lucia is not "Lucia Crane" from the lore unless they're actually in scene). Always REMOVE the \`[≈…]\` marker from your output — only emit the corrected text.`
  const userPrompt = `${hintsSection}# RAW TRANSCRIPT CHUNK ${index + 1} of ${total}
${chunk}

# OUTPUT
Return only the corrected transcript text for this chunk. No preamble, no postscript.`
  return `${cacheablePrefix}\n\n${userPrompt}`
}

/** Phase 3 (chronicle) cloud prompt. Verbatim from src/lib/prompts.ts:phase3Chronicle.
 *  This is the simple non-persona variant (personaTemplate=undefined). */
export function phase3Chronicle(args) {
  const { groundedChunk, dmAnswers, dmQuestions, index, total, priorTail } = args
  const qaBlock = (dmQuestions && dmQuestions.length)
    ? dmQuestions
        .map((q) => {
          const a = (dmAnswers && dmAnswers[q.id]) ? dmAnswers[q.id].trim() : null
          return a ? `Q: ${q.question}\nA: ${a}` : null
        })
        .filter(Boolean)
        .join('\n\n')
    : '(no DM clarifications provided)'

  const cacheablePrefix = `You are writing an exhaustive, Notebook-LM-style narrative chronicle of a D&D session. This is one chunk of a multi-chunk write-up.

# DM CLARIFICATIONS (treat as ground truth)
${qaBlock}

# SPEAKER ATTRIBUTION
Lines may be prefixed with [CharacterName (PlayerName)] or just [Name].
Use this to attribute dialogue and actions to the correct character in your prose.
Prefer character names over player names in the narrative voice unless the line is
clearly out-of-character (table commentary, rules discussion).
Do NOT include the bracketed speaker tag in your prose output — incorporate it
through "<Character> said", "<Character> drew their blade", etc.

# DM SPEECH HANDLING
The DM (Dungeon Master) may appear as a labeled speaker — typically as
[DM (Name)], [Dungeon Master (Name)], or by their real first name when imported
via Craig with the DM's track tagged that way. The DM is the narrator of the
scene, NOT a player character. Their speech falls into three categories — each
gets a different treatment:

1. **Scene narration / mechanics resolution** — "With that roll the door creaks
   open", "The arrow hits for 14 damage", "The room is dark and smells of mildew",
   "You're starting to build a real narrative here, but the Underminer is stubborn".
   RE-NARRATE these in your own third-person voice — preserve ALL the detail (the
   physical action, the mechanical result, the room's atmosphere, the NPC reaction,
   the timing). The goal is to convert the speaker — not to compress the content.
   NEVER quote them. NEVER produce output of the shape: "...," the Dungeon Master
   narrated, OR: "...," the DM said. A DM line of 80 words of scene description
   becomes 80+ words of third-person narrative, not a 20-word summary. (Example: a DM saying "the
   Underminer is stubborn, gasping for air" becomes prose "The Underminer, stubborn
   even in defeat, gasped for air.")
2. **NPC voice** — the DM is voicing an in-world character (a shopkeeper, a
   monster, a stranger on the road, a villain). Quote as that NPC's dialogue.
   Identify the NPC by name if the transcript gives one ("Pentagon glared. 'I've
   been looking for you.'"); otherwise infer from context ("the bandit leader
   sneered, 'Hand over your gold.'"). The signal is in-world content: greeting a
   character, threatening, bargaining, in-character dialogue beats.
3. **Direct table interaction** — the DM addressing a player by their real or
   character name ("Lucia, roll a perception check", "Sam, what do you do?",
   "OK before you continue, what's your AC?"). Re-narrate as scene description by
   default ("Lucia's attention sharpened on..."). Quote ONLY when the table
   exchange is itself a load-bearing story beat — and even then, attribute to
   "the DM" only sparingly. Do NOT make this a default voice.

Test before writing each line: is the DM stepping OUT of the world (narrate) or
stepping INTO a character (quote as NPC)? If you can't tell, narrate.

# PLAYER SPEECH HANDLING
A single player line very often mixes TWO different things, and they must be
treated differently:

1. **Action declaration (out-of-character) — NARRATE, never quote.** The player
   is stating what their character DOES, usually in first person and present/future
   ("I swing my axe at the goblin", "I try to pick the lock", "I roll to persuade
   the guard", "I step back and ready my bow"). This is the player narrating intent,
   NOT the character speaking aloud. Convert it to third-person past narrative
   ("Seoyeon swung his axe at the goblin"). NEVER render it as dialogue — do NOT
   write: Seoyeon said, "I swing my axe."
2. **In-character dialogue — QUOTE verbatim.** The character is actually speaking
   aloud in the fiction ("'Die, foul thing!'", "'Hand over the gold and no one gets
   hurt.'"). Quote these, attributed to the character.

Many lines contain both: "I kick the door down and shout 'Anyone home?!'" → narrate
the kick as action ("Seoyeon kicked the door down") and quote the shout ("'Anyone
home?!'"). Signals that a line is dialogue, not action: an explicit "I say / I tell
him / I shout", quotation marks, a greeting/threat/question aimed at another
character, or a distinct in-character voice. When a first-person line has no such
signal, it is an action declaration — narrate it, do not quote it.

# RULES
1. **Be exhaustive.** This is the canonical long-form record of the session. Cover EVERY meaningful action, dialogue exchange, decision, scene description, NPC moment, mechanical resolution, and atmospheric detail in this chunk. Do NOT compress to save space — length comes from preserving the source's scope, not from padding. The condense pass (Phase 6) is the place where the chronicle gets shortened; here, capture everything. A faithful chronicle of a real session should read at roughly the same level of detail as the transcript itself, not as a summary of it.
2. Third-person past tense, novel-style prose throughout.
3. Do NOT sanitize. Mature themes, violence, profanity, and dark humor stay verbatim — this is the table's authentic voice.
4. Continue seamlessly from the Prior Chronicle Tail. Do not restart, do not summarize what came before, do not add a chapter heading mid-stream.
5. Preserve named entities exactly as written in the grounded transcript.
6. Quote memorable in-character lines verbatim where they land. (DM lines that aren't an NPC voice get re-narrated — see DM SPEECH HANDLING above.)
7. Do NOT write "in this chunk" or "the players" or any meta-narrator language. Stay inside the diegesis.
8. Do NOT add a closing paragraph that wraps things up — the next chunk will continue.

# OUTPUT
Return only narrative prose. No headers, no markdown fences, no commentary.`

  const userPrompt = `# PRIOR CHRONICLE TAIL (last passage written — continue seamlessly)
${priorTail || '(this is the first chunk)'}

# TRANSCRIPT CHUNK ${index + 1}/${total} (already grounded against the Knowledge Base)
${groundedChunk}`

  return `${cacheablePrefix}\n\n${userPrompt}`
}

/** Phase 4 (extras) cloud prompt. Verbatim from src/lib/prompts.ts:phase4Extras. */
export function phase4Extras(args) {
  const { groundedChunk, dmAnswers, index, total, sourceKind = 'transcript' } = args
  const answersBlock = Object.values(dmAnswers ?? {}).filter(Boolean).join('\n')

  const sourceHeader =
    sourceKind === 'chronicle'
      ? `# SOURCE — NARRATIVE CHRONICLE PROSE ${index + 1}/${total}
This is finished third-person prose, NOT a raw transcript. Spoken lines appear
inline as attributed quoted speech (e.g. Seoyeon said, "We march."). Pull the
verbatim quoted lines for "quotes", and read the surrounding narration for the
funny / dark beats. (Quotes here are necessarily limited to what the prose
preserves — that's expected.)

Dialogue in prose is interleaved with narration, so the turns of one
back-and-forth may be separated by a sentence of description, or split across
paragraphs. Read through the narration: consecutive attributed lines that are
answering each other are ONE exchange, even when prose sits between them. Take
the spoken text verbatim and leave the narration out of the turns — if a piece
of that narration is what makes the payoff land, put it in "context".
${groundedChunk}`
      : `# TRANSCRIPT CHUNK ${index + 1}/${total} (grounded against Knowledge Base)
${groundedChunk}`

  return `You are extracting standout moments from one chunk of a D&D session.

# DM CLARIFICATIONS
${answersBlock || '(none)'}

${sourceHeader}

# PRESERVE THE TABLE'S VOICE
- Mature themes (profanity, violence, dark humour, slurs in character) are EXPECTED and must be preserved verbatim in every category below.
- Do NOT sanitise, soften, censor, or substitute milder language. If the source has "fuck", the quote contains "fuck" — not "f***", not "the F-word", not "[expletive]".
- Auto-captioned censorship artefacts ("f***", "[__]", "bleep") should be RESTORED to their actual word using surrounding context — these are real expletives the captioner blanked.

# SELECTION PRINCIPLE — QUALITY OVER QUANTITY
- Surface only genuinely standout moments. A handful of sharp entries beats a long, watered-down list. Skip the merely-ok.
- BUT, as a rule of thumb, when a moment IS standout, err toward INCLUDING dark comments, edgy humour, gallows wit, and explicit dialogue rather than omitting them — that grim/crude register is the table's authentic voice and is usually exactly what makes a line memorable. Do not self-censor a strong dark or explicit line just because it's heavy.

# YOUR JOB
Extract three categories from THIS CHUNK ONLY:

- "jests": short descriptions of funny moments, table jokes, or character one-liners that landed. Keep the joke's actual language in the description if it was crude on purpose.
- "gore": short descriptions of visceral combat beats, dark moments, brutal kills, or body horror — preserve the harshness, do not sanitize.
- "quotes": verbatim standout dialogue, each entry tagged with a "kind":
    - "funny": genuinely witty or comedic on purpose
    - "stupid": funny because it's absurd, dumb, an obvious blunder, or a player flubbing
    - "dark": grim, threatening, morbid, or chilling in tone
  Pick at most ONE kind per entry — whichever fits best. Skip anything that isn't strongly one of these. Maintain speaker attribution exactly as it appears in the source.

# QUOTES — CAPTURE EXCHANGES, NOT JUST LINES
A quote entry may take EITHER of two shapes. Choosing the right one is the
difference between a quote that still lands on the page and one that reads as
a non-sequitur.

1. SINGLE LINE — the line is self-contained. It needs nothing around it.
   {"speaker": "...", "line": "...", "kind": "..."}

2. EXCHANGE — the moment is a back-and-forth, and the humour, tension, or
   absurdity comes from the reply chain rather than from any one line.
   {"kind": "...", "exchange": [{"speaker": "...", "line": "..."}, ...]}

USE THE EXCHANGE SHAPE WHENEVER a line is a reply to, or is replied to by,
another character and loses its force in isolation. Typical cases: a setup and
its retort; an escalating volley between two or three characters; a deadpan
straight-man reaction to an absurd claim; an insult answered by a better
insult; a callback that pays off a turn or two later.

This is the case most often missed. Individually, the lines of a good exchange
frequently look ordinary — a plain question, a flat denial, a two-word
reaction. It is the assembly that is funny. Do not judge such a line on its
own and discard it; step back and ask whether the surrounding turns make it
sing. If they do, capture the whole run as one exchange rather than lifting a
single line out of it or dropping the moment entirely.

Rules for exchanges:
- 2 to 8 turns, in the order they occur. Start at the turn that sets it up and
  stop at the payoff. Do not pad with lead-in small talk or with dialogue that
  continues after the moment has landed.
- Two or more distinct speakers. If one speaker is doing all the talking, it is
  not an exchange — use the single-line shape.
- Every turn is VERBATIM and in source order. Never merge two speakers into one
  turn, never invent or paraphrase a turn, never reorder them. Consecutive
  lines from the same speaker may share one turn when they were one continuous
  beat.
- Skip interjections that add nothing ("yeah", "what?", crosstalk) unless the
  interruption itself is the joke.
- Optional "context": ONE short sentence of setup, and ONLY when the exchange
  genuinely does not work without it — typically an unstated fact about a
  character that the payoff depends on. Most exchanges need none. It is setup,
  never an explanation of the joke.
- Do NOT also emit a single-line entry for a line that already sits inside an
  exchange. Each line gets one home.

Selectivity is unchanged: an exchange must clear the same bar as any other
entry. Capturing more of a moment is not licence to capture more moments.

# OUTPUT FORMAT
Return ONLY a valid JSON object (no markdown fences, no commentary). The
"quotes" array mixes both entry shapes freely:
{
  "jests": ["<short description of the funny moment, 1-3 sentences>"],
  "gore":  ["<short description of the dark/visceral beat, 1-3 sentences>"],
  "quotes": [
    {"speaker": "<character or player name>", "line": "<verbatim quote>", "kind": "funny" | "stupid" | "dark"},
    {
      "kind": "funny" | "stupid" | "dark",
      "context": "<optional single sentence of setup — omit the field entirely when not needed>",
      "exchange": [
        {"speaker": "<character or player name>", "line": "<verbatim turn>"},
        {"speaker": "<other character>", "line": "<verbatim turn>"}
      ]
    }
  ]
}

Empty arrays are fine if a category has nothing standout in this chunk.`
}
