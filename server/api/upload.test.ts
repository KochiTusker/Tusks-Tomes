// Application-surface tests for the upload routes. Pins the Phase 1.3
// invariants: id validation runs BEFORE multer touches disk, and the
// in-flight byte cap (uploadGate) refuses oversized requests with 503.
//
// Distinct from server/multer.compat.test.ts which is a library-compat
// smoke check (does multer 2.x's API still behave) — that file tests
// multer; this file tests our application's wiring of multer.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { withRouter } from '../testing/httpFixture.js'
import { uploadRouter } from './upload.js'

const UPLOAD_TMP_DIR = path.join(os.tmpdir(), 'tusks-tomes-uploads')

async function listTmpFiles(): Promise<string[]> {
  try {
    return await fs.readdir(UPLOAD_TMP_DIR)
  } catch {
    return []
  }
}

describe('POST /:id/append-multitrack — gateById before multer (Phase 1.3 regression)', () => {
  let baselineTmp: string[]

  beforeEach(async () => {
    baselineTmp = await listTmpFiles()
  })
  afterEach(async () => {
    // Best-effort cleanup of any files created by tests. We never expect
    // any since the gate should reject — but defence in depth.
    const after = await listTmpFiles()
    for (const name of after) {
      if (!baselineTmp.includes(name)) {
        await fs.unlink(path.join(UPLOAD_TMP_DIR, name)).catch(() => undefined)
      }
    }
  })

  async function postAppendMultitrack(
    sessionId: string,
    multipartBody: Buffer,
    boundary: string,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    return withRouter('/api/sessions', uploadRouter(), async (baseUrl) => {
      const res = await fetch(
        `${baseUrl}/${encodeURIComponent(sessionId)}/append-multitrack`,
        {
          method: 'POST',
          headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
          body: new Uint8Array(multipartBody),
        },
      )
      let body: Record<string, unknown> = {}
      try {
        body = (await res.json()) as Record<string, unknown>
      } catch {
        // Not JSON — that's OK, leave body empty.
      }
      return { status: res.status, body }
    })
  }

  function buildMultipart(content: Buffer, boundary: string, filename = 'test.flac'): Buffer {
    const head = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="files"; filename="${filename}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`,
    )
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
    return Buffer.concat([head, content, tail])
  }

  it('invalid :id → 400 AND zero files written to UPLOAD_TMP_DIR', async () => {
    const boundary = 'boundary-test-1'
    const body = buildMultipart(Buffer.alloc(1024, 0x41), boundary)
    // ":id" containing slashes is decoded by Express. We hit a route
    // that *would* match but with a bogus segment.
    const { status } = await postAppendMultitrack('..%2Fetc', body, boundary)
    expect(status).toBe(400)

    const after = await listTmpFiles()
    const newFiles = after.filter((f) => !baselineTmp.includes(f))
    expect(newFiles).toEqual([])
  })

  it('still 400 with a much larger payload — gate prevents disk write', async () => {
    // 5 MB of junk under a bogus id. If multer ran first, this would be
    // on disk before the rejection.
    const boundary = 'boundary-test-2'
    const body = buildMultipart(Buffer.alloc(5 * 1024 * 1024, 0x42), boundary)
    const { status } = await postAppendMultitrack('a/b/c', body, boundary)
    expect(status).toBe(400)

    const after = await listTmpFiles()
    const newFiles = after.filter((f) => !baselineTmp.includes(f))
    expect(newFiles).toEqual([])
  })

  it('still 400 with characters that previously bypassed regex (null byte injection)', async () => {
    const boundary = 'boundary-test-3'
    const body = buildMultipart(Buffer.from('payload'), boundary)
    // %00 in a URL → decoded to null in req.params.id. validator rejects.
    const { status } = await postAppendMultitrack('valid%00id', body, boundary)
    expect(status).toBe(400)
  })
})

describe('uploadGate — actual-bytes accounting (Phase 6.2 regression test)', () => {
  it('503 when Content-Length declares a value above the system cap (fast-fail)', async () => {
    // 17 GB Content-Length advertised but no body sent. The gate should
    // refuse before multer streams a single byte. We keep this fast-fail
    // shape so an obviously-oversized request is rejected without ever
    // having to receive bytes.
    const http = await import('node:http')
    await withRouter('/api/sessions', uploadRouter(), async (baseUrl) => {
      const url = new URL(`${baseUrl}/upload-multitrack`)
      const oversizedCL = String(17 * 1024 * 1024 * 1024)
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method: 'POST',
            headers: {
              'Content-Type': 'multipart/form-data; boundary=x',
              'Content-Length': oversizedCL,
            },
          },
          (res) => {
            resolve(res.statusCode ?? 0)
            res.resume()
          },
        )
        req.on('error', reject)
        req.end()
      })
      expect(status).toBe(503)
    })
  })

  it('does NOT reserve bytes against the cap based on a lying Content-Length (the regression)', async () => {
    // Pre-Phase-6.2: a request declaring Content-Length: 6_000_000_000
    // with zero body bytes would reserve 6 GB against inFlightBytes
    // for the lifetime of the connection. Three such connections
    // (18 GB) would trip the 16 GB cap and 503 every legitimate
    // upload until they timed out. With actual-bytes accounting,
    // zero body bytes contribute zero to the counter.
    const http = await import('node:http')
    const { _getInFlightBytesForTests } = await import('./upload.js')
    const initial = _getInFlightBytesForTests()
    await withRouter('/api/sessions', uploadRouter(), async (baseUrl) => {
      const url = new URL(`${baseUrl}/upload-multitrack`)
      // 6 GB declared, but we send the connection without sending the
      // body. The server should NOT have moved the counter by 6 GB.
      const liedCL = String(6 * 1024 * 1024 * 1024)
      // Don't await the response — the request will hang since we
      // never end it. We close from our side after a quick probe.
      const req = http.request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'multipart/form-data; boundary=x',
          'Content-Length': liedCL,
        },
      })
      req.on('error', () => undefined)
      req.write('')  // open the request without sending anything meaningful
      // Give Express a moment to register the request, then check the
      // counter. Under the regression, this would already be ~6 GB.
      await new Promise((r) => setTimeout(r, 50))
      const afterOpen = _getInFlightBytesForTests()
      req.destroy()
      // We may have ingested a few bytes of headers/empty write, but
      // NOT 6 GB. The header should NOT have reserved that capacity.
      expect(afterOpen - initial).toBeLessThan(1024 * 1024)
    })
  })

  it('accepts a tiny payload under the cap', async () => {
    const boundary = 'b-tiny'
    const body = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="files"; filename="x.flac"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n` +
        `tiny\r\n--${boundary}--\r\n`,
    )
    await withRouter('/api/sessions', uploadRouter(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/upload-multitrack`, {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body: new Uint8Array(body),
      })
      // Could be 200 (succeeded, no real extractor wired here) or 500
      // (the extractor tried to run on bogus content). What matters:
      // it's NOT 503.
      expect(res.status).not.toBe(503)
    })
  })
})
