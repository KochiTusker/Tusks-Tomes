// @vitest-environment jsdom

// The sessions list is the only surface that outlives the Upload panel: a
// job started from here, or one restored after a restart, had no way back
// into the live transcript view. These tests pin the row's "View
// transcript" toggle and the status line that prefers audio time over an
// utterance percentage.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    message: vi.fn(),
  }),
}))

// The live view is another stream's concern. The stub proves which session
// it was handed and lets a test drive its hand-off callback.
vi.mock('./LiveTranscript', () => ({
  LiveTranscript: ({
    sessionId,
    onSendToRefinement,
  }: {
    sessionId: string
    onSendToRefinement?: (sbv: string) => void
  }) => (
    <div data-testid="live-transcript">
      {sessionId}
      <button type="button" onClick={() => onSendToRefinement?.('sbv body')}>
        Use this transcript
      </button>
    </div>
  ),
}))

vi.mock('@/features/transcription/lib/multitrackUpload', () => ({
  deleteSessionAudio: vi.fn(),
}))

vi.mock('@/features/transcription/lib/sessionsClient', () => ({
  listSessions: vi.fn(),
  getTranscribeStatus: vi.fn(),
  deleteSession: vi.fn(),
  downloadSbv: vi.fn(),
  sbvDownloadUrl: (id: string) => `/api/sessions/${id}/sbv`,
  startTranscribe: vi.fn(),
}))

import {
  getTranscribeStatus,
  listSessions,
  type SessionManifest,
  type TranscribeProgress,
} from '@/features/transcription/lib/sessionsClient'
import { fmtAudioMs, processingLabel, SessionsList } from './SessionsList'

const RUNNING_ID = 'aaaaaaaa-0000-4000-8000-000000000001'
const PROCESSED_ID = 'bbbbbbbb-0000-4000-8000-000000000002'
const EMPTY_ID = 'cccccccc-0000-4000-8000-000000000003'

function manifest(over: Partial<SessionManifest> & { sessionId: string }): SessionManifest {
  return {
    version: 1,
    guildId: 'guild',
    voiceChannelId: 'channel',
    voiceChannelName: 'Table',
    startedAt: '2026-01-01T19:00:00.000Z',
    endedAt: '2026-01-01T23:03:00.000Z',
    participants: [
      {
        discordUserId: 'speaker-one',
        utterances: [
          {
            utteranceId: 'ut-1',
            startedAtMs: 0,
            endedAtMs: 60_000,
            filename: 'speaker-one.flac',
            durationMs: 60_000,
          },
        ],
      },
    ],
    processing: { transcribedAt: null, sbvPath: null },
    ...over,
  }
}

const HOUR = 3_600_000
const MINUTE = 60_000

const runningWithAudio: TranscribeProgress = {
  state: 'running',
  runState: 'transcribing',
  utterancesTotal: 40,
  utterancesDone: 12,
  errors: [],
  startedAt: 1,
  processedAudioMs: 1 * HOUR + 12 * MINUTE,
  totalAudioMs: 4 * HOUR + 3 * MINUTE,
}

const runningLegacy: TranscribeProgress = {
  state: 'running',
  utterancesTotal: 40,
  utterancesDone: 12,
  errors: [],
  startedAt: 1,
}

describe('fmtAudioMs', () => {
  it('reads like a person would say it', () => {
    expect(fmtAudioMs(0)).toBe('0s')
    expect(fmtAudioMs(40_000)).toBe('40s')
    expect(fmtAudioMs(12 * MINUTE)).toBe('12m')
    expect(fmtAudioMs(1 * HOUR + 12 * MINUTE)).toBe('1h 12m')
    expect(fmtAudioMs(4 * HOUR + 3 * MINUTE)).toBe('4h 03m')
  })
})

