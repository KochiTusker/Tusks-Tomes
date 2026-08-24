// Tests for POST /api/chronicle/docx — the browser-download Word export. It
// reuses the shared renderer, so this focuses on the HTTP contract: validation
// + that a real .docx (zip) is streamed back with download headers.

import { describe, expect, it } from 'vitest'
import express from 'express'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { chronicleRouter } from './chronicle.js'

async function withServer<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = express()
  app.use(express.json({ limit: '20mb' }))
  app.use('/api/chronicle', chronicleRouter())
  const server: Server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${addr.port}/api/chronicle`
  try {
    return await fn(baseUrl)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

const postDocx = (base: string, body: unknown) =>
  fetch(`${base}/docx`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('POST /api/chronicle/docx', () => {
  it('streams a .docx with download headers for a valid request', async () => {
    await withServer(async (base) => {
      const res = await postDocx(base, {
        campaign: 'Too Many Bruisers',
        sessionNumber: 24,
        chronicle: 'The party marched at dawn.',
        extras: { jests: [], gore: [], quotes: [] },
        condensed: { narrative: 'A tight recap.', bulletPoints: ['They marched.'] },
        mode: 'full',
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('wordprocessingml.document')
      expect(res.headers.get('content-disposition')).toContain('.docx')
      const buf = Buffer.from(await res.arrayBuffer())
      // .docx is a zip — the OOXML container starts with the PK signature.
      expect(buf.length).toBeGreaterThan(0)
      expect(buf.subarray(0, 2).toString('latin1')).toBe('PK')
    })
  })

  it('rejects a request with no chronicle', async () => {
    await withServer(async (base) => {
      const res = await postDocx(base, { campaign: 'x', sessionNumber: 1, chronicle: '   ' })
      expect(res.status).toBe(400)
    })
  })
})
