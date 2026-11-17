/** @vitest-environment jsdom */
// The transcription view's contract with the person watching it:
//   - silence escalates: amber "still working" after a minute, red "may be
//     stuck" after the stall budget, each with copy that says what to do;
//   - the progress bar is in audio, with an accessible value text;
//   - a CPU fallback is visible in the header pill;
//   - a finished run reads as finished: no progress bar left full at 100 %,
//     a done line that keeps the counts and points to the green hand-off;
//   - a failed run is announced once, as an alert;
//   - a server that predates the liveness fields (no runState, no totals)
//     still renders the finished state and the green hand-off button;
//   - there is exactly one live region and the ticking clock never
//     touches it, so a screen reader is not read the seconds.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { LiveSessionResponse } from '@/features/transcription/lib/liveSession'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() },
}))

vi.mock('@/features/transcription/lib/liveSession', () => ({
  getLiveSession: vi.fn(),
  refreshLiveLabels: vi.fn(async () => undefined),
}))

vi.mock('@/features/corrections/lib/speakers', () => ({
  getSpeakers: vi.fn(async () => ({ version: 1, speakers: [] })),
  putSpeakers: vi.fn(),
  findSpeakerFor: vi.fn(() => undefined),
}))

import { getLiveSession } from '@/features/transcription/lib/liveSession'
import { LiveTranscript } from './LiveTranscript'

const MIN = 60_000
const SESSION = 'sess-1'

function payload(over: Partial<LiveSessionResponse> = {}, now = Date.now()): LiveSessionResponse {
  return {
    sessionId: SESSION,
    active: true,
    pending: 0,
    processed: 2,
    enqueued: 12,
    cueCount: 340,
    errors: [],
    participants: [],
    sbv: '',
    finalized: false,
    serverNow: now,
    ...over,
  }
}

function transcribing(now: number, over: Partial<LiveSessionResponse> = {}): LiveSessionResponse {
  return payload(
    {
      runState: 'transcribing',
      startedAt: now - 14 * MIN,
      lastActivityAt: now - 5_000,
      totalAudioMs: 243 * MIN,
      processedAudioMs: 72 * MIN,
      utterancesTotal: 12,
      utterancesDone: 2,
      current: {
        utteranceId: 'u3',
        speakerDisplay: 'Zuri',
        audioMs: 58 * MIN,
        startedAt: now - 3 * MIN,
        attempt: 1,
        progressMs: 4 * MIN,
      },
      engine: {
        name: 'faster-whisper',
        model: 'large-v3',
        device: 'cuda',
        computeType: 'float16',
        fallback: false,
      },
      throughput: 18,
      failure: null,
      ...over,
    },
    now,
  )
}

/** Let the poll's promise chain settle inside act, without real timers. */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve()
  })
}

