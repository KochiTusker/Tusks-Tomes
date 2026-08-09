// Shared HTTP test fixture for Express router tests.
//
// Extracted from the pattern that's copy-pasted across
// server/api/runs.test.ts and server/api/settings.test.ts:
//   1. Build an `app` with the router under test mounted at a fixed path.
//   2. Bind to localhost:0 (OS picks a free port).
//   3. Run the test body with the live baseUrl.
//   4. Tear down the server when the body finishes (success or throw).
//
// New tests should reach for this helper. Existing green tests are left
// alone — no churn for the sake of churn.

import express, { type Router } from 'express'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

/** Spin up the router on a random local port, hand the baseUrl to `body`,
 *  then tear down. The mountPath becomes part of the returned baseUrl
 *  so callers can `fetch(baseUrl + '/some-resource')` directly. */
export async function withRouter<T>(
  mountPath: string,
  router: Router,
  body: (baseUrl: string) => Promise<T>,
  opts: { jsonLimit?: string } = {},
): Promise<T> {
  const app = express()
  app.use(express.json({ limit: opts.jsonLimit ?? '20mb' }))
  app.use(mountPath, router)
  const server: Server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${addr.port}${mountPath}`
  try {
    return await body(baseUrl)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

/** Create a tmp dir for tests that need to scribble files. Returns the
 *  dir + a cleanup callback. Pattern:
 *
 *      const { dir, cleanup } = await withTempConfigDir()
 *      afterEach(cleanup)
 */
export async function withTempConfigDir(prefix = 'tt-test-'): Promise<{
  dir: string
  cleanup: () => Promise<void>
}> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), prefix))
  return {
    dir,
    cleanup: async () => {
      // allowlist:dangerous-fs-rm
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
}
