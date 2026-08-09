// Shared consumer for the add-on install SSE stream
// (POST /api/addons/:name/install — see server/api/addons.ts).
//
// The server emits three event types:
//   event: line   data: { stream: 'stdout'|'stderr', line: string }
//   event: done   data: { exitCode: number }
//   event: error  data: { error: string }
//
// AddonsManager.tsx and WhisperSettings.tsx each hand-rolled this parser
// before this helper existed; new callers should use this one rather than
// adding a fourth copy. Those two are deliberately left alone for now —
// they work, and rewriting them is unrelated risk.

export type InstallLogEntry = { stream: 'stdout' | 'stderr'; line: string }

export type InstallResult = { exitCode: number }

/**
 * Run an add-on install, invoking `onLine` for each log line as it arrives.
 *
 * Resolves with the exit code when the server sends `done`. Rejects if the
 * server sends `error`, if the request fails, or if the stream ends without
 * a `done` event — a silent truncation must not read as success.
 */
export async function streamAddonInstall(
  addonName: string,
  onLine: (entry: InstallLogEntry) => void,
  opts: { signal?: AbortSignal } = {},
): Promise<InstallResult> {
  const res = await fetch(`/api/addons/${encodeURIComponent(addonName)}/install`, {
    method: 'POST',
    signal: opts.signal,
  })
  if (!res.ok && !res.body) {
    throw new Error(`Install request failed (HTTP ${res.status})`)
  }
  if (!res.body) throw new Error('No response body from the install endpoint.')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let result: InstallResult | null = null
  let streamError: string | null = null

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    // SSE frames are separated by a blank line.
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''
    for (const frame of frames) {
      const event = frame.match(/^event: (\w+)/m)?.[1]
      const raw = frame.match(/^data: (.+)$/m)?.[1]
      if (!event || !raw) continue
      let data: Record<string, unknown>
      try {
        data = JSON.parse(raw)
      } catch {
        continue // a malformed frame shouldn't abort a running install
      }
      if (event === 'line') onLine(data as unknown as InstallLogEntry)
      else if (event === 'done') result = { exitCode: Number(data.exitCode ?? -1) }
      else if (event === 'error') streamError = String(data.error ?? 'unknown install error')
    }
  }

  if (streamError) throw new Error(streamError)
  if (!result) throw new Error('Install stream ended without a completion event.')
  return result
}
