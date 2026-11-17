/** @vitest-environment jsdom */
//
// Golden characterisation tests — Reforge (scenario 7) and Caption Repair
// grounding (scenario 8). See src/features/pipeline/lib/__golden__/harness.ts.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GLOSSARY_FIXTURE,
  PERSONA_FIXTURE,
  applyTokenFixes,
  buildGoldenTranscript,
  createWorld,
  deepClone,
  drive,
  eventCollector,
  fp,
  goldenKb,
  recorded,
  sha,
  teardownWorld,
} from './__golden__/harness'

vi.mock('@google/genai', async () => (await import('./__golden__/harness')).genaiMockFactory())
vi.mock('openai', async () => (await import('./__golden__/harness')).openaiMockFactory())

const TRANSCRIPT = buildGoldenTranscript()

afterEach(() => teardownWorld())

/** A prior chronicle: ~7 KB of prose in the shape a finished run has. */
function buildPriorChronicle(): string {
  const paragraphs: string[] = []
  for (let i = 1; i <= 9; i++) {
    paragraphs.push(
      `Chapter beat ${i}. Under the Place-Delta sky, PC-Alpha pressed the matter while PC-Beta watched the road. ` +
        `"We hold the line," PC-Alpha said, and NPC-Gamma answered, "You were warned." ` +
        `PC-Kappa gathered Item-Epsilon close and spoke a low word of warding while steel rang on stone ` +
        `and the corridor filled with the smell of old rain and iron. They went on, slower now, listening ` +
        `for the next sound in the dark.`,
    )
  }
  return paragraphs.join('\n\n')
}

const PRIOR_CHRONICLE = buildPriorChronicle()
const GROUNDED = applyTokenFixes(TRANSCRIPT)
const DM_QUESTIONS = [
  { id: 'q-1-1', question: 'Which weapon did PC-Alpha draw?', context: 'Raw and grounded disagree.' },
  { id: 'q-2-1', question: 'Who spoke at the gate?', context: 'Two speakers overlap.' },
]
const DM_ANSWERS = { 'q-1-1': 'Item-Epsilon, drawn at the gate.' }

function persona() {
  return PERSONA_FIXTURE.personas[0].prompts
}

function normProgress(p: any): any {
  const o = deepClone(p)
  if (typeof o.chronicle === 'string') o.chronicle = fp(o.chronicle)
  if (o.inFlight && typeof o.inFlight.partial === 'string') o.inFlight.partial = fp(o.inFlight.partial)
  return o
}

describe('golden: Reforge', () => {
  it('7a. regenerate the chronicle on Gemini, with per-phase overrides (extras on OpenRouter, condense on Claude Code)', async () => {
    const world = await createWorld({
      fixtures: { glossary: GLOSSARY_FIXTURE },
    })
    const cap = eventCollector()
    const progress: any[] = []
    const { reforge } = world.mods
    const input = {
      chronicle: PRIOR_CHRONICLE,
      groundedTranscript: GROUNDED,
      dmQuestions: DM_QUESTIONS,
      dmAnswers: DM_ANSWERS,
      kb: goldenKb(),
      retrieveVaultKb: true,
      aliasIndex: null,
      campaign: 'Golden Campaign',
      sessionNumber: 7,
    }
    const config = {
      regenerateChronicle: true,
      doExtras: true,
      doCondense: true,
      extrasSource: 'transcript' as const,
      provider: 'gemini' as const,
      geminiTier: 'paid' as const,
      model: 'gemini-2.5-pro',
      phaseModels: {
        phase4: { provider: 'openrouter' as const, geminiTier: 'auto' as const, model: 'x-ai/grok-4.20' },
        phase6: { provider: 'claudeCode' as const, geminiTier: 'auto' as const, model: 'sonnet' },
      },
      personaTemplates: {
        phase3: { cloud: persona().phase3Cloud, local: persona().phase3Local },
        phase6: { cloud: persona().phase6Cloud, local: persona().phase6Local },
      },
      condensePercentage: 40,
    }
    expect(reforge.validateReforge(input, config)).toBeNull()
    const result = await drive(
      reforge.runReforge(input, config, { onEvent: cap.onEvent }, { onProgress: (p) => progress.push(normProgress(p)) }),
    )
    expect(result.chronicleRegenerated).toBe(true)
    expect({
      result,
      events: cap.events,
      progress,
      ...recorded(world),
    }).toMatchSnapshot()
  }, 120_000)

  it('7b. keep the chronicle, extras from the chronicle on Codex, condense on Gemini Flash with a fixed target', async () => {
    const world = await createWorld({ fixtures: { glossary: GLOSSARY_FIXTURE } })
    const cap = eventCollector()
    const progress: any[] = []
    const { reforge } = world.mods
    const input = {
      chronicle: PRIOR_CHRONICLE,
      dmQuestions: [],
      dmAnswers: {},
      kb: goldenKb(),
      campaign: 'Golden Campaign',
      sessionNumber: 7,
    }
    const config = {
      regenerateChronicle: false,
      doExtras: true,
      doCondense: true,
      extrasSource: 'chronicle' as const,
      provider: 'codex' as const,
      geminiTier: 'auto' as const,
      model: 'gpt-5.5',
      phaseModels: {
        phase6: { provider: 'gemini' as const, geminiTier: 'paid' as const, model: 'gemini-2.5-flash' },
      },
      targetWordCount: 120,
    }
    expect(reforge.validateReforge(input, config)).toBeNull()
    const result = await drive(
      reforge.runReforge(input, config, { onEvent: cap.onEvent }, { onProgress: (p) => progress.push(normProgress(p)) }),
    )
    expect(result.chronicleRegenerated).toBe(false)
    expect({ result, events: cap.events, progress, ...recorded(world) }).toMatchSnapshot()
  }, 120_000)
})

