// Tests for the public-site generator.
//
// The load-bearing case is the first describe block: the site MUST NOT be
// able to publish a dev-only doc. That property is delegated to the release
// scanner's forbidden-file registry rather than duplicated, and these tests
// pin the delegation — if someone swaps it for a local copy of the list, or
// the registry stops matching, this fails.
//
// The rest cover the transforms that quietly corrupt a site when they drift:
// link rewriting (a wrong branch here 404s every cross-doc link), slug
// mapping (changing one silently breaks every inbound search result), and
// metadata extraction (an empty <title>/description tanks the page in search).

import { describe, expect, it } from 'vitest'
import {
  SITE,
  clampDescription,
  createLastModifiedLookup,
  extractMeta,
  formatTimestamp,
  isPublishable,
  parseTimestamp,
  publishedSlug,
  renderMarkdown,
  rewriteHref,
  slugForDoc,
  slugifyHeading,
  stripMd,
  UNAPPROVED_PREVIEW_MARKER,
  examplesBlock,
  examplesJsonLd,
  inlineHtml,
  keywordString,
  seoFor,
} from './build-site.mjs'

describe('dev-only docs can never be published', () => {
  // These two are the entire reason the release gate exists. If either ever
  // renders to the public site, the OSINT threat model is broken.
  it.each(['CLAUDE.md', 'docs/security/public-release-workflow.md'])(
    'refuses %s',
    (file) => {
      expect(isPublishable(file)).toBe(false)
      expect(publishedSlug(file)).toBeNull()
    },
  )

  it('refuses them regardless of path separator or case', () => {
    expect(isPublishable('claude.md')).toBe(false)
    expect(isPublishable('docs\\security\\public-release-workflow.md')).toBe(false)
  })

  it('links to a dev-only doc degrade to GitHub, never to a site URL', () => {
    // A doc that cross-references the workflow file must not gain a working
    // public link to it just because the reference exists.
    const href = rewriteHref('security/public-release-workflow.md', 'docs/faq.md')
    // Not `not.toContain(SITE.base)` — the repo URL legitimately ends in
    // /Tusks-Tomes. The property that matters is that it is not a
    // SITE-RELATIVE link, i.e. it does not start with the site base path.
    expect(href.startsWith(`${SITE.base}/`)).toBe(false)
    expect(href).toBe(`${SITE.repo}/blob/main/docs/security/public-release-workflow.md`)
  })

  it('still publishes ordinary docs', () => {
    expect(isPublishable('docs/faq.md')).toBe(true)
    expect(isPublishable('docs/add-ons/codex.md')).toBe(true)
  })

  it('ignores non-markdown', () => {
    expect(isPublishable('docs/assets/logo.png')).toBe(false)
    expect(isPublishable('src/lib/pipeline.ts')).toBe(false)
  })
})

describe('slug mapping', () => {
  it('maps docs paths to pretty URLs', () => {
    expect(slugForDoc('docs/faq.md')).toBe('docs/faq')
    expect(slugForDoc('docs/add-ons/codex.md')).toBe('docs/add-ons/codex')
  })

  it('collapses README to its directory', () => {
    expect(slugForDoc('docs/README.md')).toBe('docs')
  })

  it('gives root-level pages their promoted slug', () => {
    expect(publishedSlug('SETUP.md')).toBe('docs/setup')
    expect(publishedSlug('ROADMAP.md')).toBe('docs/roadmap')
  })

  it('lets AddOns.md own /docs/add-ons/ and skips the redirect stub', () => {
    // docs/add-ons/README.md is a 491-byte pointer at AddOns.md. Publishing
    // both would put a thin duplicate on the canonical URL.
    expect(publishedSlug('AddOns.md')).toBe('docs/add-ons')
    expect(isPublishable('docs/add-ons/README.md')).toBe(false)
  })

  it('promotes the project docs that live outside docs/', () => {
    // architecture.md sits at the repo root and the community files live in
    // .github/, which is a GitHub convention rather than a URL anyone should
    // see. Both get a normal /docs/ slug.
    expect(publishedSlug('architecture.md')).toBe('docs/architecture')
    expect(publishedSlug('.github/SECURITY.md')).toBe('docs/security-policy')
    expect(publishedSlug('.github/CODE_OF_CONDUCT.md')).toBe('docs/code-of-conduct')
  })

  it('keeps README.md off the site', () => {
    // Not an oversight. The landing page covers the same ground for a reader
    // who has never heard of the project; publishing both would put two
    // near-identical pages in the index competing for the same queries.
    expect(publishedSlug('README.md')).toBeNull()
  })

  it('returns null for repo files that are not on the site', () => {
    expect(publishedSlug('CONTRIBUTING.md')).toBeNull()
    expect(publishedSlug('.github/PULL_REQUEST_TEMPLATE.md')).toBeNull()
  })
})

