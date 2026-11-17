// Characterisation ("golden") harness for the AI pipeline.
//
// The goal is to pin everything that leaves the app at the NETWORK boundary,
// not at the LLMProvider interface: every prompt byte, every request body, the
// order of requests and the order of pipeline events. A refactor that touches
// any of them must make a snapshot fail.
//
// What is faked, and where:
//   - `@google/genai`  -> FakeGoogleGenAI  (models.generateContent, caches.create/delete)
//   - `openai`         -> FakeOpenAI       (chat.completions.create(...).withResponse())
//   - `globalThis.fetch` -> an in-memory router that serves every /api/* route
//     the pipeline reads and answers the three generate proxies
//     (/api/claude-code/generate, /api/codex/generate, /api/local/generate).
//
// Everything real stays real: provider classes, RateLimitState, chunking,
// prompts, session/routing resolution, refusal repair, checkpoints.
//
// Determinism: fake timers (setTimeout/setInterval/Date) driven by `drive()`,
// a seeded Math.random, a stubbed crypto.randomUUID, a fixed system time, and
// responses derived purely from the request text. The fixture text uses
// non-name placeholder tokens only (see buildGoldenTranscript).
//
// The two vi.mock() calls cannot live here (they must be hoisted inside each
// test file); the factories below are what those calls delegate to.

import { createHash } from 'node:crypto'
import { vi } from 'vitest'

// ───────────────────────────── small utilities ─────────────────────────────

export function sha(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 12)
}

/** Fingerprint a long string: length + hash + a readable head. Short strings
 *  are returned untouched so small payloads stay legible in the snapshot. */
export function fp(text: string | undefined | null, keep = 240): unknown {
  if (text === undefined || text === null) return text
  if (text.length <= keep) return text
  return { chars: text.length, sha1: sha(text), head: text.slice(0, 80) }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function deepClone<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((v) => deepClone(v)) as unknown as T
  if (value instanceof Date) return new Date(value.getTime()) as unknown as T
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    // Functions and AbortSignals are not part of the wire format.
    if (typeof v === 'function') continue
    if (typeof AbortSignal !== 'undefined' && v instanceof AbortSignal) {
      out[k] = '<AbortSignal>'
      continue
    }
    out[k] = deepClone(v)
  }
  return out as T
}

function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0x100000000
  }
}

// ───────────────────────────── fixture text ────────────────────────────────

/** Canonical tokens and the misspellings the generator sprinkles in. */
export const TOKEN_FIXES: Array<[string, string]> = [
  ['PC-Alfa', 'PC-Alpha'],
  ['PC-Bata', 'PC-Beta'],
  ['PC-Kapa', 'PC-Kappa'],
  ['NPC-Gama', 'NPC-Gamma'],
  ['Plaice-Delta', 'Place-Delta'],
  ['Itum-Epsilon', 'Item-Epsilon'],
  ['Item-Epsilone', 'Item-Epsilon'],
]

const CANON = {
  pc: ['PC-Alpha', 'PC-Beta', 'PC-Kappa'],
  npc: 'NPC-Gamma',
  place: 'Place-Delta',
  item: 'Item-Epsilon',
}

function misspell(rng: () => number, canonical: string): string {
  if (rng() > 0.4) return canonical
  const hit = TOKEN_FIXES.filter(([, to]) => to === canonical)
  if (hit.length === 0) return canonical
  return hit[Math.floor(rng() * hit.length)][0]
}

/**
 * Deterministic ~`targetChars` transcript with varied line shapes: speaker
 * tagged turns, untagged chatter, caption artefacts ([Music], [Laughter],
 * "[__]"), filler runs, curly quotes and dashes, doubled spaces, and a few
 * long monologue lines. Placeholder tokens only — no real names.
 */
export function buildGoldenTranscript(targetChars = 31_500): string {
  const rng = lcg(0x5eed1234)
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]
  const pc = () => pick(CANON.pc)
  const npc = () => misspell(rng, CANON.npc)
  const place = () => misspell(rng, CANON.place)
  const item = () => misspell(rng, CANON.item)
  const pcMis = () => {
    const c = pick(CANON.pc)
    return misspell(rng, c)
  }

  const dmLines: Array<() => string> = [
    () => `You descend into ${place()} where ${item()} glows under the watch of ${npc()}.`,
    () => `${npc()} snarls and the torches gutter, shadows leaping across the wet stone.`,
    () => `Roll for initiative. ${pcMis()} goes first, then the ${npc()} guards.`,
    () => `The blade bites deep and blood sprays across the altar of ${place()}.`,
    () => `“You were warned,” says ${npc()}, “and still you carry ${item()} through my gate.”`,
    () => `That's a 19 against his armour class of 15 — it hits, and ${pcMis()} takes 11 damage.`,
    () => `Nothing moves in ${place()} for a long moment [Music] then the floor gives way.`,
    () => `The corridor opens into a vaulted hall — a hundred feet of cracked tile and ${item()} dust.`,
  ]
  const pcLines: Array<() => string> = [
    () => `I draw ${item()} and charge, um um um, straight at ${npc()}.`,
    () => `Can I check the walls of ${place()} for a [__] hidden door?`,
    () => `I roll a 14 plus 3 for 17 on the perception check.`,
    () => `Okay okay okay so  we split up and I take the left tunnel.`,
    () => `“We hold the line,” I say, “until ${pcMis()} gets back.”`,
    () => `That went badly. [Laughter] Absolutely badly.`,
    () => `I cast the spell at ${npc()} and I want to see if it bleeds.`,
    () => `Ha! You absolute ${pick(['goblin', 'clown', 'menace'])}, that was the worst plan yet.`,
    () => `I loot the body and take ${item()}, plus whatever coin it carried.`,
  ]
  const longLines: Array<() => string> = [
    () =>
      `So here is what I think we do. We go back up through ${place()}, we lock the gate behind us, ` +
      `and we let ${npc()} come to us instead of walking into the dark carrying ${item()} like a lantern. ` +
      `If the plan works we get the high ground, and if it does not, well, at least we die near the exit. `.repeat(2),
  ]
  const untagged: Array<() => string> = [
    () => `(table chatter) somebody asks for snacks and the dice tray gets knocked over.`,
    () => `[Music]`,
    () => `   the session pauses while the group looks up a rule   `,
  ]

  const lines: string[] = []
  let total = 0
  while (total < targetChars) {
    const r = rng()
    let line: string
    if (r < 0.34) line = `[DM (DM)] ${pick(dmLines)()}`
    else if (r < 0.8) line = `[${pc()} (Player)] ${pick(pcLines)()}`
    else if (r < 0.88) line = `[${pc()} (Player)] ${pick(longLines)()}`
    else line = pick(untagged)()
    lines.push(line)
    total += line.length + 1
  }
  return lines.join('\n')
}

