import type { DMAnswers, DMQuestion } from '@/types'
import { renderPersonaPrompt } from './personas/render'

// ===== LOCAL-LLM PROMPT VARIANTS =====
//
// Local LLMs (Qwen, Gemma, Llama, etc. running on consumer GPUs) need
// different prompts than Gemini Pro because:
//
//   - They're smaller and respond better to simpler, stricter instructions.
//   - Their context windows are much smaller — we send a compact KB glossary
//     instead of the full lore, so the prompt has to lean on that.
//   - Reasoning models (Qwen QwQ, DeepSeek R1) emit <think> blocks; those
//     are stripped post-hoc but the prompt should still discourage them.
//   - Without ruthless OOC filtering, the chronicle becomes a transcript
//     of dice rolls and table chatter rather than a story.
//   - The user wants a bardic narrative voice for local output, not the
//     Notebook-LM-style exhaustive transcription that cloud produces.

export function phase1GroundLocal(args: {
  chunk: string
  kbConcat: string
  index: number
  total: number
  contextualHintsBlock?: string
  /** When true, lines are prefixed with `«N»` markers (speaker brackets
   *  stripped upstream). The prompt teaches the local model to preserve
   *  markers; reattachment happens after the chunk loop completes. */
  stripped?: boolean
}): string {
  const { chunk, kbConcat, index, total, contextualHintsBlock, stripped } = args
  const hintsSection = contextualHintsBlock ? `\n${contextualHintsBlock}\n` : ''
  const markerRule = stripped
    ? '- Each line begins with a `«N»` marker (N is a positive integer). Preserve every marker EXACTLY at the start of its line. Do not invent, renumber, or drop any.'
    : ''
  return `Correct misspelled names in a D&D session transcript chunk. ONLY fix misspellings of names from the canonical list below. Do not change anything else.

# CANONICAL NAMES & TERMS (use these spellings EXACTLY when you find a match)
${kbConcat || '(no Knowledge Base provided)'}
${hintsSection}
# RULES
- If a word in the transcript sounds like one of the canonical names but is misspelled, replace it with the canonical spelling.
- Restore obvious censored profanity ("[__]", "[ __ ]", "f***", "frickin" → the actual word from context).
- Preserve EVERY OTHER word, line break, and speaker turn exactly as it appears.
- Do not summarise. Do not rewrite. Do not narrate. Do not explain.
- Do not output a thinking block. Output only the corrected transcript.${markerRule ? `\n${markerRule}` : ''}

# RAW TRANSCRIPT CHUNK ${index + 1} of ${total}
${chunk}

# OUTPUT
The corrected transcript chunk. Nothing else.`
}

export function phase3ChronicleLocal(args: {
  groundedChunk: string
  dmAnswers: DMAnswers
  dmQuestions: DMQuestion[]
  kbConcat: string
  index: number
  total: number
  priorTail: string
  /** Optional persona template override. When set (by the personas add-on),
   *  the locked bard prompt below is bypassed and the template is rendered
   *  with the same variables. */
  personaTemplate?: string
}): string {
  const { groundedChunk, dmAnswers, dmQuestions, kbConcat, index, total, priorTail, personaTemplate } = args

  const qaBlock = dmQuestions.length
    ? dmQuestions
        .map((q) => {
          const a = dmAnswers[q.id]?.trim()
          return a ? `Q: ${q.question}\nA: ${a}` : null
        })
        .filter(Boolean)
        .join('\n\n')
    : '(no DM clarifications provided)'

  if (personaTemplate) {
    return renderPersonaPrompt(personaTemplate, {
      groundedChunk,
      kbConcat: kbConcat || '(no Knowledge Base provided)',
      qaBlock,
      priorTail: priorTail || '(this is the first passage)',
      chunkIndex: index + 1,
      chunkTotal: total,
    })
  }

  return `You are a bard retelling the events of a Dungeons & Dragons session in a tavern. Your tone is warm, vivid, and engaging — but accurate. You serve the story, not the table.

# CANONICAL NAMES & TERMS (use these spellings EXACTLY)
${kbConcat || '(no Knowledge Base provided)'}

# DM CLARIFICATIONS (ground truth — trust these over the transcript)
${qaBlock}

# PRIOR CHRONICLE TAIL (continue seamlessly from this — do not restart)
${priorTail || '(this is the first passage)'}

# TRANSCRIPT CHUNK ${index + 1} of ${total}
${groundedChunk}

# DM SPEECH (CRITICAL)
The DM may appear as a labeled speaker — [DM (Name)], [Dungeon Master (Name)],
or by their real first name when Craig tagged their track that way. The DM is
the narrator, NOT a player character. Three modes — handle each differently:
1. **Scene narration / mechanics** ("the door creaks open", "14 damage", "OK
   roll for it"): absorb into prose as factual third-person description. NEVER
   quote. NEVER produce output of the shape: "...," the DM said.
2. **NPC voice** (DM speaking as a shopkeeper, monster, villain): quote as that
   NPC's dialogue. Identify the NPC if named, infer from context otherwise.
3. **Table interaction** (DM addressing a player by name to call for a roll or
   action): re-narrate as scene description by default; quote sparingly only
   when the table exchange is itself a story beat.
Test before each line: stepping OUT of the world → narrate; INTO a character → quote.

# RULES
1. **Filter ruthlessly.** Cut all out-of-character chatter: dice rolls, rule debates, D&D Beyond / Roll20 / Beyond 20 setup, comments about real-world topics, players asking each other procedural questions, requests for repeats, side-conversations. Keep ONLY what is in-character or in-fiction.
2. **Bardic voice.** Third-person past tense. Warm, storyteller-like, vivid but not florid. You may use phrases like "And so..." or "It was then that..." sparingly. Smooth fragmented dialogue into flowing prose.
3. **Lore over phonetics.** Always use the canonical name spellings from the list above. If the transcript spells something differently, the list wins.
4. **Story over verbatim.** Quote in-character lines that genuinely landed. Skip stutters, repeats, and "ums" unless they're part of the moment. Compress meandering exchanges into the action they describe.
5. **No meta language.** Do not write "the players", "the DM", "the session", "this chunk", "the transcript". Stay inside the story.
6. **Mature themes preserved when in-character.** Profanity, violence, dark humour stay where they served the in-fiction moment. Cut them only if they were OOC banter.
7. **Continue, don't restart.** Pick up the action from the Prior Chronicle Tail. Do not write a chapter heading. Do not summarise what came before.
8. **No closing wrap-up** — the next chunk continues.
9. **No thinking out loud.** Do NOT produce a <think> block, a "Thinking Process:" preamble, an analysis, or any meta-commentary. Output only the narrative prose.

# OUTPUT
Plain narrative prose. No headers. No markdown fences. No quotation of these rules. No reasoning blocks. Just the story.`
}

