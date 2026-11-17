import type { Response } from 'express'

/**
 * Stream a long-running job's log lines to the client as Server-Sent Events:
 * one `line` event per entry, then `done` with the exit code, or `error` if the
 * job throws. The response always ends. The client reads it through
 * `fetch().body.getReader()`, which is why the routes using this are POSTs: a
 * drive-by `<img src=…>` can't start the job.
 */
export async function streamLogToSse<T>(
  res: Response,
  run: (onLine: (entry: T) => void) => Promise<number>,
): Promise<void> {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders?.()

  try {
    const exitCode = await run((entry) => {
      res.write(`event: line\n`)
      res.write(`data: ${JSON.stringify(entry)}\n\n`)
    })
    res.write(`event: done\n`)
    res.write(`data: ${JSON.stringify({ exitCode })}\n\n`)
  } catch (err) {
    res.write(`event: error\n`)
    res.write(`data: ${JSON.stringify({ error: (err as Error).message })}\n\n`)
  } finally {
    res.end()
  }
}