describe('rewriteHref', () => {
  it('rewrites a sibling doc link to a site URL', () => {
    expect(rewriteHref('pricing.md', 'docs/faq.md')).toBe(`${SITE.base}/docs/pricing/`)
  })

  it('resolves nested and parent-relative links', () => {
    expect(rewriteHref('add-ons/codex.md', 'docs/README.md')).toBe(`${SITE.base}/docs/add-ons/codex/`)
    expect(rewriteHref('../../AddOns.md', 'docs/add-ons/codex.md')).toBe(`${SITE.base}/docs/add-ons/`)
  })

  it('preserves fragments', () => {
    expect(rewriteHref('pricing.md#tiers', 'docs/faq.md')).toBe(`${SITE.base}/docs/pricing/#tiers`)
  })

  it('points asset references at the copied assets', () => {
    expect(rewriteHref('assets/logo.png', 'docs/features.md')).toBe(`${SITE.base}/docs/assets/logo.png`)
  })

  it('sends source-file links to GitHub so they still resolve', () => {
    expect(rewriteHref('../src/lib/pipeline.ts', 'docs/faq.md')).toBe(
      `${SITE.repo}/blob/main/src/lib/pipeline.ts`,
    )
  })

  it('leaves external, absolute and in-page links alone', () => {
    expect(rewriteHref('https://craig.chat', 'docs/faq.md')).toBe('https://craig.chat')
    // example.com deliberately: the repo's personal-info scanner flags any
    // address outside its allowlist, and CI runs that scanner over the tree.
    expect(rewriteHref('mailto:a@example.com', 'docs/faq.md')).toBe('mailto:a@example.com')
    expect(rewriteHref('#section', 'docs/faq.md')).toBe('#section')
    expect(rewriteHref('/Tusks-Tomes/docs/', 'docs/faq.md')).toBe('/Tusks-Tomes/docs/')
  })

  it('clamps links that climb above the repo root', () => {
    // ../../../etc/passwd style input must not emit ../ into a site URL.
    expect(rewriteHref('../../../../secrets.md', 'docs/faq.md')).not.toContain('..')
  })
})

describe('parseTimestamp', () => {
  it('accepts plain seconds', () => {
    expect(parseTimestamp(90)).toBe(90)
    expect(parseTimestamp('90')).toBe(90)
    expect(parseTimestamp(0)).toBe(0)
  })

  it('accepts YouTube chapter-list forms', () => {
    expect(parseTimestamp('1:30')).toBe(90)
    expect(parseTimestamp('0:00')).toBe(0)
    expect(parseTimestamp('1:02:03')).toBe(3723)
  })

  it('returns null for empty or unparseable values', () => {
    expect(parseTimestamp('')).toBeNull()
    expect(parseTimestamp(undefined)).toBeNull()
    expect(parseTimestamp(null)).toBeNull()
    expect(parseTimestamp('later')).toBeNull()
    expect(parseTimestamp('1:2:3:4')).toBeNull()
    expect(parseTimestamp(-5)).toBeNull()
  })
})

describe('formatTimestamp', () => {
  // Round-trips with parseTimestamp: what you type into site.json is what
  // visitors see next to the video, and what ends up in the Clip structured
  // data Google reads for "Key Moments".
  it('formats seconds the way a video player does', () => {
    expect(formatTimestamp(0)).toBe('0:00')
    expect(formatTimestamp(9)).toBe('0:09')
    expect(formatTimestamp(90)).toBe('1:30')
    expect(formatTimestamp(345)).toBe('5:45')
    expect(formatTimestamp(3723)).toBe('1:02:03')
  })

  it('round-trips with parseTimestamp', () => {
    for (const t of ['0:00', '1:30', '12:05', '1:02:03']) {
      expect(formatTimestamp(parseTimestamp(t))).toBe(t)
    }
  })

  it('returns null for values it cannot render', () => {
    expect(formatTimestamp(null)).toBeNull()
    expect(formatTimestamp(undefined)).toBeNull()
    expect(formatTimestamp(-1)).toBeNull()
    expect(formatTimestamp(NaN)).toBeNull()
  })
})

