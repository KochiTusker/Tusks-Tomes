import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import express from 'express'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

// Phase J — speakers PUT now surfaces dropped-entry counts.

let WORK: string

beforeEach(async () => {
  WORK = await fs.mkdtemp(path.join(tmpdir(), 'speakers-test-'))
  vi.resetModules()
  vi.doMock('../appData.js', async () => {
    const actual = await vi.importActual<typeof import('../appData')>('../appData.js')
    return {
      ...actual,
      configDir: () => WORK,
      speakersFile: () => path.join(WORK, 'speakers.json'),
    }
  })
})

afterEach(async () => {
  vi.doUnmock('../appData.js')
  vi.resetModules()
  await fs.rm(WORK, { recursive: true, force: true })
})

async function withSpeakersServer<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const mod = await import('./speakers.js')
  const app = express()
  app.use(express.json())
  app.use('/api/speakers', mod.speakersRouter())
  const server: Server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${addr.port}/api/speakers`
  try {
    return await fn(baseUrl)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

describe('speakersRouter PUT — strict validation (Phase J)', () => {
  it('happy path: well-formed speaker round-trips without warnings', async () => {
    await withSpeakersServer(async (base) => {
      const res = await fetch(base, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          speakers: [
            { discordUserId: 'u-1', playerName: 'Alice', characterName: 'Aragorn' },
          ],
        }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as Record<string, unknown>
      expect(body.warnings).toBeUndefined()
    })
  })

  it('returns 400 for non-object body', async () => {
    await withSpeakersServer(async (base) => {
      const res = await fetch(base, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: 'null',
      })
      // 'null' parses as null which is not a JSON object → 400
      expect(res.status).toBe(400)
    })
  })

  it('warns when speakers entries are dropped due to missing discordUserId', async () => {
    await withSpeakersServer(async (base) => {
      const res = await fetch(base, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          speakers: [
            { discordUserId: 'ok', playerName: 'Alice', characterName: 'A' },
            { playerName: 'no id', characterName: 'X' }, // dropped — no discordUserId
            { discordUserId: '', playerName: 'empty id', characterName: 'Y' }, // dropped — empty
          ],
        }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { warnings?: string[]; speakers: unknown[] }
      expect(body.warnings).toBeDefined()
      expect(body.warnings![0]).toContain('2')
      expect(body.warnings![0]).toContain('discordUserId')
      expect(body.speakers.length).toBe(1)
    })
  })
})
