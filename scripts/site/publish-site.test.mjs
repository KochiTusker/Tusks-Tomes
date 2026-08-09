/**
 * Publish-time identity gate.
 *
 * Regression this pins: the gh-pages orphan commit used to inherit whatever
 * `git config user.name` happened to be in effect. A repo-local `Test` (set
 * for a fixture and forgotten) overrode the correct global alias, git took it
 * silently, and the mistake only surfaced at the pre-push scanner — AFTER
 * typecheck and ~1200 tests had run. The publisher now resolves and validates
 * the identity up front, against the scanner's own allowlist so the two can
 * never disagree about what is publishable.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { cleanGitEnv } from '../lib/clean-git-env.mjs'
import { ALLOWED_AUTHORS, isAllowedIdentity } from '../lib/personal-info-scanner.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PUBLISH = path.join(HERE, 'publish-site.mjs')

const GOOD_NAME = ALLOWED_AUTHORS[0]
const GOOD_EMAIL = `12345+${ALLOWED_AUTHORS[0]}@users.noreply.github.com`
// Assembled at runtime rather than written as a literal. This address has to
// be OUTSIDE the allowlist for the assertion below to mean anything — and a
// literal outside-the-allowlist address is exactly what the repo's
// personal-info scanner blocks, so writing one here would fail the CI gate
// this file exists to protect.
const DISALLOWED_EMAIL = ['someone', 'not-an-alias.example'].join('@')

/** Run the publisher in a throwaway repo. Always --dry-run: no push, ever. */
function runPublish(cwd, env = {}) {
  try {
    const stdout = execFileSync('node', [PUBLISH, '--dry-run'], {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
      env: cleanGitEnv({
        // Neutralise the ambient identity so the test exercises the
        // publisher's own resolution rather than the developer's config.
        GIT_CONFIG_GLOBAL: path.join(cwd, 'nonexistent-global-config'),
        GIT_CONFIG_SYSTEM: path.join(cwd, 'nonexistent-system-config'),
        TUSKS_PUBLIC_AUTHOR_NAME: '',
        TUSKS_PUBLIC_AUTHOR_EMAIL: '',
        ...env,
      }),
    })
    return { ok: true, stdout, stderr: '' }
  } catch (err) {
    return {
      ok: false,
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
    }
  }
}

/** git against the fixture repo, never the repo this suite lives in. */
function fixtureGit(...args) {
  return execFileSync('git', args, {
    cwd: repo,
    stdio: 'pipe',
    encoding: 'utf8',
    env: cleanGitEnv(),
  })
}

let repo

beforeAll(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'tusks-publish-'))

  fixtureGit('init', '-q')
  // A remote literally named `public` — the publisher refuses to run without
  // one, because the pre-push gate keys on the remote NAME.
  fixtureGit('remote', 'add', 'public', 'https://example.com/placeholder.git')
  // Repo-local identity the scanner rejects: exactly the trap being pinned.
  fixtureGit('config', 'user.name', 'Test')
  fixtureGit('config', 'user.email', 'test@example.com')

  // Minimal site-dist/ so the publisher gets past its input check.
  mkdirSync(path.join(repo, 'site-dist'), { recursive: true })
  writeFileSync(path.join(repo, 'site-dist', 'index.html'), '<h1>fixture</h1>')
})

afterAll(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('publish-site identity gate', () => {
  it('refuses to build a commit the push gate would reject', () => {
    const r = runPublish(repo)

    expect(r.ok).toBe(false)
    expect(r.stderr).toContain('no publishable commit identity')
    // The failure must be actionable, not just a rejection.
    expect(r.stderr).toContain(GOOD_NAME)
    expect(r.stderr).toContain('TUSKS_PUBLIC_AUTHOR_NAME')
    // It must show what it actually found, or the user cannot tell which
    // of the three config scopes is the one shadowing the others.
    expect(r.stderr).toContain('Test <test@example.com>')
  })

  it('fails before touching git refs, so a bad run leaves nothing behind', () => {
    runPublish(repo)

    expect(() => fixtureGit('rev-parse', '--verify', 'refs/heads/gh-pages')).toThrow()
  })

  it('accepts an env-supplied identity without touching repo config', () => {
    const r = runPublish(repo, {
      TUSKS_PUBLIC_AUTHOR_NAME: GOOD_NAME,
      TUSKS_PUBLIC_AUTHOR_EMAIL: GOOD_EMAIL,
    })

    expect(r.stderr).toBe('')
    expect(r.ok).toBe(true)
    expect(r.stdout).toContain(`${GOOD_NAME} <${GOOD_EMAIL}>`)
    expect(r.stdout).toContain('--dry-run: not pushing')

    // The repo's own (rejected) identity must be untouched by the publish.
    expect(fixtureGit('config', 'user.name').trim()).toBe('Test')
  })

  it('stamps the resolved identity onto the orphan commit itself', () => {
    runPublish(repo, {
      TUSKS_PUBLIC_AUTHOR_NAME: GOOD_NAME,
      TUSKS_PUBLIC_AUTHOR_EMAIL: GOOD_EMAIL,
    })

    const [an, ae, cn, ce, parents] = fixtureGit(
      'log',
      '-1',
      '--format=%an%n%ae%n%cn%n%ce%n%P',
      'refs/heads/gh-pages',
    )
      .trim()
      .split('\n')

    // Both roles, not just the author — the scanner checks each separately.
    expect([an, cn]).toEqual([GOOD_NAME, GOOD_NAME])
    expect([ae, ce]).toEqual([GOOD_EMAIL, GOOD_EMAIL])
    expect(isAllowedIdentity(an, ae)).toBe(true)
    expect(isAllowedIdentity(cn, ce)).toBe(true)

    // Orphan: no parent. This is what keeps dev history off the public remote.
    expect(parents ?? '').toBe('')
  })

  it('stamps a UTC timestamp, not a local offset', () => {
    runPublish(repo, {
      TUSKS_PUBLIC_AUTHOR_NAME: GOOD_NAME,
      TUSKS_PUBLIC_AUTHOR_EMAIL: GOOD_EMAIL,
    })

    // A `+HH:MM` offset on a public commit is a geolocation tell.
    const offsets = fixtureGit('log', '-1', '--format=%ai%n%ci', 'refs/heads/gh-pages')
      .trim()
      .split('\n')

    for (const stamp of offsets) expect(stamp).toMatch(/\+0000$/)
  })
})

describe('isAllowedIdentity', () => {
  it('is the shared verdict for the gate and the publisher', () => {
    expect(isAllowedIdentity(GOOD_NAME, GOOD_EMAIL)).toBe(true)

    // Name and email are both required — an allowlisted email does not
    // launder a non-alias name, which is precisely the case that slipped
    // through to the pre-push scanner.
    expect(isAllowedIdentity('Test', 'test@example.com')).toBe(false)
    expect(isAllowedIdentity('Test', GOOD_EMAIL)).toBe(false)
    expect(isAllowedIdentity(GOOD_NAME, DISALLOWED_EMAIL)).toBe(false)
    expect(isAllowedIdentity('', '')).toBe(false)
    expect(isAllowedIdentity(GOOD_NAME, '')).toBe(false)
  })
})
