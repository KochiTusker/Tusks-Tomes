/**
 * The helper itself, plus a contract guard over its callers.
 *
 * The guard exists because this bug does not announce itself. A test that
 * shells out to git with the ambient environment passes every local run and
 * fails only under `git push`, where GIT_DIR is exported — and in the
 * meantime it is issuing commands against the real repository. It has landed
 * twice now (audit-security-contracts, then publish-site), each time costing
 * a full push cycle to diagnose. A third file added a year from now would
 * repeat it, so the rule is enforced rather than remembered.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { cleanGitEnv } from './clean-git-env.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

describe('cleanGitEnv', () => {
  it('strips the entire GIT_* namespace, not an enumerated list', () => {
    const env = cleanGitEnv()

    // Whatever git happens to export, none of it survives — including
    // variables that did not exist when this test was written.
    expect(Object.keys(env).filter((k) => k.startsWith('GIT_'))).toEqual([])
  })

  it('strips variables present in the ambient environment', () => {
    const saved = process.env.GIT_DIR
    process.env.GIT_DIR = '/some/outer/repo/.git'
    try {
      expect(cleanGitEnv().GIT_DIR).toBeUndefined()
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = saved
    }
  })

  it('keeps the rest of the environment intact', () => {
    // Stripping too much would break PATH and the spawn would fail in a way
    // that looks like the thing under test is broken.
    expect(cleanGitEnv().PATH ?? cleanGitEnv().Path).toBeTruthy()
  })

  it('applies overrides after stripping, so deliberate GIT_* vars survive', () => {
    const env = cleanGitEnv({ GIT_CONFIG_GLOBAL: '/nope', FOO: 'bar' })

    expect(env.GIT_CONFIG_GLOBAL).toBe('/nope')
    expect(env.FOO).toBe('bar')
  })

  it('does not mutate process.env', () => {
    const before = { ...process.env }
    cleanGitEnv({ GIT_DIR: 'x' })
    expect({ ...process.env }).toEqual(before)
  })
})

describe('contract: tests that spawn git must neutralise the environment', () => {
  it('every test file spawning git imports and uses cleanGitEnv', () => {
    // Tracked files only — node_modules and build output are not ours.
    const tracked = execFileSync('git', ['ls-files', '-z'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      env: cleanGitEnv(),
    })
      .split('\0')
      .filter((f) => /\.test\.(mjs|ts|tsx)$/.test(f))

    // A literal spawn of the git binary. Matches execFileSync('git', …),
    // spawnSync("git", …) and friends.
    const SPAWNS_GIT = /(?:exec|spawn)(?:File)?(?:Sync)?\(\s*['"`]git['"`]/
    // A file that mocks child_process never reaches the real binary, so the
    // environment cannot leak. diagnoseBundle.test.ts is the live example.
    const MOCKS_CHILD_PROCESS = /vi\.mock\(\s*['"`](?:node:)?child_process['"`]/

    const offenders = []
    for (const file of tracked) {
      const raw = readFileSync(path.join(REPO_ROOT, file), 'utf8')
      // Comments describing a spawn are not a spawn. Strip them before
      // matching, or a line like "// Mock child_process so spawn('git', …)"
      // reads as an offence.
      const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

      if (!SPAWNS_GIT.test(src)) continue
      if (MOCKS_CHILD_PROCESS.test(src)) continue
      if (!src.includes('cleanGitEnv')) offenders.push(file)
    }

    expect(offenders, offenders.length ? offenderMessage(offenders) : undefined).toEqual([])
  })
})

function offenderMessage(files) {
  return [
    'These test files spawn git without neutralising the inherited environment:',
    ...files.map((f) => `  - ${f}`),
    '',
    'Git exports GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE to its hooks, and',
    'those take precedence over `cwd`. The commands will hit the REAL repo',
    'when the suite runs under `git push`, while passing every local run.',
    '',
    "Fix: import { cleanGitEnv } from '<path>/lib/clean-git-env.mjs' and pass",
    'env: cleanGitEnv() to every git spawn.',
  ].join('\n')
}