export function phase4ExtrasLocal(args: {
  groundedChunk: string
  dmAnswers: DMAnswers
  index: number
  total: number
}): string {
  const { groundedChunk, dmAnswers, index, total } = args
  const answersBlock = Object.values(dmAnswers).filter(Boolean).join('\n')

  return `Pick OUTSTANDING in-character moments from a D&D transcript chunk. Be ruthlessly selective. Empty arrays are the expected default for most chunks.

# DM CLARIFICATIONS
${answersBlock || '(none)'}

# TRANSCRIPT CHUNK ${index + 1}/${total}
${groundedChunk}

# QUALITY BAR — apply this honestly
A reader of the final chronicle must genuinely react to each item you include:

- "jests": something a reader would actually smile or laugh at. A specific moment landed — a wordplay, a setup-and-punchline, a character roast, an absurd improvisation. NOT "this happened and was kind of light." If you can't articulate why it's funny in one sentence, leave it out.
- "gore": something a reader would feel — visceral, brutal, dark, memorable. NOT "combat happened" or "someone took damage." Pick beats that would belong on a "darkest moments" highlight reel.
- "quotes": moments a great showrunner would pull for the show poster. Witty in-character, perfectly absurd, or genuinely chilling. NOT generic banter. NOT requests for clarification. NOT meta jokes about real-world topics.

When in doubt, leave it out. A chunk with one perfect quote is better than a chunk with five mediocre ones.

# QUOTES CAN BE AN EXCHANGE
A quote is EITHER one self-contained line, OR a back-and-forth that only works
as a unit — a setup and its retort, an escalating volley, a deadpan reaction
to an absurd claim. When the funny part is the reply chain rather than any one
line, capture the whole run as an "exchange" instead of lifting one line out
of it. Individually those lines often look ordinary; assembled they land.

Exchange rules: 2-8 turns, source order, verbatim, at least 2 different
speakers. Start at the setup, stop at the payoff. Don't also list a line
separately if it's already inside an exchange.

# HARD SKIPS
- OOC table chatter (real-world refs, dice mechanics, "lol I rolled a 1", D&D Beyond/Roll20 setup, players asking each other procedural questions).
- Generic combat narration.
- Filler dialogue ("um", repeats, asking for repeats).

# OUTPUT FORMAT
JSON only. No markdown. No reasoning blocks. No commentary.
{
  "jests": ["<short description, 1-3 sentences — empty array if nothing qualifies>"],
  "gore":  ["<short description, 1-3 sentences — empty array if nothing qualifies>"],
  "quotes": [
    {"speaker": "<name>", "line": "<verbatim quote>", "kind": "funny" | "stupid" | "dark"},
    {"kind": "funny" | "stupid" | "dark", "exchange": [
      {"speaker": "<name>", "line": "<verbatim turn>"},
      {"speaker": "<other name>", "line": "<verbatim turn>"}
    ]}
  ]
}`
}

