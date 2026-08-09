// Regression tests for scripts/audit-security-contracts.mjs Rule 6.
//
// The audit script encodes institutional memory — these tests pin its
// own behaviour so a regression in the scanner can't silently mask a
// real regression in server/index.ts.
//
// Strategy: run the script as a subprocess against the real repo and
// against synthetic regressions written to a temp tree.

import { describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Spawning git against a temp fixture needs the inherited GIT_* namespace
// stripped, or the commands hit the outer repo instead. See the helper for
// the full explanation — it is shared because this has bitten twice.
import { cleanGitEnv } from './lib/clean-git-env.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(__dirname, 'audit-security-contracts.mjs')
const REPO_ROOT = resolve(__dirname, '..')

describe('audit-security-contracts script — overall', () => {
  it('exits 0 against the current real repo (sanity check)', () => {
    const result = spawnSync('node', [SCRIPT], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/clean/)
  })
})

// Helper: copy the script + the necessary helper modules into a temp
// dir, then write a synthetic server/index.ts and re-run the script
// pointing at the temp tree as its git working directory.
function runAgainstFixture(synthetic_server_index_content) {
  const tmp = mkdtempSync(join(tmpdir(), 'audit-contracts-fixture-'))
  try {
    // Initialise as a minimal git repo so `git ls-files` works.
    execFileSync('git', ['init', '-q'], { cwd: tmp, env: cleanGitEnv() })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmp, env: cleanGitEnv() })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmp, env: cleanGitEnv() })

    // Lay out the minimum tree the script needs:
    // - scripts/audit-security-contracts.mjs (the script under test)
    // - server/index.ts (the fixture content)
    // - server/api/localProxy.ts (lockedFile for Rule 1)
    // - some scripts/lib/*.mjs to satisfy globbing
    mkdirSync(join(tmp, 'scripts'), { recursive: true })
    cpSync(SCRIPT, join(tmp, 'scripts', 'audit-security-contracts.mjs'))

    mkdirSync(join(tmp, 'server', 'api'), { recursive: true })
    writeFileSync(join(tmp, 'server', 'index.ts'), synthetic_server_index_content)
    // Minimum localProxy.ts with a shell:true spawn + AUDIT comment so
    // Rule 1's positive-presence check passes.
    writeFileSync(join(tmp, 'server', 'api', 'localProxy.ts'), [
      "import { spawn } from 'node:child_process'",
      'function launch() {',
      '  // AUDIT: shell:true safe — literal inputs in fixture',
      "  spawn('cmd', ['ok'], { shell: true })",
      '}',
      'export { launch }',
    ].join('\n'))

    // Track everything in the fixture's git index so git ls-files returns it.
    execFileSync('git', ['add', '-A'], { cwd: tmp, env: cleanGitEnv() })

    const result = spawnSync('node', [join(tmp, 'scripts', 'audit-security-contracts.mjs')], {
      cwd: tmp,
      encoding: 'utf8',
      env: cleanGitEnv(),
    })
    return { tmp, ...result }
  } finally {
    // Caller cleans up after asserting.
  }
}

function cleanup(tmp) {
  try {
    rmSync(tmp, { recursive: true, force: true })
  } catch {
    // Windows lock — best effort.
  }
}

