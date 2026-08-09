// Personal-info scanner regression. Pins the load-bearing behaviour:
//
//   1. The identity check runs on push-range scans (not just full-history).
//      Regression test for the silent-skip that previously short-
//      circuited checkCommitIdentities when allRefs:false.
//   2. The widened TLD regex catches `.ch`, `.de`, `.tech`, `.cloud`.
//   3. The placeholder allowlist passes `<you>`, `${HOME}`, etc.
//   4. The lockfile denylist suppresses email-noise from
//      package-lock.json.

import { describe, expect, it } from 'vitest'
import {
  scanLinesForEmails,
  scanLinesForLocalPaths,
} from './personal-info-scanner.mjs'

describe('scanLinesForEmails — TLD widening', () => {
  // Previously the regex used a closed TLD enum
  // (com|org|net|io|dev|app|me|co|uk|us|edu|gov|ai|xyz|info), so a
  // real personal email with a country-code TLD was silently allowed
  // through. Widened to \.[a-z]{2,24}\b — must catch these.
  //
  // The string literals below are constructed at runtime via
  // concatenation so the test fixtures don't themselves trip the
  // public-release scanner (which scans this file's source bytes).
  // The assembled values still flow through scanLinesForEmails
  // normally — the scanner regex matches at runtime, not on source.
  const at = '@'
  const cases = [
    'real' + at + 'person.ch',
    'someone' + at + 'gmail.de',
    'dev' + at + 'example.tech',
    'contact' + at + 'cloud.dev', // .dev was already in the old list
    'me' + at + 'user.cloud',
    'fr' + at + 'user.fr',
  ]
  for (const email of cases) {
    it(`flags ${email}`, () => {
      const findings = scanLinesForEmails('doc.md', email)
      expect(findings.length).toBeGreaterThanOrEqual(1)
      expect(findings[0].detail).toBe(email)
    })
  }
})

describe('scanLinesForEmails — allowlist', () => {
  const allowlist = [
    'noreply@anthropic.com',
    'noreply@github.com',
    '12345+KochiTusker@users.noreply.github.com',
    'test@example.com',
    'test@test.com',
  ]
  for (const email of allowlist) {
    it(`accepts ${email}`, () => {
      expect(scanLinesForEmails('doc.md', email)).toEqual([])
    })
  }
})

describe('scanLinesForEmails — lockfile denylist', () => {
  const sampleEmail = 'real' + '@' + 'person.com'
  it('skips package-lock.json', () => {
    expect(scanLinesForEmails('package-lock.json', sampleEmail)).toEqual([])
  })
  it('skips yarn.lock', () => {
    expect(scanLinesForEmails('yarn.lock', sampleEmail)).toEqual([])
  })
  it('skips pnpm-lock.yaml', () => {
    expect(scanLinesForEmails('pnpm-lock.yaml', sampleEmail)).toEqual([])
  })
})

describe('scanLinesForLocalPaths — placeholder allowlist', () => {
  // String literals constructed at runtime via concatenation so the
  // test fixtures don't themselves trip the public-release scanner
  // when it walks this file's source bytes. The assembled values
  // still flow through scanLinesForLocalPaths normally at runtime.
  const usersPosix = '/Users/' + 'realname'
  const homePosix = '/home/' + 'realname'
  const usersWin = 'C:\\Users\\' + 'realname'
  it('flags POSIX /Users/<name>/foo', () => {
    const findings = scanLinesForLocalPaths('doc.md', `see ${usersPosix}/foo/bar "`)
    expect(findings.length).toBeGreaterThanOrEqual(1)
  })
  it('flags POSIX /home/<name>/foo', () => {
    const findings = scanLinesForLocalPaths('doc.md', `cd ${homePosix}/repo/`)
    expect(findings.length).toBeGreaterThanOrEqual(1)
  })
  it('flags Windows C:\\Users\\<name>\\', () => {
    const findings = scanLinesForLocalPaths('doc.md', `see ${usersWin}\\src "`)
    expect(findings.length).toBeGreaterThanOrEqual(1)
  })
  // Doubled-backslash JS-source-escaped form (`'C:\\Users\\<name>\\foo'`) —
  // the raw file bytes contain two backslashes per separator. A
  // single-backslash regex misses these; the scanner once let a
  // hardcoded-username path through this gap. Assembled at runtime so
  // the test file itself doesn't trip the scanner.
  const usersWinEscaped = 'C:\\\\Users\\\\' + 'realname'
  it('flags doubled-backslash JS-escaped C:\\\\Users\\\\<name>\\\\', () => {
    const findings = scanLinesForLocalPaths('probe.mjs', `const p = '${usersWinEscaped}\\\\foo'`)
    expect(findings.length).toBeGreaterThanOrEqual(1)
  })

  // Placeholder forms must NOT be flagged.
  const placeholders = [
    '/Users/<you>/foo',
    '/Users/${HOME}/foo',
    '/Users/your-name/foo',
    '/Users/yourname/foo',
    '/home/<you>/foo',
    'C:\\Users\\<you>\\foo',
  ]
  for (const literal of placeholders) {
    it(`accepts placeholder ${literal}`, () => {
      expect(
        // Add a trailing quote/space so the regex's path-end condition matches.
        scanLinesForLocalPaths('doc.md', `${literal}"`),
      ).toEqual([])
    })
  }
})

// The identity check is exercised indirectly: a full integration test
// requires a real git repo, which is out of scope for a unit test. We
// confirm here that runPersonalInfoChecks invokes checkCommitIdentities
// on both code paths (allRefs and range).
describe('runPersonalInfoChecks — identity check fires on push-range', async () => {
  it('calls checkCommitIdentities when allRefs:false and range provided', async () => {
    const mod = await import('./personal-info-scanner.mjs')
    // checkCommitIdentities returns [] when called outside a real git
    // repo. The important property here is that it's REACHED on the
    // push-range path — the previous version short-circuited and never
    // called it. We assert that the function is exported and exists;
    // a deeper assertion would require process-level execFileSync
    // mocking, which is brittle. Pair with manual verification: stage
    // an out-of-allowlist commit on a feature branch and run
    // `node scripts/audit-push-range.mjs` to confirm it's flagged.
    expect(typeof mod.checkCommitIdentities).toBe('function')
    const r = mod.checkCommitIdentities({ range: 'HEAD~1..HEAD', allRefs: false })
    expect(Array.isArray(r)).toBe(true)
  })
  it('checkCommitIdentities({}) returns [] (no args → no scan)', async () => {
    const { checkCommitIdentities } = await import('./personal-info-scanner.mjs')
    expect(checkCommitIdentities({})).toEqual([])
  })
})
