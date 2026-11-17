// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PhaseModelPicker } from './PhaseModelPicker'
import type { PhaseOption } from '@/features/routing/lib/phaseOptions'

function option(over: Partial<PhaseOption>): PhaseOption {
  return {
    key: 'k',
    modelId: 'm',
    provider: 'openrouter',
    providerLabel: 'OpenRouter',
    connection: 'openrouter',
    vendor: 'vendor',
    grade: 'untested',
    cost: 1,
    pickRank: Number.MAX_SAFE_INTEGER,
    tested: false,
    mature: false,
    ...over,
  }
}

const CHOSEN = option({
  key: 'cloud:gemini-paid:gemini-native-model',
  modelId: 'gemini-native-model',
  provider: 'gemini',
  providerLabel: 'Gemini',
  connection: 'gemini',
  vendor: 'google',
})

/** Enough graded OpenRouter models to push the connection folders down. */
const GRADED = Array.from({ length: 40 }, (_, i) =>
  option({ key: `cloud:openrouter:v/m${i}`, modelId: `v/m${i}`, grade: 'B' }),
)

const noop = () => {}

describe('PhaseModelPicker', () => {
  it('shows the head of a long Recommended list and the rest on request', async () => {
    render(
      <PhaseModelPicker phase="phase3" options={GRADED} value={null} onSelect={noop} onCancel={noop} />,
    )
    expect(screen.queryByText('v/m39')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Show all 40 recommended' }))
    expect(screen.getByText('v/m39')).toBeTruthy()
  })

  it('opens on the folder holding the current choice', () => {
    render(
      <PhaseModelPicker
        phase="phase3"
        options={[...GRADED, CHOSEN]}
        value={CHOSEN.key}
        onSelect={noop}
        onCancel={noop}
      />,
    )
    expect(screen.getByText('gemini-native-model')).toBeTruthy()
  })

  it('opens that folder once the lists arrive, if they arrive after the picker opened', async () => {
    const onSelect = vi.fn()
    const { rerender } = render(
      <PhaseModelPicker phase="phase3" options={[]} value={CHOSEN.key} onSelect={onSelect} onCancel={noop} />,
    )
    expect(screen.queryByText('gemini-native-model')).toBeNull()
    rerender(
      <PhaseModelPicker
        phase="phase3"
        options={[...GRADED, CHOSEN]}
        value={CHOSEN.key}
        onSelect={onSelect}
        onCancel={noop}
      />,
    )
    expect(await screen.findByText('gemini-native-model')).toBeTruthy()
  })
})
