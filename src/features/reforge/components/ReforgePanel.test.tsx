// @vitest-environment jsdom
//
// A reforge runs for minutes inside a panel whose entire header is a collapse
// toggle. The question these tests answer is the one a user asks after
// clicking that header by accident: is my run still there, and can I tell?

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ReforgePanel } from './ReforgePanel'
import { saveChronicle } from '@/features/library/lib/chronicleLibrary'
import type { ReforgeResult } from '@/features/reforge/lib/reforge'
import {
  REFORGE_COMPLETE_EVENT,
  REFORGE_RUNNING_EVENT,
  type ReforgeCompleteDetail,
} from '@/platform/lib/appEvents'

const SUMMARY = {
  id: 'chron-1',
  createdAt: '2026-09-01T10:00:00.000Z',
  campaign: 'Ashfall',
  sessionNumber: 12,
  wordCount: 5000,
  hasExtras: true,
  hasCondensed: true,
  hasGroundedTranscript: true,
}

const RECORD = {
  ...SUMMARY,
  chronicle: 'The chronicle as it stands.',
  groundedTranscript: '[Zuri (DM)] The party rides for Harrowgate.',
  extras: { jests: [], gore: [], quotes: [] },
  condensed: { narrative: 'Short version.', bulletPoints: [] },
}

vi.mock('@/features/library/lib/chronicleLibrary', async (orig) => ({
  ...(await orig<typeof import('@/features/library/lib/chronicleLibrary')>()),
  listChronicles: vi.fn(async () => [SUMMARY]),
  getChronicle: vi.fn(async () => RECORD),
  saveChronicle: vi.fn(async () => ({ id: 'chron-2' })),
}))

vi.mock('@/features/personas/lib/personas', () => ({
  getPersonas: vi.fn(async () => ({ version: 1, personas: [] })),
}))

vi.mock('@/features/lore/hooks/useLoreDocuments', () => ({
  useLoreDocuments: () => ({ documents: [], loading: false, refresh: vi.fn() }),
}))

// Never resolves by default: the run stays in flight for the whole test,
// which is the state the panel used to lose. Individual tests override it
// with a result to exercise what happens after one finishes.
const runReforge = vi.fn(
  (..._args: unknown[]): Promise<ReforgeResult> => new Promise<ReforgeResult>(() => {}),
)
vi.mock('@/features/reforge/lib/reforge', async (orig) => ({
  ...(await orig<typeof import('@/features/reforge/lib/reforge')>()),
  runReforge: (...args: unknown[]) => runReforge(...args),
  validateReforge: () => null,
}))

// The picker is its own tested component; here it is just the thing that
// hands back a model choice.
vi.mock('./ReforgeModelPicker', () => ({
  ReforgeModelPicker: ({
    open,
    onConfirm,
  }: {
    open: boolean
    onConfirm: (s: unknown) => void
  }) =>
    open ? (
      <button
        onClick={() =>
          onConfirm({
            primary: { provider: 'gemini', model: 'gemini-2.5-pro', geminiTier: 'auto', label: 'Gemini · Pro' },
            perPhase: {},
          })
        }
      >
        confirm-model
      </button>
    ) : null,
}))

/** Each step below waits up to this long rather than the 1s default: the
 *  panel's first render pulls in the provider SDKs, which on a busy CI runner
 *  can take more than a second without anything being wrong. */
const WAIT = { timeout: 5_000 }

/** Pick a chronicle and start a reforge; leaves the run in flight. Returns the
 *  chronicle dropdown, which is the only combobox before the run adds more. */
async function startRun() {
  render(<ReforgePanel />)
  fireEvent.click(screen.getByText('Reforge a Chronicle'))
  const select = (await screen.findByRole('combobox', {}, WAIT)) as HTMLSelectElement
  fireEvent.change(select, { target: { value: 'chron-1' } })
  const go = await screen.findByRole('button', { name: /Choose model & reforge/i }, WAIT)
  fireEvent.click(go)
  fireEvent.click(await screen.findByText('confirm-model', {}, WAIT))
  await waitFor(() => expect(runReforge).toHaveBeenCalled(), WAIT)
  return select
}

