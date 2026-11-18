// @vitest-environment jsdom

// The screen a run lands on when its page closed or reloaded mid-run. The run
// state in localStorage still holds every finished output, so the screen
// offers to continue from the first step that has none instead of starting
// again. Mounted through the same harness as the app snapshots, with the
// pipeline's phase functions replaced so no provider is called.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import {
  installScenario,
  mountApp,
  settle,
  type Scenario,
} from '@/platform/__ui_golden__/harness'
import {
  DEFAULT_OUTPUT_SELECTION,
  initialRefinementState,
  type RefinementState,
} from '@/features/pipeline/lib/types'
import { INTERRUPTED_RUN_MESSAGE } from '../lib/refinementRun'

vi.mock('sonner', async () => (await import('@/platform/__ui_golden__/sonnerMock')).sonnerMock)

// The harness resets the module graph for each scenario, which would re-run a
// mock factory and orphan the spies this file holds. Sharing them through
// globalThis keeps one set across every graph.
const phases = vi.hoisted(() => {
  type Spy = ReturnType<typeof vi.fn>
  const g = globalThis as unknown as { __interruptedPhases?: Record<string, Spy> }
  g.__interruptedPhases ??= {
    runPhase2: vi.fn(async () => []),
    runPhase3: vi.fn(async () => 'Fresh chronicle.'),
    runPhase4: vi.fn(async () => ({ jests: [], gore: [], quotes: [] })),
    runPhase5Polish: vi.fn(async (a: { chronicle: string }) => a.chronicle),
    runPhase6: vi.fn(async () => ({ narrative: 'Short.', bulletPoints: ['One.'] })),
  }
  return g.__interruptedPhases
})

vi.mock('@/features/pipeline/lib/pipeline', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/pipeline/lib/pipeline')>()),
  runPhase2: phases.runPhase2,
  runPhase3: phases.runPhase3,
  runPhase4: phases.runPhase4,
  runPhase5Polish: phases.runPhase5Polish,
  runPhase6: phases.runPhase6,
}))

type Mounted = Awaited<ReturnType<typeof mountApp>>

let scenario: Scenario
let app: Mounted | null = null

beforeEach(() => {
  for (const spy of Object.values(phases)) spy.mockClear()
})

afterEach(() => {
  app?.unmount()
  app = null
  vi.restoreAllMocks()
  vi.useRealTimers()
})

/** Mount with an interrupted run already persisted, as a reload leaves it. */
async function bootInterrupted(overrides: Partial<RefinementState>): Promise<void> {
  scenario = installScenario({ audio: false, populated: true })
  // A save answers with an id, so the auto-save on completion can be counted.
  scenario.routes['POST /api/chronicle-library'] = { body: { id: 'saved-1' } }
  scenario.routes['PUT /api/chronicle-library/saved-0'] = { body: { id: 'saved-0' } }
  const stored: RefinementState = {
    ...initialRefinementState,
    rawTranscript: 'PC-Alpha: We reach Place-Delta.\nDM: The gates stand open.',
    ...overrides,
  }
  localStorage.setItem('refinement_state', JSON.stringify(stored))
  app = await mountApp(scenario)
}

function buttonNames(): string[] {
  return screen.getAllByRole('button').map((b) => (b.textContent ?? '').trim())
}

function continueButton(): HTMLElement | null {
  return screen.queryByRole('button', { name: /^Continue from / })
}

function savesMade(): string[] {
  return scenario.calls
    .filter((c) => c.path.startsWith('/api/chronicle-library') && c.method !== 'GET')
    .map((c) => `${c.method} ${c.path}`)
}

const running = (currentPhase: RefinementState['currentPhase']): Partial<RefinementState> => ({
  status: currentPhase ?? 'idle',
  currentPhase,
})

