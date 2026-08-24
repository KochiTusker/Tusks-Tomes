// @vitest-environment jsdom

// Component test for UpdaterCard. Pins the Phase 1.5 invariant from the
// UI side: clicking "Apply" must POST the FULL 40-char remoteHead.sha,
// not the 7-char shortSha. The contract test on `applyUpdate` proves
// the function-level shape; this test proves the card passes the right
// value into the function.
//
// Loaded under jsdom via the per-file pragma above. Sonner is mocked at
// module level so we don't render a real toast root.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
  },
}))

const FULL_SHA = 'a1b2c3d4e5f6789012345678901234567890abcd'
const SHORT_SHA = 'a1b2c3d'

const baseStatus = {
  installedViaGit: true,
  branch: 'main',
  clean: true,
  head: {
    sha: '0000000000000000000000000000000000000000',
    shortSha: '0000000',
    subject: 'previous',
    author: 'me',
    date: '2026-05-22T10:00:00Z',
  },
  remoteHead: {
    sha: FULL_SHA,
    shortSha: SHORT_SHA,
    subject: 'pending',
    author: 'them',
    date: '2026-05-22T11:00:00Z',
  },
  pendingCommits: [
    {
      sha: FULL_SHA,
      shortSha: SHORT_SHA,
      subject: 'pending',
      author: 'them',
      date: '2026-05-22T11:00:00Z',
    },
  ],
  aheadCommits: [],
  remoteName: 'origin' as const,
}

describe('UpdaterCard — Apply uses full 40-char sha', () => {
  let fetchSpy: ReturnType<typeof vi.fn>
  let originalFetch: typeof fetch
  let originalConfirm: typeof window.confirm

  beforeEach(() => {
    originalFetch = globalThis.fetch
    originalConfirm = window.confirm
    window.confirm = vi.fn().mockReturnValue(true)
    fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
      if (url === '/api/updater/status' || url.endsWith('/api/updater/status')) {
        return new Response(JSON.stringify(baseStatus), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.endsWith('/api/updater/apply')) {
        return new Response(JSON.stringify({ ok: true, applied: true, status: baseStatus }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      // Unknown URL — let the test catch it loudly.
      return new Response('not mocked: ' + url, { status: 599 })
    })
    globalThis.fetch = fetchSpy as unknown as typeof fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    window.confirm = originalConfirm
    vi.restoreAllMocks()
  })

  it('renders with a pending commit and Apply enabled', async () => {
    const { UpdaterCard } = await import('./UpdaterCard')
    render(<UpdaterCard />)
    // Wait for the status fetch + rerender.
    // Wait for the Apply button to appear (which only happens after the
    // status fetch resolves and there's a pending commit).
    const applyBtn = await screen.findByRole('button', { name: /apply/i }, { timeout: 3000 })
    expect(applyBtn).toBeInTheDocument()
  })

  it('clicking Apply POSTs confirmRemoteHead = FULL 40-char sha (Phase 1.5 regression)', async () => {
    const { UpdaterCard } = await import('./UpdaterCard')
    render(<UpdaterCard />)
    const applyBtn = await screen.findByRole('button', { name: /apply/i }, { timeout: 3000 })
    await userEvent.click(applyBtn)

    await waitFor(() => {
      const applyCall = fetchSpy.mock.calls.find(
        (call) => typeof call[0] === 'string' && (call[0] as string).endsWith('/apply'),
      )
      expect(applyCall).toBeDefined()
    })

    const applyCall = fetchSpy.mock.calls.find(
      (call) => typeof call[0] === 'string' && (call[0] as string).endsWith('/apply'),
    ) as [string, RequestInit]
    const body = JSON.parse(applyCall[1].body as string)

    // THE REGRESSION TEST. If a future change passes status.remoteHead?.shortSha
    // here (perhaps as a "convenient default"), this assertion catches it
    // BEFORE the server's 412 reaches a user.
    expect(body.confirmRemoteHead).toBe(FULL_SHA)
    expect(body.confirmRemoteHead).not.toBe(SHORT_SHA)
    expect(body.confirmRemoteHead.length).toBe(40)
  })
})
