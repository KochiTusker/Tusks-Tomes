// Load-bearing regression coverage for the release-gate scanner.
//
// These are the highest-stakes tests in the repo: a regression here
// re-arms one of the OSINT leaks the gate is meant to block — and
// because the failures are silent (clean output = "ship it"), a broken
// scanner produces no warning. The tests pin:
//
//   1. Dev-only-doc filenames (CLAUDE.md, public-release-workflow.md)
//      ALWAYS produce a blocking finding.
//   2. Each token-shape regex finds at least one canonical positive.
//   3. The Anthropic / OpenAI prefix dedup invariant holds.
//   4. The `.env.example` allowlist works.
//   5. False-positive negatives: variable names with `sk_` prefix etc.
//      do NOT trigger.
//   6. The audit-current-tree refactor (per-file scan, no synthetic
//      diff) still detects a planted secret in a file's content.
//
// Test-naming convention matches the rest of the suite (vitest).

import { describe, expect, it } from 'vitest'
import {
  checkForbiddenFilenames,
  scanDiffForTokens,
  scanLinesForTokens,
  stripGeneratedSlugs,
} from './secret-scanner.mjs'

describe('checkForbiddenFilenames — dev-only doc blocking (forever-rule)', () => {
  it('flags CLAUDE.md', () => {
    const findings = checkForbiddenFilenames(['CLAUDE.md'])
    expect(findings.length).toBeGreaterThanOrEqual(1)
    expect(findings[0].layer).toBe('filename')
    expect(findings[0].detail).toMatch(/dev-only/)
  })

  it('flags docs/security/public-release-workflow.md', () => {
    const findings = checkForbiddenFilenames(['docs/security/public-release-workflow.md'])
    expect(findings.length).toBeGreaterThanOrEqual(1)
    expect(findings[0].layer).toBe('filename')
    expect(findings[0].detail).toMatch(/dev-only release-gate recipe/)
  })

  // If either of the two above ever returns zero findings, a future
  // public push could ship the doc — that's the highest-impact silent
  // regression in the repo. The next two test cases add a "the
  // forbidden list is non-empty in both directions" sanity belt.
  it('flags multiple dev-only files in one call', () => {
    const findings = checkForbiddenFilenames([
      'CLAUDE.md',
      'docs/security/public-release-workflow.md',
    ])
    expect(findings.length).toBe(2)
  })

  it('does NOT flag the existence of a legitimate file', () => {
    const findings = checkForbiddenFilenames(['README.md', 'package.json', 'docs/index.md'])
    expect(findings).toEqual([])
  })
})

describe('checkForbiddenFilenames — credential-bearing filenames', () => {
  const positives = [
    ['.env', 'env'],
    ['.env.production', 'env'],
    ['secrets/api.pem', 'PEM'],
    ['certs/server.key', 'private key'],
    ['credentials.json', 'credentials'],
    ['service-account-prod.json', 'service-account'],
    ['gcp-key-prod.json', 'GCP'],
  ]
  for (const [file, expectedSubstring] of positives) {
    it(`flags ${file}`, () => {
      const findings = checkForbiddenFilenames([file])
      expect(findings.length).toBeGreaterThanOrEqual(1)
      expect(findings[0].detail.toLowerCase()).toContain(expectedSubstring.toLowerCase())
    })
  }
})

describe('checkForbiddenFilenames — allowlist', () => {
  it('does NOT flag .env.example', () => {
    expect(checkForbiddenFilenames(['.env.example'])).toEqual([])
  })
  it('does NOT flag .env.sample', () => {
    expect(checkForbiddenFilenames(['.env.sample'])).toEqual([])
  })
})

