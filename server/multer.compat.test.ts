// Multer 2.x compatibility smoke test. Confirms the upload + body-field
// shape we depend on in upload.ts / lore.ts / index.ts still works
// after the 1.x → 2.x bump.
//
// Why this is its own test rather than under api/: we want a tight,
// dependency-free check that exercises multer in isolation; richer
// integration tests for individual routers already cover the higher
// layers.

import { describe, expect, it } from 'vitest'
import express from 'express'
import multer from 'multer'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

describe('multer 2.x compatibility', () => {
  it('memoryStorage: req.file.buffer + size + originalname populated', async () => {
    const app = express()
    const upload = multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: 1024 * 1024 },
    })
    let captured: { name?: string; size?: number; bufferLen?: number; bodyField?: string } = {}
    app.post('/parse/pdf', upload.single('file'), (req, res) => {
      if (!req.file) {
        return res.status(400).json({ error: 'no file' })
      }
      captured = {
        name: req.file.originalname,
        size: req.file.size,
        bufferLen: req.file.buffer.length,
        bodyField: req.body.extra,
      }
      res.json({ ok: true })
    })

    const server = http.createServer(app)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as AddressInfo).port

    // multipart payload: one tiny file under `file`, one text field
    // under `extra`. Confirms req.body alongside req.file works in v2.
    const boundary = '----test-boundary-' + Math.random().toString(36).slice(2)
    const fileBuf = Buffer.from('hello world')
    const parts = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="extra"',
      '',
      'extra-value',
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="hello.txt"',
      'Content-Type: application/octet-stream',
      '',
      fileBuf.toString('binary'),
      `--${boundary}--`,
      '',
    ].join('\r\n')

    try {
      const res = await fetch(`http://127.0.0.1:${port}/parse/pdf`, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body: parts,
      })
      expect(res.status).toBe(200)
      expect(captured.name).toBe('hello.txt')
      expect(captured.size).toBe(fileBuf.length)
      expect(captured.bufferLen).toBe(fileBuf.length)
      expect(captured.bodyField).toBe('extra-value')
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it('limits.fileSize → 413/MulterError on oversize', async () => {
    const app = express()
    const upload = multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: 10 }, // 10 bytes
    })
    app.post('/u', upload.single('file'), (_req, res) => {
      res.json({ ok: true })
    })
    // multer errors flow to the default error handler — give it a typed
    // one that surfaces the MulterError code so we can assert.
    app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const e = err as { code?: string; message?: string }
      res.status(413).json({ code: e.code, message: e.message })
    })

    const server = http.createServer(app)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as AddressInfo).port

    const boundary = '----test-boundary-' + Math.random().toString(36).slice(2)
    const fileBuf = Buffer.alloc(1000) // way over 10
    const parts = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="big.bin"',
      'Content-Type: application/octet-stream',
      '',
      fileBuf.toString('binary'),
      `--${boundary}--`,
      '',
    ].join('\r\n')

    try {
      const res = await fetch(`http://127.0.0.1:${port}/u`, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body: parts,
      })
      expect(res.status).toBe(413)
      const body = (await res.json()) as { code?: string }
      expect(body.code).toBe('LIMIT_FILE_SIZE')
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
})
