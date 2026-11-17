/** @vitest-environment jsdom */
//
// Golden characterisation tests — full pipeline runs (scenarios 1-4).
//
// Each scenario drives the same call sequence RefinementTool drives
// (buildSession -> Phase 1 -> 2 -> 3 -> 5 -> 4 -> 6) against REAL providers whose
// network edge is faked, and snapshots the request bodies, event stream and
// outputs. Any change to a prompt byte, a request body, an event, or the order
// of any of them fails a snapshot. See src/features/pipeline/lib/__golden__/harness.ts.
//
// Placeholder tokens only (PC-Alpha, Place-Delta, ...). No real names.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GLOSSARY_FIXTURE,
  ALIAS_INDEX_FIXTURE,
  PERSONA_FIXTURE,
  SPEAKERS_FIXTURE,
  buildGoldenTranscript,
  createWorld,
  defaultFixtures,
  runFullRun,
  scenarioSnapshot,
  teardownWorld,
} from './__golden__/harness'

vi.mock('@google/genai', async () => (await import('./__golden__/harness')).genaiMockFactory())
vi.mock('openai', async () => (await import('./__golden__/harness')).openaiMockFactory())

const TRANSCRIPT = buildGoldenTranscript()

afterEach(() => teardownWorld())

describe('golden: full pipeline runs', () => {
  it('fixture transcript is stable', () => {
    expect(TRANSCRIPT.length).toBeGreaterThan(30_000)
    expect(TRANSCRIPT.length).toBeLessThan(33_000)
    expect(TRANSCRIPT).toMatchSnapshot()
  })

  it('1. all phases on Gemini (paid), non-empty inputs, thinking on, dev truncation, condense', async () => {
    const base = defaultFixtures()
    const world = await createWorld({
      fixtures: {
        glossary: GLOSSARY_FIXTURE,
        speakers: SPEAKERS_FIXTURE,
        personas: PERSONA_FIXTURE,
        aliasIndex: ALIAS_INDEX_FIXTURE,
        settings: {
          ...base.settings,
          disableThinkingOnGrounding: true,
          phase1AliasHints: true,
          reassembleQuotes: true,
          retrieveVaultKb: true,
          perPhaseThinking: { phase1: false, phase2: false, phase4: true, phase6: true },
          devTestMode: { enabled: true, maxChars: 24000 },
        },
      },
    })
    const run = await runFullRun(world, { provider: 'gemini', geminiTier: 'paid', transcript: TRANSCRIPT })
    expect(scenarioSnapshot(world, run)).toMatchSnapshot()
  }, 120_000)

  it('2. all phases on OpenRouter', async () => {
    const world = await createWorld({
      fixtures: { glossary: GLOSSARY_FIXTURE, speakers: SPEAKERS_FIXTURE },
    })
    const run = await runFullRun(world, { provider: 'openrouter', transcript: TRANSCRIPT })
    expect(scenarioSnapshot(world, run)).toMatchSnapshot()
  }, 120_000)

  it('3. all phases on Claude Code (subscription CLI path)', async () => {
    const world = await createWorld({
      fixtures: { glossary: GLOSSARY_FIXTURE, speakers: SPEAKERS_FIXTURE },
    })
    const run = await runFullRun(world, { provider: 'claudeCode', transcript: TRANSCRIPT })
    expect(scenarioSnapshot(world, run)).toMatchSnapshot()
  }, 120_000)

  it('3b. all phases on Codex (subscription CLI path)', async () => {
    const world = await createWorld({
      fixtures: { glossary: GLOSSARY_FIXTURE },
    })
    const run = await runFullRun(world, { provider: 'codex', transcript: TRANSCRIPT })
    expect(scenarioSnapshot(world, run)).toMatchSnapshot()
  }, 120_000)

  it('4. per-phase hybrid routing: grounding + audit on local, prose on Gemini', async () => {
    const base = defaultFixtures()
    const world = await createWorld({
      fixtures: {
        glossary: GLOSSARY_FIXTURE,
        routing: {
          ...base.routing,
          perPhase: {
            phase1: { target: 'local', modelId: 'local-model-alpha', baseUrl: 'http://localhost:11434' },
            phase2: { target: 'local', modelId: 'local-model-beta', baseUrl: 'http://localhost:1234' },
          },
        },
      },
    })
    const run = await runFullRun(world, { provider: 'gemini', geminiTier: 'paid', transcript: TRANSCRIPT })
    expect(scenarioSnapshot(world, run)).toMatchSnapshot()
  }, 120_000)
})
