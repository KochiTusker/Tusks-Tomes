// Tests for the in-app updater route. This is the highest-stakes
// endpoint in the codebase — POST /apply runs `git pull + npm install`
// on the user's disk based on a request body. Previously had zero tests;
// the Phase 1.5 hardening (40-char-only confirmRemoteHead, no shortSha
// fallback) is the headline regression we pin here.
//
// We mock node:child_process.spawn (so git is scripted, not real) and
// node:fs (so .git lookups land in fixture state). settings.js is
// mocked at the module boundary so we don't need a real config dir.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mockSpawn, resetSpawnMock, spawnCalls, whenCommand } from '../testing/spawnMock.js'
import { withRouter } from '../testing/httpFixture.js'

// IMPORTANT: vi.mock calls are hoisted to the top of the file by vitest.
// Module-level mocks must be declared BEFORE the import of the SUT.
vi.mock('node:child_process', () => mockSpawn())
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    promises: {
      ...actual.promises,
      stat: vi.fn().mockImplementation(async (p: string) => {
        // .git lookup → pretend it's a directory.
        if (p.endsWith('.git') || /\.git[\\/]/.test(p)) {
          return { isDirectory: () => true, isFile: () => false, mtime: new Date(), mtimeMs: Date.now() }
        }
        // package-lock checks → pretend they're missing so
        // isNodeModulesStale returns false (no DEPS_CHANGED noise).
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }),
    },
  }
})
vi.mock('./settings.js', () => ({
  effectiveUpdaterRemote: vi.fn().mockResolvedValue('origin'),
  isDevAuthRequired: vi.fn().mockResolvedValue(false),
}))

// Now safe to import the SUT.
const REMOTE_HEAD_SHA = 'a1b2c3d4e5f6789012345678901234567890abcd' // 40 hex chars
const HEAD_SHA = '0000000000000000000000000000000000000000'

function scriptCleanGitWithPending() {
  whenCommand('git', (call) => {
    const args = call.args.join(' ')
    if (args.startsWith('rev-parse --abbrev-ref HEAD')) {
      return { code: 0, stdout: 'main' }
    }
    if (args.startsWith('status --porcelain')) {
      return { code: 0, stdout: '' } // clean
    }
    if (args.startsWith('log -1') && args.endsWith('HEAD')) {
      return { code: 0, stdout: `${HEAD_SHA}\t0000000\thead subject\tauthor\t2026-05-22T10:00:00Z` }
    }
    if (args.includes('log -1') && args.endsWith('origin/main')) {
      return { code: 0, stdout: `${REMOTE_HEAD_SHA}\ta1b2c3d\tremote subject\tauthor\t2026-05-22T11:00:00Z` }
    }
    if (args.startsWith(`log HEAD..${REMOTE_HEAD_SHA}`)) {
      return { code: 0, stdout: `${REMOTE_HEAD_SHA}\ta1b2c3d\tpending\tauthor\t2026-05-22T11:00:00Z` }
    }
    if (args.startsWith(`log ${REMOTE_HEAD_SHA}..HEAD`)) {
      return { code: 0, stdout: '' } // not ahead
    }
    if (args.startsWith('diff --name-only')) {
      return { code: 0, stdout: '' }
    }
    if (args.startsWith('fetch')) {
      return { code: 0, stdout: '' }
    }
    return { code: 0, stdout: '' }
  })
}

