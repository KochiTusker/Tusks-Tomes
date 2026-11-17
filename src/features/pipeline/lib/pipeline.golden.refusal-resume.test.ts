/** @vitest-environment jsdom */
//
// Golden characterisation tests — refusal repair (scenario 5) and resume from a
// checkpoint (scenario 6). See src/features/pipeline/lib/__golden__/harness.ts for how the
// network edge is faked and why every request is recorded in full.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GLOSSARY_FIXTURE,
  GOLDEN_REFUSAL,
  applyTokenFixes,
  buildGoldenTranscript,
  createWorld,
  defaultFixtures,
  drive,
  eventCollector,
  goldenKb,
  recorded,
  runFullRun,
  scenarioSnapshot,
  teardownWorld,
  type World,
} from './__golden__/harness'

vi.mock('@google/genai', async () => (await import('./__golden__/harness')).genaiMockFactory())
vi.mock('openai', async () => (await import('./__golden__/harness')).openaiMockFactory())

const TRANSCRIPT = buildGoldenTranscript()

afterEach(() => teardownWorld())

// ───────────────────────── scenario 5: refusal repair ─────────────────────────

/** Refuse exactly one Claude Code chronicle chunk (the second). */
function refuseSecondChronicleChunk(world: World) {
  world.rec.hooks.push((ctx) =>
    ctx.via === 'claudeCode' && ctx.phase === 'phase3' && ctx.chunk?.index === 1
      ? GOLDEN_REFUSAL
      : undefined,
  )
}

describe('golden: Claude Code refusal repair', () => {
  it('5a. failsafe ON, default repair target (Gemini Flash)', async () => {
    const world = await createWorld({
      localStorage: { claude_failsafe_enabled: 'true' },
      fixtures: { glossary: GLOSSARY_FIXTURE },
    })
    refuseSecondChronicleChunk(world)
    const run = await runFullRun(world, { provider: 'claudeCode', transcript: TRANSCRIPT })
    expect(run.events.some((e) => e.type === 'auto_fallback' && e.reason === 'claude_refusal')).toBe(true)
    expect(scenarioSnapshot(world, run)).toMatchSnapshot()
  }, 120_000)

  it('5b. failsafe ON, repair target configured to an OpenRouter model', async () => {
    const world = await createWorld({
      localStorage: {
        claude_failsafe_enabled: 'true',
        claude_failsafe_model: 'x-ai/grok-4.20',
      },
      fixtures: { glossary: GLOSSARY_FIXTURE },
    })
    refuseSecondChronicleChunk(world)
    const run = await runFullRun(world, { provider: 'claudeCode', transcript: TRANSCRIPT })
    expect(run.events.some((e) => e.type === 'auto_fallback' && e.reason === 'claude_refusal')).toBe(true)
    expect(scenarioSnapshot(world, run)).toMatchSnapshot()
  }, 120_000)

  it('5c. failsafe OFF: the refusal stays unrepaired and is marked in the prose', async () => {
    const world = await createWorld({ fixtures: { glossary: GLOSSARY_FIXTURE } })
    refuseSecondChronicleChunk(world)
    const run = await runFullRun(world, { provider: 'claudeCode', transcript: TRANSCRIPT })
    expect(scenarioSnapshot(world, run)).toMatchSnapshot()
  }, 120_000)
})

// ───────────────────────── scenario 6: resume ─────────────────────────────────

/** Profiles that give Gemini two chronicle chunks and three grounding chunks on
 *  a ~31 KB transcript (Flash runs on the smaller `fast` chunk row). Phase 4 is
 *  Pro so the run is not "all fast" and the chunk sizes are the plain rows. */
function resumeFixtures() {
  const base = defaultFixtures()
  return {
    glossary: GLOSSARY_FIXTURE,
    settings: { ...base.settings, disableThinkingOnGrounding: true, reassembleQuotes: false },
    profiles: {
      ...base.profiles,
      profiles: {
        ...base.profiles.profiles,
        gemini: {
          phase1Model: 'gemini-2.5-flash',
          phase2Model: 'gemini-2.5-flash',
          phase3Model: 'gemini-2.5-flash',
          phase4Model: 'gemini-2.5-pro',
          phase6Model: 'gemini-2.5-flash',
        },
      },
    },
  }
}

const FIXED_ISO = '2030-01-01T00:05:00.000Z'

type Paused = { checkpoint: any; action: any; preEvents: any[] }

