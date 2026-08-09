import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import express from 'express'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

// Phase J — Strict validation contract for PUT /api/profiles.
//
// Phase I didn't find a reproducible silent-coercion bug in profiles.ts
// (sanitizeProfile() falls back to seed values for non-string fields,
// which is conservative). But the handoff calls for applying the same
// pattern proactively — hard-shape body errors → 400; unknown modelId
// → 200 with warnings — so the user sees the same fail-loud behaviour
// they get from routing.ts.

let WORK: string

beforeEach(async () => {
  WORK = await fs.mkdtemp(path.join(tmpdir(), 'profiles-test-'))
  vi.resetModules()
  vi.doMock('../appData.js', async () => {
    const actual = await vi.importActual<typeof import('../appData')>('../appData.js')
    return {
      ...actual,
      configDir: () => WORK,
      profilesFile: () => path.join(WORK, 'profiles.json'),
    }
  })
})

afterEach(async () => {
  vi.doUnmock('../appData.js')
  vi.resetModules()
  await fs.rm(WORK, { recursive: true, force: true })
})

async function withProfilesServer<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const mod = await import('./profiles.js')
  const app = express()
  app.use(express.json())
  app.use('/api/profiles', mod.profilesRouter())
  const server: Server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${addr.port}/api/profiles`
  try {
    return await fn(baseUrl)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

const SEED_BODY = {
  version: 1,
  profiles: {
    gemini: {
      phase1Model: 'gemini-2.5-pro',
      phase2Model: 'gemini-2.5-flash',
      phase3Model: 'gemini-2.5-pro',
      phase4Model: 'gemini-2.5-flash',
    },
    claude: {
      phase1Model: 'claude-sonnet-4-6',
      phase2Model: 'claude-haiku-4-5-20251001',
      phase3Model: 'claude-sonnet-4-6',
      phase4Model: 'claude-haiku-4-5-20251001',
    },
    openai: {
      phase1Model: 'gpt-5-mini',
      phase2Model: 'gpt-5-nano',
      phase3Model: 'gpt-5',
      phase4Model: 'gpt-5-mini',
    },
  },
}

describe('profilesRouter PUT — strict validation (Phase J)', () => {
  it('happy path: SEED-shaped doc returns 200 with no warnings', async () => {
    await withProfilesServer(async (base) => {
      const res = await fetch(base, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(SEED_BODY),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as Record<string, unknown>
      expect(body.warnings).toBeUndefined()
    })
  })

  it('returns 400 for array body (express.json strict mode rejects bare strings/numbers before our handler runs)', async () => {
    await withProfilesServer(async (base) => {
      const res = await fetch(base, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(['array', 'not', 'object']),
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as Record<string, unknown>
      expect(body.field).toBe('_root')
    })
  })

  it('returns 400 when version is not 1', async () => {
    await withProfilesServer(async (base) => {
      const res = await fetch(base, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...SEED_BODY, version: 99 }),
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as Record<string, unknown>
      expect(body.field).toBe('version')
    })
  })

  it('returns 200 with warnings for unknown Claude modelId', async () => {
    await withProfilesServer(async (base) => {
      const res = await fetch(base, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...SEED_BODY,
          profiles: {
            ...SEED_BODY.profiles,
            claude: {
              ...SEED_BODY.profiles.claude,
              phase1Model: 'claude-omega-9000',
            },
          },
        }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { warnings?: string[] }
      expect(body.warnings).toBeDefined()
      expect(body.warnings!.some((w) => w.includes('claude-omega-9000'))).toBe(true)
    })
  })

  it('returns 200 with multiple warnings when several modelIds are unknown', async () => {
    await withProfilesServer(async (base) => {
      const res = await fetch(base, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...SEED_BODY,
          profiles: {
            ...SEED_BODY.profiles,
            gemini: {
              ...SEED_BODY.profiles.gemini,
              phase1Model: 'gemini-fake-1',
              phase3Model: 'gemini-fake-2',
            },
          },
        }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { warnings?: string[] }
      expect(body.warnings).toBeDefined()
      expect(body.warnings!.length).toBeGreaterThanOrEqual(2)
    })
  })
})