describe('processingLabel', () => {
  const recorded = manifest({ sessionId: RUNNING_ID })

  it('prefers audio figures when the server reports them', () => {
    expect(processingLabel(recorded, runningWithAudio)).toBe(
      'Transcribing · 1h 12m of 4h 03m audio (12 of 40 tracks)',
    )
  })

  it('falls back to the utterance percentage for an older server', () => {
    expect(processingLabel(recorded, runningLegacy)).toBe('Transcribing 30% (12/40)')
  })

  it('names an interrupted run and a failed run', () => {
    expect(processingLabel(recorded, { ...runningLegacy, runState: 'interrupted' })).toMatch(
      /^Interrupted/,
    )
    expect(processingLabel(recorded, { ...runningLegacy, runState: 'failed' })).toBe('Failed')
    expect(processingLabel(recorded, { ...runningLegacy, state: 'error' })).toBe('Failed')
  })

  it('reports the transitional run states while running', () => {
    expect(processingLabel(recorded, { ...runningWithAudio, runState: 'loading_model' })).toMatch(
      /^Loading/,
    )
    expect(processingLabel(recorded, { ...runningWithAudio, runState: 'finalising' })).toMatch(
      /^Finalising/,
    )
  })

  it('reads the manifest when there is no job', () => {
    expect(processingLabel(recorded, null)).toBe('Recorded')
    expect(
      processingLabel(
        manifest({
          sessionId: PROCESSED_ID,
          processing: { transcribedAt: '2026-01-02T00:00:00.000Z', sbvPath: 'session.sbv' },
        }),
        null,
      ),
    ).toBe('Processed')
  })
})

describe('SessionsList — viewing a transcript from a row', () => {
  beforeEach(() => {
    vi.mocked(listSessions).mockReset()
    vi.mocked(getTranscribeStatus).mockReset()
  })
  afterEach(() => cleanup())

  function seed() {
    vi.mocked(listSessions).mockResolvedValue([
      manifest({ sessionId: RUNNING_ID }),
      manifest({
        sessionId: PROCESSED_ID,
        processing: { transcribedAt: '2026-01-02T00:00:00.000Z', sbvPath: 'session.sbv' },
      }),
      // Audio never uploaded: nothing to transcribe, nothing to view.
      manifest({ sessionId: EMPTY_ID, participants: [] }),
    ])
    vi.mocked(getTranscribeStatus).mockImplementation(async (id: string) =>
      id === RUNNING_ID ? runningWithAudio : null,
    )
  }

  it('shows the audio figures on a running row and offers its transcript', async () => {
    seed()
    render(<SessionsList />)

    await screen.findByText('Transcribing · 1h 12m of 4h 03m audio (12 of 40 tracks)')
    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(3)

    const [running, processed, empty] = rows
    expect(within(running).getByRole('button', { name: /View transcript/ })).toBeInTheDocument()
    expect(within(processed).getByRole('button', { name: /View transcript/ })).toBeInTheDocument()
    expect(within(empty).queryByRole('button', { name: /View transcript/ })).not.toBeInTheDocument()
  })

  it('mounts LiveTranscript with that row\'s id, one row at a time', async () => {
    seed()
    const user = userEvent.setup()
    render(<SessionsList />)

    await screen.findByText(/Transcribing · 1h 12m/)
    const [running, processed] = screen.getAllByRole('listitem')

    await user.click(within(running).getByRole('button', { name: /View transcript/ }))
    expect(screen.getByTestId('live-transcript')).toHaveTextContent(RUNNING_ID)
    expect(within(running).getByRole('button', { name: /Hide transcript/ })).toBeInTheDocument()

    // Opening a second row closes the first: one poll loop at a time.
    await user.click(within(processed).getByRole('button', { name: /View transcript/ }))
    const open = screen.getAllByTestId('live-transcript')
    expect(open).toHaveLength(1)
    expect(open[0]).toHaveTextContent(PROCESSED_ID)

    await user.click(within(processed).getByRole('button', { name: /Hide transcript/ }))
    expect(screen.queryByTestId('live-transcript')).not.toBeInTheDocument()
  })

  it('hands the transcript on with the session filename', async () => {
    seed()
    const user = userEvent.setup()
    const onSend = vi.fn()

    render(<SessionsList onSendToRefinement={onSend} />)
    await screen.findByText(/Transcribing · 1h 12m/)
    const [running] = screen.getAllByRole('listitem')
    await user.click(within(running).getByRole('button', { name: /View transcript/ }))
    await user.click(within(running).getByRole('button', { name: 'Use this transcript' }))

    // LiveTranscript hands over the body alone; the row supplies the same
    // filename the "Send to Refinement" button would.
    expect(onSend).toHaveBeenCalledWith('sbv body', `session-${RUNNING_ID.slice(0, 8)}.sbv`)
  })
})