describe('Rule 6 — credentialed routes must carry loopbackOnly()', () => {
  it('passes when /api/provider-keys mount has loopbackOnly()', () => {
    const goodIndex = [
      "import { providerKeysRouter } from './api/providerKeys.js'",
      "import { loopbackOnly } from './lib/loopbackGate.js'",
      'const app = makeApp()',
      "app.use('/api/provider-keys', loopbackOnly(), providerKeysRouter())",
    ].join('\n')
    const { tmp, status, stdout, stderr } = runAgainstFixture(goodIndex)
    try {
      expect(status).toBe(0)
      expect(stdout + stderr).not.toMatch(/credentialed-route-missing-loopback-gate/)
    } finally {
      cleanup(tmp)
    }
  })

  it('fails when /api/provider-keys mount is missing loopbackOnly()', () => {
    const badIndex = [
      "import { providerKeysRouter } from './api/providerKeys.js'",
      'const app = makeApp()',
      "app.use('/api/provider-keys', providerKeysRouter())",
    ].join('\n')
    const { tmp, status, stdout, stderr } = runAgainstFixture(badIndex)
    try {
      expect(status).not.toBe(0)
      expect(stdout + stderr).toMatch(/credentialed-route-missing-loopback-gate/)
      expect(stdout + stderr).toMatch(/\/api\/provider-keys/)
    } finally {
      cleanup(tmp)
    }
  })

  it('fails when /api/providers mount is missing loopbackOnly()', () => {
    const badIndex = [
      "import { providersRouter } from './api/providers.js'",
      'const app = makeApp()',
      "app.use('/api/providers', providersRouter())",
    ].join('\n')
    const { tmp, status, stdout, stderr } = runAgainstFixture(badIndex)
    try {
      expect(status).not.toBe(0)
      expect(stdout + stderr).toMatch(/credentialed-route-missing-loopback-gate/)
    } finally {
      cleanup(tmp)
    }
  })

  it('fails when /api/updater mount is missing loopbackOnly()', () => {
    const badIndex = [
      "import { updaterRouter } from './api/updater.js'",
      'const app = makeApp()',
      "app.use('/api/updater', updaterRouter())",
    ].join('\n')
    const { tmp, status, stdout, stderr } = runAgainstFixture(badIndex)
    try {
      expect(status).not.toBe(0)
      expect(stdout + stderr).toMatch(/credentialed-route-missing-loopback-gate/)
    } finally {
      cleanup(tmp)
    }
  })

  it('accepts an explicit `// LAN-OK:` opt-out comment on the same line', () => {
    const optOutIndex = [
      "import { providerKeysRouter } from './api/providerKeys.js'",
      'const app = makeApp()',
      "app.use('/api/provider-keys', providerKeysRouter()) // LAN-OK: synthetic test — deliberately bypassing gate",
    ].join('\n')
    const { tmp, status, stdout, stderr } = runAgainstFixture(optOutIndex)
    try {
      expect(status).toBe(0)
      expect(stdout + stderr).not.toMatch(/credentialed-route-missing-loopback-gate/)
    } finally {
      cleanup(tmp)
    }
  })

  it('accepts an `// AUDIT:` opt-out comment on the line above', () => {
    const optOutIndex = [
      "import { providerKeysRouter } from './api/providerKeys.js'",
      'const app = makeApp()',
      '// AUDIT: synthetic test — explicit acknowledgement of unguarded route',
      "app.use('/api/provider-keys', providerKeysRouter())",
    ].join('\n')
    const { tmp, status, stdout, stderr } = runAgainstFixture(optOutIndex)
    try {
      expect(status).toBe(0)
      expect(stdout + stderr).not.toMatch(/credentialed-route-missing-loopback-gate/)
    } finally {
      cleanup(tmp)
    }
  })

  it('passes when only non-credentialed routes are mounted', () => {
    const goodIndex = [
      "import { glossaryRouter } from './api/glossary.js'",
      'const app = makeApp()',
      "app.use('/api/glossary', glossaryRouter())",
      "app.use('/api/sessions', glossaryRouter())",
    ].join('\n')
    const { tmp, status, stdout, stderr } = runAgainstFixture(goodIndex)
    try {
      expect(status).toBe(0)
      expect(stdout + stderr).not.toMatch(/credentialed-route-missing-loopback-gate/)
    } finally {
      cleanup(tmp)
    }
  })
})