describe('scanLinesForTokens — token shapes', () => {
  it('catches an Anthropic token shape', () => {
    const content = `const key = "sk-ant-${'A'.repeat(50)}";`
    const findings = scanLinesForTokens('fixture.ts', content)
    expect(findings.length).toBeGreaterThanOrEqual(1)
    expect(findings[0].detail).toMatch(/Anthropic/)
  })

  it('catches an OpenAI token shape', () => {
    const content = `const key = "sk-${'A'.repeat(30)}";`
    const findings = scanLinesForTokens('fixture.ts', content)
    expect(findings.length).toBeGreaterThanOrEqual(1)
    expect(findings[0].detail).toMatch(/OpenAI/)
  })

  it('catches a Google AIza-prefixed key', () => {
    // 39 chars total: AIza + 35-char body
    const content = `const key = "AIza${'B'.repeat(35)}";`
    const findings = scanLinesForTokens('fixture.ts', content)
    expect(findings.length).toBeGreaterThanOrEqual(1)
    expect(findings[0].detail).toMatch(/Google/)
  })

  it('Anthropic dedup invariant: sk-ant-… produces exactly ONE finding, not two', () => {
    const content = `sk-ant-${'A'.repeat(40)}`
    const findings = scanLinesForTokens('fixture.ts', content)
    expect(findings.length).toBe(1)
    expect(findings[0].detail).toMatch(/Anthropic/)
  })

  it('false-positive negative: variable name with sk_ prefix does NOT trigger', () => {
    const content = `const sk_value = process.env.SK_VAR\nconst sk_label = "ok"`
    const findings = scanLinesForTokens('fixture.ts', content)
    expect(findings).toEqual([])
  })

  // Synthetic-diff refactor regression: previously, the audit-current-tree
  // scanner concatenated all file contents into one synthetic diff with
  // `+commit … +++ b/<file>` markers, so a tracked file containing the
  // literal text `+++ b/other` could desync the parser. The per-file
  // scanLinesForTokens API can't be desynced this way — currentFile is
  // passed in by the caller. This test pins that planted secret in a
  // file whose content includes a hostile diff marker still gets caught.
  it('regression: detects a planted secret even when content contains diff markers', () => {
    const content = [
      '+++ b/decoy-path',
      'commit deadbeef',
      `const real = "sk-ant-${'X'.repeat(50)}"`,
    ].join('\n')
    const findings = scanLinesForTokens('real-file.ts', content)
    expect(findings.length).toBeGreaterThanOrEqual(1)
    expect(findings[0].file).toBe('real-file.ts')
    // The finding's "file" must be the caller-passed real-file.ts, NOT
    // the decoy path from inside the content — the per-file API can't
    // be tricked into reattributing.
    expect(findings[0].detail).toMatch(/Anthropic/)
  })
})

// Heading-anchor slugs, and the three gates that scan them.
//
// A generated slug tripped the OpenAI `sk-<16+>` pattern and blocked a real
// publish. It was then fixed twice — in the site build's verifier and in the
// site audit — while the pre-push range scanner, which is the gate that
// actually stops the push, went on failing. Hence one implementation here,
// and a test that covers the DIFF path specifically.
describe('generated heading-anchor slugs', () => {
  // Assembled at runtime: written literally, this file would trip the very
  // scanner it is testing.
  const SLUG = ['ta', 'sk', 'schema', 'srclibruncheckpointts'].join('-')
  const HEADING = `<h2 id="${SLUG}"><a href="#${SLUG}">Task schema</a></h2>`

  it('does not fire on an anchor id in an HTML file', () => {
    expect(scanLinesForTokens('docs/architecture/index.html', HEADING)).toEqual([])
  })

  it('does not fire on the same slug in a DIFF of an HTML file', () => {
    // The pre-push gate's path. Fixing only the whole-file scanner left this
    // one blocking, which is how the publish stayed broken after two fixes.
    const diff = `commit abc1234\n+++ b/docs/architecture/index.html\n+${HEADING}`

    expect(scanDiffForTokens(diff)).toEqual([])
  })

  it('STILL fires on a real key elsewhere in the same HTML line', () => {
    // The suppression must not become a hiding place: an attribute that is
    // not id/href, on the very same line, is still scanned.
    const key = ['sk', 'a'.repeat(24)].join('-')
    const line = `<h2 id="${SLUG}" data-note="${key}">Task schema</h2>`

    expect(scanLinesForTokens('docs/x/index.html', line).length).toBeGreaterThan(0)
  })

  it('STILL fires on a real key in HTML body text', () => {
    // A credential pasted into a heading survives in the visible text, which
    // is where it should be caught — legibly, not as a mangled slug.
    const key = ['sk', 'b'.repeat(24)].join('-')

    expect(scanLinesForTokens('docs/x/index.html', `<p>${key}</p>`).length).toBeGreaterThan(0)
  })

  it('does NOT suppress anything in a non-HTML file', () => {
    // Source files have no generated slugs, so an id="…" there is ordinary
    // content and gets no exemption.
    const key = ['sk', 'c'.repeat(24)].join('-')

    expect(scanLinesForTokens('src/thing.ts', `const x = 'id="${key}"'`).length).toBeGreaterThan(0)
  })

  it('leaves ordinary attributes and text untouched', () => {
    expect(stripGeneratedSlugs('<a class="btn" href="/docs/">Docs</a>')).toBe(
      '<a class="btn" href="/docs/">Docs</a>',
    )
    // Only same-page hrefs go; a real link target is left alone.
    expect(stripGeneratedSlugs('<a href="#top">Top</a>')).not.toContain('#top')
  })
})