describe('metadata extraction', () => {
  it('takes the H1 as the title and strips a leading emoji', () => {
    // Emoji in a <title> wastes SERP pixel budget and can render as mojibake.
    expect(extractMeta('# ✨ Features\n\nWhat it does.').title).toBe('Features')
    expect(extractMeta('# ❓ Frequently asked questions\n\nStuff.').title).toBe(
      'Frequently asked questions',
    )
  })

  it('uses the first real paragraph as the description', () => {
    // Long enough to stand alone — a SHORT opening deliberately absorbs the
    // following block instead, which is covered in the snippet-length tests.
    const md =
      '# Title\n\nThe first real paragraph, which is long enough on its own to make a perfectly good search snippet.\n\nSecond para.'
    expect(extractMeta(md).description).toBe(
      'The first real paragraph, which is long enough on its own to make a perfectly good search snippet.',
    )
  })

  it('skips badge rows, images and raw HTML when looking for prose', () => {
    const md = '# Title\n\n![badge](x.png)\n\n<details class="x">\n\nReal prose here.'
    expect(extractMeta(md).description).toBe('Real prose here.')
  })

  it('returns nulls rather than guessing when there is no H1', () => {
    expect(extractMeta('Just text, no heading.').title).toBeNull()
  })

  it('strips markdown syntax out of descriptions', () => {
    expect(stripMd('A **bold** [link](http://x) and `code`.')).toBe('A bold link and code.')
  })

  it('clamps long descriptions on a word boundary', () => {
    const long = `# T\n\n${'word '.repeat(80)}`
    const desc = extractMeta(long).description
    expect(desc.length).toBeLessThanOrEqual(160)
    expect(desc.endsWith('…')).toBe(true)
  })
})

describe('slugifyHeading', () => {
  it('produces GitHub-style anchors', () => {
    expect(slugifyHeading('How it works')).toBe('how-it-works')
    expect(slugifyHeading('What does it cost?')).toBe('what-does-it-cost')
  })
})

describe('renderMarkdown', () => {
  it('adds ids to headings and collects an H2 outline', async () => {
    const { html, toc } = await renderMarkdown('# T\n\n## First bit\n\ntext\n\n## Second bit\n', 'docs/x.md')
    expect(html).toContain('id="first-bit"')
    expect(toc.map((t) => t.id)).toEqual(['first-bit', 'second-bit'])
  })

  it('de-duplicates repeated heading anchors', async () => {
    const { html } = await renderMarkdown('# T\n\n## Notes\n\na\n\n## Notes\n', 'docs/x.md')
    expect(html).toContain('id="notes"')
    expect(html).toContain('id="notes-2"')
  })

  it('rewrites links and lazy-loads images', async () => {
    const { html } = await renderMarkdown(
      '# T\n\n[cost](pricing.md)\n\n![shot](assets/a.png)\n',
      'docs/faq.md',
    )
    expect(html).toContain(`href="${SITE.base}/docs/pricing/"`)
    expect(html).toContain(`src="${SITE.base}/docs/assets/a.png"`)
    expect(html).toContain('loading="lazy"')
  })

  it('marks external links noopener', async () => {
    const { html } = await renderMarkdown('# T\n\n[craig](https://craig.chat)\n', 'docs/x.md')
    expect(html).toContain('rel="noopener"')
  })

  it('passes through the raw HTML the docs already use', async () => {
    // docs/features.md wraps sections in <details class="docs-section">.
    const { html } = await renderMarkdown(
      '# T\n\n<details class="docs-section">\n<summary><h2>Bit</h2></summary>\n</details>\n',
      'docs/x.md',
    )
    expect(html).toContain('<details class="docs-section">')
  })

  it('renders GFM tables', async () => {
    const { html } = await renderMarkdown('# T\n\n| a | b |\n|---|---|\n| 1 | 2 |\n', 'docs/x.md')
    expect(html).toContain('<table>')
  })
})

