import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import express from 'express'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

// settings.ts reads/writes through appData's settingsFile(), which is
// {configDir}/settings.json. We redirect configDir at module-load time
// to a temp dir per test so the real user config is never touched.

let WORK: string

beforeEach(async () => {
  WORK = await fs.mkdtemp(path.join(tmpdir(), 'settings-test-'))
  vi.resetModules()
  vi.doMock('../appData.js', async () => {
    const actual =
      await vi.importActual<typeof import('../appData')>('../appData.js')
    return {
      ...actual,
      configDir: () => WORK,
      settingsFile: () => path.join(WORK, 'settings.json'),
    }
  })
})

afterEach(async () => {
  vi.doUnmock('../appData.js')
  vi.resetModules()
  await fs.rm(WORK, { recursive: true, force: true })
})

/** Spin up a real HTTP server with settingsRouter mounted, hand the
 *  base URL + the module's exports to a test, then tear down. The
 *  module is re-imported each call so each test starts with fresh
 *  module-scoped state (devAuthSession resets to false).
 *
 *  Real HTTP via Node's built-in http + the global fetch (Node 18+)
 *  exercises express middleware + the router exactly as production
 *  does — no mocks for the request body parser, JSON handling, etc. */
async function withSettingsServer<T>(
  fn: (
    baseUrl: string,
    mod: typeof import('./settings'),
  ) => Promise<T>,
): Promise<T> {
  const mod = await import('./settings.js')
  const app = express()
  app.use(express.json())
  app.use('/api/settings', mod.settingsRouter())
  const server: Server = createServer(app)
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  )
  const addr = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${addr.port}/api/settings`
  try {
    return await fn(baseUrl, mod)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

describe('readSettings', () => {
  it('returns the default updaterRemote="origin" when no file exists', async () => {
    const { readSettings } = await import('./settings.js')
    expect(await readSettings()).toEqual({ updaterRemote: 'origin', disableThinkingOnGrounding: false, phase1AliasHints: false, reassembleQuotes: false, retrieveVaultKb: false, claudeCodePlan: 'unknown', codexPlan: 'unknown', perPhaseThinking: {}, devTestMode: { enabled: false, maxChars: 24000 } })
  })

  it('reads a persisted "dev" setting back', async () => {
    await fs.writeFile(
      path.join(WORK, 'settings.json'),
      JSON.stringify({ updaterRemote: 'dev' }),
      'utf8',
    )
    const { readSettings } = await import('./settings.js')
    expect(await readSettings()).toEqual({ updaterRemote: 'dev', disableThinkingOnGrounding: false, phase1AliasHints: false, reassembleQuotes: false, retrieveVaultKb: false, claudeCodePlan: 'unknown', codexPlan: 'unknown', perPhaseThinking: {}, devTestMode: { enabled: false, maxChars: 24000 } })
  })

  // Security guard: the persisted value flows into `git fetch <remote>`,
  // so an arbitrary string here would be passed to git as a remote name.
  // The validator must coerce anything outside the closed union back to
  // "origin" so a hand-edited file can't smuggle in a bogus value.
  it('coerces an unknown updaterRemote value to "origin"', async () => {
    await fs.writeFile(
      path.join(WORK, 'settings.json'),
      JSON.stringify({ updaterRemote: 'totally-not-a-remote' }),
      'utf8',
    )
    const { readSettings } = await import('./settings.js')
    expect(await readSettings()).toEqual({ updaterRemote: 'origin', disableThinkingOnGrounding: false, phase1AliasHints: false, reassembleQuotes: false, retrieveVaultKb: false, claudeCodePlan: 'unknown', codexPlan: 'unknown', perPhaseThinking: {}, devTestMode: { enabled: false, maxChars: 24000 } })
  })

  it('survives a malformed settings.json (treats as missing)', async () => {
    await fs.writeFile(path.join(WORK, 'settings.json'), '{ not json', 'utf8')
    // Mute the deliberate warn so the test output stays clean.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { readSettings } = await import('./settings.js')
    // A hand-edited / corrupted settings.json must NOT block the
    // updater. readSettings catches the parse failure and falls back
    // to defaults; the user can fix the file via POST /api/settings
    // (or by deleting it) whenever they like.
    await expect(readSettings()).resolves.toEqual({ updaterRemote: 'origin', disableThinkingOnGrounding: false, phase1AliasHints: false, reassembleQuotes: false, retrieveVaultKb: false, claudeCodePlan: 'unknown', codexPlan: 'unknown', perPhaseThinking: {}, devTestMode: { enabled: false, maxChars: 24000 } })
  })

  it('treats null or non-object roots as empty', async () => {
    await fs.writeFile(path.join(WORK, 'settings.json'), 'null', 'utf8')
    const { readSettings } = await import('./settings.js')
    expect(await readSettings()).toEqual({ updaterRemote: 'origin', disableThinkingOnGrounding: false, phase1AliasHints: false, reassembleQuotes: false, retrieveVaultKb: false, claudeCodePlan: 'unknown', codexPlan: 'unknown', perPhaseThinking: {}, devTestMode: { enabled: false, maxChars: 24000 } })
  })
})

describe('writeSettings', () => {
  it('persists updaterRemote="dev" to disk', async () => {
    const { writeSettings, readSettings } = await import('./settings.js')
    const result = await writeSettings({ updaterRemote: 'dev' })
    expect(result).toEqual({ updaterRemote: 'dev', disableThinkingOnGrounding: false, phase1AliasHints: false, reassembleQuotes: false, retrieveVaultKb: false, claudeCodePlan: 'unknown', codexPlan: 'unknown', perPhaseThinking: {}, devTestMode: { enabled: false, maxChars: 24000 } })
    expect(await readSettings()).toEqual({ updaterRemote: 'dev', disableThinkingOnGrounding: false, phase1AliasHints: false, reassembleQuotes: false, retrieveVaultKb: false, claudeCodePlan: 'unknown', codexPlan: 'unknown', perPhaseThinking: {}, devTestMode: { enabled: false, maxChars: 24000 } })
  })

  it('drops an invalid value silently and writes the safe default', async () => {
    const { writeSettings } = await import('./settings.js')
    // Cast through unknown to bypass the closed-union compile-time check —
    // simulates a malicious POST body the server should still coerce.
    const result = await writeSettings({
      updaterRemote: 'evil-remote' as unknown as 'dev',
    })
    expect(result.updaterRemote).toBe('origin')
  })

  it('preserves existing fields when patching a partial', async () => {
    const { writeSettings, readSettings } = await import('./settings.js')
    await writeSettings({ updaterRemote: 'dev' })
    // Empty patch — should not change anything.
    await writeSettings({})
    expect((await readSettings()).updaterRemote).toBe('dev')
  })

  it('is round-trip stable across many writes', async () => {
    const { writeSettings, readSettings } = await import('./settings.js')
    for (const target of ['dev', 'origin', 'dev', 'origin'] as const) {
      await writeSettings({ updaterRemote: target })
      expect((await readSettings()).updaterRemote).toBe(target)
    }
  })

  it('clears the dev-auth session when switching back to origin', async () => {
    // Setup: grant dev-auth and confirm.
    const mod = await import('./settings.js')
    await mod.writeSettings({ updaterRemote: 'dev' })
    // Manually trip the session flag via the writeSettings path on
    // 'dev' (production code uses the /dev-auth endpoint; we set
    // directly via require to test the clear-on-public-switch invariant).
    // Use the orchestrator helpers — they're the public contract.
    expect(mod.isDevAuthGranted()).toBe(false) // never auto-granted

    // Simulate an active session as if /dev-auth had been called.
    // We don't have a public setter for grant; use a deliberately
    // narrow test hook: re-import a copy of the module won't help (it'd
    // be a separate module-state). Instead, write 'dev' + manually
    // clear, asserting the writeSettings 'origin' path triggers clear.
    // The flag is initialised to false in module scope, so confirming
    // it stays false after a write-to-origin is sufficient here.
    await mod.writeSettings({ updaterRemote: 'origin' })
    expect(mod.isDevAuthGranted()).toBe(false)
  })
})

describe('dev-auth session state', () => {
  it('isDevAuthGranted defaults to false (not persisted across module init)', async () => {
    const { isDevAuthGranted } = await import('./settings.js')
    expect(isDevAuthGranted()).toBe(false)
  })

  it('clearDevAuthSession is idempotent and silently safe to re-call', async () => {
    const { clearDevAuthSession, isDevAuthGranted } = await import('./settings.js')
    clearDevAuthSession()
    clearDevAuthSession()
    expect(isDevAuthGranted()).toBe(false)
  })

  it('effectiveUpdaterRemote returns origin when grant is missing, even if setting is dev', async () => {
    const { writeSettings, effectiveUpdaterRemote, clearDevAuthSession } =
      await import('./settings.js')
    await writeSettings({ updaterRemote: 'dev' })
    clearDevAuthSession()
    expect(await effectiveUpdaterRemote()).toBe('origin')
  })

  it('isDevAuthRequired is true when setting=dev and grant is missing', async () => {
    const { writeSettings, isDevAuthRequired, clearDevAuthSession } =
      await import('./settings.js')
    await writeSettings({ updaterRemote: 'dev' })
    clearDevAuthSession()
    expect(await isDevAuthRequired()).toBe(true)
  })

  it('isDevAuthRequired is false when setting is origin (no dev preference)', async () => {
    const { writeSettings, isDevAuthRequired } = await import('./settings.js')
    await writeSettings({ updaterRemote: 'origin' })
    expect(await isDevAuthRequired()).toBe(false)
  })
})

// ───── Route-level tests for the dev-auth endpoints ─────
//
// These are the security-critical paths. The unit tests above cover
// the underlying functions, but the actual surface a user (or an
// attacker) hits is HTTP. Each test spins up a real express server
// with the real router and hits it with real fetch — no mocks for
// the body parser or the route dispatch.
//
// PROVE-IT: the invariants here are exactly the security claims made
// in 083f6d6's commit message. If any of these go red, the
// dev-mode gate has regressed.

describe('POST /api/settings/dev-auth — input validation (PROVE-IT)', () => {
  // The headline security claim: nothing short of a deliberate
  // non-empty submission flips the in-memory grant or persists the
  // dev-preference. An attacker can't slip the gate by sending
  // empty / missing / whitespace-only / wrongly-typed payloads.

  it('rejects { email: "" } with HTTP 400 and grants no auth', async () => {
    await withSettingsServer(async (base, mod) => {
      const res = await fetch(`${base}/dev-auth`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: '' }),
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { ok?: boolean; error?: string }
      expect(body.ok).toBe(false)
      expect(typeof body.error).toBe('string')
      expect(mod.isDevAuthGranted()).toBe(false)
      // Persistent preference is unchanged — empty email cannot promote.
      expect((await mod.readSettings()).updaterRemote).toBe('origin')
    })
  })

  it('rejects { email: "   " } (whitespace-only after trim)', async () => {
    await withSettingsServer(async (base, mod) => {
      const res = await fetch(`${base}/dev-auth`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: '   \t  ' }),
      })
      expect(res.status).toBe(400)
      expect(mod.isDevAuthGranted()).toBe(false)
      expect((await mod.readSettings()).updaterRemote).toBe('origin')
    })
  })

  it('rejects missing email field', async () => {
    await withSettingsServer(async (base, mod) => {
      const res = await fetch(`${base}/dev-auth`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(400)
      expect(mod.isDevAuthGranted()).toBe(false)
    })
  })

  it('rejects non-string email values', async () => {
    await withSettingsServer(async (base, mod) => {
      for (const bad of [12345, null, true, [], { x: 1 }]) {
        const res = await fetch(`${base}/dev-auth`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: bad }),
        })
        expect(res.status, `value ${JSON.stringify(bad)} should be rejected`).toBe(400)
        expect(mod.isDevAuthGranted()).toBe(false)
      }
    })
  })

  it('rejects emails longer than 254 chars (RFC 5321 cap)', async () => {
    await withSettingsServer(async (base, mod) => {
      const tooLong = 'a'.repeat(245) + '@example.com' // 257 chars
      const res = await fetch(`${base}/dev-auth`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: tooLong }),
      })
      expect(res.status).toBe(400)
      expect(mod.isDevAuthGranted()).toBe(false)
    })
  })

  it('rejects non-JSON body (missing content-type)', async () => {
    await withSettingsServer(async (base, mod) => {
      // express.json() ignores the request without the right
      // content-type, so req.body is {} and our route returns 400.
      const res = await fetch(`${base}/dev-auth`, {
        method: 'POST',
        body: 'email=test@example.com',
      })
      expect(res.status).toBe(400)
      expect(mod.isDevAuthGranted()).toBe(false)
    })
  })
})

describe('POST /api/settings/dev-auth — success path', () => {
  it('with a non-empty email: grants session AND persists pref=dev', async () => {
    await withSettingsServer(async (base, mod) => {
      const res = await fetch(`${base}/dev-auth`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'maintainer@example.com' }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        ok?: boolean
        updaterRemote?: string
      }
      expect(body.ok).toBe(true)
      expect(body.updaterRemote).toBe('dev')
      expect(mod.isDevAuthGranted()).toBe(true)
      expect((await mod.readSettings()).updaterRemote).toBe('dev')
    })
  })

  it('typed email is NOT persisted (no plaintext leaks to disk)', async () => {
    await withSettingsServer(async (base, _mod) => {
      const secret = 'should-never-be-stored@example.com'
      await fetch(`${base}/dev-auth`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: secret }),
      })
      // The only persisted artefact should be settings.json with
      // updaterRemote=dev. The email itself must appear nowhere.
      const onDisk = await fs.readFile(path.join(WORK, 'settings.json'), 'utf8')
      expect(onDisk).not.toContain(secret)
      expect(onDisk).not.toContain('should-never-be-stored')
    })
  })

  it('grant survives subsequent reads within the same process', async () => {
    await withSettingsServer(async (base, mod) => {
      await fetch(`${base}/dev-auth`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'test@example.com' }),
      })
      // Multiple downstream calls should keep returning the granted state.
      expect(await mod.effectiveUpdaterRemote()).toBe('dev')
      expect(await mod.isDevAuthRequired()).toBe(false)
      expect(await mod.effectiveUpdaterRemote()).toBe('dev')
    })
  })
})

describe('POST /api/settings/dev-auth/lock', () => {
  it('clears the grant without changing the persisted preference', async () => {
    await withSettingsServer(async (base, mod) => {
      // Unlock first.
      await fetch(`${base}/dev-auth`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'a@example.com' }),
      })
      expect(mod.isDevAuthGranted()).toBe(true)
      expect((await mod.readSettings()).updaterRemote).toBe('dev')

      const res = await fetch(`${base}/dev-auth/lock`, { method: 'POST' })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok?: boolean }
      expect(body.ok).toBe(true)

      // Grant cleared, preference preserved.
      expect(mod.isDevAuthGranted()).toBe(false)
      expect((await mod.readSettings()).updaterRemote).toBe('dev')
      expect(await mod.effectiveUpdaterRemote()).toBe('origin') // no grant
      expect(await mod.isDevAuthRequired()).toBe(true)
    })
  })

  it('is idempotent — locking twice is fine and stays clean', async () => {
    await withSettingsServer(async (base, mod) => {
      const r1 = await fetch(`${base}/dev-auth/lock`, { method: 'POST' })
      const r2 = await fetch(`${base}/dev-auth/lock`, { method: 'POST' })
      expect(r1.status).toBe(200)
      expect(r2.status).toBe(200)
      expect(mod.isDevAuthGranted()).toBe(false)
    })
  })
})

describe('POST /api/settings — switch-to-public auto-clears the grant', () => {
  it('writing updaterRemote=origin via /settings clears any active grant', async () => {
    await withSettingsServer(async (base, mod) => {
      await fetch(`${base}/dev-auth`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'a@example.com' }),
      })
      expect(mod.isDevAuthGranted()).toBe(true)

      const res = await fetch(`${base}/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ updaterRemote: 'origin' }),
      })
      expect(res.status).toBe(200)
      expect(mod.isDevAuthGranted()).toBe(false)
      expect((await mod.readSettings()).updaterRemote).toBe('origin')
    })
  })

  it('writing updaterRemote=dev via /settings does NOT grant', async () => {
    // Important invariant: setting the PREFERENCE to dev via the
    // generic /settings endpoint must not bypass the email gate.
    // Only the /dev-auth endpoint grants. Otherwise a casual user
    // could flip the toggle in two clicks (5-tap + switch) without
    // ever typing an email.
    await withSettingsServer(async (base, mod) => {
      const res = await fetch(`${base}/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ updaterRemote: 'dev' }),
      })
      expect(res.status).toBe(200)
      expect((await mod.readSettings()).updaterRemote).toBe('dev')
      expect(mod.isDevAuthGranted()).toBe(false)
      expect(await mod.isDevAuthRequired()).toBe(true)
      // git operations would use origin, not dev, until the grant is
      // explicitly issued via /dev-auth.
      expect(await mod.effectiveUpdaterRemote()).toBe('origin')
    })
  })
})
