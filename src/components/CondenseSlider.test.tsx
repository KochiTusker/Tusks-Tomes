/** @vitest-environment jsdom */
// CondenseSlider contract:
//   - Renders the wand icon + range input + word-count preview.
//   - Live word-count updates to track the slider value × estimated chronicle.
//   - 0% and >=90% show advisory warnings.
//   - Range is 0-100 with step 5.
//   - Calls onChange with the new value as the user drags.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { CondenseSlider, CONDENSE_SLIDER_MAX, CONDENSE_SLIDER_MIN, CONDENSE_SLIDER_STEP } from './CondenseSlider'

afterEach(() => cleanup())

describe('CondenseSlider — rendering', () => {
  it('shows the percent + estimated word count text', () => {
    render(<CondenseSlider value={20} onChange={vi.fn()} estimatedChronicleWords={10000} />)
    expect(screen.getByText(/20% ≈/)).toBeTruthy()
    expect(screen.getByText(/2,000 words/)).toBeTruthy()
  })

  it('renders the range input with the expected min/max/step bounds', () => {
    render(<CondenseSlider value={20} onChange={vi.fn()} estimatedChronicleWords={5000} />)
    const range = screen.getByLabelText(/Condense percentage/i) as HTMLInputElement
    expect(range.type).toBe('range')
    expect(range.min).toBe(String(CONDENSE_SLIDER_MIN))
    expect(range.max).toBe(String(CONDENSE_SLIDER_MAX))
    expect(range.step).toBe(String(CONDENSE_SLIDER_STEP))
  })

  it('uses the supplied value as the current slider position', () => {
    render(<CondenseSlider value={35} onChange={vi.fn()} estimatedChronicleWords={8000} />)
    const range = screen.getByLabelText(/Condense percentage/i) as HTMLInputElement
    expect(range.value).toBe('35')
  })
})

describe('CondenseSlider — word-count preview', () => {
  it('updates the preview text to match value × estimatedChronicleWords / 100', () => {
    const cases: Array<{ value: number; estimated: number; expectedWords: number }> = [
      { value: 5, estimated: 14000, expectedWords: 700 },
      { value: 10, estimated: 14000, expectedWords: 1400 },
      { value: 25, estimated: 12000, expectedWords: 3000 },
      { value: 50, estimated: 8000, expectedWords: 4000 },
    ]
    for (const { value, estimated, expectedWords } of cases) {
      cleanup()
      render(<CondenseSlider value={value} onChange={vi.fn()} estimatedChronicleWords={estimated} />)
      expect(
        screen.getByText(new RegExp(`${value}% ≈ ${expectedWords.toLocaleString()} words`)),
      ).toBeTruthy()
    }
  })
})

describe('CondenseSlider — advisory warnings', () => {
  it('shows the 0% warning explaining condense will not run', () => {
    render(<CondenseSlider value={0} onChange={vi.fn()} estimatedChronicleWords={10000} />)
    expect(screen.getByText(/disables the condense pass entirely/i)).toBeTruthy()
  })

  it('shows the high-percentage warning at 90%+', () => {
    render(<CondenseSlider value={90} onChange={vi.fn()} estimatedChronicleWords={10000} />)
    expect(screen.getByText(/near-copy of the chronicle/i)).toBeTruthy()
  })

  it('does not show either warning at the typical default (20%)', () => {
    render(<CondenseSlider value={20} onChange={vi.fn()} estimatedChronicleWords={10000} />)
    expect(screen.queryByText(/disables the condense pass entirely/i)).toBeNull()
    expect(screen.queryByText(/near-copy of the chronicle/i)).toBeNull()
  })
})

describe('CondenseSlider — onChange', () => {
  it('fires onChange with the new numeric value when the user drags', () => {
    const onChange = vi.fn()
    render(<CondenseSlider value={20} onChange={onChange} estimatedChronicleWords={10000} />)
    const range = screen.getByLabelText(/Condense percentage/i) as HTMLInputElement
    fireEvent.change(range, { target: { value: '40' } })
    expect(onChange).toHaveBeenCalledWith(40)
  })

  it('snaps an off-step incoming value to the nearest valid step on display', () => {
    // If localStorage gets corrupted and stores e.g. value=23, we render
    // value=25 (snapped to step 5) rather than failing.
    render(<CondenseSlider value={23} onChange={vi.fn()} estimatedChronicleWords={10000} />)
    const range = screen.getByLabelText(/Condense percentage/i) as HTMLInputElement
    expect(range.value).toBe('25')
  })

  it('clamps a >100 incoming value to 100', () => {
    render(<CondenseSlider value={150} onChange={vi.fn()} estimatedChronicleWords={10000} />)
    const range = screen.getByLabelText(/Condense percentage/i) as HTMLInputElement
    expect(range.value).toBe('100')
  })
})
