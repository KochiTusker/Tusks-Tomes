// Regression test for the DocsViewer XSS surface.
//
// DocsViewer renders user-fetched markdown with rehypeRaw (required so
// programmatically-injected <details>/<summary> wrappers from
// wrapH2SectionsInDetails actually render as DOM, not as escaped text).
// Without sanitisation a compromised .md (e.g. via a hostile update
// pull) could execute arbitrary script — and that script would have
// access to /api/provider-keys, which returns the decrypted keystore.
//
// The fix layers rehype-sanitize on top of rehypeRaw with a strict
// schema. This test runs the same unified pipeline DocsViewer uses and
// asserts:
//   1. Script tags are stripped.
//   2. onerror / onclick attributes are stripped.
//   3. javascript: URLs are stripped from <a href>.
//   4. The <details>/<summary>/<div class> wrappers DocsViewer depends
//      on still render.

import { describe, expect, it } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import rehypeStringify from 'rehype-stringify'

// Import the REAL schema from the component — not a copy. If the
// component's schema is ever loosened (intentionally or not), this
// test exercises the same shape the user's browser would, so any
// regression in the security contract surfaces here.
import { SAFE_HTML_SCHEMA } from './DocsViewer'

async function renderMarkdown(md: string): Promise<string> {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSanitize, SAFE_HTML_SCHEMA)
    .use(rehypeStringify)
  const out = await processor.process(md)
  return String(out)
}

describe('DocsViewer XSS sealing', () => {
  it('strips inline <script> tags', async () => {
    const html = await renderMarkdown('Hello\n\n<script>window.__pwn=1</script>\n')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('__pwn')
  })

  it('strips onerror attributes', async () => {
    const html = await renderMarkdown('<img src="x" onerror="window.__pwn=1">')
    expect(html).not.toMatch(/onerror/i)
  })

  it('strips onclick attributes', async () => {
    const html = await renderMarkdown('<a href="x" onclick="window.__pwn=1">click</a>')
    expect(html).not.toMatch(/onclick/i)
  })

  it('strips javascript: URLs from <a href>', async () => {
    const html = await renderMarkdown('<a href="javascript:alert(1)">click</a>')
    expect(html).not.toMatch(/javascript:/i)
  })

  it('strips iframe tags', async () => {
    const html = await renderMarkdown('<iframe src="https://evil.example"></iframe>')
    expect(html).not.toContain('<iframe')
  })

  it('strips data: URIs that could execute (e.g. text/html base64)', async () => {
    // rehype-sanitize denies non-http(s) URI protocols on <a href> by default.
    const html = await renderMarkdown('<a href="data:text/html,<script>alert(1)</script>">x</a>')
    expect(html).not.toContain('data:text/html')
  })

  it('preserves <details>/<summary>/<div class="docs-section-body">', async () => {
    // This is the exact shape wrapH2SectionsInDetails injects. The
    // sanitiser MUST keep these intact or the docs UX breaks.
    const md = [
      '<details class="docs-section">',
      '<summary><h2>Heading</h2></summary>',
      '<div class="docs-section-body">',
      '',
      'Body text.',
      '',
      '</div>',
      '</details>',
    ].join('\n')
    const html = await renderMarkdown(md)
    expect(html).toContain('<details')
    expect(html).toContain('<summary')
    expect(html).toContain('docs-section')
    expect(html).toContain('Body text.')
  })

  it('preserves ordinary GFM tables (passes through the chain unchanged)', async () => {
    const md = '| a | b |\n| - | - |\n| 1 | 2 |\n'
    const html = await renderMarkdown(md)
    expect(html).toContain('<table')
    expect(html).toContain('<th')
    expect(html).toContain('<td')
  })

  // ---- Phase 3.9: additional XSS vectors ----

  it('strips <svg> tags with embedded <script>', async () => {
    const html = await renderMarkdown('<svg><script>window.__pwn=1</script></svg>')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('__pwn')
  })

  it('strips <svg onload> event handlers', async () => {
    const html = await renderMarkdown('<svg onload="window.__pwn=1"></svg>')
    expect(html).not.toMatch(/onload/i)
    expect(html).not.toContain('__pwn')
  })

  it('strips javascript: URL from markdown link syntax [text](javascript:...)', async () => {
    // Different code path than raw HTML — goes through remark-parse,
    // not rehype-raw. The sanitiser still runs after, but the URL
    // protocol check has to fire on either path.
    const html = await renderMarkdown('[click me](javascript:alert(1))')
    expect(html).not.toMatch(/javascript:/i)
  })

  it('strips javascript: URL from reference-style markdown link', async () => {
    const html = await renderMarkdown('[click][evil]\n\n[evil]: javascript:alert(1)')
    expect(html).not.toMatch(/javascript:/i)
  })

  it('strips data: URL from markdown image syntax ![alt](data:...)', async () => {
    // SVG-via-image-via-data-URL is a classic vector for inert XSS
    // (the browser may execute scripts inside an SVG even when loaded
    // as an <img src>). rehype-sanitize should reject the protocol.
    const html = await renderMarkdown(
      '![x](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+PC9zdmc+)',
    )
    expect(html).not.toContain('data:image/svg+xml')
  })

  it('strips <math> / MathML which can host XSS via foreign-namespace bypass', async () => {
    const html = await renderMarkdown('<math><mtext><script>alert(1)</script></mtext></math>')
    expect(html).not.toContain('<math')
    expect(html).not.toContain('<script')
  })

  it('strips <style> tags (CSS expression / @import injection vector)', async () => {
    const html = await renderMarkdown('<style>body { background: url("javascript:alert(1)") }</style>')
    // The <style> element itself is removed. rehype-sanitize keeps the
    // inner text content as plain text, which is inert — "javascript:"
    // appearing in body prose is not an injection. The thing that
    // matters: no <style> tag, so no parser executes the CSS.
    expect(html).not.toContain('<style')
  })

  // The other side of the contract: the schema must stay permissive enough
  // for the markup the docs actually rely on. The docs carry no emoji, so a
  // silently-stripped class would turn every warning into flat grey prose —
  // a legibility regression that no XSS assertion above would catch.
  describe('markup the docs depend on survives', () => {
    it('keeps the class on a docs-alert callout', async () => {
      const html = await renderMarkdown(
        [
          '<div class="docs-alert docs-alert-caution">',
          '<div class="docs-alert-label">Warning</div>',
          '',
          'Body with **bold** and `code`.',
          '',
          '</div>',
        ].join('\n'),
      )
      expect(html).toContain('docs-alert-caution')
      expect(html).toContain('docs-alert-label')
      // Blank lines around the body are what let markdown inside the HTML
      // block still be parsed as markdown.
      expect(html).toContain('<strong>bold</strong>')
      expect(html).toContain('<code>code</code>')
    })

    it('keeps the collapsible section wrappers', async () => {
      const html = await renderMarkdown(
        [
          '<details class="docs-section">',
          '<summary><h2>Heading</h2></summary>',
          '<div class="docs-section-body">',
          '',
          'text',
          '',
          '</div>',
          '</details>',
        ].join('\n'),
      )
      expect(html).toContain('docs-section')
      expect(html).toContain('docs-section-body')
      expect(html).toContain('<summary>')
    })

    it('drops style attributes, which is why callouts use classes not inline colour', async () => {
      const html = await renderMarkdown('<span style="color:red">warning</span>')
      expect(html).not.toContain('style=')
      // The text still renders — it just has no colour. This is the exact
      // reason renderDocsAlerts emits div+class instead of a styled span.
      expect(html).toContain('warning')
    })
  })
})
