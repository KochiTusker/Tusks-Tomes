// @vitest-environment jsdom

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { AppErrorBoundary } from './AppErrorBoundary'

// Stub the diagnose + verboseLog dependencies so the boundary's side-effects
// don't try to hit /api or write to disk in the test environment.
vi.mock('@/lib/diagnose', () => ({
  requestBundle: vi.fn(async () => ({ ok: true })),
}))
vi.mock('@/lib/verboseLog', () => ({
  vlog: vi.fn(),
}))

function Boom({ when }: { when: boolean }): ReactElement {
  if (when) throw new Error('component blew up on render')
  return <div data-testid="ok">happy path</div>
}

describe('AppErrorBoundary', () => {
  let consoleErr: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    // React logs the caught error to console.error in dev; silence it so the
    // test output isn't noisy.
    consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {})
    // Reset the requestBundle/vlog mocks so call counts don't accumulate
    // across tests in the same describe block.
    vi.clearAllMocks()
  })
  afterEach(() => {
    consoleErr.mockRestore()
    cleanup()
  })

  it('renders children unchanged when no error fires', () => {
    render(
      <AppErrorBoundary>
        <Boom when={false} />
      </AppErrorBoundary>,
    )
    expect(screen.getByTestId('ok')).toHaveTextContent('happy path')
  })

  it('renders the fallback UI when a child throws during render', () => {
    render(
      <AppErrorBoundary>
        <Boom when={true} />
      </AppErrorBoundary>,
    )
    // The default fallback's heading + the truncated error message should appear.
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.getByText('The Chronicle stalled')).toBeTruthy()
    expect(screen.getByText(/component blew up on render/)).toBeTruthy()
    // The recovery affordances should be present.
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /copy error/i })).toBeTruthy()
  })

  it('honors a custom fallback render prop for tests / themes', () => {
    render(
      <AppErrorBoundary fallback={(s) => <div data-testid="custom">custom: {s.error?.message}</div>}>
        <Boom when={true} />
      </AppErrorBoundary>,
    )
    expect(screen.getByTestId('custom')).toHaveTextContent('custom: component blew up on render')
  })

  it('triggers requestBundle() with trigger=hard_error + the error message', async () => {
    const { requestBundle } = await import('@/lib/diagnose')
    render(
      <AppErrorBoundary>
        <Boom when={true} />
      </AppErrorBoundary>,
    )
    expect(requestBundle).toHaveBeenCalledTimes(1)
    expect(requestBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: 'hard_error',
        errorMessage: 'component blew up on render',
      }),
    )
  })

  it('writes a verbose-log entry tagged render_error', async () => {
    const { vlog } = await import('@/lib/verboseLog')
    render(
      <AppErrorBoundary>
        <Boom when={true} />
      </AppErrorBoundary>,
    )
    expect(vlog).toHaveBeenCalledWith(
      'pipeline',
      expect.objectContaining({ type: 'render_error', message: 'component blew up on render' }),
    )
  })
})