describe('clampDescription', () => {
  it('leaves short text untouched', () => {
    expect(clampDescription('Short enough.')).toBe('Short enough.')
  })
})

describe('meta descriptions are usable as search snippets', () => {
  // Google renders ~155 characters. A doc that opens with a short lead-in
  // ("Two sources of config, in priority order:") used to yield a 40-character
  // description, wasting the slot on every such page. The extractor keeps
  // absorbing blocks until it has something worth showing.
  it('keeps gathering past a short opening line', () => {
    const md = [
      '# Configuration',
      '',
      'Two sources of config, in priority order:',
      '',
      '1. **In-app Settings tab.** The encrypted keystore, per-phase model assignments, and the per-add-on toggle. This is the source of truth after the first save.',
    ].join('\n')
    const { description } = extractMeta(md)
    expect(description.length).toBeGreaterThan(90)
    expect(description).toMatch(/Two sources of config/)
    // List markers must not survive into the snippet.
    expect(description).not.toMatch(/^\s*\d+\.\s/)
    expect(description).not.toContain('**')
  })

  it('still stops once it has enough, rather than swallowing the page', () => {
    const md = [
      '# T',
      '',
      'A first paragraph that comfortably exceeds the ninety character minimum all by itself, so nothing further is needed.',
      '',
      'A second paragraph that should NOT appear.',
    ].join('\n')
    const { description } = extractMeta(md)
    expect(description).not.toMatch(/should NOT appear/)
  })
})