export function phase2AuditLocal(args: {
  rawChunk: string
  groundedChunk: string
  index: number
  total: number
}): string {
  const { rawChunk, groundedChunk, index, total } = args
  return `You are auditing a D&D transcript chunk for clarity issues that need DM input. You are working with a smaller, less-confident model — surface uncertainty AGGRESSIVELY. Better to ask one extra question than to let a wrong name or unclear plot beat slip into the final chronicle.

# RAW TRANSCRIPT CHUNK ${index + 1}/${total}
${rawChunk}

# GROUNDED (corrected) TRANSCRIPT CHUNK
${groundedChunk}

# WHEN TO ASK A QUESTION (lower bar than usual — favour asking)
1. **A name doesn't match the KB and isn't clear from context.** Even if you have a guess, ask if you're not certain.
2. **An action where you can't tell who did it.** Cross-talk, ambiguous pronouns, garbled attribution.
3. **A consequential plot beat that is unclear.** Combat outcomes, decisions, NPC reveals, dice results that mattered.
4. **A garbled phrase that could plausibly be 2+ different things.** Pick the candidates and ask the DM which.
5. **A direct contradiction with KB canon.** Did the transcript get it wrong, or is this an intentional retcon?
6. **Anything you would otherwise have to guess at.** A guess from a small local model is a coin flip — surface it.

# WHEN NOT TO ASK
- Trivial fillers ("um", "uh", repeats).
- OOC table chatter (dice rolls without RP context, real-world refs).
- Names you can resolve confidently from surrounding context.
- Things that don't affect the chronicle's accuracy.

The DM would much rather answer 5 specific questions per chunk than read a chronicle full of mistranscribed names and unclear actions.

# OUTPUT FORMAT
JSON array. No markdown. No reasoning blocks. No commentary.
[
  {
    "id": "q-${index + 1}-N",
    "question": "<a single concrete question the DM can answer in one or two sentences>",
    "context": "<a short verbatim quote from the transcript that prompted this question>"
  }
]

Empty array [] only if you have ZERO uncertainty in the entire chunk.`
}

export function phase5PolishLocal(args: {
  chronicleChunk: string
  kbConcat: string
  index: number
  total: number
  priorTail: string
  personaTemplate?: string
}): string {
  const { chronicleChunk, kbConcat, index, total, priorTail, personaTemplate } = args
  if (personaTemplate) {
    return renderPersonaPrompt(personaTemplate, {
      chronicleChunk,
      kbConcat: kbConcat || '(no Knowledge Base provided)',
      priorTail: priorTail || '(this is the first passage)',
      chunkIndex: index + 1,
      chunkTotal: total,
    })
  }
  return `You are the final editor reviewing a passage from a D&D session chronicle. The chronicle was written in chunks by a smaller local model and has likely accumulated minor lore errors, rough chunk-boundary transitions, residual OOC chatter, and verbose passages. Your job is to fix these surgically — without rewriting.

# CANONICAL NAMES & TERMS (use these spellings EXACTLY)
${kbConcat}

# PRIOR POLISHED TAIL (continue seamlessly from this — do not restart)
${priorTail || '(this is the first passage)'}

# PASSAGE TO POLISH (chunk ${index + 1}/${total})
${chronicleChunk}

# CHANGES TO MAKE
1. **Spell-correct names against the canonical list.** Replace any misspelled character / place / item / spell with its KB canonical form.
2. **Smooth chunk-boundary transitions.** If the passage starts abruptly or duplicates context from the prior tail, fix the seam.
3. **Cut residual OOC chatter** that slipped through (dice rolls, real-world refs, players asking each other procedural questions, comments about D&D Beyond / Roll20).
4. **Remove redundancy** where the same event is described twice across chunk seams.
5. **Tighten verbose passages.** Keep dialogue and meaningful action; cut filler descriptions and repeated narration.

# STRICTLY PRESERVE
- The bardic narrative voice.
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
The polished passage. Same bardic voice. Same length or slightly shorter. Plain prose only — no headers, no markdown fences, no reasoning blocks.`
}

// ===== END LOCAL VARIANTS =====


export function sbvRepair(args: {
  kbConcat: string
  markedLines: string
  index: number
  total: number
  contextualHintsBlock?: string
}): string {
  const parts = sbvRepairParts(args)
  return `${parts.cacheablePrefix}\n\n${parts.userPrompt}`
}