beforeEach(() => {
  vi.mocked(getLiveSession).mockReset()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('LiveTranscript liveness', () => {
  it('90 s of silence while transcribing shows the amber "still working" copy', async () => {
    const now = Date.now()
    vi.mocked(getLiveSession).mockResolvedValue(
      transcribing(now, { lastActivityAt: now - 90_000 }),
    )
    render(<LiveTranscript sessionId={SESSION} />)
    expect(
      await screen.findByText(/Whisper is still working on this track — long tracks can take several minutes/),
    ).toBeInTheDocument()
    expect(screen.queryByText(/this may be stuck/)).toBeNull()
  })

  it('15 min of silence shows the red "may be stuck" copy with a link to the error list', async () => {
    const now = Date.now()
    vi.mocked(getLiveSession).mockResolvedValue(
      transcribing(now, { lastActivityAt: now - 15 * MIN, throughput: null, utterancesDone: 0 }),
    )
    render(<LiveTranscript sessionId={SESSION} />)
    expect(await screen.findByText(/No progress for 15 minutes — this may be stuck/)).toBeInTheDocument()
    const link = screen.getByRole('link', { name: /See the error list/ })
    expect(link.getAttribute('href')).toBe(`#live-errors-${SESSION}`)
    expect(document.getElementById(`live-errors-${SESSION}`)).not.toBeNull()
  })

  it('the progress bar is in audio, with the percentage and a readable value text', async () => {
    const now = Date.now()
    vi.mocked(getLiveSession).mockResolvedValue(transcribing(now))
    render(<LiveTranscript sessionId={SESSION} />)
    const bar = await screen.findByRole('progressbar', { name: 'Audio transcribed' })
    // 72 min of 243 min is 29.6 %, shown as a whole number.
    expect(bar.getAttribute('aria-valuenow')).toBe('30')
    expect(bar.getAttribute('aria-valuetext')).toBe('1h 12m of 4h 03m')
    expect(screen.getByText(/Track 3 of 12 — Zuri \(58 min\)/)).toBeInTheDocument()
    expect(screen.getByText(/≈18× realtime/)).toBeInTheDocument()
    expect(screen.getByText(/ETA ~9 min remaining/)).toBeInTheDocument()
  })

  it('a CPU fallback is named in the header pill', async () => {
    const now = Date.now()
    vi.mocked(getLiveSession).mockResolvedValue(
      transcribing(now, {
        engine: {
          name: 'faster-whisper',
          model: 'large-v3',
          device: 'cpu',
          computeType: 'int8',
          fallback: true,
        },
      }),
    )
    render(<LiveTranscript sessionId={SESSION} />)
    expect(await screen.findByText('CPU (fallback)')).toBeInTheDocument()
    expect(screen.getByText('large-v3')).toBeInTheDocument()
  })

  it('a finished run shows a done line instead of a full progress bar, and points to the hand-off', async () => {
    const now = Date.now()
    vi.mocked(getLiveSession).mockResolvedValue(
      transcribing(now, {
        runState: 'done',
        active: false,
        finalized: true,
        current: null,
        processedAudioMs: 243 * MIN,
        utterancesDone: 12,
        sbv: '0:00:00.000,0:00:01.000\n[PC-Alpha] hello\n',
      }),
    )
    render(<LiveTranscript sessionId={SESSION} />)
    expect(await screen.findByText('Transcription finished')).toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(screen.queryByText('100%')).toBeNull()
    expect(screen.queryByText(/ETA/)).toBeNull()
    // The counts stay: in the done line and in the stat tiles.
    expect(screen.getByText(/12 of 12 tracks transcribed/)).toBeInTheDocument()
    expect(screen.getByText(/≈18× realtime/)).toBeInTheDocument()
    expect(screen.getByText('340')).toBeInTheDocument()
    expect(screen.getByText(/Next: press/)).toHaveTextContent(
      'Next: press Use this transcript for refinement at the foot of this panel.',
    )
    const button = screen.getByRole('button', {
      name: /Use this transcript for refinement/,
    }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
  })

  it('a finished run with errors says so in the done line', async () => {
    const now = Date.now()
    vi.mocked(getLiveSession).mockResolvedValue(
      transcribing(now, {
        runState: 'done',
        active: false,
        finalized: true,
        current: null,
        processedAudioMs: 243 * MIN,
        utterancesDone: 12,
        errors: ['u7: decode failed', 'note: moved to the CPU engine'],
        sbv: '0:00:00.000,0:00:01.000\n[PC-Alpha] hello\n',
      }),
    )
    render(<LiveTranscript sessionId={SESSION} />)
    // Notes are not failures, so one error, not two.
    expect(await screen.findByText('Transcription finished with 1 error')).toBeInTheDocument()
    expect(screen.queryByText('Transcription finished')).toBeNull()
    expect(screen.queryByRole('progressbar')).toBeNull()
  })

  it('a failed run renders its message exactly once, as an alert', async () => {
    const now = Date.now()
    vi.mocked(getLiveSession).mockResolvedValue(
      payload({ runState: 'failed', active: false, failure: 'CUDA out of memory' }, now),
    )
    render(<LiveTranscript sessionId={SESSION} />)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('CUDA out of memory')
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.queryByRole('button', { name: /Use this transcript/ })).toBeNull()
  })

  it('an interrupted run tells the user how to resume', async () => {
    const now = Date.now()
    vi.mocked(getLiveSession).mockResolvedValue(
      payload({ runState: 'interrupted', active: false, utterancesDone: 4, utterancesTotal: 12 }, now),
    )
    render(<LiveTranscript sessionId={SESSION} />)
    expect(
      await screen.findByText(/interrupted by a server restart — reopen the session from the list and press Process to resume/),
    ).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('the old payload shape, finalised, renders the green button and throws nothing', async () => {
    const sbv = '0:00:00.000,0:00:01.000\n[Zuri] hello\n'
    vi.mocked(getLiveSession).mockResolvedValue({
      sessionId: SESSION,
      active: false,
      pending: 0,
      processed: 3,
      enqueued: 3,
      cueCount: 40,
      errors: [],
      participants: [],
      sbv,
      finalized: true,
    })
    const onSend = vi.fn()
    render(<LiveTranscript sessionId={SESSION} onSendToRefinement={onSend} />)
    const button = (await screen.findByRole('button', {
      name: /Use this transcript for refinement/,
    })) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    expect(onSend).toHaveBeenCalledWith(sbv)
    expect(screen.getByText('Transcript ready')).toBeInTheDocument()
    expect(screen.queryByText(/Recording/)).toBeNull()
  })

  it('has exactly one live region, and the clock ticking does not change its text', async () => {
    vi.useFakeTimers()
    const now = 1_700_000_000_000
    vi.setSystemTime(now)
    vi.mocked(getLiveSession).mockResolvedValue(transcribing(now))
    render(<LiveTranscript sessionId={SESSION} />)
    await settle()

    const regions = screen.getAllByRole('status')
    expect(regions).toHaveLength(1)
    const region = regions[0]
    expect(region.getAttribute('aria-live')).toBe('polite')
    expect(region.getAttribute('aria-atomic')).toBe('true')
    const before = region.textContent
    expect(before).toMatch(/Transcribing on CUDA with large-v3/)
    expect(screen.getByText(/last update 5s ago/)).toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })

    // The visible counter moved; the live region did not.
    expect(screen.getByText(/last update 6s ago/)).toBeInTheDocument()
    expect(region.textContent).toBe(before)
    expect(getLiveSession).toHaveBeenCalledTimes(1)
  })

  it('backs off while the tab is hidden and polls at once when it returns', async () => {
    vi.useFakeTimers()
    const now = 1_700_000_000_000
    vi.setSystemTime(now)
    vi.mocked(getLiveSession).mockResolvedValue(transcribing(now))
    render(<LiveTranscript sessionId={SESSION} />)
    await settle()
    expect(getLiveSession).toHaveBeenCalledTimes(1)

    // Hide the tab before the next poll is scheduled to run.
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    try {
      // The poll scheduled while visible still fires at 2 s; the one it
      // schedules afterwards waits the hidden interval.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000)
      })
      await settle()
      expect(getLiveSession).toHaveBeenCalledTimes(2)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000)
      })
      expect(getLiveSession).toHaveBeenCalledTimes(2)

      // Back to the foreground: an immediate poll, not a wait for the slow timer.
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'))
      })
      await settle()
      expect(getLiveSession).toHaveBeenCalledTimes(3)
    } finally {
      delete (document as unknown as Record<string, unknown>).hidden
      delete (document as unknown as Record<string, unknown>).visibilityState
    }
  })
})