// A sitemap that stamps the build date on every page is the default outcome
// and the wrong one: it claims all 33 pages changed on every publish, which
// teaches crawlers to ignore the field entirely. These pin the cases where a
// naive implementation silently reverts to that behaviour.
describe('createLastModifiedLookup', () => {
  const BUILD_DATE = '2026-08-07'

  /** Fake git. `status` returns `porcelain`; `log` returns dates[path] ?? ''. */
  function fakeGit({ porcelain = '', dates = {}, throwOn = null } = {}) {
    const calls = []
    const exec = (bin, args, opts) => {
      calls.push({ bin, args, opts })
      if (throwOn && args.includes(throwOn)) throw new Error('git failed')
      if (args[0] === 'status') return porcelain
      if (args[0] === 'log') return (dates[args[args.length - 1]] ?? '') + '\n'
      return ''
    }
    return { exec, calls }
  }

  it('returns the committed date for a clean tracked file', () => {
    const { exec } = fakeGit({ dates: { 'docs/faq.md': '2026-05-19' } })
    const lastMod = createLastModifiedLookup('/repo', BUILD_DATE, { exec })

    expect(lastMod('docs/faq.md')).toBe('2026-05-19')
  })

  it('falls back to the build date for a file dirty in the working tree', () => {
    // Committed in May, edited since. The committed date would understate it.
    const { exec } = fakeGit({
      porcelain: ' M docs/faq.md\0',
      dates: { 'docs/faq.md': '2026-05-19' },
    })
    const lastMod = createLastModifiedLookup('/repo', BUILD_DATE, { exec })

    expect(lastMod('docs/faq.md')).toBe(BUILD_DATE)
  })

  it('falls back to the build date for an untracked file (git returns nothing)', () => {
    const { exec } = fakeGit({ dates: {} })
    const lastMod = createLastModifiedLookup('/repo', BUILD_DATE, { exec })

    expect(lastMod('docs/brand-new.md')).toBe(BUILD_DATE)
  })

  it('falls back to the build date when git is unavailable entirely', () => {
    // An export with no .git — the site must still build.
    const exec = () => {
      throw new Error('not a git repository')
    }
    const lastMod = createLastModifiedLookup('/repo', BUILD_DATE, { exec })

    expect(lastMod('docs/faq.md')).toBe(BUILD_DATE)
  })

  it('takes the NEWEST date when a page is built from several sources', () => {
    const { exec } = fakeGit({
      dates: { 'site/index.template.html': '2026-05-19', 'site/site.json': '2026-07-29' },
    })
    const lastMod = createLastModifiedLookup('/repo', BUILD_DATE, { exec })

    expect(lastMod('site/index.template.html', 'site/site.json')).toBe('2026-07-29')
  })

  it('falls back to the build date if ANY source of a multi-source page is unknown', () => {
    // A known-stale date beside an unknown one would understate the page.
    const { exec } = fakeGit({ dates: { 'site/index.template.html': '2026-05-19' } })
    const lastMod = createLastModifiedLookup('/repo', BUILD_DATE, { exec })

    expect(lastMod('site/index.template.html', 'site/site.json')).toBe(BUILD_DATE)
  })

  it('consumes the second field of a rename entry rather than parsing it as a status', () => {
    // porcelain -z emits `R  new\0old\0`. Misparsing leaves "old" read as a
    // status code, so the genuinely-dirty new path silently looks clean.
    const { exec } = fakeGit({
      porcelain: 'R  docs/new-name.md\0docs/old-name.md\0 M docs/faq.md\0',
      dates: { 'docs/new-name.md': '2026-01-01', 'docs/faq.md': '2026-01-01' },
    })
    const lastMod = createLastModifiedLookup('/repo', BUILD_DATE, { exec })

    expect(lastMod('docs/new-name.md')).toBe(BUILD_DATE)
    expect(lastMod('docs/faq.md')).toBe(BUILD_DATE)
  })

  it('forces UTC so the date cannot shift with the build machine timezone', () => {
    const { exec, calls } = fakeGit({ dates: { 'docs/faq.md': '2026-05-19' } })
    createLastModifiedLookup('/repo', BUILD_DATE, { exec })('docs/faq.md')

    for (const call of calls) expect(call.opts.env.TZ).toBe('UTC')
  })

  it('emits date-only values — a +HH:MM offset would be a geolocation tell', () => {
    const { exec, calls } = fakeGit({ dates: { 'docs/faq.md': '2026-05-19' } })
    const result = createLastModifiedLookup('/repo', BUILD_DATE, { exec })('docs/faq.md')

    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    const logCall = calls.find((c) => c.args[0] === 'log')
    expect(logCall.args).toContain('--date=format-local:%Y-%m-%d')
  })

  it('asks git once per path, however many pages reference it', () => {
    const { exec, calls } = fakeGit({ dates: { 'docs/faq.md': '2026-05-19' } })
    const lastMod = createLastModifiedLookup('/repo', BUILD_DATE, { exec })

    lastMod('docs/faq.md')
    lastMod('docs/faq.md')
    lastMod('docs/faq.md')

    expect(calls.filter((c) => c.args[0] === 'log')).toHaveLength(1)
  })

  it('normalises separators so a Windows-style path matches the dirty set', () => {
    const { exec } = fakeGit({
      porcelain: ' M docs/add-ons/whisper-cpp.md\0',
      dates: { 'docs/add-ons/whisper-cpp.md': '2026-01-01' },
    })
    const lastMod = createLastModifiedLookup('/repo', BUILD_DATE, { exec })

    expect(lastMod('docs\add-ons\whisper-cpp.md')).toBe(BUILD_DATE)
  })
})

// Search Console verification fails silently: Google reports "file not found"
// and the build looks perfectly healthy, so the property just quietly stops
// reporting. These pin the shape rather than relying on noticing.
describe('Google Search Console verification', () => {
  it('names a verification file in the shape Google issues', () => {
    // Google's filename IS the token, and the file must name itself. A typo in
    // either half fails verification with no local symptom.
    expect(SITE.googleVerificationFile).toMatch(/^google[a-z0-9]+\.html$/)
  })

  it('keeps the meta-tag token too — the two verify different properties', () => {
    // A github.io PROJECT page cannot use DNS verification (that covers the
    // whole of kochitusker.github.io, where only GitHub can set records), so
    // the tag and the file are the only two routes available.
    expect(SITE.googleSiteVerification).toBeTruthy()
    expect(SITE.googleSiteVerification).not.toMatch(/\s/)
  })

  it('serves verification from the property root the prefix points at', () => {
    // A URL-prefix property for https://…/Tusks-Tomes/ looks for the file
    // directly beneath that path. Getting the base wrong 404s the check.
    expect(SITE.base).toBe('/Tusks-Tomes')
    expect(`${SITE.origin}${SITE.base}/${SITE.googleVerificationFile}`).toBe(
      'https://kochitusker.github.io/Tusks-Tomes/googled056a1feb0133c98.html',
    )
  })
})

