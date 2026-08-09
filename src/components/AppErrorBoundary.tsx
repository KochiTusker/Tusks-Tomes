// Top-level React error boundary. Catches render errors anywhere in the
// component tree and surfaces a fallback UI with the error message, a
// "Try again" reset button, a "Copy error" clipboard helper, and triggers
// `requestBundle()` so `.diagnose/latest.md` captures the crash for
// Claude Code consumption.
//
// Without this boundary, an uncaught render error produces a blank white
// screen with no message and no recovery path — invisible to both the
// user and any future debugging session.
//
// This is a CLASS component because React's error boundary lifecycle
// methods (getDerivedStateFromError / componentDidCatch) only fire on
// class components today; function-component error boundaries don't
// exist in React 19.

import { Component, type ErrorInfo, type ReactNode } from 'react'

import { requestBundle } from '@/lib/diagnose'
import { vlog } from '@/lib/verboseLog'

type Props = {
  /** Optional override for the fallback UI. Used by tests so we don't have to
   *  build a full DOM tree to verify the boundary fired. Production code path
   *  uses the default `defaultFallback` below. */
  fallback?: (state: ErrorState) => ReactNode
  children: ReactNode
}

type ErrorState = {
  hasError: boolean
  /** The error caught from a child render. Preserved so the fallback UI can
   *  display the message + the user can click "Copy" to share it. */
  error: Error | null
  /** Stack trace from React. Useful for debugging but truncated in display
   *  because it's noisy; full text goes to clipboard on Copy. */
  componentStack: string | null
}

const initialState: ErrorState = { hasError: false, error: null, componentStack: null }

function defaultFallback(state: ErrorState, onReset: () => void): ReactNode {
  const messageRaw = state.error?.message ?? 'Unknown render error'
  const message = messageRaw.length > 800 ? messageRaw.slice(0, 800) + '…' : messageRaw
  const stack = state.componentStack ?? state.error?.stack ?? ''
  const fullText = `${state.error?.name ?? 'Error'}: ${messageRaw}\n\n${stack}`

  return (
    <div
      role="alert"
      style={{
        padding: '2rem',
        margin: '2rem auto',
        maxWidth: '40rem',
        fontFamily: 'system-ui, sans-serif',
        border: '1px solid hsl(var(--destructive, 0 84% 60%))',
        borderRadius: '0.5rem',
        background: 'hsl(var(--destructive, 0 84% 60%) / 0.05)',
      }}
    >
      <h1 style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>The Chronicle stalled</h1>
      <p style={{ marginBottom: '1rem', color: 'hsl(var(--muted-foreground))' }}>
        Something inside the page crashed before it could render. Your work is safe — pipeline runs
        auto-save to disk and your settings are encrypted in the config folder. The diagnostic
        bundle at <code>.diagnose/latest.md</code> has been refreshed with the details below; you
        can share that file (or just this message) with Claude Code to get help fixing it.
      </p>
      <pre
        style={{
          padding: '0.75rem',
          background: 'hsl(var(--muted) / 0.5)',
          borderRadius: '0.25rem',
          fontSize: '0.85rem',
          whiteSpace: 'pre-wrap',
          maxHeight: '12rem',
          overflow: 'auto',
        }}
      >
        {message}
      </pre>
      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
        <button
          type="button"
          onClick={onReset}
          style={{
            padding: '0.5rem 1rem',
            background: 'hsl(var(--primary))',
            color: 'hsl(var(--primary-foreground))',
            border: 'none',
            borderRadius: '0.25rem',
            cursor: 'pointer',
          }}
        >
          Try again
        </button>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(fullText).catch(() => {})
          }}
          style={{
            padding: '0.5rem 1rem',
            background: 'transparent',
            color: 'hsl(var(--foreground))',
            border: '1px solid hsl(var(--border))',
            borderRadius: '0.25rem',
            cursor: 'pointer',
          }}
        >
          Copy error
        </button>
      </div>
    </div>
  )
}

export class AppErrorBoundary extends Component<Props, ErrorState> {
  state: ErrorState = initialState

  static getDerivedStateFromError(error: Error): Partial<ErrorState> {
    // First half of the boundary: update state so the next render shows the
    // fallback. Pure function — no side effects allowed here.
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Second half: side effects belong here. We log via the verbose ring so
    // the next diagnose bundle picks the event up, then fire-and-forget the
    // bundle write so `.diagnose/latest.md` reflects the crash even if the
    // user reloads before sharing.
    const componentStack = info.componentStack ?? null
    this.setState({ componentStack })

    try {
      vlog('pipeline', {
        type: 'render_error',
        message: error.message,
        name: error.name,
        componentStack,
        stack: error.stack ?? null,
      })
    } catch {
      // Verbose log failures must NEVER mask the render crash — swallow.
    }

    void requestBundle({
      trigger: 'hard_error',
      errorMessage: error.message,
      errorStack: error.stack ?? undefined,
      currentState: {
        renderError: true,
        errorName: error.name,
        componentStack,
      },
    }).catch(() => {
      // Bundle write failure is non-fatal; the in-memory ring buffer still
      // has the render_error event for whoever investigates next.
    })
  }

  resetError = (): void => {
    this.setState(initialState)
  }

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback(this.state)
      return defaultFallback(this.state, this.resetError)
    }
    return this.props.children
  }
}
