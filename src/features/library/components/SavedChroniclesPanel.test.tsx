/** @vitest-environment jsdom */
// SavedChroniclesPanel contract (reading a saved chronicle):
//   - "Chronicle (.md)" downloads the same markdown as the result view,
//     extras included.
//   - Edit swaps the prose for a textarea; Save PUTs only the chronicle and
//     shows the edited text; Cancel restores the original without a PUT.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { buildMarkdown } from '../lib/exportMarkdown'

const record = {
  id: 'r1',
  createdAt: '2026-01-01T00:00:00.000Z',
  campaign: 'Acme',
  sessionNumber: 3,
  chronicle: 'PC-Alpha strode in.',
  extras: { jests: ['a jest'], gore: [], quotes: [{ speaker: 'X', line: 'Y', kind: 'funny' as const }] },
  condensed: { narrative: 'short', bulletPoints: ['b'] },
}

const lib = vi.hoisted(() => ({
  listChronicles: vi.fn(),
  getChronicle: vi.fn(),
  updateChronicle: vi.fn(),
  deleteChronicle: vi.fn(),
}))
vi.mock('@/features/library/lib/chronicleLibrary', () => ({
  ...lib,
  CHRONICLE_LIBRARY_EVENT: 'sbts:chronicle-library-changed',
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))

import { SavedChroniclesPanel } from './SavedChroniclesPanel'

beforeEach(() => {
  lib.listChronicles.mockResolvedValue([
    {
      id: 'r1',
      createdAt: record.createdAt,
      campaign: 'Acme',
      sessionNumber: 3,
      wordCount: 3,
      hasExtras: true,
      hasCondensed: true,
      hasGroundedTranscript: false,
      hasChronicle: true,
    },
  ])
  lib.getChronicle.mockResolvedValue(record)
  lib.updateChronicle.mockImplementation(async (_id: string, patch: { chronicle: string }) => ({
    ...record,
    ...patch,
  }))
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

async function openRow() {
  render(<SavedChroniclesPanel />)
  fireEvent.click(await screen.findByText(/Acme — Session 3/))
  await screen.findByRole('button', { name: /Chronicle \(\.md\)/ })
}

describe('SavedChroniclesPanel — Markdown download', () => {
  it('writes the same file as the result view, extras included', async () => {
    let blob: Blob | null = null
    URL.createObjectURL = vi.fn((b: Blob | MediaSource) => {
      blob = b as Blob
      return 'blob:x'
    })
    URL.revokeObjectURL = vi.fn()
    await openRow()
    fireEvent.click(screen.getByRole('button', { name: /Chronicle \(\.md\)/ }))
    const text = await (blob as unknown as Blob).text()
    expect(text).toBe(
      buildMarkdown({
        campaign: 'Acme',
        sessionNumber: 3,
        chronicle: record.chronicle,
        extras: record.extras,
        condensed: record.condensed,
      }),
    )
    expect(text).toContain('## Jests')
    expect(text).toContain('## Quotes')
  })
})

describe('SavedChroniclesPanel — editing', () => {
  it('Save PUTs the edited chronicle and shows it', async () => {
    await openRow()
    fireEvent.click(screen.getByRole('button', { name: /Edit/ }))
    fireEvent.change(screen.getByLabelText('Chronicle text'), { target: { value: 'PC-Beta strode in.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(lib.updateChronicle).toHaveBeenCalledWith('r1', { chronicle: 'PC-Beta strode in.' }),
    )
    expect(await screen.findByText('PC-Beta strode in.')).toBeTruthy()
    expect(screen.queryByLabelText('Chronicle text')).toBeNull()
  })

  it('Cancel restores the original without saving', async () => {
    await openRow()
    fireEvent.click(screen.getByRole('button', { name: /Edit/ }))
    fireEvent.change(screen.getByLabelText('Chronicle text'), { target: { value: 'changed' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(lib.updateChronicle).not.toHaveBeenCalled()
    expect(screen.getByText('PC-Alpha strode in.')).toBeTruthy()
  })

  it('Save with no change does not PUT', async () => {
    await openRow()
    fireEvent.click(screen.getByRole('button', { name: /Edit/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(lib.updateChronicle).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('Chronicle text')).toBeNull()
  })
})