describe('sample output is gated on human approval', () => {
  // The threat this models is not a bad sample. It is an UNREVIEWED sample:
  // somebody adds a snippet, the diff looks like a data change, it merges, and
  // extracts from a real person's game are on the public internet before
  // anyone read them end to end. So the gate is a single explicit flag, it
  // fails closed, and it is strict about what counts as approval.
  const sample = {
    approved: false,
    heading: 'What it actually writes',
    provenance: { sessionLabel: 'A session', routing: [{ phase: 'Phase 3', engine: 'Gemini' }] },
    chronicle: { label: 'The chronicle', note: 'Phase 3', paragraphs: ['SECRET_PROSE_MARKER'] },
  }

  it('renders nothing at all when approved is false', () => {
    expect(examplesBlock({ ...sample, approved: false })).toBe('')
  })

  it('renders nothing when approved is missing', () => {
    const { approved, ...noFlag } = sample
    expect(approved).toBe(false) // the fixture really did carry one
    expect(examplesBlock(noFlag)).toBe('')
  })

  it.each([
    ['the string "true"', 'true'],
    ['a truthy number', 1],
    ['a truthy object', {}],
  ])('does not accept %s as approval', (_label, value) => {
    // Strict === true. A JSON file edited by hand can easily end up with
    // "approved": "true", and a truthy check would publish on it.
    expect(examplesBlock({ ...sample, approved: value })).toBe('')
  })

  it('renders the section once approved', () => {
    const html = examplesBlock({ ...sample, approved: true })
    expect(html).toContain('SECRET_PROSE_MARKER')
    expect(html).toContain('id="examples"')
  })

  it('omits the heading and divider too, not just the samples', () => {
    // An empty <section> under a live "What it actually writes" heading would
    // read as a broken page rather than as an absent one.
    const html = examplesBlock({ ...sample, approved: false })
    expect(html).not.toContain('examples-h')
    expect(html).not.toContain('What it actually writes')
  })

  it('emits no structured data while unapproved', () => {
    // Structured data describing content that is not on the page is a
    // rich-result violation in its own right.
    expect(examplesJsonLd({ ...sample, approved: false })).toBeNull()
    expect(examplesJsonLd({ ...sample, approved: true })).not.toBeNull()
  })
})

describe('unapproved samples can be previewed but not published', () => {
  const sample = {
    approved: false,
    provenance: {},
    chronicle: { label: 'The chronicle', note: 'Phase 3', paragraphs: ['PREVIEW_PROSE'] },
  }

  it('renders under the preview flag so the samples can be read in place', () => {
    // Without this the reviewer has to flip `approved` to true to see what
    // they are approving, which inverts the gate: the file then sits at true
    // until someone remembers to put it back.
    const html = examplesBlock(sample, { preview: true })
    expect(html).toContain('PREVIEW_PROSE')
  })

  it('stamps the preview build with the marker publish-site.mjs refuses', () => {
    const html = examplesBlock(sample, { preview: true })
    expect(html).toContain(UNAPPROVED_PREVIEW_MARKER)
  })

  it('leaves no marker on an approved build', () => {
    const html = examplesBlock({ ...sample, approved: true }, { preview: true })
    expect(html).toContain('PREVIEW_PROSE')
    expect(html).not.toContain(UNAPPROVED_PREVIEW_MARKER)
  })

  it('still emits no structured data for a previewed but unapproved build', () => {
    expect(examplesJsonLd(sample)).toBeNull()
  })
})