describe('Rule 7 — inline-gated routes must keep loopbackOnly()', () => {
  // Rule 7 walks a list of known inline-gated handlers and verifies
  // each carries loopbackOnly() in its middleware chain. A regression
  // that removes the gate from a refactor would silently break the
  // contract; this test catches that.

  function runWithLocalProxy(content) {
    const tmp = mkdtempSync(join(tmpdir(), 'audit-rule7-'))
    execFileSync('git', ['init', '-q'], { cwd: tmp, env: cleanGitEnv() })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmp, env: cleanGitEnv() })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmp, env: cleanGitEnv() })
    mkdirSync(join(tmp, 'scripts'), { recursive: true })
    cpSync(SCRIPT, join(tmp, 'scripts', 'audit-security-contracts.mjs'))
    mkdirSync(join(tmp, 'server', 'api'), { recursive: true })
    writeFileSync(join(tmp, 'server', 'index.ts'), '// empty fixture\n')
    // Real localProxy.ts has shell:true with AUDIT — satisfies Rule 1.
    writeFileSync(join(tmp, 'server', 'api', 'localProxy.ts'), content)
    execFileSync('git', ['add', '-A'], { cwd: tmp, env: cleanGitEnv() })
    const result = spawnSync('node', [join(tmp, 'scripts', 'audit-security-contracts.mjs')], {
      cwd: tmp,
      encoding: 'utf8',
      env: cleanGitEnv(),
    })
    return { tmp, ...result }
  }

  it('passes when POST /launch has loopbackOnly() in the middleware chain', () => {
    const goodLocalProxy = [
      "import { spawn } from 'node:child_process'",
      "import { loopbackOnly } from '../lib/loopbackGate.js'",
      'function launch() {',
      '  // AUDIT: shell:true safe — literal inputs in fixture',
      "  spawn('cmd', ['ok'], { shell: true })",
      '}',
      'function makeRouter() {',
      '  const router = makeExpressRouter()',
      "  router.post('/launch', loopbackOnly(), async (req, res) => { launch(); res.json({ ok: true }) })",
      '  return router',
      '}',
      'export { launch, makeRouter }',
    ].join('\n')
    const { tmp, status, stdout, stderr } = runWithLocalProxy(goodLocalProxy)
    try {
      expect(status).toBe(0)
      expect(stdout + stderr).not.toMatch(/inline-gate-missing/)
    } finally {
      cleanup(tmp)
    }
  })

  it('fails when POST /launch is declared but loopbackOnly() is missing (the regression)', () => {
    const badLocalProxy = [
      "import { spawn } from 'node:child_process'",
      'function launch() {',
      '  // AUDIT: shell:true safe — literal inputs in fixture',
      "  spawn('cmd', ['ok'], { shell: true })",
      '}',
      'function makeRouter() {',
      '  const router = makeExpressRouter()',
      // No loopbackOnly() in the chain.
      "  router.post('/launch', async (req, res) => { launch(); res.json({ ok: true }) })",
      '  return router',
      '}',
      'export { launch, makeRouter }',
    ].join('\n')
    const { tmp, status, stdout, stderr } = runWithLocalProxy(badLocalProxy)
    try {
      expect(status).not.toBe(0)
      expect(stdout + stderr).toMatch(/inline-gate-missing/)
      expect(stdout + stderr).toMatch(/POST \/launch/)
    } finally {
      cleanup(tmp)
    }
  })

  it('passes (no fire) when the route is not declared at all in the fixture file', () => {
    // Rule 7 should NOT flag a missing gate when the route declaration
    // itself is absent — that means the file is in a state where the
    // route hasn't been written yet (or has been removed entirely).
    const minimal = [
      "import { spawn } from 'node:child_process'",
      'function launch() {',
      '  // AUDIT: shell:true safe — literal inputs in fixture',
      "  spawn('cmd', ['ok'], { shell: true })",
      '}',
      'export { launch }',
    ].join('\n')
    const { tmp, status, stdout, stderr } = runWithLocalProxy(minimal)
    try {
      expect(status).toBe(0)
      expect(stdout + stderr).not.toMatch(/inline-gate-missing/)
    } finally {
      cleanup(tmp)
    }
  })
})

describe('Rule 1 — shell:true global scan (Phase 6.5 promotion)', () => {
  it('fails when a NEW file introduces spawn({shell:true}) without an AUDIT comment', () => {
    // The fixture's localProxy.ts has its AUDIT comment (set up in
    // runAgainstFixture). We add an additional file with shell:true
    // and no AUDIT — the global scan should catch it.
    const tmp = mkdtempSync(join(tmpdir(), 'audit-rule1-global-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: tmp, env: cleanGitEnv() })
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmp, env: cleanGitEnv() })
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmp, env: cleanGitEnv() })

      mkdirSync(join(tmp, 'scripts'), { recursive: true })
      cpSync(SCRIPT, join(tmp, 'scripts', 'audit-security-contracts.mjs'))

      mkdirSync(join(tmp, 'server', 'api'), { recursive: true })
      // Empty index.ts so Rule 6 doesn't fire.
      writeFileSync(join(tmp, 'server', 'index.ts'), '// empty fixture\n')
      // localProxy.ts has the AUDIT comment so Rule 1a passes.
      writeFileSync(join(tmp, 'server', 'api', 'localProxy.ts'), [
        "import { spawn } from 'node:child_process'",
        'function launch() {',
        '  // AUDIT: shell:true safe — literal inputs in fixture',
        "  spawn('cmd', ['ok'], { shell: true })",
        '}',
        'export { launch }',
      ].join('\n'))
      // Add a NEW file with shell:true but NO AUDIT comment.
      writeFileSync(join(tmp, 'server', 'api', 'sketchy.ts'), [
        "import { spawn } from 'node:child_process'",
        'function risky() {',
        "  spawn('cmd', ['ok'], { shell: true })",
        '}',
      ].join('\n'))

      execFileSync('git', ['add', '-A'], { cwd: tmp, env: cleanGitEnv() })

      const result = spawnSync('node', [join(tmp, 'scripts', 'audit-security-contracts.mjs')], {
        cwd: tmp,
        encoding: 'utf8',
      env: cleanGitEnv(),
      })
      expect(result.status).not.toBe(0)
      expect(result.stdout + result.stderr).toMatch(/shell-true-needs-audit/)
      expect(result.stdout + result.stderr).toMatch(/sketchy\.ts/)
    } finally {
      cleanup(tmp)
    }
  })
})
