// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  message: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: toastMock }))

const getCatalogue = vi.hoisted(() => vi.fn())
vi.mock('@/features/providers/lib/openrouterModelsClient', () => ({ getOpenRouterCatalogue: getCatalogue }))

const probe = vi.hoisted(() => vi.fn())
vi.mock('@/features/providers/lib/providerSettings', () => ({ probeProviderKey: probe }))

import { ModelListFreshness } from './ModelListFreshness'
import type { CloudKeyOption } from '@/features/providers/lib/cloudKeys'

function opt(id: CloudKeyOption['id']): CloudKeyOption {
  return { id, provider: 'openrouter', label: id, short: id, slot: 'openrouter' }
}

const EPOCH = new Date(0).toISOString()
const OLD = '2026-01-01T00:00:00.000Z'
const NEWER = '2026-02-01T00:00:00.000Z'

describe('ModelListFreshness', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reads an epoch-0 or missing slot as never checked', () => {
    render(
      <ModelListFreshness
        cloudKeyOptions={[opt('claude-code'), opt('gemini-paid')]}
        availability={{ claudeCode: { fetchedAt: EPOCH, advertised: [], probed: [] } }}
      />,
    )
    expect(screen.getAllByText('never checked')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Check Gemini paid key' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Check Claude Code' })).toBeTruthy()
  })

  it('names the catalogue row by what is configured and falls back to the Claude Code slot', () => {
    render(
      <ModelListFreshness
        cloudKeyOptions={[opt('openrouter'), opt('claude-code')]}
        availability={{ claudeCode: { fetchedAt: OLD, advertised: [], probed: [] } }}
      />,
    )
    expect(screen.getByText('OpenRouter and Claude Code')).toBeTruthy()
    expect(screen.queryByText('never checked')).toBeNull()
    expect(screen.getByRole('button', { name: 'Re-check OpenRouter and Claude Code' })).toBeTruthy()
  })

  it('warns, and does not report success, when the timestamp does not advance', async () => {
    getCatalogue.mockResolvedValue({ fetchedAt: OLD, models: [{ id: 'a' }], providerPolicies: [] })
    const onRefreshed = vi.fn()
    render(
      <ModelListFreshness
        cloudKeyOptions={[opt('openrouter')]}
        availability={{}}
        catalogueFetchedAt={OLD}
        onCatalogueRefreshed={onRefreshed}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Re-check OpenRouter' }))
    await waitFor(() => expect(toastMock.warning).toHaveBeenCalled())
    expect(toastMock.success).not.toHaveBeenCalled()
    expect(onRefreshed).not.toHaveBeenCalled()
  })

  it('reports success and hands over the catalogue when the timestamp advances', async () => {
    const fresh = { fetchedAt: NEWER, models: [{ id: 'a' }, { id: 'b' }], providerPolicies: [] }
    getCatalogue.mockResolvedValue(fresh)
    const onRefreshed = vi.fn()
    render(
      <ModelListFreshness
        cloudKeyOptions={[opt('openrouter')]}
        availability={{}}
        catalogueFetchedAt={OLD}
        onCatalogueRefreshed={onRefreshed}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Re-check OpenRouter' }))
    await waitFor(() => expect(toastMock.success).toHaveBeenCalled())
    expect(getCatalogue).toHaveBeenCalledWith({ force: true })
    expect(onRefreshed).toHaveBeenCalledWith(fresh)
  })

  it('does not pass an empty list on when the refresh errors', async () => {
    getCatalogue.mockResolvedValue({
      fetchedAt: null,
      models: [],
      providerPolicies: [],
      error: 'HTTP 502',
    })
    const onRefreshed = vi.fn()
    render(
      <ModelListFreshness
        cloudKeyOptions={[opt('openrouter')]}
        availability={{}}
        catalogueFetchedAt={OLD}
        onCatalogueRefreshed={onRefreshed}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Re-check OpenRouter' }))
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled())
    expect(onRefreshed).not.toHaveBeenCalled()
    expect(toastMock.success).not.toHaveBeenCalled()
  })

  it('probes the Gemini paid key and reports accessible over total', async () => {
    probe.mockResolvedValue({
      ok: true,
      availability: {
        fetchedAt: NEWER,
        advertised: [],
        probed: [{ accessible: true }, { accessible: false }, { accessible: true }],
      },
    })
    render(<ModelListFreshness cloudKeyOptions={[opt('gemini-paid')]} availability={{}} />)
    await userEvent.click(screen.getByRole('button', { name: 'Check Gemini paid key' }))
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith(expect.stringContaining('2 of 3')))
    expect(probe).toHaveBeenCalledWith('gemini')
  })

  it('shows Codex as a built-in list with no button', () => {
    render(<ModelListFreshness cloudKeyOptions={[opt('codex')]} availability={{}} />)
    expect(screen.getByText('built-in list, updated with the app')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })
})