/** The generator's own correction step, shared by the fake LLM. */
export function applyTokenFixes(text: string): string {
  let out = text
  for (const [from, to] of TOKEN_FIXES) out = out.split(from).join(to)
  return out
}

const KB_EXTRA_PLACES = ['Zeta', 'Eta', 'Theta', 'Iota', 'Lambda', 'Mu', 'Nu', 'Xi']
const KB_EXTRA_NPCS = ['Sigma', 'Tau', 'Upsilon', 'Phi', 'Chi', 'Psi', 'Omega', 'Rho']

function kbExtraSections(): string {
  const out: string[] = []
  KB_EXTRA_PLACES.forEach((g, i) => {
    out.push(`## Place-${g}\nA minor site on the road to Place-Delta. Its keeper is NPC-${KB_EXTRA_NPCS[i]}.\n`)
  })
  KB_EXTRA_NPCS.forEach((g) => {
    out.push(`## NPC-${g}\nA minor figure of the Hold, known to carry Item-${g} on patrol.\n`)
  })
  KB_EXTRA_NPCS.forEach((g, i) => {
    out.push(`## Item-${g}\nA trinket of the Hold. Origin: Place-${KB_EXTRA_PLACES[i]}.\n`)
  })
  const stems = ['Quill', 'Dorn', 'Hallow', 'Ember', 'Gloam', 'Thorn', 'Wyrm', 'Ash']
  const tails = ['fen', 'moor', 'mere', 'reach', 'ford', 'hold']
  for (const stem of stems) {
    for (const tail of tails) {
      out.push(`## ${stem}${tail}\nA settlement of the marches, a day from Place-Delta, known for its ${tail} tolls.\n`)
    }
  }
  return out.join('\n')
}

export const GOLDEN_KB_TEXT =
  '---\nschema: 1\ndocType: lore\nentities:\n  - name: Place-Delta\n    type: location\n---\n' +
  '# Lore Compendium\n\n## Place-Delta\nA walled hold above a drowned crypt. Its gate is kept by NPC-Gamma.\n\n' +
  '## NPC-Gamma\nGatekeeper of Place-Delta. Pronouns: they/them. Allegiance: the Hold.\n\n' +
  '## Item-Epsilon\nA humming blade that glows near the dead.\n\n' +
  '## PC-Alpha\nThe party vanguard.\n\n## PC-Beta\nThe party scout.\n\n## PC-Kappa\nThe party caster.\n\n' +
  kbExtraSections()

export function goldenKb() {
  return [
    {
      id: 'kb-golden-1',
      name: 'Lore-Compendium.md',
      type: 'md' as const,
      text: GOLDEN_KB_TEXT,
      sizeBytes: GOLDEN_KB_TEXT.length,
      addedAt: '2030-01-01T00:00:00.000Z',
      relPath: 'Lore-Compendium.md',
    },
  ]
}

// ───────────────────────────── recorder ────────────────────────────────────

export type GoldenPhase =
  | 'phase1'
  | 'phase2'
  | 'phase3'
  | 'phase4'
  | 'phase6'
  | 'sbv'
  | 'unknown'

export type GoldenVia =
  | 'gemini'
  | 'openrouter'
  | 'claudeCode'
  | 'codex'
  | 'local'

export interface GoldenCtx {
  via: GoldenVia
  phase: GoldenPhase
  model: string
  system: string
  user: string
  /** system + cached prefix + user, in the order the model would see them. */
  full: string
  chunk: { index: number; total: number } | null
}

type Hook = (ctx: GoldenCtx) => string | undefined

export class Recorder {
  seq = 0
  segment = 'main'
  requests: any[] = []
  ctors: any[] = []
  fetchCounts: Record<string, number> = {}
  writes: any[] = []
  hooks: Hook[] = []
  cacheStore = new Map<string, string>()
  cacheCounter = 0