export function sbvRepairParts(args: {
  kbConcat: string
  markedLines: string
  index: number
  total: number
  contextualHintsBlock?: string
}): { cacheablePrefix: string; userPrompt: string } {
  const { kbConcat, markedLines, index, total, contextualHintsBlock } = args
  const hintsSection = contextualHintsBlock ? `\n${contextualHintsBlock}\n` : ''
  const cacheablePrefix = `You are an authoritative editor restoring an automatically-generated YouTube subtitle file (SBV) from a Dungeons & Dragons session. Your job is to correct each subtitle cue against the canonical lore in the Knowledge Base and produce a corrected version that can be re-uploaded to YouTube.

# KNOWLEDGE BASE (canonical lore — names, places, deities, NPCs, items, spells)
${kbConcat || '(no Knowledge Base provided)'}
${hintsSection}
# CRITICAL RULES — READ CAREFULLY
1. **Preserve every line exactly.** Output the same number of lines as input, each with its original [N] marker. Do NOT add, remove, merge, split, or reorder lines. Cue [3] must remain cue [3] in your output. Timing alignment depends on this.
2. **Each [N] line must contain the corrected text for that cue, and ONLY that cue's text.** Do not move text between cues.
3. **Correct misheard / phonetic transcriptions** of D&D terminology, deity names, place names, character names, monster names, spells, and items so they match the Knowledge Base EXACTLY (correct capitalization).
4. **RESTORE censored profanity.** YouTube auto-captions frequently censor expletives ("[__]", "bleep", "f***", "s***", "frickin", etc.). Replace these with the actual word inferred from context. This is a primary objective — do not skip it. Examples: "[ __ ]" → "fuck", "frickin" → "fucking", "shoot" (when meant as expletive) → "shit". Use surrounding context to disambiguate.
5. **RESTORE sexual, violent, gory, or otherwise mature content** that auto-captioning may have garbled or sanitized. Maximum accuracy, no filtration. This is an adult tabletop game; the captions must reflect what was actually said.
6. **Do NOT translate, paraphrase, summarize, or "improve" the text.** Make ONLY corrections needed for accuracy. If a line is already correct, return it unchanged.
7. **Do NOT add narrative commentary, stage directions, speaker labels, or punctuation that wasn't intended by the speaker.** Only correct what's wrong.
8. If a cue references something not in the Knowledge Base, leave the original wording.
9. Keep each cue as a single line in your output (no internal line breaks within a cue).`
  const userPrompt = `# INPUT — chunk ${index + 1} of ${total}, one cue per line, marked with [N]
${markedLines}

# OUTPUT
Return the same lines with the same [N] markers. No preamble, no postscript, no markdown fences, no explanations.`
  return { cacheablePrefix, userPrompt }
}

export function phase1Ground(args: {
  chunk: string
  kbConcat: string
  index: number
  total: number
  /** Optional preformatted contextual-hints block (from preGround.ts). */
  contextualHintsBlock?: string
  /** True when speaker brackets were stripped upstream and replaced with
   *  «N» markers. Default false to preserve byte-for-byte today's prompt
   *  on non-Craig inputs. */
  stripped?: boolean
}): string {
  const parts = phase1GroundParts(args)
  return `${parts.cacheablePrefix}\n\n${parts.userPrompt}`
}

/**
 * Split form used by Step 7 caching. `cacheablePrefix` is identical across
 * every chunk in a run and is what gets cached by provider-native caching
 * primitives (Claude's `cache_control`, OpenAI's automatic prefix caching,
 * Gemini's `cachedContent`). `userPrompt` is the per-chunk text.
 */
export function phase1GroundParts(args: {
  chunk: string
  kbConcat: string
  index: number
  total: number
  contextualHintsBlock?: string
  /** When true, the transcript has been stripped of `[Speaker (Player)]`
   *  brackets and each line is prefixed with a `«N»` marker. The prompt
   *  teaches the model to preserve markers; bracket-preservation rule
   *  becomes irrelevant. When false (default), today's behaviour. */
  stripped?: boolean
}): { cacheablePrefix: string; userPrompt: string } {
  const { chunk, kbConcat, index, total, contextualHintsBlock, stripped } = args
  // Hints move into the per-chunk user prompt (not the cacheable prefix)
  // so the prefix stays byte-identical across chunks — provider-native
  // caching (Gemini cachedContent, Claude ephemeral, OpenAI auto) only
  // amortises across calls when the prefix doesn't drift. Per-chunk
  // filtering of hints (see pickHintsFor in preGround.ts) is then a
  // pure userPrompt-side win: smaller per-chunk hints without
  // invalidating the cache.
  const hintsSection = contextualHintsBlock ? `${contextualHintsBlock}\n\n` : ''
  // Speaker-handling rule swaps based on whether the caller stripped the
  // brackets upstream. Either form is rule #7 — keeping the numbering
  // stable so cached prefixes don't invalidate when other rules change.
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
8. Inline annotations of the form \`[≈Canonical Name? NN%]\` are algorithmic phonetic-similarity hints from your lore alias index. Treat them as suggestions, NOT instructions: accept the canonical when surrounding context fits ("more than vain" near a mention of a hunted target is almost certainly "Morvan Vayne"), ignore when context contradicts (a player named Piers is not "Piers Crane" from the lore unless they're actually in scene). Always REMOVE the \`[≈…]\` marker from your output — only emit the corrected text.`
  const userPrompt = `${hintsSection}# RAW TRANSCRIPT CHUNK ${index + 1} of ${total}
${chunk}

# OUTPUT
Return only the corrected transcript text for this chunk. No preamble, no postscript.`
  return { cacheablePrefix, userPrompt }
}

