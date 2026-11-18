import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import type { AddressInfo } from 'node:net'
import http, { type Server } from 'node:http'
import express from 'express'
import { docsAssets, SVG_CSP } from './docsAssets'

let root: string
let server: Server
let base: string

/** GET a path exactly as written, with no client-side URL normalisation. */
function rawGet(p: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const port = (server.address() as AddressInfo).port
    http
      .get({ host: '127.0.0.1', port, path: p }, (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      })
      .on('error', reject)
  })
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'docs-assets-'))
  const assets = path.join(root, 'docs', 'assets')
  await fs.mkdir(path.join(assets, 'diagrams'), { recursive: true })
  await fs.writeFile(path.join(assets, 'diagrams', 'flow.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  await fs.writeFile(path.join(assets, 'diagrams', 'flow.excalidraw'), '{"type":"excalidraw"}')
  await fs.writeFile(path.join(assets, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  await fs.writeFile(path.join(assets, 'README.md'), '# contributors')
  await fs.writeFile(path.join(root, 'docs', 'secret.png'), 'outside the assets folder')

  const app = express()
  app.use('/docs/assets', docsAssets(root))
  // Stands in for the SPA fallback, to prove nothing falls through to it.
  app.use((_req, res) => res.status(200).send('<!doctype html>spa'))
  server = app.listen(0)
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/docs/assets`
})

afterAll(async () => {
  server.close()
  await fs.rm(root, { recursive: true, force: true })
})

describe('docsAssets', () => {
  it('serves a diagram, locked down as an SVG document', async () => {
    const res = await fetch(`${base}/diagrams/flow.svg`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^image\/svg\+xml/)
    expect(res.headers.get('content-security-policy')).toBe(SVG_CSP)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('serves raster images without the SVG policy', async () => {
    const res = await fetch(`${base}/shot.png`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-security-policy')).toBeNull()
  })

  it('does not hand out the editable sources or the folder README', async () => {
    expect((await fetch(`${base}/diagrams/flow.excalidraw`)).status).toBe(404)
    expect((await fetch(`${base}/README.md`)).status).toBe(404)
  })

  it('answers a missing image with 404, not the SPA page', async () => {
    const res = await fetch(`${base}/diagrams/nope.svg`)
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain('spa')
  })

  it('cannot be walked out of the assets folder', async () => {
    // Sent byte-for-byte: fetch() would normalise the dot segments away
    // before the request left, and the test would prove nothing.
    for (const attempt of ['/..%2Fsecret.png', '/%2e%2e/secret.png', '/%2e%2e%2fsecret.png', '/diagrams/..%5c..%5csecret.png']) {
      const { status, body } = await rawGet(`/docs/assets${attempt}`)
      expect(status, attempt).toBe(404)
      expect(body, attempt).not.toContain('outside the assets folder')
    }
  })

  it('is read-only', async () => {
    const res = await fetch(`${base}/diagrams/flow.svg`, { method: 'POST' })
    expect(res.status).toBe(405)
  })
})