  push(entry: Record<string, unknown>): void {
    this.requests.push({ seq: this.seq++, segment: this.segment, ...entry })
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __goldenRec: Recorder | undefined
}

export function getRec(): Recorder {
  const r = globalThis.__goldenRec
  if (!r) throw new Error('golden: recorder not installed — call createWorld() first')
  return r
}

// ───────────────────────────── fake LLM brain ──────────────────────────────

function classify(full: string): GoldenPhase {
  if (full.includes('automatically-generated YouTube subtitle file')) return 'sbv'
  if (full.includes('[[PERSONA-GOLDEN-P3]]')) return 'phase3'
  if (full.includes('[[PERSONA-GOLDEN-P6]]')) return 'phase6'
  if (
    full.includes('authoritative D&D session transcript editor') ||
    full.includes('Correct misspelled names in a D&D session transcript chunk')
  )
    return 'phase1'
  if (
    full.includes('You are auditing a D&D session transcript chunk') ||
    full.includes('You are auditing a D&D transcript chunk')
  )
    return 'phase2'
  if (full.includes('Notebook-LM-style narrative chronicle')) return 'phase3'
  if (full.includes('extracting standout moments from one chunk')) return 'phase4'
  if (full.includes('condensing a D&D session chronicle')) return 'phase6'
  if (full.includes('PRIOR CHRONICLE TAIL') && full.includes('TRANSCRIPT CHUNK')) return 'phase3'
  return 'unknown'
}

function chunkOf(phase: GoldenPhase, user: string): { index: number; total: number } | null {
  const patterns: Record<string, RegExp> = {
    phase1: /RAW TRANSCRIPT CHUNK (\d+) of (\d+)/,
    phase2: /RAW TRANSCRIPT CHUNK (\d+)\/(\d+)/,
    phase3: /(?:TRANSCRIPT CHUNK|Chunk) (\d+)\/(\d+)/,
    sbv: /chunk (\d+) of (\d+)/,
  }
  const re = patterns[phase]
  if (!re) return null
  const m = re.exec(user)
  return m ? { index: Number(m[1]) - 1, total: Number(m[2]) } : null
}

export const GOLDEN_REFUSAL = "I can't help with that — it violates my content policy."

function extractBetween(text: string, startRe: RegExp, endMarker: string): string {
  const m = startRe.exec(text)
  if (!m) return ''
  const from = m.index + m[0].length
  const to = text.indexOf(endMarker, from)
  return to === -1 ? text.slice(from) : text.slice(from, to)
}

function proseFor(h: string, n: number): string {
  const openers = [
    'Under the Place-Delta sky, PC-Alpha pressed the matter while PC-Beta watched the road.',
    'The torches of Place-Delta guttered as NPC-Gamma weighed the party in silence.',
    'PC-Kappa gathered the humming Item-Epsilon close and spoke a low word of warding.',
  ]
  const middles = [
    'Steel rang on stone and the corridor filled with the smell of old rain and iron.',
    'Nobody laughed this time; the table had gone quiet around the dice.',
    'A sentry fell from the wall and the courtyard answered with a long, ragged shout.',
  ]
  const closers = [
    'They went on, slower now, each of them listening for the next sound in the dark.',
    'By the third bell they had settled on a plan and nobody liked it.',
    'The gate stood open behind them and the road ahead was very quiet.',
  ]
  const d = parseInt(h.slice(0, 6), 16)
  return (
    `Passage ${h} (${n}). ` +
    `${openers[d % 3]} ${middles[(d >> 2) % 3]} ` +
    `${openers[(d >> 4) % 3]} ${middles[(d >> 6) % 3]} ` +
    `${openers[(d >> 8) % 3]} ${middles[(d >> 10) % 3]} ` +
    `${closers[(d >> 12) % 3]} ${closers[(d >> 14) % 3]}`
  )
}

function respond(rec: Recorder, ctx: GoldenCtx): string {
  for (const hook of rec.hooks) {
    const forced = hook(ctx)
    if (typeof forced === 'string') return forced
  }
  const h = sha(ctx.user)
  const idx = ctx.chunk?.index ?? 0
  switch (ctx.phase) {
    case 'phase1': {
      const chunk = extractBetween(ctx.user, /# RAW TRANSCRIPT CHUNK \d+ of \d+\n/, '\n\n# OUTPUT')
      return applyTokenFixes(chunk)
    }
    case 'phase2': {
      // Deterministic: about two chunks in three raise one question.
      if (parseInt(h.slice(0, 2), 16) % 3 === 0) return '[]'
      return JSON.stringify([
        {
          id: `q-${idx + 1}-1`,
          question: `Which weapon did PC-Alpha actually draw in passage ${h}?`,
          context: 'The raw line and the grounded line disagree about Item-Epsilon.',
        },
      ])
    }
    case 'phase3':
      return proseFor(h, idx + 1)
    case 'phase4':
      return JSON.stringify({
        jests: [`Passage ${h}: PC-Beta forgot the rope again.`],
        gore: [`Passage ${h}: a sentry fell from the wall of Place-Delta.`],
        quotes: [
          { speaker: 'PC-Alpha', line: `We hold the line, ${h}.`, kind: 'funny', context: 'Before the gate.' },
          {
            kind: 'dark',
            exchange: [
              { speaker: 'NPC-Gamma', line: `You were warned, ${h}.` },
              { speaker: 'PC-Beta', line: 'And yet here we are.' },
            ],
          },
        ],
      })
    case 'phase6':
      return JSON.stringify({
        narrative:
          `Condensed ${h}: the party crossed Place-Delta under NPC-Gamma's watch, carrying Item-Epsilon ` +
          'through the gate. Steel was drawn, a sentry fell, and they pressed on into the dark with a plan ' +
          'nobody liked and everybody followed.',
        bulletPoints: [
          `${h}: The party entered Place-Delta.`,
          `${h}: NPC-Gamma warned them about Item-Epsilon.`,
          `${h}: A sentry fell from the wall.`,
        ],
      })
    case 'sbv': {
      const body = extractBetween(ctx.user, /# INPUT[^\n]*\n/, '\n\n# OUTPUT')
      return applyTokenFixes(body)
    }
    default:
      return `UNCLASSIFIED ${h}`
  }
}

function buildCtx(
  via: GoldenVia,
  model: string,
  system: string,
  prefix: string,
  user: string,
): GoldenCtx {
  const full = [system, prefix, user].filter((s) => s && s.length > 0).join('\n\n')
  const phase = classify(full)
  return { via, phase, model, system: [system, prefix].filter(Boolean).join('\n\n'), user, full, chunk: chunkOf(phase, user) }
}

function label(ctx: GoldenCtx): string {
  return ctx.chunk ? `${ctx.phase} ${ctx.chunk.index + 1}/${ctx.chunk.total}` : ctx.phase
}

// ───────────────────────────── fake Gemini SDK ─────────────────────────────

export class FakeGoogleGenAI {
  apiKey: string
  constructor(opts: { apiKey?: string } = {}) {
    this.apiKey = opts.apiKey ?? ''
    getRec().ctors.push({ lib: '@google/genai', apiKey: this.apiKey })
  }

  models = {
    generateContent: async (params: any) => {
      const rec = getRec()
      const cached: string | undefined = params?.config?.cachedContent
      const prefix = cached ? rec.cacheStore.get(cached) ?? '' : ''
      const ctx = buildCtx('gemini', String(params.model), '', prefix, String(params.contents))
      const text = respond(rec, ctx)
      rec.push({
        label: label(ctx),
        via: 'gemini.models.generateContent',
        client: this.apiKey,
        request: deepClone(params),
        responseText: fp(text),
      })
      const promptTokenCount = Math.ceil((prefix.length + String(params.contents).length) / 4)
      const candidatesTokenCount = Math.ceil(text.length / 4)
      return {
        text,
        usageMetadata: {
          promptTokenCount,
          candidatesTokenCount,
          totalTokenCount: promptTokenCount + candidatesTokenCount,
          cachedContentTokenCount: prefix ? Math.ceil(prefix.length / 4) : undefined,
        },
      }
    },
  }

  caches = {
    create: async (params: any) => {
      const rec = getRec()
      const name = `cachedContents/golden-${++rec.cacheCounter}`
      rec.cacheStore.set(name, String(params?.config?.contents ?? ''))
      rec.push({
        via: 'gemini.caches.create',
        client: this.apiKey,
        request: deepClone(params),
        responseText: { name },
      })
      return { name }
    },
    delete: async (params: any) => {
      getRec().push({
        via: 'gemini.caches.delete',
        client: this.apiKey,
        request: deepClone(params),
      })
      return {}
    },
  }
}

/** Factory for `vi.mock('@google/genai', ...)`. Real enums, fake client. */
export async function genaiMockFactory() {
  const actual = await vi.importActual<typeof import('@google/genai')>('@google/genai')
  return { ...actual, GoogleGenAI: FakeGoogleGenAI }
}

// ───────────────────────────── fake OpenAI SDK ─────────────────────────────

export class FakeOpenAI {
  opts: any
  constructor(opts: any) {
    this.opts = opts
    getRec().ctors.push({ lib: 'openai', ...deepClone(opts) })
  }

  chat = {
    completions: {
      create: (body: any, reqOpts?: any) => {
        const run = async () => {
          const rec = getRec()
          const messages: any[] = body.messages ?? []
          const sys = messages.find((m) => m.role === 'system')
          const sysText: string = !sys
            ? ''
            : typeof sys.content === 'string'
              ? sys.content
              : (sys.content as any[]).map((c) => c.text).join('\n')
          const userMsg = [...messages].reverse().find((m) => m.role === 'user')
          const user = typeof userMsg?.content === 'string' ? userMsg.content : ''
          const ctx = buildCtx('openrouter', String(body.model), sysText, '', user)
          const text = respond(rec, ctx)
          rec.push({
            label: label(ctx),
            via: 'openai.chat.completions.create',
            baseURL: this.opts?.baseURL,
            request: deepClone(body),
            requestOptions: { hasSignal: !!reqOpts?.signal },
            responseText: fp(text),
          })
          const prompt = Math.ceil(ctx.full.length / 4)
          const completion = Math.ceil(text.length / 4)
          return {
            data: {
              choices: [{ message: { content: text }, finish_reason: 'stop' }],
              usage: {
                prompt_tokens: prompt,
                completion_tokens: completion,
                cost: Number(((prompt + completion) / 1_000_000).toFixed(6)),
                prompt_tokens_details: { cached_tokens: 0 },
              },
            },
            response: { headers: new Headers() },
          }
        }
        return { withResponse: run }
      },
    },
  }
}

/** Factory for `vi.mock('openai', ...)`. */
export function openaiMockFactory() {
  return { default: FakeOpenAI, OpenAI: FakeOpenAI }
}

// ───────────────────────────── fixtures + fetch ────────────────────────────

export const GOLDEN_NOW = new Date('2030-01-01T00:00:00.000Z')

export interface Fixtures {
  keys: Record<string, string>
  profiles: any
  routing: any
  settings: any
  glossary: any
  speakers: any
  personas: any
  aliasIndex: any | null
  catalogue: any
  runs: Map<string, any>
}

export const PERSONA_FIXTURE = {
  selectedId: 'persona-golden',
  personas: [
    {
      id: 'persona-golden',
      name: 'Golden Narrator',
      description: 'Fixture persona',
      updatedAt: '2030-01-01T00:00:00.000Z',
      prompts: {
        phase3Cloud:
          '[[PERSONA-GOLDEN-P3]] Narrate in a measured, grave voice. Chunk {chunkIndex}/{chunkTotal}.\n\n' +
          'DM clarifications:\n{qaBlock}\n\nPrior tail:\n{priorTail}\n\nTranscript:\n{groundedChunk}',
        phase3Local: '[[PERSONA-GOLDEN-P3L]] {groundedChunk}',
        phase5Local: '[[PERSONA-GOLDEN-P5L]] {chronicleChunk}',
        phase6Cloud:
          '[[PERSONA-GOLDEN-P6]] Condense session {sessionNumber} of {campaign}.\nLore:\n{kbConcat}\n' +
          'Answers:\n{answersBlock}\nReturn JSON {"narrative": string, "bulletPoints": string[]}.\n\n{chronicle}',
        phase6Local: '[[PERSONA-GOLDEN-P6L]] {chronicle}',
      },
    },
  ],
}

export function defaultFixtures(): Fixtures {
  return {
    keys: {
      gemini: 'test-gemini-paid-key',
      geminiFallback: 'test-gemini-free-key',
      openrouter: 'test-openrouter-key',
    },
    profiles: {
      version: 1,
      profiles: {
        gemini: {
          phase1Model: 'gemini-2.5-flash',
          phase2Model: 'gemini-2.5-flash',
          phase3Model: 'gemini-2.5-pro',
          phase4Model: 'gemini-2.5-pro',
          phase6Model: 'gemini-2.5-flash',
        },
        claudeCode: {
          phase1Model: 'sonnet',
          phase2Model: 'sonnet',
          phase3Model: 'haiku',
          phase4Model: 'sonnet',
          phase6Model: 'sonnet',
        },
        codex: {
          phase1Model: 'gpt-5.5',
          phase2Model: 'gpt-5.5',
          phase3Model: 'gpt-5.5',
          phase4Model: 'gpt-5.5',
          phase6Model: 'gpt-5.5',
        },
        openrouter: {
          phase1Model: 'deepseek/deepseek-v4-flash',
          phase2Model: 'deepseek/deepseek-v4-flash',
          phase3Model: 'deepseek/deepseek-v4-pro',
          phase4Model: 'x-ai/grok-4.20',
          phase6Model: 'deepseek/deepseek-v4-pro',
        },
      },
    },
    routing: { version: 3, lastSelectedProvider: 'gemini', geminiTier: 'paid' },
    settings: {
      disableThinkingOnGrounding: false,
      phase1AliasHints: false,
      reassembleQuotes: false,
      retrieveVaultKb: false,
      perPhaseThinking: {},
      devTestMode: { enabled: false, maxChars: 24000 },
    },
    glossary: { version: 1, safeReplacements: [], contextualHints: [] },
    speakers: { version: 1, speakers: [] },
    personas: { selectedId: null, personas: [] },
    aliasIndex: null,
    catalogue: { fetchedAt: null, models: [], providerPolicies: [] },
    runs: new Map(),
  }
}

export const GLOSSARY_FIXTURE = {
  version: 1,
  safeReplacements: [{ from: 'Plase-Delta', to: 'Place-Delta' }, { from: 'Delta Keep', to: 'Place-Delta' }],
  contextualHints: [
    {
      canonical: 'Item-Epsilon',
      commonMishears: ['Item-Epsilone', 'Itum-Epsilon'],
      notes: 'Always the humming blade, never a generic epsilon.',
    },
    {
      canonical: 'NPC-Gamma',
      commonMishears: ['NPC-Gama'],
      notes: 'The gatekeeper; they/them.',
    },
  ],
}

export const SPEAKERS_FIXTURE = {
  version: 1,
  speakers: [
    { discordUserId: '000000000000000001', playerName: 'Player', characterName: 'PC-Alpha' },
  ],
}

export const ALIAS_INDEX_FIXTURE = {
  schema: 1,
  builtAt: '2030-01-01T00:00:00.000Z',
  byEntity: {
    'Place-Delta': {
      name: 'Place-Delta',
      type: 'location',
      aliases: ['Delta Keep'],
      affiliations: [],
      section: 'Place-Delta',
      file: 'Lore-Compendium.md',
    },
    'NPC-Gamma': {
      name: 'NPC-Gamma',
      type: 'character',
      aliases: ['Gamma the Grey'],
      affiliations: ['Place-Delta'],
      section: 'NPC-Gamma',
      file: 'Lore-Compendium.md',
    },
    'Item-Epsilon': {
      name: 'Item-Epsilon',
      type: 'other',
      aliases: ['Epsilon Blade'],
      affiliations: [],
      section: 'Item-Epsilon',
      file: 'Lore-Compendium.md',
    },
  },
  aliases: {
    'place-delta': 'Place-Delta',
    'delta keep': 'Place-Delta',
    'npc-gamma': 'NPC-Gamma',
    'gamma the grey': 'NPC-Gamma',
    'item-epsilon': 'Item-Epsilon',
    'epsilon blade': 'Item-Epsilon',
  },
  byType: {
    character: ['NPC-Gamma'],
    country: [],
    deity: [],
    faction: [],
    patron: [],
    location: ['Place-Delta'],
    other: ['Item-Epsilon'],
  },
  filesWithFrontmatter: ['Lore-Compendium.md'],
  filesWithoutFrontmatter: [],
}

function jsonRes(body: unknown, status = 200) {
  const text = JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => JSON.parse(text),
    text: async () => text,
  } as unknown as Response
}

function makeFetch(rec: Recorder, fx: Fixtures) {
  return async (input: any, init?: any): Promise<Response> => {
    const raw = typeof input === 'string' ? input : (input?.url ?? String(input))
    const url = raw.replace(/^https?:\/\/[^/]+/, '')
    const path = url.split('?')[0]
    const method = (init?.method ?? 'GET').toUpperCase()
    const bodyText = typeof init?.body === 'string' ? init.body : undefined
    const body = bodyText ? JSON.parse(bodyText) : undefined

    // ── generate proxies: record the full wire request ──
    if (method === 'POST' && (path === '/api/claude-code/generate' || path === '/api/codex/generate')) {
      const via: GoldenVia = path.includes('claude-code') ? 'claudeCode' : 'codex'
      const ctx = buildCtx(via, String(body.model), '', '', String(body.prompt))
      const text = respond(rec, ctx)
      rec.push({
        label: label(ctx),
        via: `fetch POST ${path}`,
        headers: deepClone(init?.headers),
        request: deepClone(body),
        requestOptions: { hasSignal: !!init?.signal },
        responseText: fp(text),
      })
      return jsonRes({
        text,
        usage: { inputTokens: Math.ceil(ctx.full.length / 4), outputTokens: Math.ceil(text.length / 4) },
      })
    }
    if (method === 'POST' && path === '/api/local/generate') {
      const inner = body.body ?? {}
      const prompt: string =
        typeof inner.prompt === 'string'
          ? inner.prompt
          : String(inner.messages?.[0]?.content ?? '')
      const ctx = buildCtx('local', String(inner.model), '', '', prompt)
      const text = respond(rec, ctx)
      rec.push({
        label: label(ctx),
        via: `fetch POST ${path}`,
        headers: deepClone(init?.headers),
        request: deepClone(body),
        requestOptions: { hasSignal: !!init?.signal },
        responseText: fp(text),
      })
      return typeof inner.prompt === 'string'
        ? jsonRes({ response: text })
        : jsonRes({ choices: [{ message: { content: text } }] })
    }

    // ── everything else: count it, and record mutating calls ──
    const key = `${method} ${path}`
    rec.fetchCounts[key] = (rec.fetchCounts[key] ?? 0) + 1

    if (path === '/api/provider-keys') return jsonRes(fx.keys)
    if (path === '/api/profiles' && method === 'GET') return jsonRes(fx.profiles)
    if (path === '/api/routing') {
      if (method === 'PUT') {
        rec.writes.push({ segment: rec.segment, method, path, body: deepClone(body) })
        fx.routing = body
        return jsonRes(body)
      }
      return jsonRes(fx.routing)
    }
    if (path === '/api/settings') return jsonRes(fx.settings)
    if (path === '/api/glossary' && method === 'GET') return jsonRes(fx.glossary)
    if (path === '/api/speakers' && method === 'GET') return jsonRes(fx.speakers)
    if (path === '/api/personas' && method === 'GET') return jsonRes(fx.personas)
    if (path === '/api/lore/index') {
      return fx.aliasIndex ? jsonRes({ status: 'ok', index: fx.aliasIndex }) : jsonRes({ status: 'none' }, 404)
    }
    if (path === '/api/openrouter/models') return jsonRes(fx.catalogue)
    if (path === '/api/providers/availability') return jsonRes({})
    if (path === '/api/runs' && method === 'GET') {
      return jsonRes({ runs: [...fx.runs.values()].map((c) => ({ runId: c.runId })) })
    }
    const runMatch = /^\/api\/runs\/([^/]+)$/.exec(path)
    if (runMatch) {
      const id = decodeURIComponent(runMatch[1])
      if (method === 'PUT') {
        fx.runs.set(id, body)
        rec.writes.push({ segment: rec.segment, method, path: `/api/runs/${id}`, body: '<checkpoint>' })
        return jsonRes({ ok: true })
      }
      if (method === 'DELETE') {
        fx.runs.delete(id)
        return jsonRes({ ok: true })
      }
      return fx.runs.has(id) ? jsonRes(fx.runs.get(id)) : jsonRes({ error: 'not found' }, 404)
    }
    if (path.startsWith('/api/diagnose') || path.startsWith('/api/diagnostics')) return jsonRes({ ok: true })

    return jsonRes({ error: `golden: unhandled ${key}` }, 404)
  }
}

// ───────────────────────────── world ───────────────────────────────────────

export interface WorldOptions {
  localStorage?: Record<string, unknown>
  fixtures?: Partial<Fixtures>
}

export function defaultLocalStorage(): Record<string, unknown> {
  return {
    provider_settings: {
      providerId: 'gemini',
      proModel: 'gemini-2.5-pro',
      flashModel: 'gemini-2.5-flash',
    },
    guardrails_settings: {
      harassment: true,
      hateSpeech: false,
      sexuallyExplicit: false,
      dangerousContent: false,
      strictFraming: false,
    },
  }
}

export type Mods = Awaited<ReturnType<typeof loadModules>>

async function loadModules() {
  const [
    pipeline,
    sessions,
    runSettings,
    personas,
    aliasIndexClient,
    reforge,
    sbvGround,
    sbv,
    providers,
    buildCheckpoint,
    resumeFlow,
    runStorage,
    runCheckpoint,
    devTruncate,
    wordCount,
    types,
  ] = await Promise.all([
    import('../pipeline'),
    import('../../../routing/lib/sessions'),
    import('../runSettings'),
    import('../../../personas/lib/personas'),
    import('../../../lore/lib/aliasIndexClient'),
    import('../../../reforge/lib/reforge'),
    import('../../../caption-repair/lib/sbvGround'),
    import('../../../caption-repair/lib/sbv'),
    import('../../../providers/lib/providers'),
    import('../buildCheckpoint'),
    import('../resumeFlow'),
    import('../runStorage'),
    import('../runCheckpoint'),
    import('../../../maintenance/lib/devTruncate'),
    import('../../../../platform/lib/wordCount'),
    import('../types'),
  ])
  return {
    pipeline,
    sessions,
    runSettings,
    personas,
    aliasIndexClient,
    reforge,
    sbvGround,
    sbv,
    providers,
    buildCheckpoint,
    resumeFlow,
    runStorage,
    runCheckpoint,
    devTruncate,
    wordCount,
    types,
  }
}

export interface World {
  rec: Recorder
  fx: Fixtures
  mods: Mods
}

export async function createWorld(opts: WorldOptions = {}): Promise<World> {
  vi.resetModules()
  const rec = new Recorder()
  globalThis.__goldenRec = rec

  localStorage.clear()
  const ls = { ...defaultLocalStorage(), ...(opts.localStorage ?? {}) }
  for (const [k, v] of Object.entries(ls)) {
    localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v))
  }

