import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import express from 'express'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

// Route tests for the Obsidian add-on's CLAUDE.md generator + status. The
// vault stays read-only on the grounding path; the generator is the second
// sanctioned write (guarded behind the Claude Code add-on + a don't-clobber
// confirm). configDir/cacheDir are redirected to a temp dir, and
// isAddonLoaded is mocked so we can flip the claude-code guard.

let WORK: string
let VAULT: string
let ccLoaded = false

beforeEach(async () => {
  WORK = await fs.mkdtemp(path.join(tmpdir(), 'obsidian-route-'))
  VAULT = await fs.mkdtemp(path.join(tmpdir(), 'obsidian-vault-'))
  ccLoaded = false
  vi.resetModules()
  vi.doMock('../appData.js', async () => {
    const actual = await vi.importActual<typeof import('../appData')>('../appData.js')
    return {
      ...actual,
      configDir: () => WORK,
      cacheDir: () => WORK,
    }
  })
  vi.doMock('../addons/loader.js', () => ({
    isAddonLoaded: (name: string) => (name === 'claude-code-addon' ? ccLoaded : false),
  }))
})

afterEach(async () => {
  vi.doUnmock('../appData.js')
  vi.doUnmock('../addons/loader.js')
  vi.resetModules()
  await fs.rm(WORK, { recursive: true, force: true })
  await fs.rm(VAULT, { recursive: true, force: true })
})

/** Write the obsidian-vault.json config the resolver/router read. */
async function writeConfig(extra: Record<string, unknown> = {}): Promise<void> {
  await fs.writeFile(
    path.join(WORK, 'obsidian-vault.json'),
    JSON.stringify({ enabled: true, vaultPath: VAULT, modeB: false, useClaudeMdContext: false, ...extra }),
  )
}

async function withObsidianServer<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const mod = await import('./obsidian.js')
  const app = express()
  app.use('/api/obsidian', mod.obsidianRouter())
  const server: Server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${addr.port}/api/obsidian`
  try {
    return await fn(baseUrl)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

describe('POST /api/obsidian/generate-claude-md', () => {
  it('400s when the Claude Code add-on is not loaded', async () => {
    ccLoaded = false
    await writeConfig()
    await withObsidianServer(async (base) => {
      const res = await fetch(`${base}/generate-claude-md`, { method: 'POST' })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: string }
      expect(body.error).toContain('Claude Code add-on')
      // Nothing written to the vault.
      await expect(fs.access(path.join(VAULT, 'CLAUDE.md'))).rejects.toBeTruthy()
    })
  })

  it('writes a CLAUDE.md when both add-ons are in use', async () => {
    ccLoaded = true
    await writeConfig()
    await fs.mkdir(path.join(VAULT, '02 - NPCs'), { recursive: true })
    await fs.writeFile(path.join(VAULT, '02 - NPCs', 'Morlan.md'), `---\ntype: npc\naliases: [Gravedust]\n---\nbody`)
    await withObsidianServer(async (base) => {
      const res = await fetch(`${base}/generate-claude-md`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: boolean; replaced: boolean }
      expect(body.ok).toBe(true)
      expect(body.replaced).toBe(false)
      const written = await fs.readFile(path.join(VAULT, 'CLAUDE.md'), 'utf8')
      expect(written).toContain('# Vault navigation guide')
    })
  })

  it('409s when a CLAUDE.md already exists and overwrite is not set, then replaces on confirm', async () => {
    ccLoaded = true
    await writeConfig()
    await fs.writeFile(path.join(VAULT, 'CLAUDE.md'), '# Existing guide\n\nHand-written.\n')
    await withObsidianServer(async (base) => {
      const conflict = await fetch(`${base}/generate-claude-md`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(conflict.status).toBe(409)
      const cbody = (await conflict.json()) as { exists: boolean; existingPreview: string }
      expect(cbody.exists).toBe(true)
      expect(cbody.existingPreview).toContain('Existing guide')
      // The existing file is untouched until the user confirms.
      expect(await fs.readFile(path.join(VAULT, 'CLAUDE.md'), 'utf8')).toContain('Hand-written.')

      const replaced = await fetch(`${base}/generate-claude-md`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ overwrite: true }),
      })
      expect(replaced.status).toBe(200)
      const rbody = (await replaced.json()) as { replaced: boolean }
      expect(rbody.replaced).toBe(true)
      const after = await fs.readFile(path.join(VAULT, 'CLAUDE.md'), 'utf8')
      expect(after).toContain('# Vault navigation guide')
      expect(after).not.toContain('Hand-written.')
    })
  })
})

describe('GET /api/obsidian/status', () => {
  it('reports claudeMdPresent for the configured vault', async () => {
    await writeConfig()
    await withObsidianServer(async (base) => {
      const before = (await (await fetch(`${base}/status`)).json()) as { claudeMdPresent: boolean }
      expect(before.claudeMdPresent).toBe(false)
      await fs.writeFile(path.join(VAULT, 'CLAUDE.md'), '# Guide\n')
      const after = (await (await fetch(`${base}/status`)).json()) as { claudeMdPresent: boolean }
      expect(after.claudeMdPresent).toBe(true)
    })
  })
})