describe('ReforgePanel — a run in flight stays reachable', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => cleanup())

  it('keeps the run visible after the header is clicked', async () => {
    await startRun()
    // Open: the progress bar is in the body.
    expect(screen.getByRole('progressbar')).toBeTruthy()

    // The click that used to lose it.
    fireEvent.click(screen.getByText('Reforge a Chronicle'))

    // Collapsed, but the run is still announced and still measured.
    expect(screen.getByText('Running')).toBeTruthy()
    expect(screen.getByRole('progressbar')).toBeTruthy()
    // And the idle sales copy is not shown over a live run.
    expect(screen.queryByText(/Redo extras \/ condense/)).toBeNull()
  })

  it('reopens onto the same run rather than a fresh form', async () => {
    await startRun()
    fireEvent.click(screen.getByText('Reforge a Chronicle')) // collapse
    fireEvent.click(screen.getByText('Reforge a Chronicle')) // reopen

    expect(screen.getByRole('progressbar')).toBeTruthy()
    // Still the run, not the button that would start a second one.
    expect(screen.queryByRole('button', { name: /Choose model & reforge/i })).toBeNull()
    expect(screen.getByRole('button', { name: /Cancel/i })).toBeTruthy()
    expect(runReforge).toHaveBeenCalledTimes(1)
  })

  it('keeps the run on screen when the source selection is cleared under it', async () => {
    const select = await startRun()
    // Clearing the dropdown nulls the derived input. The run does not belong
    // to that input any more; it is already in flight.
    fireEvent.change(select, { target: { value: '' } })

    await waitFor(() => expect(screen.getByRole('progressbar')).toBeTruthy())
    expect(screen.getByRole('button', { name: /Cancel/i })).toBeTruthy()
  })

  it('tells the surfaces above it that a run started', async () => {
    const seen: boolean[] = []
    const listener = (e: Event) => seen.push(((e as CustomEvent).detail as { running: boolean }).running)
    window.addEventListener(REFORGE_RUNNING_EVENT, listener)
    try {
      await startRun()
      expect(seen).toEqual([true])
    } finally {
      window.removeEventListener(REFORGE_RUNNING_EVENT, listener)
    }
  })
})

describe('ReforgePanel — a kept phase survives the run that skipped it', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => cleanup())

  it('saves and promotes the whole artefact, not just the phases it redid', async () => {
    // The data-loss this guards: runReforge returns only what it was asked to
    // produce, so redoing extras alone comes back with condensed: undefined.
    // Saving that verbatim would drop a condense the user explicitly chose to
    // keep, and the new library entry would be a delta pretending to be a
    // finished session.
    runReforge.mockImplementationOnce(async () => ({
      chronicle: RECORD.chronicle,
      extras: { jests: ['fresh jest'], gore: [], quotes: [] },
      condensed: undefined,
      chronicleRegenerated: false,
    }))
    const promoted: ReforgeCompleteDetail[] = []
    const listener = (e: Event) => promoted.push((e as CustomEvent).detail as ReforgeCompleteDetail)
    window.addEventListener(REFORGE_COMPLETE_EVENT, listener)
    try {
      await startRun()
      await waitFor(() => expect(saveChronicle).toHaveBeenCalled())

      const saved = vi.mocked(saveChronicle).mock.calls[0][0] as {
        extras?: { jests: string[] }
        condensed?: { narrative: string }
      }
      expect(saved.extras?.jests).toEqual(['fresh jest'])
      // The condense this run did not touch, carried forward intact.
      expect(saved.condensed?.narrative).toBe(RECORD.condensed.narrative)

      await waitFor(() => expect(promoted).toHaveLength(1))
      expect(promoted[0].extras?.jests).toEqual(['fresh jest'])
      expect(promoted[0].condensed?.narrative).toBe(RECORD.condensed.narrative)
    } finally {
      window.removeEventListener(REFORGE_COMPLETE_EVENT, listener)
    }
  })

  it('prefers what the run produced over what it carried forward', async () => {
    // The other direction: a phase that DID run must not be overwritten by the
    // older copy it was replacing.
    runReforge.mockImplementationOnce(async () => ({
      chronicle: RECORD.chronicle,
      extras: undefined,
      condensed: { narrative: 'newly condensed', bulletPoints: ['new'] },
      chronicleRegenerated: false,
    }))
    await startRun()
    await waitFor(() => expect(saveChronicle).toHaveBeenCalled())
    const saved = vi.mocked(saveChronicle).mock.calls[0][0] as {
      extras?: { jests: string[] }
      condensed?: { narrative: string }
    }
    expect(saved.condensed?.narrative).toBe('newly condensed')
    expect(saved.extras?.jests).toEqual(RECORD.extras.jests)
  })
})
