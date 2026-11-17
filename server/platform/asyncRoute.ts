import type { Request, RequestHandler, Response } from 'express'

/**
 * Wrap an async route handler so a thrown error is logged under `tag` and
 * answered as `500 { error: <message> }`. For a handler whose whole body would
 * otherwise sit in a try/catch that does exactly that; a handler with its own
 * failure handling (a different status, extra cleanup, a differently shaped
 * body) keeps its own catch.
 */
export function asyncRoute(
  tag: string,
  handler: (req: Request, res: Response) => unknown,
): RequestHandler {
  return async (req, res) => {
    try {
      await handler(req, res)
    } catch (err) {
      console.error(`[${tag}] failed:`, err)
      res.status(500).json({ error: (err as Error).message })
    }
  }
}
