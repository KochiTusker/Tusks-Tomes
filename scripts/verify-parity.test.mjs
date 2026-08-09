/**
 * The local gate and CI must run the same checks.
 *
 * They drifted once already, and the failure mode is expensive: the pre-push
 * hook ran typecheck + vitest while CI additionally ran the uninstaller safety
 * tests and the dev-mode tree audit. Three consecutive pushes therefore went
 * green locally and red in CI, on failures that nothing available locally
 * could have caught — including a real uninstaller bug on Windows short paths.
 *
 * `npm run verify` is now the single definition, called by both. These tests
 * fail if CI grows a gate that verify does not cover, or if the hook stops
 * calling verify.
 *
 * Deliberately NOT asserting the reverse (verify ⊆ CI): running something
 * locally that CI does not is harmless, and forbidding it would discourage
 * adding useful local checks.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const read = (rel) => readFileSync(path.join(REPO_ROOT, rel), 'utf8')
const pkg = JSON.parse(read('package.json'))
const verify = pkg.scripts.verify ?? ''
const ci = read('.github/workflows/ci.yml')
const hook = read('scripts/hooks/pre-push')

/** Commands CI runs that the local gate must also run.
 *
 *  `npm audit` is excluded on purpose: it queries the registry for advisories
 *  published against unchanged dependencies, so it can fail on a commit that
 *  changed nothing. That belongs in CI, where a red build prompts a lockfile
 *  bump, not in a hook that would block an unrelated push. */
const MUST_BE_LOCAL = [
  'npm run typecheck',
  'npm test',
  'npm run uninstall:test',
  'audit-current-tree.mjs --dev-mode',
  'audit-security-contracts.mjs',
]

describe('npm run verify covers every CI gate', () => {
  it('is defined', () => {
    expect(verify, 'package.json has no "verify" script').toBeTruthy()
  })

  it.each(MUST_BE_LOCAL)('runs %s', (cmd) => {
    // audit:dev is the npm alias for the tree audit; accept either spelling.
    const aliases = {
      'audit-current-tree.mjs --dev-mode': ['npm run audit:dev', 'audit-current-tree.mjs --dev-mode'],
    }
    const accepted = aliases[cmd] ?? [cmd]
    expect(
      accepted.some((a) => verify.includes(a)),
      `"${cmd}" runs in CI but not in \`npm run verify\`, so a push can go green locally and red in CI.\nverify = ${verify}`,
    ).toBe(true)
  })

  it('each of those genuinely is a CI step (so this list cannot go stale)', () => {
    // If a gate is dropped from CI, this list should shrink with it rather
    // than silently pinning a command nobody runs any more.
    const missingFromCi = MUST_BE_LOCAL.filter((c) => !ci.includes(c))
    expect(missingFromCi, 'listed here but no longer in ci.yml').toEqual([])
  })
})

describe('the pre-push hook uses that single definition', () => {
  it('invokes npm run verify', () => {
    expect(hook).toMatch(/npm run --silent verify|npm run verify/)
  })

  it('does not re-list the gates itself', () => {
    // Enumerating them in the hook is how the two drifted apart the first
    // time: CI gained a step, the hook did not.
    const stageOne = hook.split('remote_lc=')[0]
    expect(stageOne).not.toMatch(/npm run --silent typecheck/)
    expect(stageOne).not.toMatch(/npm test --silent/)
  })

  it('still aborts the push on failure rather than warning', () => {
    expect(hook).toMatch(/verify FAILED\. Push aborted\./)
    expect(hook).toMatch(/exit 1/)
  })
})
