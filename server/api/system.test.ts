// Tests for GET /api/system/cli-detect — the detection endpoint the
// Recommended Setup wizard depends on.
//
// Why this endpoint exists at all is the thing worth protecting: the add-ons'
// own routers (/api/claude-code, /api/codex) are mounted by
// addon.registerRoutes() only once the add-on is enabled AND the server has
// restarted. A wizard asking "do you have a Claude Code subscription?" cannot
// use those routes, because on a first-time install they do not exist yet.
// systemRouter is mounted unconditionally, so detection lives here.
//
// If someone later "tidies" this by moving detection onto the add-on routers,
// these tests fail — which is the point.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockSpawn, resetSpawnMock, whenCommand } from '../testing/spawnMock.js'
import { withRouter } from '../testing/httpFixture.js'

vi.mock('node:child_process', () => mockSpawn())

// Detection reads credential-file PRESENCE (never contents). Stub node:fs so
// the result doesn't depend on whether the machine running the suite happens
// to have a real ~/.claude or ~/.codex.
const present = new Set<string>()
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    default: actual,
    promises: {
      ...actual.promises,
      access: (p: string) =>
        [...present].some((frag) => String(p).includes(frag))
          ? Promise.resolve()
          : Promise.reject(new Error('ENOENT')),
    },
  }
})

// The add-on loader tracks mount state in a module-level Set; the wizard needs
// it to decide whether a restart is still required.
const loaded = new Set<string>()
vi.mock('../addons/loader.js', () => ({
  isAddonLoaded: (name: string) => loaded.has(name),
}))

beforeEach(() => {
  resetSpawnMock()
  present.clear()
  loaded.clear()
  vi.resetModules()
})

async function detect(): Promise<Record<string, never> & any> {
  const { systemRouter } = await import('./system.js')
  return withRouter('/api/system', systemRouter(), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/cli-detect`)
    expect(res.status).toBe(200)
    return res.json()
  })
}

describe('GET /api/system/cli-detect', () => {
  it('reports an installed + logged-in Claude Code CLI', async () => {
    whenCommand('claude', () => ({ code: 0, stdout: '2.1.220 (Claude Code)' }))
    present.add('.credentials.json')

    const body = await detect()
    expect(body.claudeCode.installed).toBe(true)
    expect(body.claudeCode.version).toContain('2.1.220')
    expect(body.claudeCode.authenticated).toBe(true)
  })

  it('separates "installed" from "authenticated"', async () => {
    // CLI on PATH but never logged in — the wizard must offer `claude login`
    // rather than silently routing phases to a provider that will 401.
    whenCommand('claude', () => ({ code: 0, stdout: '2.1.220 (Claude Code)' }))

    const body = await detect()
    expect(body.claudeCode.installed).toBe(true)
    expect(body.claudeCode.authenticated).toBe(false)
  })

  it('reports a missing CLI without throwing', async () => {
    const enoent = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })
    whenCommand('claude', () => ({ code: -1, emitError: enoent }))

    const body = await detect()
    expect(body.claudeCode.installed).toBe(false)
    expect(body.claudeCode.version).toBeNull()
  })

  it('exposes `authenticated` for Codex too, symmetrically with Claude Code', async () => {
    // Regression: codexStatus() originally had no `authenticated` field at
    // all, so the wizard could detect that Codex was installed but never that
    // it was usable — it had to fall back to asking the user.
    whenCommand('codex', () => ({ code: 0, stdout: 'codex-cli 0.9.0' }))
    present.add('.codex')

    const body = await detect()
    expect(body.codex.installed).toBe(true)
    expect(body.codex.authenticated).toBe(true)
    expect(Object.keys(body.codex).sort()).toEqual(Object.keys(body.claudeCode).sort())
  })

  it('flags restartRequired when a usable CLI has no mounted add-on', async () => {
    whenCommand('claude', () => ({ code: 0, stdout: '2.1.220 (Claude Code)' }))
    present.add('.credentials.json')
    // loaded stays empty → add-on not mounted in this process.

    const body = await detect()
    expect(body.claudeCode.loaded).toBe(false)
    expect(body.restartRequired).toBe(true)
  })

  it('does not flag restartRequired once the add-on is mounted', async () => {
    whenCommand('claude', () => ({ code: 0, stdout: '2.1.220 (Claude Code)' }))
    present.add('.credentials.json')
    loaded.add('claude-code-addon')

    const body = await detect()
    expect(body.claudeCode.loaded).toBe(true)
    expect(body.restartRequired).toBe(false)
  })

  it('does not flag restartRequired for a CLI that is merely absent', async () => {
    // Nothing installed at all is a normal first-run state, not a restart.
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    whenCommand('claude', () => ({ code: -1, emitError: enoent }))
    whenCommand('codex', () => ({ code: -1, emitError: enoent }))

    const body = await detect()
    expect(body.restartRequired).toBe(false)
  })
})