// ───────────────────────── scenario 8: Caption Repair ─────────────────────────

/** A synthetic .sbv built from the golden lines, with real timestamps. */
function buildSbvText(cueCount: number): string {
  const lines = TRANSCRIPT.split('\n')
    .map((l) => l.replace(/^\s*\[[^\]]+\]\s*/, '').trim())
    .filter((l) => l.length > 0 && !/^\[?(Music|Laughter)\]?$/.test(l))
  const ts = (ms: number) => {
    const h = Math.floor(ms / 3_600_000)
    const m = Math.floor((ms % 3_600_000) / 60_000)
    const s = Math.floor((ms % 60_000) / 1000)
    const milli = ms % 1000
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(milli).padStart(3, '0')}`
  }
  const cues: string[] = []
  for (let i = 0; i < cueCount; i++) {
    const start = i * 3200
    cues.push(`${ts(start)},${ts(start + 3000)}\n${lines[i % lines.length].slice(0, 110)}`)
  }
  return cues.join('\n\n') + '\n'
}

const SBV_TEXT = buildSbvText(170)

function normSbvEvent(e: any): any {
  const o = deepClone(e)
  if (Array.isArray(o.cuesUpdated)) o.cuesUpdated = { count: o.cuesUpdated.length, sha1: sha(JSON.stringify(o.cuesUpdated)) }
  if (Array.isArray(o.cues)) o.cues = { count: o.cues.length, sha1: sha(JSON.stringify(o.cues)) }
  return o
}

describe('golden: Caption Repair grounding (sbvGround)', () => {
  it('8a. cloud: one chunk through the active Gemini provider', async () => {
    const world = await createWorld({ fixtures: { glossary: GLOSSARY_FIXTURE } })
    const { sbv, sbvGround } = world.mods
    const cues = sbv.parseSbv(SBV_TEXT)
    expect(cues.length).toBe(170)
    const events: any[] = []
    const result = await drive(
      sbvGround.groundSbvCues({ cues, kb: goldenKb(), callbacks: { onEvent: (e) => events.push(normSbvEvent(e)) } }),
    )
    expect(result.totalChanged).toBeGreaterThan(0)
    expect({
      input: SBV_TEXT,
      output: sbv.formatSbv(result.cues),
      totalChanged: result.totalChanged,
      events,
      ...recorded(world),
    }).toMatchSnapshot()
  }, 120_000)

  it('8b. legacy local runner (Ollama) through the proxy: smaller chunks, no pacing', async () => {
    const world = await createWorld({
      localStorage: {
        provider_settings: {
          providerId: 'ollama',
          proModel: 'local-model-alpha',
          flashModel: 'local-model-alpha',
          baseUrl: 'http://localhost:11434',
        },
      },
      fixtures: { glossary: GLOSSARY_FIXTURE },
    })
    const { sbv, sbvGround } = world.mods
    const cues = sbv.parseSbv(SBV_TEXT)
    const events: any[] = []
    const result = await drive(
      sbvGround.groundSbvCues({ cues, kb: goldenKb(), callbacks: { onEvent: (e) => events.push(normSbvEvent(e)) } }),
    )
    expect({
      output: sbv.formatSbv(result.cues),
      totalChanged: result.totalChanged,
      events,
      ...recorded(world),
    }).toMatchSnapshot()
  }, 120_000)
})