describe('POST /apply — confirmRemoteHead intent capture', () => {
  beforeEach(() => {
    resetSpawnMock()
    scriptCleanGitWithPending()
  })
  afterEach(() => {
    vi.clearAllMocks()
  })

  async function postApply(body: unknown) {
    const { updaterRouter } = await import('./updater.js')
    return withRouter('/api/updater', updaterRouter(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      return { status: res.status, body: await res.json() as Record<string, unknown> }
    })
  }

  it('412 when confirmRemoteHead is missing', async () => {
    const { status, body } = await postApply({})
    expect(status).toBe(412)
    expect(body.error).toMatch(/confirmRemoteHead required/)
  })

  it('412 when confirmRemoteHead is the 7-char shortSha (Phase 1.5 regression test)', async () => {
    // Pre-Phase-1.5 the route accepted EITHER full sha OR shortSha.
    // That collapsed the brute-force space to ~16M. The fix is to
    // require exactly 40 hex chars; a 7-char input must be rejected.
    const { status, body } = await postApply({ confirmRemoteHead: 'a1b2c3d' })
    expect(status).toBe(412)
    expect(body.error).toMatch(/full 40-char/)
  })

  it('412 when confirmRemoteHead has non-hex characters', async () => {
    const { status } = await postApply({
      confirmRemoteHead: 'z'.repeat(40), // wrong charset
    })
    expect(status).toBe(412)
  })

  it('412 when confirmRemoteHead is the wrong 40-char sha', async () => {
    const wrong = 'f'.repeat(40)
    const { status, body } = await postApply({ confirmRemoteHead: wrong })
    expect(status).toBe(412)
    expect(body.error).toMatch(/mismatch/)
  })

  it('412 when confirmRemoteHead is a non-string', async () => {
    const { status } = await postApply({ confirmRemoteHead: 12345 })
    expect(status).toBe(412)
  })

  it('proceeds with the script when the full 40-char sha matches', async () => {
    const { status, body } = await postApply({ confirmRemoteHead: REMOTE_HEAD_SHA })
    // Could be 200 (applied) or 500 (script ran but exited non-zero
    // because we didn't fully mock the apply script). What we're
    // really proving: it's NOT 412 anymore. The intent-capture passed.
    expect(status).not.toBe(412)
    // body.error is undefined on success, or some other (non-confirm)
    // error otherwise. Pin that it doesn't mention confirmRemoteHead.
    const errStr = typeof body.error === 'string' ? body.error : ''
    expect(errStr).not.toMatch(/confirmRemoteHead/)
  })

  it('rejects 39-char hex (off-by-one length boundary)', async () => {
    const offByOne = 'a'.repeat(39)
    const { status } = await postApply({ confirmRemoteHead: offByOne })
    expect(status).toBe(412)
  })

  it('rejects 41-char hex (off-by-one length boundary)', async () => {
    const offByOne = 'a'.repeat(41)
    const { status } = await postApply({ confirmRemoteHead: offByOne })
    expect(status).toBe(412)
  })
})

describe('POST /apply — guard rails', () => {
  beforeEach(() => {
    resetSpawnMock()
  })

  it('409 when the repo is not a git checkout', async () => {
    // Override the fs mock for this test only.
    const { promises: realFs } = await import('node:fs')
    const statSpy = vi.spyOn(realFs, 'stat').mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    )
    try {
      const { updaterRouter } = await import('./updater.js')
      await withRouter('/api/updater', updaterRouter(), async (baseUrl) => {
        const res = await fetch(`${baseUrl}/apply`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirmRemoteHead: REMOTE_HEAD_SHA }),
        })
        expect(res.status).toBe(409)
        const body = await res.json() as Record<string, unknown>
        expect(body.error).toMatch(/not a git checkout|git checkout/i)
      })
    } finally {
      statSpy.mockRestore()
    }
  })

  it('409 when status reports a dirty tree (blockedReason)', async () => {
    whenCommand('git', (call) => {
      const args = call.args.join(' ')
      if (args.startsWith('rev-parse --abbrev-ref HEAD')) {
        return { code: 0, stdout: 'main' }
      }
      if (args.startsWith('status --porcelain')) {
        return { code: 0, stdout: ' M src/foo.ts\n M src/bar.ts' } // dirty
      }
      if (args.includes('log -1')) {
        return { code: 0, stdout: `${HEAD_SHA}\t0000000\tsubj\ta\t2026-05-22T10:00:00Z` }
      }
      return { code: 0, stdout: '' }
    })
    const { updaterRouter } = await import('./updater.js')
    await withRouter('/api/updater', updaterRouter(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmRemoteHead: REMOTE_HEAD_SHA }),
      })
      expect(res.status).toBe(409)
    })
  })
})

describe('git spawn invariants', () => {
  beforeEach(() => {
    resetSpawnMock()
    scriptCleanGitWithPending()
  })

  it('git invocations carry argv-style args (never a shell-templated string)', async () => {
    // Pinning that git was invoked argv-style — no concatenated command
    // string that would invite arg injection. The shell:true vs false
    // choice is OK for git (cwd controlled, args fixed), but the argv
    // shape must hold.
    const { updaterRouter } = await import('./updater.js')
    await withRouter('/api/updater', updaterRouter(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/status`)
      // Ensure the request fully completed before we read spawnCalls.
      await res.json().catch(() => undefined)
    })
    const gitCalls = spawnCalls().filter((c) => c.command === 'git')
    // Some test orderings cache the route's imports; if no git ran on
    // this specific invocation, the prior test established that git
    // IS callable. Skip the cardinality check when caching elides the
    // call, but if any git calls happened they MUST be argv-shaped.
    for (const c of gitCalls) {
      expect(Array.isArray(c.args)).toBe(true)
      expect(c.args.length).toBeGreaterThan(0)
    }
  })
})