/** Real checkpoint round-trip: build -> save -> load -> validate -> plan. */
async function checkpointRoundTrip(
  world: World,
  args: { state: any; phaseNumeric: 1 | 3; inputSnapshot?: any; runId: string },
) {
  const { mods } = world
  const doc = await (await import('../../routing/lib/routing')).getRouting()
  const cp = mods.buildCheckpoint.buildCheckpoint({
    snapshot: { state: args.state, campaign: 'Golden Campaign', sessionNumber: 7 },
    runId: args.runId,
    routing: doc,
    pausedReason: 'user',
    phaseNumeric: args.phaseNumeric,
    safetyMultiplier: 1,
    runFingerprint: 'fingerprint-golden',
    inputSnapshot: args.inputSnapshot ?? null,
    nowIso: FIXED_ISO,
  })
  const saved = await mods.runStorage.saveRun(cp)
  expect(saved.ok).toBe(true)
  const loaded = await mods.runStorage.loadRun(args.runId)
  expect(mods.runCheckpoint.isValidCheckpoint(loaded)).toBe(true)
  return { checkpoint: loaded as any, action: mods.resumeFlow.planResumeAction(loaded as any) }
}

async function pausePhase1(world: World): Promise<Paused> {
  const { mods } = world
  const cap = eventCollector()
  const ctrl = new AbortController()
  let snapshot: any = null
  let lastPartial = ''
  let lastIndex = -1
  let total = 0
  world.rec.segment = 'before-pause'
  await mods.providers.ensureProvidersInitialized()
  const session = await mods.sessions.buildSession('gemini', { geminiTier: 'paid' })
  const run = mods.pipeline.runPhase1({
    rawTranscript: TRANSCRIPT,
    kb: goldenKb(),
    callbacks: {
      signal: ctrl.signal,
      onEvent: (e: any) => {
        cap.onEvent(e)
        if (e.type === 'chunk_done' && e.phase === 'phase1_ground') {
          lastPartial = e.partial
          lastIndex = e.index
          total = e.totalChunks
          if (e.index === 0) ctrl.abort()
        }
      },
    },
    model: session.phases.phase1.model,
    phaseTarget: session.phases.phase1.phaseTarget,
    cloudProvider: session.phases.phase1.cloudProvider,
    geminiTier: session.phases.phase1.geminiTier,
    allPhasesFast: session.allPhasesFast,
    disableThinkingOnGrounding: true,
    safetyMultiplier: () => 1,
    onInputSnapshot: (s: any) => {
      snapshot = s
    },
  })
  await expect(drive(run)).rejects.toMatchObject({ name: 'AbortError' })
  expect(lastIndex).toBe(0)

  const state = {
    ...mods.types.initialRefinementState,
    rawTranscript: TRANSCRIPT,
    status: 'phase1_ground',
    currentPhase: 'phase1_ground',
    currentChunkIndex: lastIndex + 1,
    totalChunks: total,
    partialOutput: lastPartial,
    updatedAt: '2030-01-01T00:00:00.000Z',
  }
  const { checkpoint, action } = await checkpointRoundTrip(world, {
    state,
    phaseNumeric: 1,
    inputSnapshot: snapshot,
    runId: 'run-golden-phase1',
  })
  return { checkpoint, action, preEvents: cap.events }
}

