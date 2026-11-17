// Start-up readiness: what the server is doing before it can serve the
// app, and how it tells callers so.
//
// The port is bound as early as possible so that a launcher, a browser
// tab opened too soon, or a health check gets an answer straight away
// instead of a refused connection. Until the last start-up step finishes,
// that answer is "starting" — a self-refreshing page for a browser, a 503
// with Retry-After for anything that speaks JSON — and /api/health carries
// the current phase so a launcher can wait for the real thing rather than
// guessing with a fixed delay.
//
// Everything here is process-wide state on purpose: there is one server
// per process, and the phase is a fact about the process.

import type { RequestHandler } from 'express'
import { performance } from 'node:perf_hooks'

/** The start-up steps, in the order start() in server/index.ts runs them.
 *  'ready' is terminal. */
export type BootPhase = 'binding' | 'addons' | 'lore' | 'vite' | 'ready'

export type BootState = {
  phase: BootPhase
  /** Epoch ms when this process began. */
  startedAt: number
  /** Epoch ms when 'ready' was reached, null until then. */
  readySince: number | null
}

/** What the app and the health endpoint need to know about readiness.
 *  Kept minimal so a test can hand in a stub without touching the
 *  process-wide state. */
export type ReadinessSource = {
  isReady: () => boolean
  phase: () => string
}

const state: BootState = {
  phase: 'binding',
  startedAt: Date.now(),
  readySince: null,
}

export function bootState(): Readonly<BootState> {
  return state
}

export function setBootPhase(phase: BootPhase): void {
  state.phase = phase
  if (phase === 'ready' && state.readySince === null) state.readySince = Date.now()
}

/** Milliseconds since the process started. */
export function uptimeMs(): number {
  return Math.round(performance.now())
}

/** Seconds since the process started, formatted for a log line. */
export function elapsedSeconds(): string {
  return (performance.now() / 1000).toFixed(2)
}

/** The process-wide readiness source that start() drives. */
export const bootReadiness: ReadinessSource = {
  isReady: () => state.phase === 'ready',
  phase: () => state.phase,
}

/** Print one numbered start-up step with the time it began, so someone
 *  watching the window can see both progress and where the time goes:
 *
 *      [2/5] +0.41s loading add-ons
 */
export function step(n: number, total: number, label: string): void {
  // eslint-disable-next-line no-console
  console.log(`  [${n}/${total}] +${elapsedSeconds()}s ${label}`)
}

/** Plain-language names for the phases, shared by the starting page and
 *  anything else that shows one to a person. */
export const PHASE_LABELS: Record<string, string> = {
  binding: 'binding the port',
  addons: 'loading add-ons',
  lore: 'reading the lore folder',
  vite: 'preparing the interface',
  ready: 'ready',
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** The page a browser gets while the server is still starting. Entirely
 *  self-contained — no stylesheet, font or script from anywhere else —
 *  because nothing else is being served yet. Colours match index.html's
 *  dark scheme so the hand-over to the real app is not a flash of white. */
export function startingPage(phase: string): string {
  const label = escapeHtml(PHASE_LABELS[phase] ?? phase)
  const labelsJson = JSON.stringify(PHASE_LABELS)
  return `<!doctype html>
<html lang="en" class="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="dark" />
    <meta name="theme-color" content="#150a24" />
    <title>Tusk's Tomes — starting…</title>
    <style>
      html, body { height: 100%; margin: 0; }
      body {
        background: #150a24;
        color: #e9e2f2;
        font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        display: flex; align-items: center; justify-content: center;
      }
      main { text-align: center; padding: 2rem; max-width: 34rem; }
      h1 {
        font-family: Georgia, "Times New Roman", serif;
        font-weight: 600; font-size: 2rem; letter-spacing: 0.02em;
        margin: 0 0 0.75rem;
      }
      .status { font-size: 1.125rem; margin: 0 0 1.5rem; }
      .dot {
        display: inline-block; width: 0.6rem; height: 0.6rem; border-radius: 50%;
        background: #c9a24a; margin-right: 0.5rem; vertical-align: middle;
        animation: pulse 1.2s ease-in-out infinite;
      }
      @keyframes pulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }
      .phase { color: #b9aecb; font-size: 0.95rem; margin: 0 0 1rem; }
      .hint { color: #8f84a3; font-size: 0.85rem; margin: 0; line-height: 1.5; }
    </style>
  </head>
  <body>
    <main>
      <h1>Tusk's Tomes</h1>
      <p class="status"><span class="dot"></span>starting…</p>
      <p class="phase">Current step: <span id="phase">${label}</span></p>
      <p class="hint">
        This page refreshes itself as soon as the app is ready.
        The first start after setup or an update takes longer while the
        app prepares its files.
      </p>
    </main>
    <script>
      (function () {
        var labels = ${labelsJson};
        var el = document.getElementById('phase');
        function tick() {
          fetch('/api/health', { cache: 'no-store' })
            .then(function (r) { return r.json(); })
            .then(function (j) {
              if (j && j.ready) { location.reload(); return; }
              if (j && j.phase && el) el.textContent = labels[j.phase] || j.phase;
              setTimeout(tick, 500);
            })
            .catch(function () { setTimeout(tick, 500); });
        }
        setTimeout(tick, 500);
      })();
    </script>
  </body>
</html>
`
}

/** Express middleware that answers for the app until start-up finishes.
 *
 *  - /api/health and /api/boot pass through: they are how a caller finds
 *    out that the server is starting, so they must work from the moment
 *    the port is bound.
 *  - Any other /api/* request gets 503 JSON with the phase and a
 *    Retry-After, so a client that fetched early can wait and retry
 *    instead of misreading a missing route as a broken one.
 *  - A GET or HEAD for anything else gets the starting page.
 *  - Everything else passes through.
 *
 *  Once isReady() is true the gate costs one function call per request. */
export function readinessGate(source: ReadinessSource): RequestHandler {
  return (req, res, next) => {
    if (source.isReady()) return next()
    const p = req.path
    if (p === '/api/health' || p === '/api/boot') return next()
    const phase = source.phase()
    if (p === '/api' || p.startsWith('/api/')) {
      res
        .status(503)
        .set('Retry-After', '1')
        .set('Cache-Control', 'no-store')
        .json({ error: 'starting', phase })
      return
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      res
        .status(503)
        .set('Retry-After', '1')
        .set('Cache-Control', 'no-store')
        .type('html')
        .send(startingPage(phase))
      return
    }
    next()
  }
}
