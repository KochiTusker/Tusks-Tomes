// @vitest-environment jsdom

// The Upload panel used to keep the session it was building in component
// state only, so a reload (or, before the Sessions tab was force-mounted,
// a tab switch) came back to a blank panel while Whisper carried on in the
// background with no view onto it. These tests pin the record that now
// survives: what it restores, when it is trusted, and when it is dropped.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
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

// Importing the real App would load the whole component tree. The panel
// only wants the event name.
vi.mock('@/App', () => ({ LOAD_TRANSCRIPT_EVENT: 'sbts:load-transcript' }))

vi.mock('@/platform/contexts/AddonContext', () => ({
  useAddons: () => ({ isEnabled: () => true, isLoaded: () => true }),
}))

vi.mock('@/features/transcription/lib/multitrackUpload', () => ({
  appendMultitrack: vi.fn(),
  cancelMultitrackUpload: vi.fn(async () => undefined),
  previewSpeakerFromFilename: (name: string) => ({ displayName: name }),
  startMultitrackTranscription: vi.fn(async () => undefined),
  uploadMultitrack: vi.fn(),
}))

// The live view is another stream's concern; here it only has to prove
// which session it was handed.
vi.mock('./LiveTranscript', () => ({
  LiveTranscript: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="live-transcript">{sessionId}</div>
  ),
}))

vi.mock('@/features/transcription/lib/liveSession', () => ({
  getLiveSession: vi.fn(),
  refreshLiveLabels: vi.fn(),
}))

import { getLiveSession } from '@/features/transcription/lib/liveSession'
import { LS_UPLOAD_SESSION } from '@/features/providers'
import { UploadPanel } from './UploadPanel'

const SESSION_ID = '0f3b2c1d-1111-4222-8333-444455556666'

const liveDone = {
  sessionId: SESSION_ID,
  active: false,
  pending: 0,
  processed: 3,
  enqueued: 3,
  cueCount: 40,
  errors: [],
  participants: [],
  sbv: 'WEBVTT-ish body',
  finalized: true,
}

function seedRecord(phase: 'committed' | 'transcribing' | 'ready' = 'transcribing') {
  localStorage.setItem(
    LS_UPLOAD_SESSION,
    JSON.stringify({
      sessionId: SESSION_ID,
      phase,
      committedBatches: [
        {
          partNumber: 1,
          summary: '1 zip — part-1.zip',
          fileCount: 1,
          speakerCount: 3,
          cumulativeDurationMs: 3_600_000,
          bytes: 1024,
        },
      ],
      sessionLabel: 'Night one',
    }),
  )
}

describe('UploadPanel — restoring a session across a reload', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.mocked(getLiveSession).mockReset()
  })
  afterEach(() => cleanup())

  it('renders idle and asks the server nothing when there is no record', () => {
    render(<UploadPanel />)
    expect(screen.getByText('Multitrack audio upload')).toBeInTheDocument()
    expect(screen.queryByTestId('live-transcript')).not.toBeInTheDocument()
    expect(getLiveSession).not.toHaveBeenCalled()
  })

  it('restores a transcribing session and mounts LiveTranscript with its id', async () => {
    seedRecord('transcribing')
    vi.mocked(getLiveSession).mockResolvedValue(liveDone)

    render(<UploadPanel />)

    // Restored synchronously from the record — no round-trip first.
    expect(screen.getByTestId('live-transcript')).toHaveTextContent(SESSION_ID)
    expect(getLiveSession).toHaveBeenCalledWith(SESSION_ID)
    // The server says it finished, so the header stops claiming Whisper
    // is still running.
    await screen.findByText('Transcription complete')
    expect(screen.getByText(/1 part stitched into one session/)).toBeInTheDocument()
  })

  it('drops the record and renders idle when the server no longer has the session', async () => {
    seedRecord('transcribing')
    vi.mocked(getLiveSession).mockRejectedValue(
      new Error(`GET /api/sessions/${SESSION_ID}/live failed: HTTP 404`),
    )

    render(<UploadPanel />)

    await waitFor(() => {
      expect(localStorage.getItem(LS_UPLOAD_SESSION)).toBeNull()
    })
    expect(screen.queryByTestId('live-transcript')).not.toBeInTheDocument()
    expect(screen.getByText('Multitrack audio upload')).toBeInTheDocument()
  })

  it('keeps the record when the check fails for any reason other than 404', async () => {
    seedRecord('transcribing')
    vi.mocked(getLiveSession).mockRejectedValue(
      new Error(`GET /api/sessions/${SESSION_ID}/live failed: HTTP 503`),
    )

    render(<UploadPanel />)

    await waitFor(() => expect(getLiveSession).toHaveBeenCalled())
    // Give the rejection a turn to land, then assert nothing was thrown away.
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.getByTestId('live-transcript')).toHaveTextContent(SESSION_ID)
    const stored = JSON.parse(localStorage.getItem(LS_UPLOAD_SESSION) ?? 'null')
    expect(stored?.sessionId).toBe(SESSION_ID)
  })

  it('restores a committed-but-not-started session to the batch view', async () => {
    seedRecord('committed')
    vi.mocked(getLiveSession).mockResolvedValue({ ...liveDone, finalized: false, processed: 0 })

    render(<UploadPanel />)

    expect(screen.queryByTestId('live-transcript')).not.toBeInTheDocument()
    expect(screen.getByText(/Saved so far — 1 part/)).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /All audio uploaded — start transcription/ }),
    ).toBeInTheDocument()
    await waitFor(() => expect(getLiveSession).toHaveBeenCalledWith(SESSION_ID))
  })

  it('"Upload another session" clears the record', async () => {
    seedRecord('transcribing')
    vi.mocked(getLiveSession).mockResolvedValue(liveDone)
    const user = userEvent.setup()

    render(<UploadPanel />)
    await screen.findByText('Transcription complete')

    await user.click(screen.getByRole('button', { name: 'Upload another session' }))

    expect(localStorage.getItem(LS_UPLOAD_SESSION)).toBeNull()
    expect(screen.queryByTestId('live-transcript')).not.toBeInTheDocument()
    expect(screen.getByText('Multitrack audio upload')).toBeInTheDocument()
  })

  it('ignores a malformed record rather than restoring garbage', () => {
    localStorage.setItem(LS_UPLOAD_SESSION, JSON.stringify({ phase: 'transcribing' }))
    render(<UploadPanel />)
    expect(screen.queryByTestId('live-transcript')).not.toBeInTheDocument()
    expect(getLiveSession).not.toHaveBeenCalled()
  })
})