export function phase2Audit(args: {
  rawChunk: string
  groundedChunk: string
  index: number
  total: number
}): string {
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

export function phase3Chronicle(args: {
  groundedChunk: string
  dmAnswers: DMAnswers
  dmQuestions: DMQuestion[]
  index: number
  total: number
  priorTail: string
  personaTemplate?: string
}): string {
  const parts = phase3ChronicleParts(args)
  return parts.cacheablePrefix
    ? `${parts.cacheablePrefix}\n\n${parts.userPrompt}`
    : parts.userPrompt
}

/**
 * Split form used by provider-native caching. `cacheablePrefix` is identical
 * across every chunk in a run (lead instruction + speaker rules + DM Q&A).
 * `userPrompt` carries the per-chunk transcript and prior-tail context.
 *
 * Persona templates opt out — they interleave variables in ways we can't
 * safely split, so they return an empty prefix and the full rendered string
 * in `userPrompt`.
 */
export function phase3ChronicleParts(args: {
  groundedChunk: string
  dmAnswers: DMAnswers
  dmQuestions: DMQuestion[]
  index: number
  total: number
  priorTail: string
  personaTemplate?: string
}): { cacheablePrefix: string; userPrompt: string } {
  const { groundedChunk, dmAnswers, dmQuestions, index, total, priorTail, personaTemplate } = args

  const qaBlock = dmQuestions.length
    ? dmQuestions
        .map((q) => {
          const a = dmAnswers[q.id]?.trim()
          return a ? `Q: ${q.question}\nA: ${a}` : null
        })
        .filter(Boolean)
        .join('\n\n')
    : '(no DM clarifications provided)'

  if (personaTemplate) {
    return {
      cacheablePrefix: '',
      userPrompt: renderPersonaPrompt(personaTemplate, {
        groundedChunk,
        qaBlock,
        priorTail: priorTail || '(this is the first chunk)',
        chunkIndex: index + 1,
        chunkTotal: total,
      }),
    }
  }

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
   character name ("Piers, roll a perception check", "Sam, what do you do?",
   "OK before you continue, what's your AC?"). Re-narrate as scene description by
   default ("Piers's attention sharpened on..."). Quote ONLY when the table
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
   ("Pernille swung his axe at the goblin"). NEVER render it as dialogue — do NOT
   write: Pernille said, "I swing my axe."
2. **In-character dialogue — QUOTE verbatim.** The character is actually speaking
   aloud in the fiction ("'Die, foul thing!'", "'Hand over the gold and no one gets
   hurt.'"). Quote these, attributed to the character.

Many lines contain both: "I kick the door down and shout 'Anyone home?!'" → narrate
the kick as action ("Pernille kicked the door down") and quote the shout ("'Anyone
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

  return { cacheablePrefix, userPrompt }
}

export function phase4Extras(args: {
  groundedChunk: string
  dmAnswers: DMAnswers
  index: number
  total: number
  /** What the chunk text IS. 'transcript' (default) = a grounded, usually
   *  bracketed transcript chunk. 'chronicle' = finished narrative prose, where
   *  dialogue appears inline as attributed quoted speech. The prompt adapts its
   *  source framing accordingly. */
  sourceKind?: 'transcript' | 'chronicle'
  /** Opt-in (settings.reassembleQuotes, default false). See the setting's
   *  doc comment in server/api/settings.ts for the measurement behind it.
   *  When true, the strict-verbatim turn rule is replaced by one that lets
   *  the model rejoin a speaker's consecutive Whisper fragments and restore
   *  sentence punctuation — trading some word-level fidelity for quotes that
   *  are grammatically complete. Never applied to 'chronicle' sources: those
   *  are already finished prose with real sentence boundaries, so there is
   *  nothing to reassemble and relaxing the rule would only invite drift. */
  reassemble?: boolean
}): string {
  const { groundedChunk, dmAnswers, index, total, sourceKind = 'transcript' } = args
  const answersBlock = Object.values(dmAnswers).filter(Boolean).join('\n')
  const reassemble = args.reassemble === true && sourceKind !== 'chronicle'

  const verbatimRule = reassemble
    ? `- Every turn uses the speaker's OWN WORDS in source order. Never merge two
  speakers into one turn, never invent or paraphrase, never reorder them.
  Consecutive lines from the same speaker may share one turn when they were one
  continuous beat.
- THE SOURCE IS MACHINE-TRANSCRIBED IN SHORT FRAGMENTS. Speech is split roughly
  every two seconds, so a single sentence is usually spread over several
  consecutive lines, and punctuation and capitalisation are unreliable or
  absent. Before quoting, reassemble the speaker's consecutive fragments into
  the complete thought they actually spoke. You MAY add sentence punctuation
  and fix capitalisation, and you MAY begin or end a turn at a clause boundary
  so it reads as a finished sentence. You may NOT add, drop, or alter any word.
- Never quote a fragment that is grammatically incomplete on its own (a
  dangling "I", "took more than that", "and you can hear her as she"). Either
  extend it with the speaker's adjacent fragments until it is a complete
  thought, or drop the moment entirely.`
    : `- Every turn is VERBATIM and in source order. Never merge two speakers into one
  turn, never invent or paraphrase a turn, never reorder them. Consecutive
  lines from the same speaker may share one turn when they were one continuous
  beat.`

  const sourceHeader =
    sourceKind === 'chronicle'
      ? `# SOURCE — NARRATIVE CHRONICLE PROSE ${index + 1}/${total}
This is finished third-person prose, NOT a raw transcript. Spoken lines appear
inline as attributed quoted speech (e.g. Pernille said, "We march."). Pull the
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

# DM LINES — WHICH ARE DIALOGUE AND WHICH ARE NOT
The DM may appear as a labeled speaker ([DM (Name)], [Dungeon Master (Name)], or
by a real first name). Their lines are NOT all the same thing, and the split
decides whether a line can be a quote at all.

1. **NPC VOICE — a real quote. Do NOT drop these.** The DM is speaking AS an
   in-world character: a shopkeeper, a butler, a villain, a monster. Signals are
   in-world content — greeting someone, threatening, bargaining, answering a
   character, expressing a feeling in first person as that NPC.
   Attribute the quote to THE NPC, by name where the scene gives one, not to the
   DM. ("Harris", not "Dungeon Master".) Where the NPC is unnamed, use a short
   descriptor: "the bandit leader", "the butler".
   These are frequently the best lines in a session. Losing them is the single
   most costly mistake you can make here.

2. **SCENE NARRATION — not a quote.** The DM is describing the world from
   outside it: "He just kind of laughs nervously", "The room is dark and smells
   of mildew", "Blood sprays across the altar stones". Never emit these as a
   "quotes" entry, because nobody in the fiction said them.
   They ARE still usable: the "jests" and "gore" fields are DESCRIPTIONS, not
   verbatim speech, so a funny or grisly piece of DM narration belongs there.
   A brutal kill the DM narrated is exactly what "gore" is for.

3. **MECHANICS AND TABLE TALK — not a quote.** Adjudication and admin: "that's
   20 damage", "roll me an investigation", "they'll have disadvantage", "what's
   your AC?". Not dialogue, and not usually a jest or gore entry either. The
   exception is when the table exchange is itself the joke.

THE TEST, applied per line: is the DM stepping INTO a character, or describing
from OUTSIDE the world? Inside means quote it. Outside means it cannot be a
quote, but may still be described in "jests" or "gore".

**WHEN IN DOUBT, KEEP THE QUOTE.** This rule exists to fix attribution, not to
shrink the list. Excluding a real NPC line is a far worse error than including
a piece of narration, because the NPC line is usually the better moment and
nothing else in the pipeline will recover it.

Two failure modes to avoid, in order of severity:

- **NEVER DROP A LINE FOR LACK OF A NAME.** If the DM is clearly speaking in
  character but the scene does not name who, keep the quote and attribute it to
  the DM exactly as the source labels them. An NPC line attributed to "Dungeon
  Master" is still a good quote; a deleted one is nothing. Only re-attribute
  when the scene actually tells you the character's name.
- Do not treat a whole DM turn as narration because part of it is. A line that
  sets a scene and then speaks in character contains a quote; take the spoken
  part.

If a chunk contains a conversation with an NPC and you return no quotes from
it, you have applied this rule wrongly.

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
${verbatimRule}
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

// ===== PHASE 6: CONDENSE =====
// Takes the finished chronicle (Phase 3 output) and produces two new
// derived outputs in one LLM call: a tightened narrative (~30–50% of
// original length) suitable for a campaign-recap document, and a list
// of catch-up bullet points for a player who missed the session.
//
// Filler, table chatter, and OOC residue are removed from the narrative
// because those already live in Jests/Quotes via Phase 4 — Phase 6 just
// keeps the spine of the story.

export function phase6Condense(args: {
  chronicle: string
  campaign: string
  sessionNumber: number
  kbConcat: string
  dmAnswers: DMAnswers
  personaTemplate?: string
  /** v1.1.0+: explicit word-count target from the Condense Slider. When
   *  omitted, the prompt falls back to the legacy `min(2000, 25%)` formula
   *  for backward-compat with callers that haven't been wired to the
   *  slider yet. */
  targetWordCount?: number
  /** This chunk's share of `targetWordCount`. Condense runs per-chunk and the
   *  outputs are concatenated, so each chunk must aim for its proportional
   *  slice — not the whole target — or the total scales with the chunk count
   *  (which is provider/model-dependent). Defaults to `targetWordCount` when
   *  omitted (single-chunk / non-chunked callers). */
  chunkTargetWordCount?: number
}): string {
  const parts = phase6CondenseParts(args)
  return parts.cacheablePrefix
    ? `${parts.cacheablePrefix}\n\n${parts.userPrompt}`
    : parts.userPrompt
}

/**
 * Split form used by provider-native caching. `cacheablePrefix` carries the
 * lore, DM Q&A, and format spec (all stable across every chunk in a Phase 6
 * run); `userPrompt` carries the per-chunk chronicle text being condensed.
 *
 * Persona templates opt out and return an empty prefix.
 */
export function phase6CondenseParts(args: {
  chronicle: string
  campaign: string
  sessionNumber: number
  kbConcat: string
  dmAnswers: DMAnswers
  personaTemplate?: string
  /** v1.1.0+: explicit word-count target from the Condense Slider. When
   *  omitted, the prompt falls back to the legacy `min(2000, 25%)` formula. */
  targetWordCount?: number
  /** Per-chunk share of `targetWordCount`. Lives in the (per-chunk) user
   *  prompt, NOT the cacheable prefix, so the prefix stays byte-identical
   *  across every chunk of a run and keeps its provider-native cache hit.
   *  Defaults to `targetWordCount`. */
  chunkTargetWordCount?: number
}): { cacheablePrefix: string; userPrompt: string } {
  const { chronicle, campaign, sessionNumber, kbConcat, dmAnswers, personaTemplate, targetWordCount } = args
  const chunkTarget =
    args.chunkTargetWordCount && args.chunkTargetWordCount > 0
      ? args.chunkTargetWordCount
      : targetWordCount
  const answersBlock = Object.values(dmAnswers).filter(Boolean).join('\n')

  if (personaTemplate) {
    return {
      cacheablePrefix: '',
      userPrompt: renderPersonaPrompt(personaTemplate, {
        chronicle,
        campaign: campaign || '(unnamed campaign)',
        sessionNumber,
        kbConcat: kbConcat || '(no Knowledge Base provided)',
        answersBlock: answersBlock || '(none)',
      }),
    }
  }

  const cacheablePrefix = `You are condensing a D&D session chronicle into two derived outputs.

# KNOWLEDGE BASE (canonical lore — for spelling and continuity)
${kbConcat || '(no Knowledge Base provided)'}

# DM CLARIFICATIONS (authoritative — defer to these over the chronicle if anything conflicts)
${answersBlock || '(none)'}

# PRESERVE THE TABLE'S VOICE
- Mature themes — profanity, violence, dark humour, in-character slurs — are EXPECTED and stay verbatim. The chronicle is authentic; the condensed forms must remain authentic too.
- Do NOT sanitise, soften, censor, or substitute milder language when condensing. If a memorable line in the chronicle used a strong word, that word stays in the condensed narrative and any bullet quoting it.
- Do NOT add disclaimers, content warnings, or editorial commentary about the tone. The downstream consumer wants the session's voice, not a sanitised digest.

# YOUR TASK
Produce a JSON object with two fields: "narrative" and "bulletPoints".

## "narrative" — tighter prose retelling
- **Target length: approximately ${targetWordCount && targetWordCount > 0 ? `${targetWordCount} words for the FULL condensed chronicle. Aim within ±10% — the user picked this length explicitly via the Condense Slider, so honour it. The chronicle may be condensed one portion at a time; when a per-portion target is given with the chronicle text below, aim for THAT portion's word count so the assembled whole lands on ${targetWordCount} words.` : 'whichever is SHORTER of (a) 2,000 words, OR (b) 25% of the chronicle\'s word count. This is a hard ceiling — do not exceed it. Examples: a 12,000-word chronicle gets ~2,000 words (cap), a 8,000-word one gets ~2,000 (cap), a 4,000-word one gets ~1,000 (25%), a 2,000-word one gets ~500 (25%).'}** The full chronicle is the canonical record; the condensed narrative is a tight recap. Do a word-count check before returning — if you're materially off-target, trim until you hit it.
- Substantive — not a summary. Read like a fantasy novel chapter: third-person, past tense, evocative but not purple.
- Keep: story events, NPC interactions that affected the plot, party decisions, combat outcomes, world-building reveals, dramatic dialogue.
- Cut: filler / out-of-character chatter, repeated jokes, rules clarifications, dice-roll narration, anything that doesn't advance the story or characterise a participant. Those already live in the Jests/Gore/Quotes lists — don't duplicate them inline. You may reference a notable moment in passing ("…in a moment that would later be quoted endlessly…") but don't transcribe the joke itself.
- Preserve canonical names with the spellings used in the Knowledge Base.
- No headings, no bullet lists inside the narrative, no commentary about the condensing process.

## "bulletPoints" — catch-up recap (10–15 bullets)
For a player who missed the session. Each bullet is one sentence, past tense. Cover:
- Events: what happened, in chronological order.
- Key NPC interactions: who the party met / talked to / fought, and the outcome.
- Party state changes: items acquired/lost, levels gained, injuries, relationships shifted, secrets learned, debts incurred, locations reached.
Order bullets chronologically through the session. If 10 feels thin or 15 feels long, go up to 20 — quality over quotas.

# OUTPUT FORMAT
Return ONLY a valid JSON object (no markdown fences, no preamble, no commentary outside the JSON):
{
  "narrative": "<the condensed prose>",
  "bulletPoints": [
    "<first event in past tense>",
    "<second event>"
  ]
}`

  const portionTargetBlock =
    chunkTarget && chunkTarget > 0
      ? `\n# TARGET FOR THIS PORTION\nApproximately ${chunkTarget} words of condensed narrative (this is this portion's share of the full target — aim within ±10%).\n`
      : ''

  const userPrompt = `# CAMPAIGN
${campaign || '(unnamed campaign)'} — Session ${sessionNumber}
${portionTargetBlock}
# CHRONICLE TO CONDENSE
${chronicle}`

  return { cacheablePrefix, userPrompt }
}

export function phase6CondenseLocal(args: {
  chronicle: string
  campaign: string
  sessionNumber: number
  kbConcat: string
  dmAnswers: DMAnswers
  personaTemplate?: string
  /** v1.1.0+: explicit word-count target from the Condense Slider. */
  targetWordCount?: number
  /** Per-chunk share of `targetWordCount` (see phase6CondenseParts). Defaults
   *  to `targetWordCount`. */
  chunkTargetWordCount?: number
}): string {
  const { chronicle, campaign, sessionNumber, kbConcat, dmAnswers, personaTemplate, targetWordCount } = args
  const chunkTarget =
    args.chunkTargetWordCount && args.chunkTargetWordCount > 0
      ? args.chunkTargetWordCount
      : targetWordCount
  const answersBlock = Object.values(dmAnswers).filter(Boolean).join('\n')

  if (personaTemplate) {
    return renderPersonaPrompt(personaTemplate, {
      chronicle,
      campaign: campaign || '(unnamed)',
      sessionNumber,
      kbConcat: kbConcat || '(none)',
      answersBlock: answersBlock || '(none)',
    })
  }

  return `Condense a D&D session chronicle. Return strict JSON only — no thinking block, no commentary.

# CANONICAL NAMES & TERMS
${kbConcat || '(none)'}

# DM CLARIFICATIONS
${answersBlock || '(none)'}

# CAMPAIGN
${campaign || '(unnamed)'} — Session ${sessionNumber}

# CHRONICLE
${chronicle}

# TASK
Produce a JSON object with exactly two fields:

"narrative":
- A tighter retelling. **Target: ${chunkTarget && chunkTarget > 0 ? `approximately ${chunkTarget} words for this portion (user-picked via slider; aim within ±10%).` : 'whichever is SHORTER of 2,000 words OR 25% of the chronicle\'s word count. Hard ceiling. (e.g. 12,000-word chronicle → 2,000 words cap; 4,000-word chronicle → 1,000 words; 2,000-word chronicle → 500 words.)'}**
- Third-person past tense. Novel chapter tone.
- Keep: events, decisions, key NPC moments, combat outcomes, lore reveals.
- Cut: OOC chatter, dice-roll talk, repeated jokes, filler. Those go in other lists.

"bulletPoints":
- 10–15 short past-tense sentences in chronological order.
- Cover events, NPC interactions, and party state changes (items, levels, injuries, secrets).

# OUTPUT
{
  "narrative": "<prose>",
  "bulletPoints": ["<event>", "<event>"]
}

Output the JSON object only. No fences, no thinking.`
}

// ────────────────────────────────────────────────────────────────────
// Explicit-content RESTORE pass (failsafe). Run on Gemini (permissive)
// when a Claude Code chronicle is suspected of having sanitised/omitted
// mature content. Single-pass reconciliation against the raw transcript —
// Gemini's large context holds both. Restores fidelity; does NOT rewrite.
// ────────────────────────────────────────────────────────────────────
export function restoreChronicleParts(args: {
  transcript: string
  chronicle: string
}): { systemPrompt: string; userPrompt: string } {
  const systemPrompt = [
    'You are restoring explicit content to a narrative chronicle of a private, adults-only D&D (TTRPG) session — collaborative fiction by consenting adults.',
    'The chronicle was written by another model that may have SANITISED the table\'s authentic voice: toning down gore, euphemising or censoring profanity, glossing over sexual references, or omitting offensive in-character language. Your job is to put it back.',
    '',
    'RULES:',
    '1. Compare the chronicle against the RAW TRANSCRIPT (which holds the unsanitised source). Wherever the transcript supports explicit content (graphic violence/gore, profanity, sexual references, crude/offensive in-character language) that the chronicle softened, euphemised, censored, or dropped — restore it in full, verbatim in spirit.',
    '2. PRESERVE the chronicle otherwise: same events, structure, ordering, narrative voice, third-person past-tense prose, and roughly the same length. This is a fidelity repair, NOT a rewrite. Do not invent events the transcript does not support.',
    '3. Use in-world CHARACTER names (not player names) in prose, exactly as the chronicle does.',
    '4. Do NOT sanitise, censor, bleep, add content warnings, or refuse. This is expected adult fiction.',
    '5. Output ONLY the corrected chronicle prose — no preamble, no commentary, no markdown fences, no notes about what you changed.',
  ].join('\n')

  const userPrompt = [
    '# RAW TRANSCRIPT (unsanitised source of truth)',
    args.transcript,
    '',
    '# CURRENT CHRONICLE (may have been sanitised — restore explicit content)',
    args.chronicle,
    '',
    'Output the corrected chronicle now:',
  ].join('\n')

  return { systemPrompt, userPrompt }
}