async function pausePhase3(world: World): Promise<Paused> {
  const { mods } = world
  const cap = eventCollector()
  const ctrl = new AbortController()
  let lastPartial = ''
  let lastIndex = -1
  let total = 0
  world.rec.segment = 'before-pause'
  await mods.providers.ensureProvidersInitialized()
  const session = await mods.sessions.buildSession('gemini', { geminiTier: 'paid' })
  const grounded = applyTokenFixes(TRANSCRIPT)
  const dmQuestions = [
    { id: 'q-1-1', question: 'Which weapon did PC-Alpha draw?', context: 'Raw and grounded disagree.' },
  ]
  const dmAnswers = { 'q-1-1': 'Item-Epsilon, drawn at the gate.' }
  const run = mods.pipeline.runPhase3({
    groundedTranscript: grounded,
    dmQuestions,
    dmAnswers,
    kb: goldenKb(),
    callbacks: {
      signal: ctrl.signal,
      onEvent: (e: any) => {
        cap.onEvent(e)
        if (e.type === 'chunk_done' && e.phase === 'phase3_chronicle') {
          lastPartial = e.partial
          lastIndex = e.index
          total = e.totalChunks
          if (e.index === 0) ctrl.abort()
        }
      },
    },
    model: session.phases.phase3.model,
    phaseTarget: session.phases.phase3.phaseTarget,
    cloudProvider: session.phases.phase3.cloudProvider,
    geminiTier: session.phases.phase3.geminiTier,
    allPhasesFast: session.allPhasesFast,
    safetyMultiplier: () => 1,
  })
  await expect(drive(run)).rejects.toMatchObject({ name: 'AbortError' })
  expect(lastIndex).toBe(0)
  expect(total).toBeGreaterThan(1)

  const state = {
    ...mods.types.initialRefinementState,
    rawTranscript: TRANSCRIPT,
    groundedTranscript: grounded,
    dmQuestions,
    dmAnswers,
    status: 'phase3_chronicle',
    currentPhase: 'phase3_chronicle',
    currentChunkIndex: lastIndex + 1,
    totalChunks: total,
    partialOutput: lastPartial,
    updatedAt: '2030-01-01T00:00:00.000Z',
    outputSelection: { chronicle: true, extras: true, condensed: true, condensePercentage: 35 },
  }
  const { checkpoint, action } = await checkpointRoundTrip(world, {
    state,
    phaseNumeric: 3,
    runId: 'run-golden-phase3',
  })
  return { checkpoint, action, preEvents: cap.events }
}

/** Mirrors RefinementTool.runFromResumeAction for phases 1 and 3. */
async function resume(world: World, paused: Paused) {
  const { mods } = world
  const { checkpoint, action } = paused
  const { pipeline, sessions, runSettings, wordCount } = mods
  const cap = eventCollector()
  const callbacks = { onEvent: cap.onEvent }
  world.rec.segment = 'resume'

  const flow = async () => {
    const currentRouting = await (await import('../../routing/lib/routing')).getRouting()
    const dispatchProvider = currentRouting.lastSelectedProvider!
    const session = await sessions.buildSession(dispatchProvider, { geminiTier: currentRouting.geminiTier })
    const originalSession = await sessions.buildSession(checkpoint.routing.lastSelectedProvider, {
      geminiTier: checkpoint.routing.geminiTier,
      routingOverride: checkpoint.routing,
      dryRun: true,
    })
    const rs = await runSettings.fetchRunSettings()
    const rawTranscript = checkpoint.refinementState.rawTranscript
    const out: Record<string, unknown> = {}
    const ph = (k: 'phase1' | 'phase2' | 'phase3' | 'phase4' | 'phase6') => ({
      model: session.phases[k].model,
      phaseTarget: session.phases[k].phaseTarget,
      cloudProvider: session.phases[k].cloudProvider,
      geminiTier: session.phases[k].geminiTier,
      geminiPaidOnlyModels: session.geminiPaidOnlyModels,
      allPhasesFast: session.allPhasesFast,
      safetyMultiplier: () => 1,
    })

    if (action.phase === 1) {
      const grounded = await pipeline.runPhase1({
        rawTranscript,
        kb: goldenKb(),
        callbacks,
        ...ph('phase1'),
        disableThinkingOnGrounding: rs.disableThinkingOnGrounding,
        phase1AliasHints: rs.phase1AliasHints,
        chunkSizeChars: sessions.chunkSizeForSessionPhase(originalSession, 'phase1'),
        startChunkIndex: action.startChunkIndex,
        priorPartial: action.priorPartial,
        inputSnapshot: checkpoint.inputSnapshot,
        onInputSnapshot: () => {},
      })
      out.grounded = grounded
      if (action.afterPhases.includes(2)) {
        out.questions = await pipeline.runPhase2({
          kb: goldenKb(),
          rawTranscript,
          groundedTranscript: grounded,
          callbacks,
          ...ph('phase2'),
        })
      }
    } else {
      const { dmAnswers, dmQuestions, groundedTranscript } = checkpoint.refinementState
      const rawChronicle = await pipeline.runPhase3({
        groundedTranscript,
        dmQuestions,
        dmAnswers,
        kb: goldenKb(),
        callbacks,
        ...ph('phase3'),
        chunkSizeChars: sessions.chunkSizeForSessionPhase(originalSession, 'phase3'),
        startChunkIndex: action.startChunkIndex,
        priorPartial: action.priorPartial,
        retrieveVaultKb: rs.retrieveVaultKb,
        aliasIndex: null,
      })
      out.chronicle = rawChronicle
      let finalChronicle = rawChronicle
      if (action.afterPhases.includes(5)) {
        finalChronicle = await pipeline.runPhase5Polish({
          chronicle: rawChronicle,
          kb: goldenKb(),
          callbacks,
          safetyMultiplier: () => 1,
        })
        out.polished = finalChronicle
      }
      if (action.afterPhases.includes(4)) {
        out.extras = await pipeline.runPhase4({
          kb: goldenKb(),
          groundedTranscript,
          dmAnswers,
          callbacks,
          ...ph('phase4'),
          thinkingOn: rs.perPhaseThinking.phase4,
          reassembleQuotes: rs.reassembleQuotes,
        })
      }
      if (action.afterPhases.includes(6) && finalChronicle.trim()) {
        out.condensed = await pipeline.runPhase6({
          chronicle: finalChronicle,
          kb: goldenKb(),
          dmAnswers,
          campaign: 'Golden Campaign',
          sessionNumber: 7,
          callbacks,
          ...ph('phase6'),
          thinkingOn: rs.perPhaseThinking.phase6,
          retrieveVaultKb: rs.retrieveVaultKb,
          aliasIndex: null,
          targetWordCount: wordCount.computeCondenseTarget(
            wordCount.countWords(finalChronicle),
            checkpoint.refinementState.outputSelection.condensePercentage,
          ),
        })
      }
    }
    return {
      dispatchProvider,
      session: { provider: session.provider, models: session.models, phases: session.phases },
      originalSession: { provider: originalSession.provider, phases: originalSession.phases },
      out,
    }
  }
  const result = await drive(flow())
  return { ...result, events: cap.events }
}

