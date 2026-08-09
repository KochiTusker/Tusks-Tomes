import { describe, expect, it } from 'vitest'
import { ZERO_SHA, checkFastForward } from './fast-forward-guard.mjs'

const PUBLISHED = 'aaaaaaaa1111111111111111111111111111aaaa'
const DESCENDANT = 'bbbbbbbb2222222222222222222222222222bbbb'
const ORPHAN = 'cccccccc3333333333333333333333333333cccc'
const UNKNOWN = 'dddddddd4444444444444444444444444444dddd'

/** Fake git. `present` is the local object store; `ancestors` maps
 *  child -> the commits it descends from. */
function fakeGit({ present = [PUBLISHED, DESCENDANT, ORPHAN], ancestors = { [DESCENDANT]: [PUBLISHED] } } = {}) {
  return (args) => {
    if (args[0] === 'cat-file') {
      const sha = args[2].replace('^{commit}', '')
      return present.includes(sha) ? 0 : 1
    }
    if (args[0] === 'merge-base') {
      const [, , maybeAncestor, child] = args
      return (ancestors[child] ?? []).includes(maybeAncestor) ? 0 : 1
    }
    throw new Error(`unexpected git call: ${args.join(' ')}`)
  }
}

const line = (localSha, remoteSha, ref = 'refs/heads/main') =>
  `refs/heads/x ${localSha} ${ref} ${remoteSha}`

describe('checkFastForward', () => {
  // The whole reason the guard exists: v2.0 shipped as a fresh orphan and
  // broke `git pull --ff-only` for every existing install at once.
  it('BLOCKS a re-rooted release that users could not fast-forward to', () => {
    const findings = checkFastForward([line(ORPHAN, PUBLISHED)], fakeGit())
    expect(findings).toHaveLength(1)
    expect(findings[0].layer).toBe('fast-forward')
    expect(findings[0].file).toBe('refs/heads/main')
    expect(findings[0].detail).toMatch(/not a descendant/)
  })

  it('allows an ordinary release built on top of the published commit', () => {
    expect(checkFastForward([line(DESCENDANT, PUBLISHED)], fakeGit())).toEqual([])
  })

  // publish-site.mjs rebuilds gh-pages parentless every time, by design.
  // Applying the guard there would deadlock a real release.
  it('exempts gh-pages, which is intentionally rebuilt as an orphan', () => {
    const findings = checkFastForward(
      [line(ORPHAN, PUBLISHED, 'refs/heads/gh-pages')],
      fakeGit(),
    )
    expect(findings).toEqual([])
  })

  it('allows the first ever push, when the remote branch does not exist', () => {
    expect(checkFastForward([line(ORPHAN, ZERO_SHA)], fakeGit())).toEqual([])
  })

  it('allows a branch deletion', () => {
    expect(checkFastForward([line(ZERO_SHA, PUBLISHED)], fakeGit())).toEqual([])
  })

  // Unverifiable is not the same as safe. Failing open here would let the
  // exact breakage the guard exists to stop through, simply by not fetching.
  it('BLOCKS, with the remedy, when the remote commit is not held locally', () => {
    const findings = checkFastForward([line(DESCENDANT, UNKNOWN)], fakeGit())
    expect(findings).toHaveLength(1)
    expect(findings[0].detail).toMatch(/git fetch public main/)
  })

  it('checks every main ref line in a multi-ref push', () => {
    const findings = checkFastForward(
      [line(DESCENDANT, PUBLISHED), line(ORPHAN, PUBLISHED, 'refs/heads/gh-pages'), line(ORPHAN, PUBLISHED)],
      fakeGit(),
    )
    expect(findings).toHaveLength(1)
    expect(findings[0].detail).toMatch(/not a descendant/)
  })
})
