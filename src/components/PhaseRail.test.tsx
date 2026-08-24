/** @vitest-environment jsdom */
// PhaseRail contract:
//   - renders all six phases, in pipeline order;
//   - each routable phase shows its resolved model (vendor prefix trimmed);
//   - phase 5 (Polish) is never routable: labelled local-only, and 'skipped'
//     on cloud runs — it must not render as an empty slot;
//   - a phase whose resolution deviates from the plan carries a Custom chip;
//   - live state lights the active rung with its note and marks done rungs.

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { PhaseRail } from './PhaseRail'
import type { ResolvedPhaseConfig, RunSession } from '@/lib/sessions'

afterEach(() => cleanup())

function cloudPhase(model: string, overrides?: Partial<ResolvedPhaseConfig>): ResolvedPhaseConfig {
  return {
    cloudProvider: 'gemini',
    geminiTier: 'paid',
    model,
    phaseTarget: { target: 'cloud' },
    override: false,
    ...overrides,
  }
}

/** The minimum RunSession shape the rail consumes. */
function makeSession(overrides?: Partial<RunSession['phases']>): RunSession {
  const phases: RunSession['phases'] = {
    phase1: cloudPhase('gemini-flash-latest'),
    phase2: cloudPhase('gemini-flash-latest'),
    phase3: cloudPhase('gemini-pro-latest'),
    phase4: cloudPhase('gemini-flash-lite-latest'),
    phase6: cloudPhase('gemini-flash-lite-latest'),
    ...overrides,
  }
  return { phases } as RunSession
}

describe('PhaseRail — resolution display', () => {
  it('renders all six phases in order with their models', () => {
    render(<PhaseRail session={makeSession()} />)
    const items = screen.getAllByRole('listitem')
    expect(items).toHaveLength(6)
    const names = items.map((el) => el.textContent ?? '')
    // Execution order: Polish runs between Chronicle and Extras, so the
    // extras are extracted from polished prose. The rail mirrors the run.
    expect(names[0]).toContain('Ground')
    expect(names[1]).toContain('Audit')
    expect(names[2]).toContain('Chronicle')
    expect(names[3]).toContain('Polish')
    expect(names[4]).toContain('Extras')
    expect(names[5]).toContain('Condense')
    expect(names[2]).toContain('gemini-pro-latest')
  })

  it('trims vendor prefixes from OpenRouter model ids', () => {
    render(
      <PhaseRail
        session={makeSession({
          phase3: cloudPhase('deepseek/deepseek-v4-pro', {
            cloudProvider: 'openrouter',
            geminiTier: undefined,
          }),
        })}
      />,
    )
    const chronicle = screen.getAllByRole('listitem')[2]
    expect(chronicle.textContent).toContain('deepseek-v4-pro')
    expect(chronicle.textContent).not.toContain('deepseek/deepseek-v4-pro')
  })

  it('renders Polish as local-only and skipped on a cloud run — never empty', () => {
    render(<PhaseRail session={makeSession()} />)
    const polish = screen.getAllByRole('listitem')[3]
    expect(polish.textContent).toContain('local runs only')
    expect(polish.textContent).toContain('skipped')
  })

  it('marks Polish as queued when the prose phase runs locally', () => {
    render(
      <PhaseRail
        session={makeSession({
          phase3: {
            cloudProvider: undefined,
            geminiTier: undefined,
            model: 'qwen3-30b',
            phaseTarget: { target: 'local', modelId: 'qwen3-30b' },
            override: true,
          },
        })}
      />,
    )
    const polish = screen.getAllByRole('listitem')[3]
    expect(polish.textContent).toContain('queued')
  })

  it('flags a deviating phase with a Custom chip only when asked to', () => {
    const session = makeSession({
      phase4: cloudPhase('glm-5.2', { cloudProvider: 'openrouter', geminiTier: undefined, override: true }),
    })
    const { rerender } = render(<PhaseRail session={session} />)
    // Off by default: after a preset pins all phases, every rung is
    // technically an override, so the chip at rest is noise.
    expect(screen.queryByText('Custom')).toBeNull()
    rerender(<PhaseRail session={session} showCustomChips />)
    expect(screen.getAllByText('Custom')).toHaveLength(1)
  })
})

describe('PhaseRail — live state', () => {
  it('lights the active rung with its note, and marks done rungs', () => {
    render(
      <PhaseRail
        session={makeSession()}
        live={{
          activePhase: 'phase3',
          activeNote: 'chunk 4 of 11',
          done: { phase1: '2m 10s', phase2: '48s' },
          skipped: { phase6: 'not requested' },
        }}
      />,
    )
    const items = screen.getAllByRole('listitem')
    expect(items[2].textContent).toContain('chunk 4 of 11')
    expect(items[0].textContent).toContain('done · 2m 10s')
    expect(items[1].textContent).toContain('done · 48s')
    expect(items[5].textContent).toContain('not requested')
    // Polish (execution slot 4) stays in its skipped state on a cloud run
    // even while later phases progress around it.
    expect(items[3].textContent).toContain('skipped')
  })
})