function resumeSnapshot(world: World, paused: Paused, resumed: Awaited<ReturnType<typeof resume>>) {
  const cp = paused.checkpoint
  return {
    checkpoint: {
      ...cp,
      // The transcripts are fixtures already pinned by the other scenarios;
      // keep the checkpoint readable.
      refinementState: {
        ...cp.refinementState,
        rawTranscript: `<${cp.refinementState.rawTranscript.length} chars>`,
        groundedTranscript: `<${cp.refinementState.groundedTranscript.length} chars>`,
        partialOutput: cp.refinementState.partialOutput,
      },
      inputSnapshot: cp.inputSnapshot
        ? {
            ...cp.inputSnapshot,
            phase1Chunks: cp.inputSnapshot.phase1Chunks.map((c: string) => ({ chars: c.length, head: c.slice(0, 60) })),
            speakersByMarker: `<${Object.keys(cp.inputSnapshot.speakersByMarker).length} markers>`,
          }
        : null,
    },
    plannedAction: paused.action,
    preEvents: paused.preEvents,
    resumedEvents: resumed.events,
    dispatchProvider: resumed.dispatchProvider,
    session: resumed.session,
    originalSession: resumed.originalSession,
    outputs: resumed.out,
    ...recorded(world),
  }
}

describe('golden: resume from a checkpoint', () => {
  it('6a. Phase 1 paused after the first chunk, resumed on the saved chunk boundaries, then Phase 2', async () => {
    const world = await createWorld({ fixtures: resumeFixtures() })
    const paused = await pausePhase1(world)
    expect(paused.action).toMatchObject({ kind: 'continue', phase: 1, startChunkIndex: 1 })
    const resumed = await resume(world, paused)
    expect(resumeSnapshot(world, paused, resumed)).toMatchSnapshot()
  }, 120_000)

  it('6b. Phase 3 paused mid-chronicle, resumed, then Phase 5 -> 4 -> 6', async () => {
    const world = await createWorld({ fixtures: resumeFixtures() })
    const paused = await pausePhase3(world)
    expect(paused.action).toMatchObject({ kind: 'continue', phase: 3, startChunkIndex: 1 })
    const resumed = await resume(world, paused)
    expect(resumeSnapshot(world, paused, resumed)).toMatchSnapshot()
  }, 120_000)

  it('6c. Phase 3 resumed after the user switched provider: dispatch on OpenRouter, boundaries from the paused Gemini run', async () => {
    const world = await createWorld({ fixtures: resumeFixtures() })
    const paused = await pausePhase3(world)
    // The user switches Active Provider between pause and resume.
    world.fx.routing = { ...world.fx.routing, lastSelectedProvider: 'openrouter', geminiTier: undefined }
    const resumed = await resume(world, paused)
    expect(resumed.dispatchProvider).toBe('openrouter')
    expect(resumeSnapshot(world, paused, resumed)).toMatchSnapshot()
  }, 120_000)
})
