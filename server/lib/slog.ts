// Server-side log helper. Mirrors the browser-side `vlog()` shape so the
// two streams merge cleanly into the same ring (see diagnosticsLog.ingest).
//
// Use `slog('server', { event: 'thing', ...details })` at any server site
// that wants to be inspectable in the terminal / log file / GET /api/diagnostics/recent.
// Existing `console.[log/warn/error]` calls keep working — `slog` is
// additive (pushes to the diagnostics ring without touching stdout).

import { ingest } from './diagnosticsLog.js'

/** The set of categories the server emits. Stays string-typed for forward
 *  compat; the browser-side `LogCategory` is the canonical list. */
export type ServerLogCategory =
  | 'server'   // generic server-side events (default)
  | 'routing'  // putRouting / getRouting transitions
  | 'sessions' // session reads / writes
  | 'cache'    // appData migrations, cache invalidation
  | 'http'     // request lifecycle if we ever opt into it

/** Fire-and-forget server log call. Errors from the underlying file
 *  writer surface via console.error inside diagnosticsLog — `slog` itself
 *  never throws. */
export function slog(cat: ServerLogCategory | string, payload: unknown): void {
  void ingest([{ cat, payload }], 'server').catch((err) => {
    // Last-resort: write directly to stderr if even the ring ingest fails.
    console.error('[slog] ingest failed:', (err as Error)?.message ?? err)
  })
}