describe('sample rendering preserves the shape of the output', () => {
  it('keeps an exchange as separate turns', () => {
    // The whole reason quotes carry an `exchange` is that the joke is the
    // back-and-forth. Flattening it into one line on the marketing page would
    // demonstrate the opposite of the feature being described.
    const html = examplesBlock({
      approved: true,
      provenance: {},
      quotes: {
        label: 'Memorable quotes',
        note: 'Phase 4',
        items: [
          {
            speaker: 'A, B',
            kind: 'funny',
            exchange: [
              { speaker: 'A', line: 'first line' },
              { speaker: 'B', line: 'second line' },
            ],
          },
        ],
      },
    })
    expect(html).toContain('quote-turns')
    expect(html).toContain('first line')
    expect(html).toContain('second line')
    expect(html).not.toContain('first line second line')
  })

  it('escapes sample text rather than trusting it', () => {
    // These strings are transcript extracts. They are not authored markup and
    // must never be treated as any.
    const html = examplesBlock({
      approved: true,
      provenance: {},
      jests: { label: 'Jests', note: 'Phase 4', items: ['<script>alert(1)</script>'] },
    })
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('renders both chronicle extracts when a second one is present', () => {
    const html = examplesBlock({
      approved: true,
      provenance: {},
      chronicle: {
        label: 'The chronicle',
        note: 'Phase 3',
        intro: 'FIRST INTRO',
        paragraphs: ['FIRST EXTRACT'],
        secondIntro: 'SECOND INTRO',
        secondParagraphs: ['SECOND EXTRACT'],
      },
    })
    for (const s of ['FIRST INTRO', 'FIRST EXTRACT', 'SECOND INTRO', 'SECOND EXTRACT']) {
      expect(html).toContain(s)
    }
  })

  it('drops the second intro when there is no second extract to introduce', () => {
    // Otherwise removing one extract leaves a dangling lead-in to nothing.
    const html = examplesBlock({
      approved: true,
      provenance: {},
      chronicle: {
        label: 'The chronicle',
        note: 'Phase 3',
        paragraphs: ['ONLY EXTRACT'],
        secondIntro: 'ORPHANED INTRO',
      },
    })
    expect(html).toContain('ONLY EXTRACT')
    expect(html).not.toContain('ORPHANED INTRO')
  })
})

describe('inlineHtml permits emphasis and nothing else', () => {
  // The samples carry real emphasis — spell names arrive italicised because
  // the pipeline italicises them. Dropping it would misrepresent the output;
  // trusting the string wholesale would mean trusting model-written text.
  it('keeps em and strong', () => {
    expect(inlineHtml('cast <em>Gentle Repose</em>')).toBe('cast <em>Gentle Repose</em>')
    expect(inlineHtml('<strong>The captaincy</strong> was decided')).toBe(
      '<strong>The captaincy</strong> was decided',
    )
  })

  it.each([
    ['a script tag', '<script>alert(1)</script>'],
    ['an event handler', '<em onclick="x()">hi</em>'],
    ['an image with onerror', '<img src=x onerror=alert(1)>'],
    ['an anchor', '<a href="https://evil.test">click</a>'],
    ['a tag with padding whitespace', '< em >hi</ em >'],
    ['an uppercase variant', '<EM>hi</EM>'],
  ])('escapes %s', (_label, input) => {
    const out = inlineHtml(input)
    expect(out).not.toMatch(/<(?!\/?(em|strong)>)/)
    expect(out).toContain('&lt;')
  })

  it('escapes ampersands and quotes in ordinary prose', () => {
    expect(inlineHtml('D&D "quoted"')).toBe('D&amp;D &quot;quoted&quot;')
  })
})

describe('search metadata is separable from on-page copy', () => {
  const seo = {
    pages: {
      'docs/audio-to-chronicle': { title: 'A search title', priority: '0.9', keywords: ['a', 'b'] },
    },
  }

  it('resolves an override by slug', () => {
    expect(seoFor('docs/audio-to-chronicle', seo).title).toBe('A search title')
  })

  it('returns an empty object for a page with no override', () => {
    // Callers spread the result, so undefined would throw and null would need
    // a guard at every site.
    expect(seoFor('docs/faq', seo)).toEqual({})
    expect(seoFor('docs/faq', undefined)).toEqual({})
    expect(seoFor('docs/faq', {})).toEqual({})
  })

  it('deduplicates keywords across the site-wide and per-page lists', () => {
    // The two lists overlap by design — a page repeats the site's headline
    // terms — and a duplicated keyword string is the shape spam filters key on.
    expect(keywordString(['a', 'b'], ['b', 'c'])).toBe('a, b, c')
  })

  it('drops blanks rather than emitting empty entries', () => {
    expect(keywordString(['a', '', null, '  ', 'b'])).toBe('a, b')
  })

  it('returns an empty string for nothing, so the caller can omit the property', () => {
    expect(keywordString([])).toBe('')
  })
})
