// Recording stand-in for `sonner`. Toasts are part of what the user sees, but a
// real toast root animates and auto-dismisses on timers, which makes
// snapshots racy. This keeps the observable fact — which toast fired, with
// what text — and drops the timing.

// Shared through globalThis: the harness resets the module graph between
// scenarios, so a module-level array here would be a different instance from
// the one the harness reads.
const g = globalThis as unknown as { __goldenToastLog?: string[] }
export const toastLog: string[] = (g.__goldenToastLog ??= [])

function record(kind: string, message: unknown, opts?: { description?: unknown }): string {
  const desc = opts && typeof opts.description === 'string' ? ` -- ${opts.description}` : ''
  toastLog.push(`${kind}: ${typeof message === 'string' ? message : '<node>'}${desc}`)
  return `toast-${toastLog.length}`
}

type Opts = { description?: unknown }
const base = (message: unknown, opts?: Opts) => record('toast', message, opts)

export const toast = Object.assign(base, {
  success: (m: unknown, o?: Opts) => record('success', m, o),
  error: (m: unknown, o?: Opts) => record('error', m, o),
  info: (m: unknown, o?: Opts) => record('info', m, o),
  warning: (m: unknown, o?: Opts) => record('warning', m, o),
  message: (m: unknown, o?: Opts) => record('message', m, o),
  loading: (m: unknown, o?: Opts) => record('loading', m, o),
  promise: () => 'toast-promise',
  dismiss: () => undefined,
  custom: () => 'toast-custom',
})

export function Toaster() {
  return null
}

export const sonnerMock = { toast, Toaster }