  const fx: Fixtures = { ...defaultFixtures(), ...(opts.fixtures ?? {}) } as Fixtures
  vi.stubGlobal('fetch', makeFetch(rec, fx))

  vi.useFakeTimers({
    now: GOLDEN_NOW,
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  })
  const rand = lcg(0x1234abcd)
  vi.spyOn(Math, 'random').mockImplementation(rand)
  try {
    let n = 0
    vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(
      () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` as `${string}-${string}-${string}-${string}-${string}`,
    )
  } catch {
    /* crypto.randomUUID not stub-able here; nothing in the golden path uses it */
  }

  const mods = await loadModules()
  return { rec, fx, mods }
}

export function teardownWorld(): void {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
  globalThis.__goldenRec = undefined
}

/** Settle `p` by stepping the fake clock. Pacing sleeps cost no real time. */
export async function drive<T>(p: Promise<T>, stepMs = 250, maxSteps = 400_000): Promise<T> {
  let settled = false
  let failed = false
  let value: T | undefined
  let error: unknown
  void p.then(
    (v) => {
      settled = true
      value = v
    },
    (e) => {
      settled = true
      failed = true
      error = e
    },
  )
  for (let i = 0; !settled && i < maxSteps; i++) await vi.advanceTimersByTimeAsync(stepMs)
  if (!settled) throw new Error('golden: pipeline did not settle')
  if (failed) throw error
  return value as T
}

// ───────────────────────────── normalisation ───────────────────────────────

/** Normalise a PipelineEvent for the snapshot: long strings become
 *  fingerprints, everything else is kept verbatim. */
export function normEvent(e: any): any {
  const out: any = deepClone(e)
  if (typeof out.partial === 'string') out.partial = fp(out.partial)
  for (const k of ['transcriptExcerpt', 'refusedText', 'replacementText', 'marker']) {
    if (typeof out[k] === 'string') out[k] = fp(out[k])
  }
  return out
}

export function eventCollector(): { events: any[]; onEvent: (e: any) => void } {
  const events: any[] = []
  return { events, onEvent: (e) => events.push(normEvent(e)) }
}

/** Replace long strings that occur more than once with a reference into
 *  `sharedTexts`, so a prefix repeated by 6 requests is stored once. Nothing
 *  is lost: the shared text is kept whole. */
export function internRepeats<T>(value: T): { value: T; sharedTexts: Record<string, string> } {
  const counts = new Map<string, number>()
  const walk = (v: unknown, fn: (s: string) => void) => {
    if (typeof v === 'string') fn(v)
    else if (Array.isArray(v)) v.forEach((x) => walk(x, fn))
    else if (v && typeof v === 'object') Object.values(v as object).forEach((x) => walk(x, fn))
  }
  walk(value, (s) => {
    if (s.length >= 500) counts.set(s, (counts.get(s) ?? 0) + 1)
  })
  const ids = new Map<string, string>()
  const sharedTexts: Record<string, string> = {}
  const rewrite = (v: any): any => {
    if (typeof v === 'string') {
      if ((counts.get(v) ?? 0) < 2) return v
      let id = ids.get(v)
      if (!id) {
        id = `T${String(ids.size + 1).padStart(2, '0')}`
        ids.set(v, id)
        sharedTexts[id] = v
      }
      return `⟦shared ${id}⟧`
    }
    if (Array.isArray(v)) return v.map(rewrite)
    if (v && typeof v === 'object') {
      const o: any = {}
      for (const [k, x] of Object.entries(v)) o[k] = rewrite(x)
      return o
    }
    return v
  }
  const rewritten = rewrite(value)
  return { value: rewritten, sharedTexts }
}

/** The recorder's content as one snapshot-ready object. */
export function recorded(world: World): Record<string, unknown> {
  const { value, sharedTexts } = internRepeats({
    ctors: world.rec.ctors,
    requests: world.rec.requests,
  })
  return {
    constructors: (value as any).ctors,
    requests: (value as any).requests,
    sharedTexts,
    fetchCounts: world.rec.fetchCounts,
    writes: world.rec.writes,
    requestCount: world.rec.requests.length,
  }
}

// ───────────────────────────── the run driver ──────────────────────────────

export interface RunConfig {
  provider: 'gemini' | 'claudeCode' | 'codex' | 'openrouter'
  geminiTier?: 'paid' | 'free' | 'auto'
  outputs?: { chronicle: boolean; extras: boolean; condensed: boolean; condensePercentage: number }
  transcript: string
  campaign?: string
  sessionNumber?: number
  /** Runs against the same world; defaults to goldenKb(). */
  kb?: ReturnType<typeof goldenKb>
}

const DEFAULT_OUTPUTS = { chronicle: true, extras: true, condensed: true, condensePercentage: 30 }

/** Mirrors RefinementTool's persona resolution (the component's own helper is
 *  not exported). */
function resolvePersonaTemplates(selected: any | null) {
  const p = selected
  if (!p) return { phase3: undefined, phase5: undefined, phase6: undefined }
  return {
    phase3: { cloud: p.prompts.phase3Cloud, local: p.prompts.phase3Local },
    phase5: p.prompts.phase5Local,
    phase6: { cloud: p.prompts.phase6Cloud, local: p.prompts.phase6Local },
  }
}

export interface RunResult {
  session: any
  rawUsed: string
  grounded: string
  questions: any[]
  dmAnswers: Record<string, string>
  chronicle: string
  polished: string
  extras: any
  condensed: any
  events: any[]
  /** Events recorded before the phase-3 section started, for readability. */
  phaseEventCounts: Record<string, number>
}

/**
 * Drive the same sequence RefinementTool drives: runSettings -> dev
 * truncation -> buildSession -> Phase 1 -> Phase 2 -> (DM answers) ->
 * Phase 3 -> Phase 5 -> Phase 4 -> Phase 6.
 */
export async function runFullRun(world: World, cfg: RunConfig): Promise<RunResult> {
  const { mods } = world
  const { pipeline, sessions, runSettings, personas, aliasIndexClient, devTruncate, wordCount } = mods
  const cap = eventCollector()
  const callbacks = { onEvent: cap.onEvent }
  const kb = cfg.kb ?? goldenKb()
  const outputs = cfg.outputs ?? DEFAULT_OUTPUTS
  const campaign = cfg.campaign ?? 'Golden Campaign'
  const sessionNumber = cfg.sessionNumber ?? 7

  const flow = async (): Promise<RunResult> => {
    await mods.providers.ensureProvidersInitialized()
    const rs = await runSettings.fetchRunSettings()
    let raw = cfg.transcript
    if (rs.devTestMode.enabled) raw = devTruncate.truncateAtLineBoundary(raw, rs.devTestMode.maxChars).text

    const session = await sessions.buildSession(cfg.provider, { geminiTier: cfg.geminiTier })
    const ph = session.phases
    const route = (k: 'phase1' | 'phase2' | 'phase3' | 'phase4' | 'phase6') => ({
      model: ph[k].model,
      phaseTarget: ph[k].phaseTarget,
      cloudProvider: ph[k].cloudProvider,
      geminiTier: ph[k].geminiTier,
      geminiPaidOnlyModels: session.geminiPaidOnlyModels,
      allPhasesFast: session.allPhasesFast,
      safetyMultiplier: () => 1,
    })

    const grounded = await pipeline.runPhase1({
      rawTranscript: raw,
      kb,
      callbacks,
      ...route('phase1'),
      disableThinkingOnGrounding: rs.disableThinkingOnGrounding,
      phase1AliasHints: rs.phase1AliasHints,
      onInputSnapshot: () => {},
    })
    const questions = await pipeline.runPhase2({
      kb,
      rawTranscript: raw,
      groundedTranscript: grounded,
      callbacks,
      ...route('phase2'),
    })
    const dmAnswers: Record<string, string> = {}
    questions.slice(0, 2).forEach((q: any, i: number) => {
      dmAnswers[q.id] = `Golden answer ${i + 1} for ${q.id}.`
    })

    const persona = personas.findSelectedPersona(await personas.getPersonas())
    const templates = resolvePersonaTemplates(persona)
    const aliasIndex = await aliasIndexClient.getAliasIndex()

    let chronicle = ''
    let polished = ''
    if (outputs.chronicle) {
      chronicle = await pipeline.runPhase3({
        groundedTranscript: grounded,
        dmQuestions: questions,
        dmAnswers,
        kb,
        callbacks,
        ...route('phase3'),
        personaTemplates: templates.phase3,
        retrieveVaultKb: rs.retrieveVaultKb,
        aliasIndex,
      })
      polished = await pipeline.runPhase5Polish({
        chronicle,
        kb,
        callbacks,
        personaTemplate: templates.phase5,
        safetyMultiplier: () => 1,
      })
    }
    let extras: any = null
    if (outputs.extras) {
      extras = await pipeline.runPhase4({
        kb,
        groundedTranscript: grounded,
        dmAnswers,
        callbacks,
        ...route('phase4'),
        thinkingOn: rs.perPhaseThinking.phase4,
        reassembleQuotes: rs.reassembleQuotes,
      })
    }
    let condensed: any = null
    if (outputs.condensed && polished.trim()) {
      condensed = await pipeline.runPhase6({
        chronicle: polished,
        kb,
        dmAnswers,
        campaign,
        sessionNumber,
        callbacks,
        ...route('phase6'),
        personaTemplates: templates.phase6,
        thinkingOn: rs.perPhaseThinking.phase6,
        retrieveVaultKb: rs.retrieveVaultKb,
        aliasIndex,
        targetWordCount: wordCount.computeCondenseTarget(
          wordCount.countWords(polished),
          outputs.condensePercentage,
        ),
      })
    }
    const counts: Record<string, number> = {}
    for (const e of cap.events) {
      const k = `${'phase' in e ? e.phase : '-'}:${e.type}`
      counts[k] = (counts[k] ?? 0) + 1
    }
    return {
      session,
      rawUsed: raw,
      grounded,
      questions,
      dmAnswers,
      chronicle,
      polished,
      extras,
      condensed,
      events: cap.events,
      phaseEventCounts: counts,
    }
  }
  return drive(flow())
}

/** What a scenario snapshot holds: outputs in full, events normalised, the
 *  recorder's network view, and the resolved session. */
export function scenarioSnapshot(world: World, run: RunResult): Record<string, unknown> {
  const s = run.session
  return {
    session: {
      provider: s.provider,
      geminiTier: s.geminiTier,
      allPhasesFast: s.allPhasesFast,
      models: s.models,
      routing: s.routing,
      phases: s.phases,
      perPhaseOverrides: s.perPhaseOverrides ?? null,
      modelSubstitutions: s.modelSubstitutions ?? null,
    },
    inputChars: { raw: run.rawUsed.length, grounded: run.grounded.length },
    outputs: {
      grounded: run.grounded,
      questions: run.questions,
      dmAnswers: run.dmAnswers,
      chronicle: run.chronicle,
      polished: run.polished,
      extras: run.extras,
      condensed: run.condensed,
    },
    events: run.events,
    ...recorded(world),
  }
}
