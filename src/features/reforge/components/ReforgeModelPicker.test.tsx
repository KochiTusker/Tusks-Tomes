// @vitest-environment jsdom

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ReforgeModelPicker } from './ReforgeModelPicker'

// The dialog's three data sources, stubbed. The point of these tests is the
// row/filter/grade logic, not the fetches.
vi.mock('@/features/providers/lib/cloudKeys', async (orig) => ({
  ...(await orig<typeof import('@/features/providers/lib/cloudKeys')>()),
  fetchConfiguredCloudKeyOptions: vi.fn(async () => [
    {
      id: 'openrouter',
      provider: 'openrouter',
      slot: 'openrouter',
      label: 'OpenRouter',
      short: 'OpenRouter',
    },
  ]),
}))

vi.mock('@/features/providers/hooks/useAvailabilityCache', () => ({
  useAvailabilityCache: () => ({ cache: {}, refresh: vi.fn() }),
}))

// Two graded models and one ungraded, so the "graded only" narrowing has
// something to remove and the sort has something to order.
const base = {
  // Enough headroom that structuralBlockers stays quiet — otherwise every
  // candidate grades F and the per-phase comparison measures nothing.
  contextLength: 1_000_000,
  maxCompletionTokens: null,
  supportsStructuredOutputs: true,
  leaksReasoning: false,
  inputPerM: 1,
  outputPerM: 1,
  isFree: false,
  isModerated: false,
}
const CATALOGUE = [
  { ...base, id: 'z-ai/glm-5.2', name: 'GLM 5.2' },
  { ...base, id: 'moonshotai/kimi-k3', name: 'Kimi K3' },
  { ...base, id: '~google/gemini-pro-latest', name: 'Gemini Pro' },
  { ...base, id: 'some/never-measured-model', name: 'Unmeasured' },
]

vi.mock('@/features/providers/lib/openrouterModelsClient', async (orig) => ({
  ...(await orig<typeof import('@/features/providers/lib/openrouterModelsClient')>()),
  getOpenRouterCatalogue: vi.fn(async () => ({ models: CATALOGUE })),
  isTextPipelineModel: () => true,
}))

const noop = () => {}

describe('ReforgeModelPicker', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => {
    cleanup()
    localStorage.clear() // the show-all tick persists, and must not leak between tests
  })

  it('renders one model row per phase being reforged', async () => {
    render(
      <ReforgeModelPicker
        open
        phases={['phase3', 'phase4']}
        onCancel={noop}
        onConfirm={noop}
      />,
    )
    await waitFor(() => {
      // Ids are phase-scoped, so their presence IS the per-phase row.
      expect(document.getElementById('reforge-phase3-model')).not.toBeNull()
      expect(document.getElementById('reforge-phase4-model')).not.toBeNull()
    })
    expect(document.getElementById('reforge-phase6-model')).toBeNull()
  })

  it('collapses to a single unlabelled row when one phase is selected', async () => {
    render(
      <ReforgeModelPicker open phases={['phase4']} onCancel={noop} onConfirm={noop} />,
    )
    await waitFor(() => {
      expect(document.getElementById('reforge-phase4-model')).not.toBeNull()
    })
    expect(document.querySelectorAll('select[id$="-model"]')).toHaveLength(1)
    // The per-phase framing is noise when there is only one phase.
    expect(screen.queryByText('Choose a model per phase')).toBeNull()
  })

  it('grades each row against ITS OWN phase, not the run as a whole', async () => {
    render(
      <ReforgeModelPicker
        open
        phases={['phase3', 'phase4']}
        onCancel={noop}
        onConfirm={noop}
      />,
    )
    await waitFor(() => {
      expect(document.getElementById('reforge-phase3-model')).not.toBeNull()
    })
    const p3 = document.getElementById('reforge-phase3-model') as HTMLSelectElement
    const p4 = document.getElementById('reforge-phase4-model') as HTMLSelectElement

    const textFor = (sel: HTMLSelectElement, id: string) =>
      [...sel.options].find((o) => o.value === id)?.textContent ?? ''

    // Gemini Pro is measured B on chronicle through OpenRouter and C on
    // extras, where it reads DM narration as spoken dialogue. If the rows
    // shared a grade the two strings would match — that they differ is the
    // whole point of grading per phase.
    expect(textFor(p3, '~google/gemini-pro-latest')).toContain('B')
    expect(textFor(p4, '~google/gemini-pro-latest')).toContain('C')
  })

  it('hides ungraded models until the filter is unticked, and never grades them', async () => {
    render(
      <ReforgeModelPicker open phases={['phase4']} onCancel={noop} onConfirm={noop} />,
    )
    await waitFor(() => {
      expect(document.getElementById('reforge-phase4-model')).not.toBeNull()
    })
    const sel = document.getElementById('reforge-phase4-model') as HTMLSelectElement
    const ids = [...sel.options].map((o) => o.value)
    expect(ids).toContain('z-ai/glm-5.2')
    // Default is graded-only, so the unmeasured entry is withheld rather than
    // shown with an empty grade.
    expect(ids).not.toContain('some/never-measured-model')
  })

  it('says what free models cost once the show-all tick is on', async () => {
    render(
      <ReforgeModelPicker open phases={['phase4']} onCancel={noop} onConfirm={noop} />,
    )
    await waitFor(() => {
      expect(document.getElementById('reforge-phase4-model')).not.toBeNull()
    })
    // Nothing to say while free models are withheld.
    expect(screen.queryByText(/Free models are now offered/)).toBeNull()
    fireEvent.click(screen.getByLabelText('Show free, small and lower-performing models'))
    // The tick puts free models on offer, and the same note the routing rows
    // show has to appear here too: this is the surface where one gets chosen.
    expect(screen.getByText(/Free models are now offered/)).not.toBeNull()
  })

  it('keeps an already-chosen ungraded model offered when the graded-only filter comes back on', async () => {
    render(
      <ReforgeModelPicker open phases={['phase4']} onCancel={noop} onConfirm={noop} />,
    )
    await waitFor(() => {
      expect(document.getElementById('reforge-phase4-model')).not.toBeNull()
    })
    const filter = screen.getByLabelText('Show only models graded by the maintainer')
    const sel = document.getElementById('reforge-phase4-model') as HTMLSelectElement
    fireEvent.click(filter) // off: the unmeasured model appears
    await waitFor(() => {
      expect([...sel.options].map((o) => o.value)).toContain('some/never-measured-model')
    })
    fireEvent.change(sel, { target: { value: 'some/never-measured-model' } })
    fireEvent.click(filter) // back on: the choice must survive, not snap to the top grade
    await waitFor(() => {
      expect(sel.value).toBe('some/never-measured-model')
    })
  })
})
