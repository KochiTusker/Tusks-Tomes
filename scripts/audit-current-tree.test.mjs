/**
 * The tree audit must read the WORKING TREE, not HEAD.
 *
 * It read `git show HEAD:<file>` for a long time while being named
 * audit-current-tree, printing "Auditing current working tree", and being
 * documented as checking "exactly the state an orphan commit would publish".
 * The orphan commit is built with `git add -A`, so HEAD is the wrong source
 * and it was wrong in the direction that matters: a credential added to a
 * tracked file but not yet committed reported CLEAN. That is precisely the
 * case the gate exists to catch — you notice a key in a diff, you have not
 * committed it yet, you run the audit, and it tells you everything is fine.
 *
 * These run the real script against a throwaway repo, so they fail if the
 * source ever reverts.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { cleanGitEnv } from './lib/clean-git-env.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT_REL = 'scripts/audit-current-tree.mjs'

let repo

/** A token the secret scanner is certain to flag, assembled at runtime so this
 *  test file does not itself trip the very gate it is testing. */
const FAKE_KEY = ['sk', 'a'.repeat(24)].join('-')

function git(...args) {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: 'pipe',
    env: cleanGitEnv(),
  })
}

function runAudit() {
  const r = spawnSync(process.execPath, [SCRIPT_REL, '--dev-mode'], {
    cwd: repo,
    encoding: 'utf8',
    env: cleanGitEnv({ NO_COLOR: '1' }),
    timeout: 120_000,
  })
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

beforeAll(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'tt-treeaudit-'))

  git('init', '-q')
  git('config', 'user.name', 'KochiTusker')
  git('config', 'user.email', '12345+KochiTusker@users.noreply.github.com')

  // The script and the scanner libraries it imports. Keep this list in step
  // with the imports at the top of audit-current-tree.mjs — a missing lib
  // makes the script fail to load, which surfaces as every case in this file
  // failing at once rather than as a clear "module not found".
  mkdirSync(path.join(repo, 'scripts', 'lib'), { recursive: true })
  copyFileSync(path.join(REPO_ROOT, SCRIPT_REL), path.join(repo, SCRIPT_REL))
  for (const lib of ['secret-scanner.mjs', 'personal-info-scanner.mjs', 'private-names.mjs', 'name-pool.mjs']) {
    copyFileSync(
      path.join(REPO_ROOT, 'scripts', 'lib', lib),
      path.join(repo, 'scripts', 'lib', lib),
    )
  }

  writeFileSync(path.join(repo, 'notes.txt'), 'nothing interesting here\n')
  git('add', '-A')
  git('commit', '-qm', 'baseline')
})

afterAll(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('audit-current-tree reads the working tree', () => {
  it('is clean on the committed baseline', () => {
    expect(runAudit().status).toBe(0)
  })

  it('FAILS on a credential that is written but not yet committed', () => {
    // The regression. Reading HEAD, this passes and the key ships.
    writeFileSync(path.join(repo, 'notes.txt'), `token = ${FAKE_KEY}\n`)

    const { status, out } = runAudit()

    expect(status, `audit passed on an uncommitted credential:\n${out}`).toBe(1)
    expect(out).toMatch(/notes\.txt/)
  })

  it('FAILS on a credential in a file that is staged but not committed', () => {
    git('add', '-A')

    expect(runAudit().status).toBe(1)
  })

  it('PASSES again once the credential is removed, without needing a commit', () => {
    // The other direction: a fix should clear the gate immediately. Having to
    // commit before the audit would agree is how the flagged line gets
    // committed in the first place.
    writeFileSync(path.join(repo, 'notes.txt'), 'cleaned up\n')

    expect(runAudit().status).toBe(0)
  })

  it('still reports clean after the fix is committed', () => {
    git('add', '-A')
    git('commit', '-qm', 'remove token')

    expect(runAudit().status).toBe(0)
  })

  it('ignores a tracked file deleted from the tree', () => {
    // `git add -A` stages the deletion, so it is absent from the orphan
    // commit; scanning HEAD's copy of it would flag something that never ships.
    writeFileSync(path.join(repo, 'doomed.txt'), `token = ${FAKE_KEY}\n`)
    git('add', '-A')
    git('commit', '-qm', 'add doomed file')
    expect(runAudit().status).toBe(1)

    rmSync(path.join(repo, 'doomed.txt'))

    expect(runAudit().status).toBe(0)
  })
})