describe('interrupted run screen', () => {
  it('Phase 1 unfinished: names the interruption and offers only Start again and Reset', async () => {
    await bootInterrupted({ ...running('phase1_ground'), currentChunkIndex: 3, totalChunks: 9 })
    expect(screen.getByText('Run interrupted')).toBeTruthy()
    expect(screen.getByText(INTERRUPTED_RUN_MESSAGE)).toBeTruthy()
    expect(buttonNames()).toContain('Start again from Phase 1')
    expect(buttonNames()).toContain('Reset')
    expect(continueButton()).toBeNull()
  })

  it('a failure that is not an interruption never offers Continue', async () => {
    await bootInterrupted({
      status: 'error',
      lastError: 'provider said no',
      currentPhase: 'phase3_chronicle',
      groundedTranscript: 'Grounded.',
    })
    expect(screen.getByText('Pipeline error')).toBeTruthy()
    expect(buttonNames()).toContain('Retry from Phase 1')
    expect(continueButton()).toBeNull()
  })

  describe('Phase 1 finished, Phase 2 not', () => {
    const state = { ...running('phase2_audit'), groundedTranscript: 'Grounded session text.' }

    it('offers Continue from the Audit step beside Start again and Reset', async () => {
      await bootInterrupted(state)
      expect(continueButton()?.textContent?.trim()).toBe('Continue from the Audit step')
      expect(buttonNames()).toContain('Start again from Phase 1')
      expect(buttonNames()).toContain('Reset')
    })

    it('runs Phase 2 on the saved grounded transcript, then asks the questions', async () => {
      phases.runPhase2.mockResolvedValueOnce([{ id: 'q1', question: 'Who is Person-Beta?' }])
      await bootInterrupted(state)
      await app!.user.click(continueButton()!)
      await settle(scenario)

      expect(phases.runPhase2).toHaveBeenCalledTimes(1)
      expect(phases.runPhase2.mock.calls[0][0]).toMatchObject({
        groundedTranscript: 'Grounded session text.',
        rawTranscript: 'PC-Alpha: We reach Place-Delta.\nDM: The gates stand open.',
      })
      expect(phases.runPhase3).not.toHaveBeenCalled()
      expect(screen.getByText('Who is Person-Beta?')).toBeTruthy()
    })
  })

  describe('outputs chosen, later phases partly finished', () => {
    const base = {
      groundedTranscript: 'Grounded.',
      dmAnswers: { q1: 'A rival.' },
      dmQuestions: [{ id: 'q1', question: 'Who is Person-Beta?' }],
      outputSelection: { ...DEFAULT_OUTPUT_SELECTION, chronicle: true, extras: true, condensed: false },
    }

    it('died in the Chronicle step: runs Chronicle and Extras, nothing earlier', async () => {
      await bootInterrupted({ ...base, ...running('phase3_chronicle') })
      expect(continueButton()?.textContent?.trim()).toBe('Continue from the Chronicle step')
      await app!.user.click(continueButton()!)
      await settle(scenario)

      expect(phases.runPhase2).not.toHaveBeenCalled()
      expect(phases.runPhase3).toHaveBeenCalledTimes(1)
      expect(phases.runPhase3.mock.calls[0][0]).toMatchObject({
        groundedTranscript: 'Grounded.',
        dmAnswers: { q1: 'A rival.' },
      })
      expect(phases.runPhase4).toHaveBeenCalledTimes(1)
      expect(phases.runPhase6).not.toHaveBeenCalled()
    })

    it('chronicle already written: skips it and runs only Extras', async () => {
      await bootInterrupted({
        ...base,
        ...running('phase4_extras'),
        chronicle: 'The party arrived at dusk.',
      })
      expect(continueButton()?.textContent?.trim()).toBe('Continue from the Extras step')
      await app!.user.click(continueButton()!)
      await settle(scenario)

      expect(phases.runPhase3).not.toHaveBeenCalled()
      expect(phases.runPhase5Polish).not.toHaveBeenCalled()
      expect(phases.runPhase4).toHaveBeenCalledTimes(1)
    })

    it('died in Polish: polishes the saved chronicle without writing it again', async () => {
      await bootInterrupted({
        ...base,
        ...running('phase5_polish'),
        chronicle: 'The party arrived at dusk.',
      })
      expect(continueButton()?.textContent?.trim()).toBe('Continue from the Polish step')
      await app!.user.click(continueButton()!)
      await settle(scenario)

      expect(phases.runPhase3).not.toHaveBeenCalled()
      expect(phases.runPhase5Polish).toHaveBeenCalledTimes(1)
      expect(phases.runPhase5Polish.mock.calls[0][0]).toMatchObject({
        chronicle: 'The party arrived at dusk.',
      })
      expect(phases.runPhase4).toHaveBeenCalledTimes(1)
    })
  })
})

describe('continued run and the saved library', () => {
  const finishedChronicle = {
    groundedTranscript: 'Grounded.',
    outputSelection: { ...DEFAULT_OUTPUT_SELECTION, chronicle: true, extras: true, condensed: false },
    ...running('phase4_extras'),
    chronicle: 'The party arrived at dusk.',
  }

  it('saves one new entry when the interrupted run never saved', async () => {
    await bootInterrupted(finishedChronicle)
    await app!.user.click(continueButton()!)
    await settle(scenario)
    expect(savesMade()).toEqual(['POST /api/chronicle-library'])
    expect(JSON.parse(localStorage.getItem('refinement_state')!).savedChronicleId).toBe('saved-1')
  })

  it('updates the entry it already had instead of creating a second', async () => {
    await bootInterrupted({ ...finishedChronicle, savedChronicleId: 'saved-0' })
    await app!.user.click(continueButton()!)
    await settle(scenario)
    expect(savesMade().some((s) => s.startsWith('POST'))).toBe(false)
    expect(savesMade()).toHaveLength(1)
  })
})
