/** @vitest-environment jsdom */
// OutputPicker contract:
//   - Renders three checkboxes seeded from the `initial` prop.
//   - Condensed auto-flips Chronicle ON (the prompt dependency).
//   - Unchecking Chronicle auto-flips Condensed OFF.
//   - "Run with selection" disabled when nothing is checked.
//   - Calls onConfirm with the current selection on Run.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { OutputPicker } from './OutputPicker'

afterEach(() => cleanup())

describe('OutputPicker — seeded selection', () => {
  it('renders all three checkboxes seeded from initial', () => {
    render(
      <OutputPicker
        initial={{ chronicle: true, extras: false, condensed: false, condensePercentage: 20 }}
        onConfirm={vi.fn()}
      />,
    )
    const chronicle = screen.getByLabelText(/generate chronicle/i) as HTMLInputElement
    const extras = screen.getByLabelText(/generate extras/i) as HTMLInputElement
    const condensed = screen.getByLabelText(/generate condensed chronicle/i) as HTMLInputElement
    expect(chronicle.checked).toBe(true)
    expect(extras.checked).toBe(false)
    expect(condensed.checked).toBe(false)
  })
})

describe('OutputPicker — Condensed ↔ Chronicle dependency', () => {
  it('checking Condensed auto-checks Chronicle when it was off', () => {
    render(
      <OutputPicker
        initial={{ chronicle: false, extras: false, condensed: false, condensePercentage: 20 }}
        onConfirm={vi.fn()}
      />,
    )
    const chronicle = screen.getByLabelText(/generate chronicle/i) as HTMLInputElement
    const condensed = screen.getByLabelText(/generate condensed chronicle/i) as HTMLInputElement
    expect(chronicle.checked).toBe(false)
    fireEvent.click(condensed)
    expect(condensed.checked).toBe(true)
    expect(chronicle.checked).toBe(true)
  })

  it('unchecking Chronicle auto-unchecks Condensed', () => {
    render(
      <OutputPicker
        initial={{ chronicle: true, extras: false, condensed: true, condensePercentage: 20 }}
        onConfirm={vi.fn()}
      />,
    )
    const chronicle = screen.getByLabelText(/generate chronicle/i) as HTMLInputElement
    const condensed = screen.getByLabelText(/generate condensed chronicle/i) as HTMLInputElement
    expect(condensed.checked).toBe(true)
    fireEvent.click(chronicle)
    expect(chronicle.checked).toBe(false)
    expect(condensed.checked).toBe(false)
  })

  it('checking Condensed when Chronicle is already on does NOT toggle Chronicle off', () => {
    render(
      <OutputPicker
        initial={{ chronicle: true, extras: false, condensed: false, condensePercentage: 20 }}
        onConfirm={vi.fn()}
      />,
    )
    const chronicle = screen.getByLabelText(/generate chronicle/i) as HTMLInputElement
    const condensed = screen.getByLabelText(/generate condensed chronicle/i) as HTMLInputElement
    fireEvent.click(condensed)
    expect(condensed.checked).toBe(true)
    expect(chronicle.checked).toBe(true)
  })
})

describe('OutputPicker — Run gating + onConfirm payload', () => {
  it('Run is disabled when nothing is checked', () => {
    render(
      <OutputPicker
        initial={{ chronicle: false, extras: false, condensed: false, condensePercentage: 20 }}
        onConfirm={vi.fn()}
      />,
    )
    const runBtn = screen.getByRole('button', { name: /Run with selection/i }) as HTMLButtonElement
    expect(runBtn.disabled).toBe(true)
  })

  it('Run fires onConfirm with the current selection', () => {
    const onConfirm = vi.fn()
    render(
      <OutputPicker
        initial={{ chronicle: true, extras: false, condensed: false, condensePercentage: 20 }}
        onConfirm={onConfirm}
      />,
    )
    fireEvent.click(screen.getByLabelText(/generate extras/i))
    fireEvent.click(screen.getByRole('button', { name: /Run with selection/i }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onConfirm).toHaveBeenCalledWith({ chronicle: true, extras: true, condensed: false, condensePercentage: 20 })
    // Note: the `condensePercentage: 20` matches the initial prop. It's
    // included in the payload even when condensed=false so the user's
    // preference persists across runs; runPhase6 only consults it when
    // condensed=true.
  })

  it('Run is enabled when only Extras is checked (no chronicle path)', () => {
    render(
      <OutputPicker
        initial={{ chronicle: false, extras: true, condensed: false, condensePercentage: 20 }}
        onConfirm={vi.fn()}
      />,
    )
    const runBtn = screen.getByRole('button', { name: /Run with selection/i }) as HTMLButtonElement
    expect(runBtn.disabled).toBe(false)
  })

  it('Run is enabled when only Chronicle is checked', () => {
    render(
      <OutputPicker
        initial={{ chronicle: true, extras: false, condensed: false, condensePercentage: 20 }}
        onConfirm={vi.fn()}
      />,
    )
    const runBtn = screen.getByRole('button', { name: /Run with selection/i }) as HTMLButtonElement
    expect(runBtn.disabled).toBe(false)
  })
})

describe('OutputPicker — phase preview', () => {
  it('shows the phase plan when at least one box is checked', () => {
    render(
      <OutputPicker
        initial={{ chronicle: true, extras: true, condensed: false, condensePercentage: 20 }}
        onConfirm={vi.fn()}
      />,
    )
    expect(document.body.textContent).toContain('Phase 3 (Chronicle)')
    // v1.1.0 — Phase 5 label now explicitly notes the cloud-skip behaviour
    // so cloud users don't mistakenly expect a Phase 5 call to fire.
    expect(document.body.textContent).toContain('Phase 5 (Polish — local-LLM only; cloud providers skip)')
    expect(document.body.textContent).toContain('Phase 4 (Extras)')
  })

  it('shows the warning when nothing is checked', () => {
    render(
      <OutputPicker
        initial={{ chronicle: false, extras: false, condensed: false, condensePercentage: 20 }}
        onConfirm={vi.fn()}
      />,
    )
    expect(document.body.textContent).toContain('Select at least one output')
  })

  it('includes Phase 6 only when Condensed is on', () => {
    render(
      <OutputPicker
        initial={{ chronicle: true, extras: false, condensed: true, condensePercentage: 20 }}
        onConfirm={vi.fn()}
      />,
    )
    expect(document.body.textContent).toContain('Phase 6 (Condense)')
  })
})

describe('OutputPicker — Back button', () => {
  it('renders + fires onBack when provided', () => {
    const onBack = vi.fn()
    render(
      <OutputPicker
        initial={{ chronicle: true, extras: true, condensed: false, condensePercentage: 20 }}
        onConfirm={vi.fn()}
        onBack={onBack}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Back/i }))
    expect(onBack).toHaveBeenCalled()
  })

  it('hides the Back button when onBack is not provided', () => {
    render(
      <OutputPicker
        initial={{ chronicle: true, extras: true, condensed: false, condensePercentage: 20 }}
        onConfirm={vi.fn()}
      />,
    )
    expect(screen.queryByRole('button', { name: /Back/i })).toBeNull()
  })
})
